import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createTokenStore } from '../src/token-store.js';
import { writeTokenAndUploadSm, setTokenSecretWriterForTests } from '../src/token-secret.js';
import { clearKeyCacheForTest } from '../src/master-key.js';

const KEY = 'alias-isolation-master-key';
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  setTokenSecretWriterForTests(undefined);
  delete process.env.MASTER_KEY;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  clearKeyCacheForTest();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-iso-'));
  dirs.push(dir);
  return dir;
}

describe('alias isolation through the file-locked token store', () => {
  it('a token minted for one alias cannot read or write another alias', () => {
    const dir = tmp();
    const store = createTokenStore(dir, { resolveKey: () => KEY });
    const linkSpy = vi.spyOn(fs, 'linkSync');

    store.writeToken('alpha', { refresh_token: 'rt-alpha', access_token: 'at-alpha' });
    store.writeToken('beta', { refresh_token: 'rt-beta', access_token: 'at-beta' });

    expect(store.readToken('alpha')).toMatchObject({ refresh_token: 'rt-alpha', access_token: 'at-alpha' });
    expect(store.readToken('beta')).toMatchObject({ refresh_token: 'rt-beta', access_token: 'at-beta' });

    store.updateToken('beta', { access_token: 'beta-rotated' });
    expect(store.readToken('alpha')).toMatchObject({ refresh_token: 'rt-alpha', access_token: 'at-alpha' });
    expect(store.readToken('beta')).toMatchObject({ refresh_token: 'rt-beta', access_token: 'beta-rotated' });

    store.writeToken('alpha', { refresh_token: 'rt-alpha-2', access_token: 'at-alpha-2' });
    expect(store.readToken('beta')!.refresh_token).toBe('rt-beta');

    const enc = fs.readdirSync(dir).filter((name) => name.endsWith('.enc')).sort();
    expect(enc).toEqual(['alpha.enc', 'beta.enc']);
    expect(fs.readdirSync(dir).some((name) => name === 'token.enc' || name === 'tokens.enc')).toBe(false);

    const locks = linkSpy.mock.calls.map((call) => String(call[1]));
    expect(locks.some((p) => p.endsWith(`${path.sep}.alpha.enc.lock`))).toBe(true);
    expect(locks.some((p) => p.endsWith(`${path.sep}.beta.enc.lock`))).toBe(true);
    expect(locks.some((p) => p.endsWith(`${path.sep}token.enc`) || p.endsWith(`${path.sep}.token.enc.lock`))).toBe(false);

    expect(() => store.writeToken('../beta', { refresh_token: 'stolen' })).toThrow(/Invalid alias/);
    expect(store.readToken('beta')!.refresh_token).toBe('rt-beta');
    expect(store.readToken('alpha')!.refresh_token).toBe('rt-alpha-2');
  });

  it('concurrent writes for two accounts both survive inside the per-alias lock', async () => {
    const dir = tmp();
    const bootUrl = new URL('./fixtures/token-write-worker-boot.mjs', import.meta.url);
    const entry = new URL('./token-write-worker.ts', bootUrl).href;
    const run = (alias: string, access: string) =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(bootUrl, {
          workerData: { entry, dir, alias, access, refresh: `rt-${alias}`, key: KEY },
        });
        worker.once('message', (msg: { ok?: boolean; error?: string }) => {
          if (msg?.ok) resolve();
          else reject(new Error(msg?.error || `${alias} worker failed`));
        });
        worker.once('error', reject);
      });

    await Promise.all([run('alpha', 'alpha-concurrent'), run('beta', 'beta-concurrent')]);

    const store = createTokenStore(dir, { resolveKey: () => KEY });
    expect(store.readToken('alpha')).toMatchObject({ refresh_token: 'rt-alpha', access_token: 'alpha-concurrent' });
    expect(store.readToken('beta')).toMatchObject({ refresh_token: 'rt-beta', access_token: 'beta-concurrent' });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.enc')).sort()).toEqual(['alpha.enc', 'beta.enc']);
  });

  it('desk-mint writeTokenAndUploadSm writes only that alias and takes its lock', async () => {
    const { getAccountSet } = await import('../src/accounts.js');
    const alias = 'test';
    const config = getAccountSet().configs[alias];
    const dir = tmp();
    const encPath = path.join(dir, `${alias}.enc`);
    const previous = config.encPath;
    config.encPath = encPath;
    process.env.MASTER_KEY = KEY;
    process.env.GOOGLE_CLOUD_PROJECT = 'test-proj';
    clearKeyCacheForTest();
    const linkSpy = vi.spyOn(fs, 'linkSync');
    setTokenSecretWriterForTests(async () => ({ versionName: 'projects/test-proj/secrets/google-mcp-token-test/versions/1' }));
    try {
      await writeTokenAndUploadSm(alias, { refresh_token: 'rt-desk', access_token: 'at-desk' });
      const names = fs.readdirSync(dir).filter((name) => name.endsWith('.enc'));
      expect(names).toEqual([`${alias}.enc`]);
      expect(fs.existsSync(path.join(dir, 'token.enc'))).toBe(false);
      const locks = linkSpy.mock.calls.map((call) => String(call[1]));
      expect(locks.some((p) => p.endsWith(`${path.sep}.${alias}.enc.lock`))).toBe(true);
    } finally {
      config.encPath = previous;
    }
  });
});
