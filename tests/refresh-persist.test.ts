/**
 * Hosted refresh persist must match Connect: fail-closed Secret Manager write
 * of google-mcp-token-<alias>, in-memory overlay only. Never write the Cloud
 * Run token mount or TOKEN_STORE_PATH as success. Desk/stdio may still write
 * local *.enc after SM success.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNT_CONFIG } from '../src/accounts.js';
import {
  persistRotatedTokenUpdates,
  setTokenSecretWriterForTests,
  assertGoogleRefreshTokenShape,
} from '../src/token-secret.js';
import {
  encryptToken,
  readToken,
  resetTokenOverlayForTests,
  snapshotEncFile,
  writeToken,
} from '../src/token-store.js';
import { decryptToken } from '../src/token-store.js';

const KEY = 'test-master-key-refresh-persist';
const PLANTED_OLD = 'refresh-token-old-do-not-print';
const PLANTED_NEW = 'refresh-token-rotated-new-do-not-print';

const sample = {
  refresh_token: PLANTED_OLD,
  access_token: 'a-old',
  scope: 's',
  expiry_date: 123,
  token_type: 'Bearer',
};

const originalPath = ACCOUNT_CONFIG.test.encPath;
const cleanupDirs: string[] = [];

function chmodTreeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const st = fs.statSync(root);
  if (st.isDirectory()) {
    fs.chmodSync(root, 0o755);
    for (const name of fs.readdirSync(root)) {
      chmodTreeWritable(path.join(root, name));
    }
  } else {
    fs.chmodSync(root, 0o644);
  }
}

/** Replica of Cloud Run's read-only per-alias secret volume. */
function readOnlyTokenMount(root: string, alias: string, bytes: Buffer): string {
  const dir = path.join(root, 'mnt', `tok-${alias}`);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${alias}.enc`);
  fs.writeFileSync(filePath, bytes);
  fs.chmodSync(filePath, 0o444);
  fs.chmodSync(dir, 0o555);
  return filePath;
}

describe('assertGoogleRefreshTokenShape', () => {
  it('accepts an opaque refresh token and refuses JWT access tokens', () => {
    expect(assertGoogleRefreshTokenShape('1//0opaque-refresh')).toBe('1//0opaque-refresh');
    expect(() => assertGoogleRefreshTokenShape('')).toThrow(/missing or empty/);
    expect(() =>
      assertGoogleRefreshTokenShape('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig'),
    ).toThrow(/access token \(JWT\)/);
  });
});

describe('hosted refresh persist (Secret Manager, no local mount write)', () => {
  let tmp: string;
  const prev: Record<string, string | undefined> = {};
  const envKeys = ['MASTER_KEY', 'GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT', 'MCP_HOSTED', 'K_SERVICE'] as const;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'google-refresh-'));
    cleanupDirs.push(tmp);
    for (const k of envKeys) {
      prev[k] = process.env[k];
    }
    process.env.MASTER_KEY = KEY;
    process.env.GOOGLE_CLOUD_PROJECT = 'test-proj';
    delete process.env.GCP_PROJECT;
    delete process.env.MCP_HOSTED;
    delete process.env.K_SERVICE;
    ACCOUNT_CONFIG.test.encPath = path.join(tmp, 'test.enc');
    setTokenSecretWriterForTests(async () => ({ versionName: 'v-refresh' }));
    resetTokenOverlayForTests();
  });

  afterEach(() => {
    setTokenSecretWriterForTests(undefined);
    resetTokenOverlayForTests();
    ACCOUNT_CONFIG.test.encPath = originalPath;
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    for (const dir of cleanupDirs.splice(0)) {
      try {
        chmodTreeWritable(dir);
      } catch {
        /* best-effort so rmSync can delete a 0555 mount replica */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hosted SM success writes google-mcp-token-<alias> and does not write the read-only mount', async () => {
    const oldBytes = Buffer.from(encryptToken(sample, KEY), 'utf8');
    const filePath = readOnlyTokenMount(tmp, 'test', oldBytes);
    ACCOUNT_CONFIG.test.encPath = filePath;

    const writes: { parent: string; payload: Buffer }[] = [];
    setTokenSecretWriterForTests(async (args) => {
      writes.push(args);
      return { versionName: 'v-hosted-refresh' };
    });

    const hostedEnv = {
      ...process.env,
      MCP_HOSTED: 'true',
      K_SERVICE: 'google-multi-mcp',
      GOOGLE_CLOUD_PROJECT: 'test-proj',
      MASTER_KEY: KEY,
    } as NodeJS.ProcessEnv;

    await persistRotatedTokenUpdates(
      'test',
      { refresh_token: PLANTED_NEW, access_token: 'a-new', expiry_date: 456 },
      hostedEnv,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.parent).toBe('projects/test-proj/secrets/google-mcp-token-test');
    const envelope = JSON.parse(writes[0]!.payload.toString('utf8')) as { v: number; data?: string };
    expect(envelope.v).toBe(1);
    expect(writes[0]!.payload.toString('utf8')).not.toContain(PLANTED_NEW);
    expect(snapshotEncFile('test')?.equals(oldBytes)).toBe(true);
    expect(readToken('test')?.refresh_token).toBe(PLANTED_NEW);
    expect(readToken('test')?.access_token).toBe('a-new');
  });

  it('hosted SM failure does not adopt the rotated token and does not write disk', async () => {
    const oldBytes = Buffer.from(encryptToken(sample, KEY), 'utf8');
    const filePath = readOnlyTokenMount(tmp, 'test', oldBytes);
    ACCOUNT_CONFIG.test.encPath = filePath;
    setTokenSecretWriterForTests(async () => {
      throw new Error('PERMISSION_DENIED');
    });

    const hostedEnv = {
      ...process.env,
      MCP_HOSTED: 'true',
      K_SERVICE: 'google-multi-mcp',
      GOOGLE_CLOUD_PROJECT: 'test-proj',
      MASTER_KEY: KEY,
    } as NodeJS.ProcessEnv;

    await expect(
      persistRotatedTokenUpdates(
        'test',
        { refresh_token: PLANTED_NEW, access_token: 'a-new' },
        hostedEnv,
      ),
    ).rejects.toThrow(/Secret Manager persist of google-mcp-token-test failed/);

    expect(snapshotEncFile('test')?.equals(oldBytes)).toBe(true);
    expect(readToken('test')?.refresh_token).toBe(PLANTED_OLD);
    expect(readToken('test')?.access_token).toBe('a-old');
  });

  it('hosted SM success still skips disk when TOKEN_STORE_PATH is writable', async () => {
    writeToken('test', sample);
    const prior = snapshotEncFile('test')!;
    const writes: { parent: string; payload: Buffer }[] = [];
    setTokenSecretWriterForTests(async (args) => {
      writes.push(args);
      return { versionName: 'v-hosted-writable' };
    });

    await persistRotatedTokenUpdates(
      'test',
      { refresh_token: PLANTED_NEW, access_token: 'a-new' },
      { ...process.env, MCP_HOSTED: 'true', GOOGLE_CLOUD_PROJECT: 'test-proj', MASTER_KEY: KEY },
    );

    expect(writes).toHaveLength(1);
    expect(snapshotEncFile('test')?.equals(prior)).toBe(true);
    expect(readToken('test')?.refresh_token).toBe(PLANTED_NEW);
    expect(decryptToken(prior.toString('utf8'), KEY).refresh_token).toBe(PLANTED_OLD);
  });

  it('hosted access-token-only refresh still writes SM first (every Cloud Run refresh)', async () => {
    writeToken('test', sample);
    const prior = snapshotEncFile('test')!;
    const writes: { parent: string; payload: Buffer }[] = [];
    setTokenSecretWriterForTests(async (args) => {
      writes.push(args);
      return { versionName: 'v-every-refresh' };
    });

    await persistRotatedTokenUpdates(
      'test',
      { access_token: 'a-new', expiry_date: 999 },
      { ...process.env, MCP_HOSTED: 'true', K_SERVICE: 'google-multi-mcp', GOOGLE_CLOUD_PROJECT: 'test-proj', MASTER_KEY: KEY },
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.parent).toBe('projects/test-proj/secrets/google-mcp-token-test');
    expect(snapshotEncFile('test')?.equals(prior)).toBe(true);
    expect(readToken('test')?.refresh_token).toBe(PLANTED_OLD);
    expect(readToken('test')?.access_token).toBe('a-new');
    expect(JSON.stringify(writes[0]?.parent)).not.toContain(PLANTED_OLD);
  });

  it('desk path still writes local *.enc after SM success', async () => {
    writeToken('test', sample);
    const writes: { parent: string; payload: Buffer }[] = [];
    setTokenSecretWriterForTests(async (args) => {
      writes.push(args);
      return { versionName: 'v-desk' };
    });

    await persistRotatedTokenUpdates(
      'test',
      { refresh_token: PLANTED_NEW, access_token: 'a-new' },
      { ...process.env, MCP_HOSTED: 'false', GOOGLE_CLOUD_PROJECT: 'test-proj', MASTER_KEY: KEY, K_SERVICE: '' },
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.parent).toBe('projects/test-proj/secrets/google-mcp-token-test');
    expect(readToken('test')?.refresh_token).toBe(PLANTED_NEW);
    const disk = decryptToken(snapshotEncFile('test')!.toString('utf8'), KEY);
    expect(disk.refresh_token).toBe(PLANTED_NEW);
  });

  it('desk SM failure does not leave a partial disk write and does not adopt overlay', async () => {
    writeToken('test', sample);
    const prior = snapshotEncFile('test')!;
    setTokenSecretWriterForTests(async () => {
      throw new Error('Secret Manager unavailable');
    });

    await expect(
      persistRotatedTokenUpdates(
        'test',
        { refresh_token: PLANTED_NEW, access_token: 'a-new' },
        { ...process.env, MCP_HOSTED: 'false', GOOGLE_CLOUD_PROJECT: 'test-proj', MASTER_KEY: KEY, K_SERVICE: '' },
      ),
    ).rejects.toThrow(/google-mcp-token-test failed/);

    expect(snapshotEncFile('test')?.equals(prior)).toBe(true);
    expect(readToken('test')?.refresh_token).toBe(PLANTED_OLD);
  });

  it('fails closed without GOOGLE_CLOUD_PROJECT (no silent gcloud default) and does not write disk', async () => {
    writeToken('test', sample);
    const prior = snapshotEncFile('test')!;
    const writes: { parent: string; payload: Buffer }[] = [];
    setTokenSecretWriterForTests(async (args) => {
      writes.push(args);
      return { versionName: 'v-no-project' };
    });

    await expect(
      persistRotatedTokenUpdates(
        'test',
        { refresh_token: PLANTED_NEW },
        { MCP_HOSTED: 'true', MASTER_KEY: KEY, GOOGLE_CLOUD_PROJECT: '', GCP_PROJECT: '' },
      ),
    ).rejects.toThrow(/must be set explicitly/);

    expect(writes).toHaveLength(0);
    expect(snapshotEncFile('test')?.equals(prior)).toBe(true);
    expect(readToken('test')?.refresh_token).toBe(PLANTED_OLD);
  });

  it('refuses a JWT access token as refresh_token before any SM write', async () => {
    writeToken('test', sample);
    const prior = snapshotEncFile('test')!;
    const writes: { parent: string; payload: Buffer }[] = [];
    setTokenSecretWriterForTests(async (args) => {
      writes.push(args);
      return { versionName: 'v-jwt' };
    });

    await expect(
      persistRotatedTokenUpdates(
        'test',
        { refresh_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig' },
        { ...process.env, MCP_HOSTED: 'true', GOOGLE_CLOUD_PROJECT: 'test-proj', MASTER_KEY: KEY },
      ),
    ).rejects.toThrow(/access token \(JWT\)/);

    expect(writes).toHaveLength(0);
    expect(snapshotEncFile('test')?.equals(prior)).toBe(true);
    expect(readToken('test')?.refresh_token).toBe(PLANTED_OLD);
  });
});
