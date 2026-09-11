import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { accessSecretVersion, addSecretVersion, getSecretVersion } = vi.hoisted(() => ({
  accessSecretVersion: vi.fn(async (_arg: { name: string }) => [
    { payload: { data: Buffer.from('{"v":1}', 'utf8') } },
  ]),
  addSecretVersion: vi.fn(async (_arg: { parent: string; payload: { data: Buffer } }) => [
    { name: 'projects/test-proj/secrets/google-mcp-token-test/versions/3' },
  ]),
  getSecretVersion: vi.fn(async (_arg: { name: string }) => [
    {
      name: 'projects/test-proj/secrets/google-mcp-token-test/versions/3',
      createTime: '2026-09-11T00:00:00.000Z',
      etag: 'etag-3',
    },
  ]),
}));

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    accessSecretVersion = accessSecretVersion;
    addSecretVersion = addSecretVersion;
    getSecretVersion = getSecretVersion;
  },
}));
import {
  parseProveArgs,
  runProve,
  runProveCli,
  publicVersionMeta,
  tokenSecretParentFromProject,
  assertNoPayloadInPublicMeta,
  proveUsage,
  LIVE_NOT_FOR_THIS_PR,
} from '../src/token-secret-prove.js';

const PLANTED = 'rt-do-not-print-this-token-value';

function mockLiveClient() {
  const payload = Buffer.from(JSON.stringify({ v: 1, iv: 'iv', tag: 'tag', data: PLANTED }), 'utf8');
  return {
    accessLatestPayload: vi.fn(async (_parent: string) => payload),
    addSecretVersion: vi.fn(async (_parent: string, _payload: Buffer): Promise<{ name?: string }> => ({
      name: 'projects/test-proj/secrets/google-mcp-token-test/versions/12',
    })),
    getSecretVersionMeta: vi.fn(async (_versionName: string) => ({
      name: 'projects/test-proj/secrets/google-mcp-token-test/versions/12',
      createTime: '2026-09-11T11:00:00.000Z',
      etag: 'etag-12',
    })),
  };
}

describe('parseProveArgs', () => {
  it('fails closed when --project is missing (does not use env or gcloud)', () => {
    const prev = process.env.GOOGLE_CLOUD_PROJECT;
    process.env.GOOGLE_CLOUD_PROJECT = 'env-must-not-count';
    try {
      const parsed = parseProveArgs(['--alias', 'test']);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toMatch(/Missing --project/);
        expect(parsed.error).toMatch(/gcloud config get-value project/);
        expect(parsed.error).not.toContain('env-must-not-count');
      }
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = prev;
    }
  });

  it('fails closed when --alias is missing', () => {
    const parsed = parseProveArgs(['--project', 'test-proj']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/Missing --alias/);
  });

  it('accepts --project and --alias and defaults to dry-run (not live)', () => {
    const parsed = parseProveArgs(['--project', 'test-proj', '--alias', 'stromback']);
    expect(parsed).toEqual({
      ok: true,
      value: { live: false, project: 'test-proj', alias: 'stromback' },
    });
  });

  it('accepts --project= / --account= form and --live', () => {
    const parsed = parseProveArgs(['--project=test-proj', '--account=test', '--live']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.project).toBe('test-proj');
      expect(parsed.value.alias).toBe('test');
      expect(parsed.value.live).toBe(true);
    }
  });

  it('rejects unknown args rather than treating them as a gcloud project', () => {
    const parsed = parseProveArgs(['--project', 'test-proj', '--alias', 'test', '--adc']);
    expect(parsed.ok).toBe(false);
  });

  it('accepts --help and --secret-id', () => {
    const help = parseProveArgs(['--help']);
    expect(help.ok).toBe(true);
    if (help.ok) expect(help.value.help).toBe(true);
    expect(parseProveArgs(['--project', 'p', '--alias', 'test', '--secret-id', 'other'])).toEqual({
      ok: true,
      value: { live: false, project: 'p', alias: 'test', secretId: 'other' },
    });
  });
});

describe('runProve dry-run', () => {
  it('refuses network and does not call the SM client', async () => {
    const client = mockLiveClient();
    const report = await runProve(
      { project: 'test-proj', live: false, alias: 'stromback' },
      client,
    );
    expect(report.mode).toBe('dry-run');
    expect(report.network).toBe(false);
    expect(report.parent).toBe('projects/test-proj/secrets/google-mcp-token-stromback');
    expect(report.version).toBeUndefined();
    expect(report.note).toBe(LIVE_NOT_FOR_THIS_PR);
    expect(client.accessLatestPayload).not.toHaveBeenCalled();
    expect(client.addSecretVersion).not.toHaveBeenCalled();
    expect(client.getSecretVersionMeta).not.toHaveBeenCalled();
  });
});

describe('runProve --live (injected client, no GCP)', () => {
  it('writes a version then reads name/createTime/etag only', async () => {
    const client = mockLiveClient();
    const report = await runProve(
      { project: 'test-proj', live: true, alias: 'test' },
      client,
    );
    expect(report.mode).toBe('live');
    expect(client.accessLatestPayload).toHaveBeenCalledTimes(1);
    expect(client.addSecretVersion).toHaveBeenCalledTimes(1);
    expect(client.getSecretVersionMeta).toHaveBeenCalledWith(
      'projects/test-proj/secrets/google-mcp-token-test/versions/12',
    );
    expect(report.version).toEqual({
      name: 'projects/test-proj/secrets/google-mcp-token-test/versions/12',
      createTime: '2026-09-11T11:00:00.000Z',
      etag: 'etag-12',
    });
    expect(JSON.stringify(report)).not.toContain(PLANTED);
    expect(JSON.stringify(report)).not.toMatch(/payload/i);
  });

  it('fails closed when addSecretVersion returns no name', async () => {
    const client = mockLiveClient();
    client.addSecretVersion.mockResolvedValueOnce({ name: undefined });
    await expect(
      runProve({ project: 'test-proj', live: true, alias: 'test' }, client),
    ).rejects.toThrow(/no version name/);
  });

  it('fails closed when latest payload is empty', async () => {
    const client = mockLiveClient();
    client.accessLatestPayload.mockResolvedValueOnce(Buffer.alloc(0));
    await expect(
      runProve({ project: 'test-proj', live: true, alias: 'test' }, client),
    ).rejects.toThrow(/no payload/);
  });

  it('fails closed when getSecretVersion meta has no name', async () => {
    const client = mockLiveClient();
    client.getSecretVersionMeta.mockResolvedValueOnce({ etag: 'e' } as never);
    await expect(
      runProve({ project: 'test-proj', live: true, alias: 'test' }, client),
    ).rejects.toThrow(/no name/);
  });
});

describe('runProveCli', () => {
  it('exits 1 without --project and does not mention a planted token', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runProveCli([], {
      log: (s) => logs.push(s),
      error: (s) => errors.push(s),
    });
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/Missing --project/);
    expect([...logs, ...errors].join('\n')).not.toContain(PLANTED);
  });

  it('dry-run prints parent and the not-for-this-PR note', async () => {
    const logs: string[] = [];
    const code = await runProveCli(['--project', 'test-proj', '--alias', 'stromback'], {
      log: (s) => logs.push(s),
      error: (s) => {
        throw new Error(s);
      },
    });
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/dry-run/);
    expect(out).toMatch(/projects\/test-proj\/secrets\/google-mcp-token-stromback/);
    expect(out).toMatch(/not for this pull request/);
    expect(out).not.toContain(PLANTED);
  });

  it('mocked --live stdout has metadata only', async () => {
    const logs: string[] = [];
    const client = mockLiveClient();
    const code = await runProveCli(
      ['--project', 'test-proj', '--alias', 'test', '--live'],
      {
        log: (s) => logs.push(s),
        error: (s) => {
          throw new Error(s);
        },
      },
      client,
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('etag-12');
    expect(out).toContain('versions/12');
    expect(out).not.toContain(PLANTED);
    expect(out).not.toMatch(/refresh_token/);
  });

  it('prints usage on --help and reports prove failures', async () => {
    const logs: string[] = [];
    expect(
      await runProveCli(['-h'], {
        log: (s) => logs.push(s),
        error: (s) => {
          throw new Error(s);
        },
      }),
    ).toBe(0);
    expect(logs.join('\n')).toContain(proveUsage().slice(0, 20));
    const errors: string[] = [];
    const client = mockLiveClient();
    client.accessLatestPayload.mockRejectedValueOnce(new Error('nope'));
    expect(
      await runProveCli(
        ['--project', 'test-proj', '--alias', 'test', '--live'],
        {
          log: () => {
            throw new Error('log');
          },
          error: (s) => errors.push(s),
        },
        client,
      ),
    ).toBe(1);
    expect(errors.join('\n')).toMatch(/Prove failed: nope/);
  });
});

describe('publicVersionMeta', () => {
  it('drops payload/data if a client leaks them', () => {
    const meta = publicVersionMeta({
      name: 'projects/p/secrets/google-mcp-token-test/versions/1',
      createTime: { seconds: 1700000000 },
      etag: 'e1',
      payload: { data: PLANTED },
      data: PLANTED,
    });
    expect(meta).toEqual({
      name: 'projects/p/secrets/google-mcp-token-test/versions/1',
      createTime: new Date(1700000000 * 1000).toISOString(),
      etag: 'e1',
    });
    expect(JSON.stringify(meta)).not.toContain(PLANTED);
  });

  it('stringifies Date-like createTime and ignores broken toISOString', () => {
    expect(
      publicVersionMeta({
        name: 'n',
        createTime: { toISOString: () => '2026-01-02T00:00:00.000Z' },
      }).createTime,
    ).toBe('2026-01-02T00:00:00.000Z');
    expect(
      publicVersionMeta({
        name: 'n',
        createTime: {
          toISOString: () => {
            throw new Error('bad date');
          },
        },
      }).createTime,
    ).toBeUndefined();
    expect(publicVersionMeta({ name: 'n', createTime: 'already' }).createTime).toBe('already');
    expect(publicVersionMeta({ name: 'n', createTime: 1 }).createTime).toBeUndefined();
  });

  it('assertNoPayloadInPublicMeta refuses extra keys', () => {
    expect(() =>
      assertNoPayloadInPublicMeta({ name: 'n', payload: PLANTED } as { name: string }),
    ).toThrow(/payload must never be printed/);
    expect(() =>
      assertNoPayloadInPublicMeta({ name: 'n', createTime: 't', etag: 'e' }),
    ).not.toThrow();
  });
});

describe('tokenSecretParentFromProject', () => {
  it('builds google-mcp-token-<alias> from the flag values only', () => {
    expect(tokenSecretParentFromProject('my-proj', 'stromback')).toBe(
      'projects/my-proj/secrets/google-mcp-token-stromback',
    );
  });

  it('fails closed on blank project or unsafe alias', () => {
    expect(() => tokenSecretParentFromProject('  ', 'test')).toThrow(/must be explicit/);
    expect(() => tokenSecretParentFromProject('p', '../x')).toThrow(/Invalid alias/);
  });
});

describe('CLI script spawn (dry-run only)', () => {
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../scripts/prove-google-mcp-token-secret.ts',
  );
  const tsxCli = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../node_modules/tsx/dist/cli.mjs',
  );

  it('exits non-zero without --project and does not spawn gcloud', () => {
    const result = spawnSync(process.execPath, [tsxCli, script, '--alias', 'test'], {
      encoding: 'utf8',
      env: { ...process.env, GOOGLE_CLOUD_PROJECT: 'must-not-be-used' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Missing --project/);
    expect(result.stderr).toMatch(/Do not use `gcloud config get-value project`/);
    expect(result.stderr).not.toContain('must-not-be-used');
  });

  it('dry-run with --project and --alias exits 0 and does not print a secret payload', () => {
    const result = spawnSync(
      process.execPath,
      [tsxCli, script, '--project', 'test-proj', '--alias', 'stromback'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/"mode": "dry-run"/);
    expect(result.stdout).toMatch(/google-mcp-token-stromback/);
    expect(result.stdout).toMatch(/not for this pull request/);
    expect(result.stdout).not.toMatch(/refresh_token/);
    expect(result.stdout).not.toContain(PLANTED);
  });
});

describe('createLiveProveClient via mocked SM SDK', () => {
  beforeEach(() => {
    accessSecretVersion.mockReset();
    addSecretVersion.mockReset();
    getSecretVersion.mockReset();
  });

  it('uses getSecretVersion metadata after addSecretVersion (no payload in report)', async () => {
    accessSecretVersion.mockResolvedValueOnce([
      { payload: { data: Buffer.from('{"v":1}', 'utf8') } },
    ]);
    addSecretVersion.mockResolvedValueOnce([
      { name: 'projects/test-proj/secrets/google-mcp-token-test/versions/3' },
    ]);
    getSecretVersion.mockResolvedValueOnce([
      {
        name: 'projects/test-proj/secrets/google-mcp-token-test/versions/3',
        createTime: '2026-09-11T00:00:00.000Z',
        etag: 'etag-3',
      },
    ]);

    const report = await runProve({ project: 'test-proj', live: true, alias: 'test' });
    expect(accessSecretVersion).toHaveBeenCalledTimes(1);
    expect(addSecretVersion).toHaveBeenCalledTimes(1);
    expect(getSecretVersion).toHaveBeenCalledWith({
      name: 'projects/test-proj/secrets/google-mcp-token-test/versions/3',
    });
    expect(report.version?.etag).toBe('etag-3');
    expect(JSON.stringify(report)).not.toContain(PLANTED);
  });

  it('fails closed when latest SDK payload or getSecretVersion name is missing', async () => {
    accessSecretVersion.mockResolvedValueOnce([{ payload: {} }] as never);
    await expect(
      runProve({ project: 'test-proj', live: true, alias: 'test' }),
    ).rejects.toThrow(/no payload/);

    accessSecretVersion.mockResolvedValueOnce([
      { payload: { data: Buffer.from('{"v":1}', 'utf8') } },
    ]);
    addSecretVersion.mockResolvedValueOnce([
      { name: 'projects/test-proj/secrets/google-mcp-token-test/versions/9' },
    ]);
    getSecretVersion.mockResolvedValueOnce([{ etag: 'e' }] as never);
    await expect(
      runProve({ project: 'test-proj', live: true, alias: 'test' }),
    ).rejects.toThrow(/no name/);
  });
});
