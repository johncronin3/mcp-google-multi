import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OAuth2Client } from 'googleapis-common';
import { attachRefreshPersist } from '../src/client.js';
import { setTokenSecretWriterForTests } from '../src/token-secret.js';
import { ACCOUNT_CONFIG } from '../src/accounts.js';
import {
  readToken,
  resetTokenOverlayForTests,
  snapshotEncFile,
  writeToken,
} from '../src/token-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = 'test-master-key-client-refresh';
const OLD = 'refresh-old-client-do-not-print';
const NEW = 'refresh-new-client-do-not-print';
const sample = {
  refresh_token: OLD,
  access_token: 'a-old',
  scope: 's',
  expiry_date: 1,
  token_type: 'Bearer',
};

const originalPath = ACCOUNT_CONFIG.test.encPath;

type RefreshHook = {
  refreshTokenNoCache: (t?: string | null) => Promise<{ tokens: object }>;
};

describe('attachRefreshPersist', () => {
  let tmp: string;
  const prevHosted = process.env.MCP_HOSTED;
  const prevKey = process.env.MASTER_KEY;
  const prevProject = process.env.GOOGLE_CLOUD_PROJECT;
  const prevK = process.env.K_SERVICE;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'google-client-refresh-'));
    ACCOUNT_CONFIG.test.encPath = path.join(tmp, 'test.enc');
    process.env.MASTER_KEY = KEY;
    process.env.GOOGLE_CLOUD_PROJECT = 'test-proj';
    process.env.MCP_HOSTED = 'true';
    process.env.K_SERVICE = 'google-multi-mcp';
    resetTokenOverlayForTests();
    writeToken('test', sample);
  });

  afterEach(() => {
    setTokenSecretWriterForTests(undefined);
    resetTokenOverlayForTests();
    ACCOUNT_CONFIG.test.encPath = originalPath;
    if (prevHosted === undefined) delete process.env.MCP_HOSTED;
    else process.env.MCP_HOSTED = prevHosted;
    if (prevKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = prevKey;
    if (prevProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = prevProject;
    if (prevK === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = prevK;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('persists via SM before adopting credentials and reverts the client on SM failure', async () => {
    const prior = snapshotEncFile('test')!;
    setTokenSecretWriterForTests(async () => {
      throw new Error('PERMISSION_DENIED');
    });

    const client = new OAuth2Client('id', 'secret', 'http://localhost:4242/oauth2callback');
    client.setCredentials(sample);
    const hook = client as unknown as RefreshHook;
    hook.refreshTokenNoCache = async () => ({
      tokens: { refresh_token: NEW, access_token: 'a-new', expiry_date: 9 },
    });
    attachRefreshPersist(client, 'test');

    await expect(hook.refreshTokenNoCache(OLD)).rejects.toThrow(/google-mcp-token-test failed/);
    expect(client.credentials.refresh_token).toBe(OLD);
    expect(snapshotEncFile('test')?.equals(prior)).toBe(true);
    expect(readToken('test')?.refresh_token).toBe(OLD);
  });

  it('adopts overlay after SM success without writing local', async () => {
    const prior = snapshotEncFile('test')!;
    const writes: { parent: string }[] = [];
    setTokenSecretWriterForTests(async (args) => {
      writes.push({ parent: args.parent });
      return { versionName: 'v-client' };
    });

    const client = new OAuth2Client('id', 'secret', 'http://localhost:4242/oauth2callback');
    client.setCredentials(sample);
    const hook = client as unknown as RefreshHook;
    hook.refreshTokenNoCache = async () => ({
      tokens: { refresh_token: NEW, access_token: 'a-new', expiry_date: 9 },
    });
    attachRefreshPersist(client, 'test');

    await hook.refreshTokenNoCache(OLD);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.parent).toBe('projects/test-proj/secrets/google-mcp-token-test');
    expect(snapshotEncFile('test')?.equals(prior)).toBe(true);
    expect(readToken('test')?.refresh_token).toBe(NEW);
  });
});
