/**
 * Fail-closed desk → Secret Manager writer for per-alias encrypted `*.enc` files.
 * Hosted Cloud Run mounts `google-mcp-token-<alias>` (see docs/hosted-mcp.md).
 * Never logs token / enc payload / MASTER_KEY. See docs/internals.md.
 */

import { ACCOUNTS, ACCOUNT_CONFIG } from './accounts.js';
import { isHostedHttp } from './hosted.js';
import { restoreEncFile, snapshotEncFile, writeToken } from './token-store.js';

export const GOOGLE_MCP_TOKEN_SECRET_PREFIX = 'google-mcp-token-';

const ALIAS_RE = /^[a-zA-Z0-9_-]+$/;

export type TokenSecretWriter = (args: {
  parent: string;
  payload: Buffer;
}) => Promise<{ versionName?: string } | void>;

let testWriter: TokenSecretWriter | undefined;

/** Test seam — never used in production. */
export function setTokenSecretWriterForTests(writer?: TokenSecretWriter): void {
  testWriter = writer;
}

export function envFlagTruthy(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function wantsSmUpload(argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes('--upload-sm') || envFlagTruthy(env.GOOGLE_UPLOAD_SM) || envFlagTruthy(env.GOOGLE_SM_UPLOAD);
}

export function parseNamedFlag(argv: string[], name: string): string | undefined {
  const eq = `${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      const next = (argv[i + 1] ?? '').trim();
      return next || undefined;
    }
    if (a.startsWith(eq)) {
      const v = a.slice(eq.length).trim();
      return v || undefined;
    }
  }
  return undefined;
}

export function explicitGcpProject(env: NodeJS.ProcessEnv = process.env): string {
  const project =
    (env.GOOGLE_CLOUD_PROJECT || '').trim() ||
    (env.GCP_PROJECT || '').trim();
  if (!project) {
    throw new Error(
      'GCP project must be set explicitly via --project / GOOGLE_CLOUD_PROJECT / GCP_PROJECT. ' +
        'Do not rely on gcloud application-default project. ' +
        'Do not call `gcloud config get-value project`. ' +
        'Interim operator pin when a comment must name a project: myflow-260730 (do not deploy from this change).',
    );
  }
  return project;
}

export function assertSafeAlias(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed || !ALIAS_RE.test(trimmed)) {
    throw new Error(
      'Invalid alias. Allowed characters: letters, digits, underscore, hyphen. ' +
        'Refusing Secret Manager write.',
    );
  }
  return trimmed;
}

export function secretIdForAlias(alias: string, secretIdOverride?: string): string {
  const override = (secretIdOverride ?? '').trim();
  if (override) {
    if (!/^[a-zA-Z0-9_-]+$/.test(override)) {
      throw new Error('Invalid --secret-id; refusing Secret Manager write.');
    }
    return override;
  }
  return `${GOOGLE_MCP_TOKEN_SECRET_PREFIX}${assertSafeAlias(alias)}`;
}

export function tokenSecretParent(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
  secretIdOverride?: string,
): string {
  const project = explicitGcpProject(env);
  const secretId = secretIdForAlias(alias, secretIdOverride);
  return `projects/${project}/secrets/${secretId}`;
}

/** v1 AES-GCM envelope only — never decrypts, never logs iv/tag/data. */
export function assertEncFileShape(bytes: Buffer): void {
  if (!bytes || bytes.length === 0) {
    throw new Error('desk token file is empty; refusing Secret Manager write');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('desk token file is not JSON; refusing Secret Manager write of google-mcp-token-*');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('desk token file is not a v1 AES-GCM enc envelope; refusing Secret Manager write');
  }
  const rec = parsed as { v?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
  if (rec.v !== 1 || typeof rec.iv !== 'string' || typeof rec.tag !== 'string' || typeof rec.data !== 'string') {
    throw new Error('desk token file is not a v1 AES-GCM enc envelope; refusing Secret Manager write');
  }
  if (!rec.iv || !rec.tag || !rec.data) {
    throw new Error('desk token file is missing envelope fields; refusing Secret Manager write');
  }
}

export function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/MASTER_KEY\s*=\s*\S+/gi, 'MASTER_KEY=<redacted>')
    .replace(/refresh_token":\s*"[^"]*"/gi, 'refresh_token":"<redacted>"')
    .replace(/access_token":\s*"[^"]*"/gi, 'access_token":"<redacted>"');
}

async function addSecretVersion(parent: string, payload: Buffer, writer?: TokenSecretWriter): Promise<string> {
  const run = writer ?? testWriter;
  if (run) {
    const result = await run({ parent, payload });
    const versionName = result?.versionName;
    if (!versionName) {
      throw new Error('addSecretVersion returned no version name; refusing to treat persist as complete');
    }
    return versionName;
  }

  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const [version] = await client.addSecretVersion({
    parent,
    payload: { data: payload },
  });
  const versionName = version?.name ?? undefined;
  if (!versionName) {
    throw new Error('addSecretVersion returned no version name; refusing to treat persist as complete');
  }
  return versionName;
}

export type PersistResult = {
  parent: string;
  versionName: string;
  alias: string;
  secretId: string;
  reverted: boolean;
};

/**
 * Upload the current desk `*.enc` for one alias. Does not write the desk file.
 * Fail-closed: missing project / missing file / SM error → throw. No revert
 * (this path did not update the desk file).
 */
export async function persistEncFileToSecretManager(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { secretId?: string; writer?: TokenSecretWriter } = {},
): Promise<PersistResult> {
  const safeAlias = assertSafeAlias(alias);
  const parent = tokenSecretParent(safeAlias, env, opts.secretId);
  const bytes = snapshotEncFile(safeAlias);
  if (!bytes) {
    throw new Error(
      `No desk token file for alias "${safeAlias}". Mint with auth --account, then retry upload-sm.`,
    );
  }
  assertEncFileShape(bytes);
  const versionName = await addSecretVersion(parent, bytes, opts.writer);
  return {
    parent,
    versionName,
    alias: safeAlias,
    secretId: secretIdForAlias(safeAlias, opts.secretId),
    reverted: false,
  };
}

/**
 * Desk remint transaction: snapshot prior bytes → writeToken → SM version.
 * SM failure reverts the desk file when a prior file existed. See docs/internals.md.
 */
export async function writeTokenAndUploadSm(
  alias: string,
  tokens: object,
  env: NodeJS.ProcessEnv = process.env,
  opts: { secretId?: string; writer?: TokenSecretWriter } = {},
): Promise<PersistResult> {
  const safeAlias = assertSafeAlias(alias);
  // Resolve project before touching the desk file so a missing project cannot
  // count as a completed remint.
  const parent = tokenSecretParent(safeAlias, env, opts.secretId);
  const prior = snapshotEncFile(safeAlias);
  writeToken(safeAlias, tokens);
  try {
    const bytes = snapshotEncFile(safeAlias);
    if (!bytes) {
      throw new Error('desk token file missing after write; refusing Secret Manager write');
    }
    assertEncFileShape(bytes);
    const versionName = await addSecretVersion(parent, bytes, opts.writer);
    return {
      parent,
      versionName,
      alias: safeAlias,
      secretId: secretIdForAlias(safeAlias, opts.secretId),
      reverted: false,
    };
  } catch (err) {
    let reverted = false;
    if (prior) {
      restoreEncFile(safeAlias, prior);
      reverted = true;
    }
    const message = safeErrorMessage(err);
    throw new Error(
      `Secret Manager write failed; remint incomplete.${reverted ? ' Desk *.enc reverted to prior bytes.' : ' No prior desk file to revert.'} ${message}`,
      { cause: err },
    );
  }
}

export type UploadParseOk = {
  help?: boolean;
  account?: string;
  project?: string;
  secretId?: string;
};

export type UploadParseResult =
  | { ok: true; value: UploadParseOk }
  | { ok: false; error: string };

export function uploadSmUsage(): string {
  return `Usage:
  mcp-google-multi upload-sm --account <alias> --project <gcp-project>
  npm run upload-sm -- --account <alias> --project <gcp-project>

Uploads the current desk *.enc for ONE alias to Secret Manager
google-mcp-token-<alias>. Fail-closed: SM error exits non-zero.
Does not remint Google OAuth. Does not touch other aliases.

  --account <alias>   GOOGLE_ACCOUNTS alias (required). --alias is accepted.
  --project <id>      GCP project (required unless GOOGLE_CLOUD_PROJECT / GCP_PROJECT).
                      Never uses gcloud config / ADC default project.
                      Interim pin if a comment must name one: myflow-260730.
  --secret-id <id>    Override secret id (default google-mcp-token-<alias>).

Never prints token / enc / MASTER_KEY. Success prints version name only.
Hosted Cloud Run still needs a remount after the version bump.
`;
}

export function parseUploadSmArgs(argv: string[]): UploadParseResult {
  const value: UploadParseOk = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      return { ok: true, value: { ...value, help: true } };
    }
    if (a === '--live' || a === '--upload-sm') {
      continue;
    }
    if (a === '--account' || a === '--alias') {
      value.account = (argv[++i] || '').trim() || undefined;
      continue;
    }
    if (a.startsWith('--account=')) {
      value.account = a.slice('--account='.length).trim() || undefined;
      continue;
    }
    if (a.startsWith('--alias=')) {
      value.account = a.slice('--alias='.length).trim() || undefined;
      continue;
    }
    if (a === '--project') {
      value.project = (argv[++i] || '').trim() || undefined;
      continue;
    }
    if (a.startsWith('--project=')) {
      value.project = a.slice('--project='.length).trim() || undefined;
      continue;
    }
    if (a === '--secret-id') {
      value.secretId = (argv[++i] || '').trim() || undefined;
      continue;
    }
    if (a.startsWith('--secret-id=')) {
      value.secretId = a.slice('--secret-id='.length).trim() || undefined;
      continue;
    }
    return {
      ok: false,
      error: `Unknown argument: ${a}. This command does not take a gcloud default project.`,
    };
  }
  if (value.help) return { ok: true, value };
  if (!value.account) {
    return { ok: false, error: 'Missing --account. Pass one GOOGLE_ACCOUNTS alias. Do not upload other aliases.' };
  }
  return { ok: true, value };
}

export type UploadReport = {
  parent: string;
  versionName: string;
  alias: string;
  secretId: string;
};

export async function runUploadSmCli(
  argv: string[],
  io: { log: (s: string) => void; error: (s: string) => void } = {
    log: (s) => console.log(s),
    error: (s) => console.error(s),
  },
  env: NodeJS.ProcessEnv = process.env,
  writer?: TokenSecretWriter,
): Promise<number> {
  if (isHostedHttp(env)) {
    io.error('Hosted mode refuses desk Secret Manager upload. Mint and upload-sm on a desk.');
    return 1;
  }

  const parsed = parseUploadSmArgs(argv);
  if (!parsed.ok) {
    io.error(parsed.error);
    io.error(uploadSmUsage());
    return 1;
  }
  if (parsed.value.help) {
    io.log(uploadSmUsage());
    return 0;
  }

  const alias = parsed.value.account!;
  if (!ACCOUNTS.includes(alias)) {
    io.error(`Unknown account "${alias}". Valid aliases: ${ACCOUNTS.join(', ')}`);
    return 1;
  }
  if (!ACCOUNT_CONFIG[alias]) {
    io.error(`Unknown account "${alias}".`);
    return 1;
  }

  const project = parsed.value.project?.trim() || '';
  const effectiveEnv: NodeJS.ProcessEnv = { ...env };
  if (project) {
    effectiveEnv.GOOGLE_CLOUD_PROJECT = project;
  }

  try {
    explicitGcpProject(effectiveEnv);
  } catch (err) {
    io.error(safeErrorMessage(err));
    io.error(uploadSmUsage());
    return 1;
  }

  try {
    const result = await persistEncFileToSecretManager(alias, effectiveEnv, {
      secretId: parsed.value.secretId,
      writer,
    });
    const report: UploadReport = {
      parent: result.parent,
      versionName: result.versionName,
      alias: result.alias,
      secretId: result.secretId,
    };
    io.log(JSON.stringify(report, null, 2));
    io.log('Desk→SM upload complete. Hosted Cloud Run still needs a remount before it serves this version.');
    return 0;
  } catch (err) {
    io.error(`upload-sm failed: ${safeErrorMessage(err)}`);
    return 1;
  }
}

/** Env overlay so auth --project reaches explicitGcpProject. */
export function envWithProjectFlag(argv: string[], env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const project = parseNamedFlag(argv, '--project');
  if (!project) return env;
  return { ...env, GOOGLE_CLOUD_PROJECT: project };
}

export function resolveAuthUploadProject(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  return explicitGcpProject(envWithProjectFlag(argv, env));
}
