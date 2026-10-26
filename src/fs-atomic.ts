import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;
// A holder this process cannot identify (another PID namespace, another boot,
// or no /proc) is dead only once its lock is this old.
const LOCK_LEASE_MS = 60_000;
// Breaking a lock takes microseconds, so an older breaker file was left by a crash.
const BREAKER_STALE_MS = 2_000;
// The no-hard-link fallback writes the lock in two syscalls (create, then the
// pid); a reader can catch it empty in between. See docs/internals.md.
const LOCK_WRITE_GRACE_MS = 2_000;
const PROCESS_START_MS = performance.timeOrigin;
const OWNER_NAME = /^(\d+)\.(\d+|host)\.(\d+)\.([0-9a-f]{8}|0)\.[0-9a-f]{12}\.owner$/;

// Which process instance holds a lock: PID namespace id, start time in clock
// ticks since boot, and a boot id prefix; an unreadable part is `host` or `0`.
interface LockIdentity {
  ns: string;
  start: string;
  boot: string;
}

function startOf(pid: number | 'self'): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return /^\d+$/.test(start ?? '') ? start : undefined;
  } catch {
    return undefined;
  }
}

function selfIdentity(): LockIdentity {
  const identity: LockIdentity = { ns: 'host', start: '0', boot: '0' };
  try {
    identity.ns = /^pid:\[(\d+)\]$/.exec(fs.readlinkSync('/proc/self/ns/pid'))?.[1] ?? 'host';
  } catch {
    // no /proc
  }
  try {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').replace(/[^0-9a-f]/g, '').slice(0, 8);
    if (boot.length === 8) identity.boot = boot;
  } catch {
    // no /proc
  }
  try {
    // A /proc mounted for another PID namespace describes other processes,
    // so no pid can be looked up in it.
    if (fs.readlinkSync('/proc/self') === String(process.pid)) identity.start = startOf('self') ?? '0';
  } catch {
    // no /proc
  }
  return identity;
}

let SELF = selfIdentity();

/** Test hook: act as a process with this identity (undefined restores the real one). */
export function __setLockIdentityForTest(identity?: LockIdentity): void {
  SELF = identity ?? selfIdentity();
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface FileId {
  ino: bigint;
  dev: bigint;
}

interface LockHolder extends FileId {
  /** '' when the lock path is not a regular file. */
  body: string;
  mtimeNs: bigint;
  mtimeMs: number;
  /** The holder's owner file, linked to the lock or bound to it by a recorded identity; absent for an older writer. */
  owner?: LockIdentity & { path: string };
  /** A same-pid owner file exists but its binding does not (yet) match this lock. See docs/internals.md. */
  ownerPending?: boolean;
}

function sameFile(a: FileId, b: FileId): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function bindingRecord(id: LockAcquisition): string {
  return `${id.dev}:${id.ino}:${id.mtimeNs}`;
}

function matchesBinding(content: string, id: LockAcquisition): boolean {
  const m = /^(\d+):(\d+):(\d+)$/.exec(content);
  return m !== null && BigInt(m[1]) === id.dev && BigInt(m[2]) === id.ino && BigInt(m[3]) === id.mtimeNs;
}

// Undefined when the lock changed hands while it was being read.
function readHolder(lock: string): LockHolder | undefined {
  const before = fs.lstatSync(lock, { bigint: true });
  const body = before.isFile() ? fs.readFileSync(lock, 'utf8') : '';
  let owner: LockHolder['owner'];
  let ownerPending = false;
  if (before.isFile()) {
    const dir = path.dirname(lock);
    const prefix = `${path.basename(lock)}.`;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const m = OWNER_NAME.exec(name.slice(prefix.length));
      if (!m || m[1] !== body) continue;
      const ownerPath = path.join(dir, name);
      try {
        const ownerStat = fs.lstatSync(ownerPath, { bigint: true });
        if (sameFile(ownerStat, before) || matchesBinding(fs.readFileSync(ownerPath, 'utf8'), before)) {
          owner = { path: ownerPath, ns: m[2], start: m[3], boot: m[4] };
          break;
        }
        ownerPending = true;
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    }
  }
  const after = fs.lstatSync(lock, { bigint: true });
  if (!sameFile(before, after)) return undefined;
  return { body, ino: after.ino, dev: after.dev, mtimeNs: after.mtimeNs, mtimeMs: Number(after.mtimeNs) / 1e6, owner, ownerPending };
}

// The owner file's random name tells two holders apart even when the second
// lock reuses the first one's freed inode.
function sameHolder(a: LockHolder, b: LockHolder): boolean {
  return sameFile(a, b) && a.body === b.body && a.mtimeNs === b.mtimeNs && a.owner?.path === b.owner?.path;
}

function probeDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM: PID exists but is not signalable (another user's process).
    if (code === 'ESRCH') return true;
    if (code !== 'EPERM') throw error;
    return false;
  }
}

// Symmetric: a clock step back must not make a write-in-progress lock look
// permanently fresh (see docs/internals.md).
function withinWriteGrace(now: number, mtimeMs: number): boolean {
  return Math.abs(now - mtimeMs) < LOCK_WRITE_GRACE_MS;
}

function holderDead(holder: LockHolder, now: number): boolean {
  if (holder.body === '' && withinWriteGrace(now, holder.mtimeMs)) return false;
  const pid = Number(holder.body);
  if (!(Number.isSafeInteger(pid) && pid > 0)) return true;
  // A same-pid owner file exists but is not yet bound (the fallback lock's two
  // writes race a reader); give it the same grace as an empty lock.
  if (!holder.owner && holder.ownerPending && withinWriteGrace(now, holder.mtimeMs)) return false;
  const leaseOver = now - holder.mtimeMs >= LOCK_LEASE_MS;
  const owner = holder.owner;
  // No owner file: an older writer, whose namespace is unknown.
  if (!owner) return probeDead(pid) || leaseOver;
  if (owner.ns !== SELF.ns || owner.boot !== SELF.boot) return leaseOver;
  // Two unreadable parts compare equal without naming the same namespace or
  // boot, so only a fully known identity is looked up by start time.
  if (SELF.ns !== 'host' && SELF.boot !== '0' && SELF.start !== '0' && owner.start !== '0') {
    // A live namespace id is never shared, so the recorded pid is ours to look
    // up: a restarted container reuses both the id and the pid, but not the start time.
    const start = startOf(pid);
    if (start !== undefined) return start !== owner.start;
    return probeDead(pid) || leaseOver;
  }
  if (pid === process.pid) return holder.mtimeMs < PROCESS_START_MS;
  return probeDead(pid) || leaseOver;
}

// One waiter at a time breaks a dead lock, or the second could unlink the
// first one's new lock; false when another waiter is already breaking it.
function breakLock(lock: string, holder: LockHolder): boolean {
  const breaker = `${lock}.break`;
  // A token, not the inode: a breaker created after ours was removed can
  // get our freed inode.
  const token = `${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(breaker, token, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    clearStaleBreaker(breaker);
    return false;
  }
  try {
    const current = readHolder(lock);
    if (current && sameHolder(current, holder)) {
      fs.rmSync(lock, { force: true });
      if (holder.owner) fs.rmSync(holder.owner.path, { force: true });
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
  } finally {
    releaseBreaker(breaker, token);
  }
  return true;
}

// A symlink, or a breaker dated the other side of a clock step, would
// otherwise block every break.
function clearStaleBreaker(breaker: string): void {
  try {
    const st = fs.lstatSync(breaker);
    if (!st.isFile() || Math.abs(Date.now() - st.mtimeMs) >= BREAKER_STALE_MS) fs.rmSync(breaker, { force: true });
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

function releaseBreaker(breaker: string, token: string): void {
  try {
    if (fs.readFileSync(breaker, 'utf8') === token) fs.rmSync(breaker, { force: true });
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

/** The lock's own identity at the moment this call created it. */
type LockAcquisition = FileId & { mtimeNs: bigint };

// No hard links here (Android/Termux denies link() in private storage, some
// filesystems lack it entirely): the lock is created directly with O_EXCL,
// carrying the bare pid a linked owner file would carry, and the owner file
// is bound to it by a recorded identity instead of a hard link. See docs/internals.md.
function takeFallbackLock(lock: string, ownerFile: string): LockAcquisition {
  const fd = fs.openSync(lock, 'wx', 0o600);
  let acquired: LockAcquisition;
  try {
    fs.writeSync(fd, String(process.pid));
    const stat = fs.fstatSync(fd, { bigint: true });
    acquired = { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs };
  } catch (error) {
    // The lock is left empty; remove it only if it is still the one we just
    // created, then rethrow so the caller never retries a write failure.
    const stat = fs.fstatSync(fd, { bigint: true });
    fs.closeSync(fd);
    try {
      if (sameFile(fs.lstatSync(lock, { bigint: true }), stat)) fs.rmSync(lock, { force: true });
    } catch (cleanupError) {
      if (!isEnoent(cleanupError)) throw cleanupError;
    }
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.writeFileSync(ownerFile, bindingRecord(acquired));
  } catch (error) {
    // The lock already exists holding our live pid; without this cleanup
    // every other writer sees an ownerless holder and waits out the full lease.
    try {
      const current = fs.lstatSync(lock, { bigint: true });
      if (sameFile(current, acquired) && current.mtimeNs === acquired.mtimeNs) fs.rmSync(lock, { force: true });
    } catch (cleanupError) {
      if (!isEnoent(cleanupError)) throw cleanupError;
    }
    throw error;
  }
  return acquired;
}

// Hardlink-based advisory lock; the lock body is the bare pid, as older
// readers expect. See docs/internals.md.
export function withFileLock<T>(absPath: string, fn: () => T, label = `lock: ${absPath}`): T {
  const dir = path.dirname(absPath);
  const lock = path.join(dir, `.${path.basename(absPath)}.lock`);
  const ownerFile = `${lock}.${process.pid}.${SELF.ns}.${SELF.start}.${SELF.boot}.${randomBytes(6).toString('hex')}.owner`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ownerFile, String(process.pid), { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let linked = false;
  let acquired: LockAcquisition | undefined;

  try {
    while (true) {
      try {
        fs.linkSync(ownerFile, lock);
        linked = true;
        acquired = fs.lstatSync(lock, { bigint: true });
        break;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          try {
            acquired = takeFallbackLock(lock, ownerFile);
            linked = true;
            break;
          } catch (fbError) {
            if ((fbError as NodeJS.ErrnoException).code !== 'EEXIST') throw fbError;
          }
        } else if (err.code !== 'EEXIST') {
          throw error;
        }
        try {
          const holder = readHolder(lock);
          if (holder && holderDead(holder, Date.now()) && breakLock(lock, holder)) continue;
        } catch (readError) {
          if (isEnoent(readError)) continue;
          throw readError;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${label}`, { cause: error });
        }
        sleep(LOCK_RETRY_MS);
      }
    }
  } finally {
    if (!linked) fs.rmSync(ownerFile, { force: true });
  }

  try {
    return fn();
  } finally {
    releaseLock(lock, ownerFile, acquired);
  }
}

// A holder whose lock was broken (its owner file removed with it) must not
// remove its successor's lock: only drop the lock if it is still the exact
// file this call created, and our own owner file is still there to vouch for it.
function releaseLock(lock: string, ownerFile: string, acquired: LockAcquisition | undefined): void {
  try {
    if (acquired) {
      const current = fs.lstatSync(lock, { bigint: true });
      if (sameFile(current, acquired) && current.mtimeNs === acquired.mtimeNs && fs.existsSync(ownerFile)) {
        fs.rmSync(lock, { force: true });
      }
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  fs.rmSync(ownerFile, { force: true });
}

export function atomicWriteFileSync(absPath: string, contents: string, mode = 0o600): void {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, contents, { mode, flag: 'wx' });
    // Open read-write, not read-only: on Windows fsync maps to
    // FlushFileBuffers, which returns EPERM on a read-only handle.
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, absPath);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // force only suppresses ENOENT; a Windows handle-holder can make this
      // throw and mask the real write error. The orphan tmp is harmless.
    }
  }
}

// Windows only: renaming over a momentarily-open file throws transient EPERM/EACCES/EBUSY (reads take no lock); see docs/internals.md.
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= RENAME_ATTEMPTS) throw error;
      sleep(RENAME_RETRY_MS * attempt);
    }
  }
}

export function atomicWriteWithLock(absPath: string, contents: string, mode = 0o600): void {
  withFileLock(absPath, () => atomicWriteFileSync(absPath, contents, mode));
}
