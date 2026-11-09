// The RefreshStore of v6.0.0-beta.4 (the latest tagged release at the time this fixture was
// written; checked against `git show v6.0.0-beta.4:src/mcp-token.ts` before vendoring), for the
// by-field downgrade round trip in tests/mcp-token.test.ts. This release already has
// generation-counted families, but FamilyRecord has no `by`. Do not edit the class; if a later
// release moves the tag, re-vendor from that tag instead of hand-editing this one.
//
// Distinct from refresh-store-prev.ts, which vendors the release before generation-counted
// families existed at all (for the legacy active/spent migration round trip) and is frozen to
// that earlier point on purpose.
import { createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { deriveKey, encryptToken, decryptToken } from '../../src/token-store.js';
import { atomicWriteFileSync, withFileLock } from '../../src/fs-atomic.js';

export interface RefreshRecord {
  sub: string;
  issuedAt: number;
  family: string;
}

const REFRESH_FORMAT = 2;
const R1_PREFIX = 'r1.';
const R1_LENGTH = 94;
const R1_BODY = 36;
const R1_BYTES = 68;
const R1_MAC_DOMAIN = Buffer.from('mcp-google-multi refresh r1\n');
const R1_KEY_INFO = 'mcp-google-multi:refresh-mac:v1';
const R1_SCRYPT_SALT = 'mcp-google-multi:refresh-mac:scrypt:v1';
const R1_SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const GEN_MAX = 0xffffffff;
const LEGACY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CLOCK_SKEW_MS = 5 * 60_000;

interface FamilyRecord {
  sub: string;
  gen: number;
  cur: string;
  createdAt: number;
  usedAt: number;
  legacy?: string;
}

interface RefreshData {
  families: Record<string, FamilyRecord>;
  active: Record<string, RefreshRecord>;
  spent: Record<string, string>;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();
const familyTag = (family: Buffer | string): string => sha256(family).toString('hex').slice(0, 8);

const macKeyMemo = new Map<string, Buffer>();
function refreshMacKey(masterKey: string): Buffer {
  const hit = macKeyMemo.get(masterKey);
  if (hit) return hit;
  const raw = deriveKey(masterKey);
  const ikm = Buffer.from(masterKey, 'base64').length === 32 ? raw : scryptSync(masterKey, R1_SCRYPT_SALT, 32, R1_SCRYPT);
  const key = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), R1_KEY_INFO, 32));
  macKeyMemo.set(masterKey, key);
  return key;
}
function r1Mac(key: Buffer, body: Buffer): Buffer {
  return createHmac('sha256', key).update(R1_MAC_DOMAIN).update(body).digest();
}

interface R1Token {
  fidBytes: Buffer;
  fid: string;
  gen: number;
  digest: Buffer;
}

function parseR1(t: unknown, key: Buffer): R1Token | null {
  if (typeof t !== 'string' || t.length !== R1_LENGTH || !t.startsWith(R1_PREFIX)) return null;
  const text = t.slice(R1_PREFIX.length);
  const buf = Buffer.from(text, 'base64url');
  if (buf.length !== R1_BYTES || buf.toString('base64url') !== text) return null;
  if (!timingSafeEqual(buf.subarray(R1_BODY), r1Mac(key, buf.subarray(0, R1_BODY)))) return null;
  const fidBytes = buf.subarray(0, 16);
  return { fidBytes, fid: fidBytes.toString('base64url'), gen: buf.readUInt32BE(16), digest: sha256(buf) };
}

function mintR1(key: Buffer, fid: Buffer, gen: number): { token: string; cur: string } {
  const body = Buffer.alloc(R1_BODY);
  fid.copy(body, 0);
  body.writeUInt32BE(gen, 16);
  randomBytes(16).copy(body, 20);
  const buf = Buffer.concat([body, r1Mac(key, body)]);
  return { token: R1_PREFIX + buf.toString('base64url'), cur: sha256(buf).toString('base64url') };
}

function ownEntries(o: unknown): [string, unknown][] {
  return o !== null && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o).filter(([k]) => k !== '__proto__') : [];
}

function isLegacyRecord(r: unknown): r is RefreshRecord {
  if (r === null || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return typeof x.sub === 'string' && x.sub !== '' && typeof x.family === 'string' && typeof x.issuedAt === 'number' && Number.isFinite(x.issuedAt);
}

function isCanonicalB64(s: string, bytes: number): boolean {
  return B64URL.test(s) && Buffer.from(s, 'base64url').length === bytes && Buffer.from(s, 'base64url').toString('base64url') === s;
}

function isFamilyRecord(key: string, r: unknown): r is FamilyRecord {
  if (r === null || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return (
    isCanonicalB64(key, 16) &&
    typeof x.sub === 'string' && x.sub !== '' &&
    Number.isInteger(x.gen) && (x.gen as number) >= 0 && (x.gen as number) <= GEN_MAX &&
    typeof x.cur === 'string' && x.cur.length === 43 && isCanonicalB64(x.cur, 32) &&
    Number.isFinite(x.createdAt) && Number.isFinite(x.usedAt) &&
    (x.legacy === undefined || typeof x.legacy === 'string')
  );
}

function formatError(file: string, format: unknown): Error {
  const name = basename(file);
  return new Error(`E_REFRESH_STORE_FORMAT: ${name} was written by a newer release (format ${JSON.stringify(format)}): upgrade, or delete ${name} to sign every MCP client out`);
}

function readPlain(file: string, masterKey: string): unknown {
  if (!existsSync(file)) return null;
  return decryptToken(readFileSync(file, 'utf-8'), masterKey);
}

function checkFormat(file: string, d: unknown): void {
  if (d !== null && typeof d === 'object' && Object.hasOwn(d, 'format') && (d as { format: unknown }).format !== REFRESH_FORMAT) {
    throw formatError(file, (d as { format: unknown }).format);
  }
}

// This release has no notion of `by`: an extra field on a family record is
// simply dropped when the record is copied out, same as any other unknown key.
function decodeData(d: unknown): { data: RefreshData; dirty: boolean } {
  const data: RefreshData = { families: {}, active: {}, spent: {} };
  const x = (d ?? {}) as Record<string, unknown>;
  let dropped = 0;
  for (const [k, f] of ownEntries(x.families)) {
    if (isFamilyRecord(k, f)) {
      data.families[k] = { sub: f.sub, gen: f.gen, cur: f.cur, createdAt: f.createdAt, usedAt: f.usedAt, ...(f.legacy === undefined ? {} : { legacy: f.legacy }) };
    } else dropped += 1;
  }
  for (const [t, r] of ownEntries(x.active)) {
    if (isLegacyRecord(r)) data.active[t] = { sub: r.sub, issuedAt: r.issuedAt, family: r.family };
    else dropped += 1;
  }
  for (const [t, fam] of ownEntries(x.spent)) {
    if (typeof fam === 'string') data.spent[t] = fam;
    else dropped += 1;
  }
  return { data, dirty: dropped > 0 };
}

function dropSub(data: RefreshData, sub: string): number {
  let n = 0;
  for (const [k, f] of Object.entries(data.families)) {
    if (f.sub === sub) {
      delete data.families[k];
      n += 1;
    }
  }
  for (const [t, r] of Object.entries(data.active)) {
    if (r.sub === sub) {
      delete data.active[t];
      n += 1;
    }
  }
  return n;
}

export interface RefreshStoreOptions {
  maxAgeSec?: number;
  idleSec?: number;
  maxFamiliesPerSub?: number;
  log?: (line: string) => void;
}

function positiveInt(name: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Error(`E_REFRESH_OPTION_INVALID: ${name} must be a positive whole number`);
  return v;
}

function lifetimeMs(name: string, v: unknown): number | undefined {
  const n = positiveInt(name, v);
  return n === undefined ? undefined : n * 1000;
}

export class RefreshStore {
  private readonly log: (line: string) => void;
  private readonly maxAgeMs: number | undefined;
  private readonly idleMs: number | undefined;
  private readonly maxFamiliesPerSub: number | undefined;
  private macKey: Buffer | undefined;
  private legacyEmpty = false;

  constructor(
    private readonly path: string,
    private readonly masterKey: string,
    options: RefreshStoreOptions = {},
  ) {
    this.maxAgeMs = lifetimeMs('maxAgeSec', options.maxAgeSec);
    this.idleMs = lifetimeMs('idleSec', options.idleSec);
    this.maxFamiliesPerSub = positiveInt('maxFamiliesPerSub', options.maxFamiliesPerSub);
    this.log = options.log ?? (() => undefined);
  }

  private get timed(): boolean {
    return this.maxAgeMs !== undefined || this.idleMs !== undefined;
  }

  private live(createdAt: number, usedAt: number, nowMs: number): boolean {
    return (this.maxAgeMs === undefined || nowMs < createdAt + this.maxAgeMs) && (this.idleMs === undefined || nowMs < usedAt + this.idleMs);
  }

  private prune(data: RefreshData, nowMs: number, lines: string[]): number {
    if (!this.timed) return 0;
    let n = 0;
    for (const [k, f] of Object.entries(data.families)) {
      if (!this.live(f.createdAt, f.usedAt, nowMs)) {
        delete data.families[k];
        n += 1;
      }
    }
    for (const [t, r] of Object.entries(data.active)) {
      if (!this.live(r.issuedAt, r.issuedAt, nowMs)) {
        delete data.active[t];
        n += 1;
      }
    }
    if (n > 0) {
      lines.push(`refresh families expired n=${n}`);
      if (Object.keys(data.families).length === 0 && Object.keys(data.active).length === 0) lines.push('refresh store: every session expired at once (check the host clock)');
    }
    return n;
  }

  private clamp(data: RefreshData, nowMs: number, lines: string[]): boolean {
    if (!this.timed) return false;
    const limit = nowMs + CLOCK_SKEW_MS;
    let n = 0;
    const pull = (t: number): number => {
      if (t <= limit) return t;
      n += 1;
      return nowMs;
    };
    for (const f of Object.values(data.families)) {
      f.createdAt = pull(f.createdAt);
      f.usedAt = pull(f.usedAt);
    }
    for (const r of Object.values(data.active)) r.issuedAt = pull(r.issuedAt);
    if (n > 0) lines.push(`refresh store clock: n=${n} timestamps ahead of the clock were clamped`);
    return n > 0;
  }

  private key(): Buffer {
    return (this.macKey ??= refreshMacKey(this.masterKey));
  }

  private load(nowMs?: number, lines: string[] = []): { data: RefreshData; dirty: boolean } {
    let d: unknown;
    let readOk = true;
    try {
      d = readPlain(this.path, this.masterKey);
    } catch {
      d = null;
      readOk = false;
    }
    checkFormat(this.path, d);
    const loaded = decodeData(d);
    if (nowMs !== undefined) {
      if (this.clamp(loaded.data, nowMs, lines)) loaded.dirty = true;
      if (this.prune(loaded.data, nowMs, lines) > 0) loaded.dirty = true;
    }
    if (readOk && Object.keys(loaded.data.active).length === 0 && Object.keys(loaded.data.spent).length === 0) this.legacyEmpty = true;
    return loaded;
  }

  private save(data: RefreshData): void {
    const live = new Set<string>();
    for (const r of Object.values(data.active)) live.add(r.family);
    for (const f of Object.values(data.families)) if (f.legacy !== undefined) live.add(f.legacy);
    for (const [t, fam] of Object.entries(data.spent)) if (!live.has(fam)) delete data.spent[t];
    atomicWriteFileSync(this.path, encryptToken({ format: REFRESH_FORMAT, families: data.families, active: data.active, spent: data.spent }, this.masterKey), 0o600);
  }

  private emit(lines: string[]): void {
    for (const line of lines) {
      try {
        this.log(line);
      } catch {
        // log sink failure ignored
      }
    }
  }

  private enforceFamilyCap(data: RefreshData, sub: string, limit: number, lines: string[], keepKey: string): void {
    const entries: { at: number; drop: () => void }[] = [];
    for (const [k, f] of Object.entries(data.families)) {
      if (f.sub !== sub || k === keepKey) continue;
      entries.push({
        at: f.usedAt,
        drop: () => {
          delete data.families[k];
          lines.push(`refresh family dropped: cap tag=${familyTag(Buffer.from(k, 'base64url'))}`);
        },
      });
    }
    for (const [t, r] of Object.entries(data.active)) {
      if (r.sub !== sub) continue;
      entries.push({
        at: r.issuedAt,
        drop: () => {
          delete data.active[t];
          lines.push(`refresh family dropped: cap tag=${familyTag(r.family)}`);
        },
      });
    }
    if (entries.length + 1 <= limit) return;
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries.slice(0, entries.length + 1 - limit)) e.drop();
  }

  private newFamilyId(data: RefreshData): Buffer {
    let fid: Buffer;
    do fid = randomBytes(16);
    while (Object.hasOwn(data.families, fid.toString('base64url')));
    return fid;
  }

  issue(nowMs: number, sub: string): string {
    if (typeof sub !== 'string' || sub === '') throw new Error('RefreshStore.issue: sub must be a non-empty string');
    const key = this.key();
    return withFileLock(this.path, () => {
      const lines: string[] = [];
      const { data } = this.load(nowMs, lines);
      const fid = this.newFamilyId(data);
      const fidKey = fid.toString('base64url');
      const { token, cur } = mintR1(key, fid, 0);
      data.families[fidKey] = { sub, gen: 0, cur, createdAt: nowMs, usedAt: nowMs };
      if (this.maxFamiliesPerSub !== undefined) this.enforceFamilyCap(data, sub, this.maxFamiliesPerSub, lines, fidKey);
      this.save(data);
      this.emit(lines);
      return token;
    });
  }

  rotate(oldToken: string, nowMs: number, accept?: (sub: string) => boolean): { token: string; sub: string } | null {
    const key = this.key();
    const r1 = parseR1(oldToken, key);
    if (!r1 && !(typeof oldToken === 'string' && LEGACY_TOKEN.test(oldToken) && !this.legacyEmpty)) return null;
    return withFileLock(this.path, () => {
      const lines: string[] = [];
      const { data, dirty } = this.load(nowMs, lines);
      const done = <T>(result: T, write: boolean): T => {
        if (write) this.save(data);
        this.emit(lines);
        return result;
      };
      const refuse = (sub: string): null => {
        lines.push(`refresh sessions dropped: accept n=${dropSub(data, sub)}`);
        return done(null, true);
      };

      if (r1) {
        const f = Object.hasOwn(data.families, r1.fid) ? data.families[r1.fid] : undefined;
        if (!f) return done(null, dirty);
        const drop = (why: 'reuse' | 'ahead' | 'mismatch' | 'overflow'): null => {
          delete data.families[r1.fid];
          lines.push(`refresh family ${why === 'reuse' ? 'revoked' : 'dropped'}: ${why} tag=${familyTag(r1.fidBytes)}`);
          return done(null, true);
        };
        if (r1.gen < f.gen) return drop('reuse');
        if (r1.gen > f.gen) return drop('ahead');
        if (!timingSafeEqual(r1.digest, Buffer.from(f.cur, 'base64url'))) return drop('mismatch');
        if (accept && !accept(f.sub)) return refuse(f.sub);
        if (f.gen === GEN_MAX) return drop('overflow');
        const next = mintR1(key, r1.fidBytes, f.gen + 1);
        f.gen += 1;
        f.cur = next.cur;
        f.usedAt = Math.max(f.usedAt, nowMs);
        return done({ token: next.token, sub: f.sub }, true);
      }

      const rec = Object.hasOwn(data.active, oldToken) ? data.active[oldToken] : undefined;
      if (!rec) {
        const fam = Object.hasOwn(data.spent, oldToken) ? data.spent[oldToken] : undefined;
        if (fam === undefined) return done(null, dirty);
        for (const [t, r] of Object.entries(data.active)) if (r.family === fam) delete data.active[t];
        for (const [k, f] of Object.entries(data.families)) if (f.legacy === fam) delete data.families[k];
        lines.push(`refresh family revoked: reuse tag=${familyTag(fam)}`);
        return done(null, true);
      }
      if (accept && !accept(rec.sub)) return refuse(rec.sub);
      delete data.active[oldToken];
      data.spent[oldToken] = rec.family;
      const fid = this.newFamilyId(data);
      const next = mintR1(key, fid, 0);
      data.families[fid.toString('base64url')] = { sub: rec.sub, gen: 0, cur: next.cur, createdAt: rec.issuedAt, usedAt: Math.max(rec.issuedAt, nowMs), legacy: rec.family };
      return done({ token: next.token, sub: rec.sub }, true);
    });
  }

  purgeTenant(sub: string): number {
    return withFileLock(this.path, () => {
      const { data } = this.load();
      const dropped = dropSub(data, sub);
      if (dropped > 0) this.save(data);
      return dropped;
    });
  }
}
