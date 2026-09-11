import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNT_CONFIG } from '../src/accounts.js';
import { encryptToken, snapshotEncFile, writeToken } from '../src/token-store.js';
import {
  assertEncFileShape,
  explicitGcpProject,
  persistEncFileToSecretManager,
  parseUploadSmArgs,
  runUploadSmCli,
  secretIdForAlias,
  setTokenSecretWriterForTests,
  tokenSecretParent,
  wantsSmUpload,
  writeTokenAndUploadSm,
  GOOGLE_MCP_TOKEN_SECRET_PREFIX,
} from '../src/token-secret.js';

const KEY = 'test-master-key-sm-writer';
const PLANTED = 'refresh-token-do-not-print-this-value';
const sample = { refresh_token: PLANTED, access_token: 'a', scope: 's', expiry_date: 123, token_type: 'Bearer' };

const originalPath = ACCOUNT_CONFIG.test.encPath;
const cleanupDirs: string[] = [];

function tempEnc(alias = 'test'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-secret-'));
  cleanupDirs.push(dir);
  ACCOUNT_CONFIG.test.encPath = path.join(dir, `${alias}.enc`);
  return ACCOUNT_CONFIG.test.encPath;
}

beforeEach(() => {
  process.env.MASTER_KEY = KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  ACCOUNT_CONFIG.test.encPath = originalPath;
  delete process.env.MASTER_KEY;
  setTokenSecretWriterForTests(undefined);
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('explicitGcpProject', () => {
  const keys = ['GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT'] as const;
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it('fails closed when no project is set (does not use gcloud default)', () => {
    expect(() => explicitGcpProject({})).toThrow(/must be set explicitly/);
    expect(() => explicitGcpProject({})).toThrow(/gcloud config get-value project/);
  });

  it('reads GOOGLE_CLOUD_PROJECT and does not hardcode a project', () => {
    expect(explicitGcpProject({ GOOGLE_CLOUD_PROJECT: 'explicit-proj' })).toBe('explicit-proj');
    expect(explicitGcpProject({ GOOGLE_CLOUD_PROJECT: 'explicit-proj' })).not.toBe('myflow-260730');
  });

  it('accepts GCP_PROJECT fallback', () => {
    expect(explicitGcpProject({ GCP_PROJECT: 'from-gcp' })).toBe('from-gcp');
  });
});

describe('secret naming', () => {
  it('builds google-mcp-token-<alias> under an explicit project', () => {
    expect(GOOGLE_MCP_TOKEN_SECRET_PREFIX).toBe('google-mcp-token-');
    expect(secretIdForAlias('stromback')).toBe('google-mcp-token-stromback');
    expect(tokenSecretParent('stromback', { GOOGLE_CLOUD_PROJECT: 'my-proj' })).toBe(
      'projects/my-proj/secrets/google-mcp-token-stromback',
    );
  });

  it('allows --secret-id override and rejects unsafe ids', () => {
    expect(secretIdForAlias('test', 'google-mcp-token-other')).toBe('google-mcp-token-other');
    expect(() => secretIdForAlias('test', '../etc/passwd')).toThrow(/Invalid --secret-id/);
    expect(() => secretIdForAlias('../../etc')).toThrow(/Invalid alias/);
  });
});

describe('assertEncFileShape', () => {
  it('accepts a v1 envelope and refuses garbage without echoing payload', () => {
    const ok = Buffer.from(encryptToken(sample, KEY), 'utf8');
    expect(() => assertEncFileShape(ok)).not.toThrow();
    expect(() => assertEncFileShape(Buffer.from(''))).toThrow(/empty/);
    expect(() => assertEncFileShape(Buffer.from('not-json'))).toThrow(/not JSON/);
    expect(() => assertEncFileShape(Buffer.from('{"v":2}'))).toThrow(/envelope/);
  });
});

describe('wantsSmUpload / parseUploadSmArgs', () => {
  it('gates on --upload-sm or GOOGLE_UPLOAD_SM / GOOGLE_SM_UPLOAD', () => {
    expect(wantsSmUpload([])).toBe(false);
    expect(wantsSmUpload(['--upload-sm'])).toBe(true);
    expect(wantsSmUpload([], { GOOGLE_UPLOAD_SM: '1' })).toBe(true);
    expect(wantsSmUpload([], { GOOGLE_SM_UPLOAD: 'yes' })).toBe(true);
    expect(wantsSmUpload([], { GOOGLE_UPLOAD_SM: '0' })).toBe(false);
  });

  it('requires --account and rejects unknown args', () => {
    expect(parseUploadSmArgs([])).toMatchObject({ ok: false });
    if (parseUploadSmArgs([]).ok === false) {
      expect(parseUploadSmArgs([]).error).toMatch(/Missing --account/);
    }
    const parsed = parseUploadSmArgs(['--account', 'test', '--project', 'p']);
    expect(parsed).toEqual({
      ok: true,
      value: { account: 'test', project: 'p' },
    });
    expect(parseUploadSmArgs(['--account', 'test', '--adc']).ok).toBe(false);
  });
});

describe('persistEncFileToSecretManager', () => {
  it('fails closed when GCP project is missing rather than using a silent default', async () => {
    tempEnc();
    writeToken('test', sample);
    const writer = vi.fn(async () => ({ versionName: 'v' }));
    await expect(
      persistEncFileToSecretManager('test', {}, { writer }),
    ).rejects.toThrow(/must be set explicitly/);
    expect(writer).not.toHaveBeenCalled();
  });

  it('fails closed when the desk file is missing', async () => {
    tempEnc();
    const writer = vi.fn(async () => ({ versionName: 'v' }));
    await expect(
      persistEncFileToSecretManager('test', { GOOGLE_CLOUD_PROJECT: 'test-proj' }, { writer }),
    ).rejects.toThrow(/No desk token file/);
    expect(writer).not.toHaveBeenCalled();
  });

  it('success path reports metadata only (version name / parent / alias)', async () => {
    tempEnc();
    writeToken('test', sample);
    const writer = vi.fn(async () => ({
      versionName: 'projects/test-proj/secrets/google-mcp-token-test/versions/4',
    }));

    const result = await persistEncFileToSecretManager(
      'test',
      { GOOGLE_CLOUD_PROJECT: 'test-proj' },
      { writer },
    );

    expect(result.parent).toBe('projects/test-proj/secrets/google-mcp-token-test');
    expect(result.versionName).toBe('projects/test-proj/secrets/google-mcp-token-test/versions/4');
    expect(result.alias).toBe('test');
    expect(result.secretId).toBe('google-mcp-token-test');
    expect(writer).toHaveBeenCalledTimes(1);
    const arg = writer.mock.calls[0]?.[0];
    expect(arg?.parent).toBe('projects/test-proj/secrets/google-mcp-token-test');
    expect(Buffer.isBuffer(arg?.payload)).toBe(true);
    expect(arg?.payload.length).toBeGreaterThan(0);
    const envelope = JSON.parse(arg!.payload.toString('utf8')) as { v: number; data?: string };
    expect(envelope.v).toBe(1);
    expect(typeof envelope.data).toBe('string');
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('fails closed when addSecretVersion returns no version name', async () => {
    tempEnc();
    writeToken('test', sample);
    const writer = vi.fn(async () => ({}));
    await expect(
      persistEncFileToSecretManager('test', { GOOGLE_CLOUD_PROJECT: 'test-proj' }, { writer }),
    ).rejects.toThrow(/no version name/);
  });

  it('does not revert the desk file on SM error when this path did not write it', async () => {
    tempEnc();
    writeToken('test', sample);
    const prior = snapshotEncFile('test');
    const writer = vi.fn(async () => {
      throw new Error('PERMISSION_DENIED');
    });
    await expect(
      persistEncFileToSecretManager('test', { GOOGLE_CLOUD_PROJECT: 'test-proj' }, { writer }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(snapshotEncFile('test')?.equals(prior!)).toBe(true);
  });
});

describe('writeTokenAndUploadSm fail-closed revert', () => {
  it('reverts the desk file to prior bytes when SM fails and a prior file existed', async () => {
    tempEnc();
    writeToken('test', sample);
    const prior = snapshotEncFile('test');
    expect(prior).toBeTruthy();

    const writer = vi.fn(async () => {
      throw new Error('PERMISSION_DENIED');
    });

    await expect(
      writeTokenAndUploadSm(
        'test',
        { ...sample, access_token: 'new-access' },
        { GOOGLE_CLOUD_PROJECT: 'test-proj' },
        { writer },
      ),
    ).rejects.toThrow(/PERMISSION_DENIED/);

    expect(snapshotEncFile('test')?.equals(prior!)).toBe(true);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it('does not invent a prior file when SM fails on first mint', async () => {
    const encPath = tempEnc();
    const writer = vi.fn(async () => {
      throw new Error('PERMISSION_DENIED');
    });

    await expect(
      writeTokenAndUploadSm('test', sample, { GOOGLE_CLOUD_PROJECT: 'test-proj' }, { writer }),
    ).rejects.toThrow(/No prior desk file to revert/);

    expect(fs.existsSync(encPath)).toBe(true);
  });

  it('does not write the desk file when project is missing', async () => {
    const encPath = tempEnc();
    const writer = vi.fn(async () => ({ versionName: 'v' }));
    await expect(
      writeTokenAndUploadSm('test', sample, {}, { writer }),
    ).rejects.toThrow(/must be set explicitly/);
    expect(fs.existsSync(encPath)).toBe(false);
    expect(writer).not.toHaveBeenCalled();
  });

  it('success path leaves the new desk file and reports version name only', async () => {
    tempEnc();
    writeToken('test', sample);
    const prior = snapshotEncFile('test');
    const writer = vi.fn(async () => ({
      versionName: 'projects/test-proj/secrets/google-mcp-token-test/versions/7',
    }));

    const result = await writeTokenAndUploadSm(
      'test',
      { ...sample, access_token: 'rotated' },
      { GOOGLE_CLOUD_PROJECT: 'test-proj' },
      { writer },
    );

    expect(result.versionName).toMatch(/versions\/7$/);
    expect(snapshotEncFile('test')?.equals(prior!)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(JSON.stringify(result)).not.toContain('rotated');
  });
});

describe('runUploadSmCli', () => {
  it('exits 1 without --account / without project and does not mention a planted token', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runUploadSmCli([], {
      log: (s) => logs.push(s),
      error: (s) => errors.push(s),
    }, { ...process.env, GOOGLE_CLOUD_PROJECT: undefined, GCP_PROJECT: undefined, K_SERVICE: undefined, MCP_HOSTED: '0' });
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/Missing --account/);
    expect([...logs, ...errors].join('\n')).not.toContain(PLANTED);
  });

  it('exits 1 when GOOGLE_CLOUD_PROJECT is missing even with --account', async () => {
    const errors: string[] = [];
    const env = { ...process.env };
    delete env.GOOGLE_CLOUD_PROJECT;
    delete env.GCP_PROJECT;
    env.MCP_HOSTED = '0';
    delete env.K_SERVICE;
    const code = await runUploadSmCli(['--account', 'test'], {
      log: () => {
        throw new Error('log');
      },
      error: (s) => errors.push(s),
    }, env);
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/must be set explicitly/);
    expect(errors.join('\n')).toMatch(/gcloud config get-value project/);
  });

  it('success stdout is metadata-only', async () => {
    tempEnc();
    writeToken('test', sample);
    const logs: string[] = [];
    const writer = vi.fn(async () => ({
      versionName: 'projects/test-proj/secrets/google-mcp-token-test/versions/2',
    }));
    const code = await runUploadSmCli(
      ['--account', 'test', '--project', 'test-proj'],
      {
        log: (s) => logs.push(s),
        error: (s) => {
          throw new Error(s);
        },
      },
      { ...process.env, MCP_HOSTED: '0', K_SERVICE: '' },
      writer,
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('versions/2');
    expect(out).toContain('google-mcp-token-test');
    expect(out).not.toContain(PLANTED);
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/refresh_token/);
  });

  it('refuses hosted mode', async () => {
    const errors: string[] = [];
    const code = await runUploadSmCli(['--account', 'test', '--project', 'p'], {
      log: () => {
        throw new Error('log');
      },
      error: (s) => errors.push(s),
    }, { ...process.env, MCP_HOSTED: '1' });
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/Hosted mode refuses/);
  });
});
