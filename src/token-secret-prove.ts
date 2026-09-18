/**
 * Fail-closed prove path for Secret Manager google-mcp-token-<alias>.
 *
 * Default is dry-run: no network. `--live` writes a new secret version
 * (byte-copy of latest so desk tokens are not clobbered) and reads back
 * version name / createTime / etag only. Never prints the payload.
 *
 * `--live` is not for this pull request. Do not run it until John says so.
 * Do not deploy. Do not remint Google accounts.
 *
 * Requires an explicit `--project` flag AND `--alias`. Never calls
 * `gcloud config get-value project`. Interim operator pin if a comment
 * must name a project: myflow-260730.
 */

export const GOOGLE_MCP_TOKEN_SECRET_PREFIX = 'google-mcp-token-';

export type PublicVersionMeta = {
  name?: string;
  createTime?: string;
  etag?: string;
};

export type TokenSecretProveClient = {
  accessLatestPayload(parent: string): Promise<Buffer>;
  addSecretVersion(parent: string, payload: Buffer): Promise<{ name?: string }>;
  getSecretVersionMeta(versionName: string): Promise<PublicVersionMeta>;
};

export type ProveParseOk = {
  help?: boolean;
  project?: string;
  live: boolean;
  alias?: string;
  secretId?: string;
};

export type ProveParseResult =
  | { ok: true; value: ProveParseOk }
  | { ok: false; error: string };

export const LIVE_NOT_FOR_THIS_PR =
  '--live is not for this pull request. Do not run until John says so. No Cloud Run deploy. No Google remint.';

export function proveUsage(): string {
  return `Usage:
  npm run prove:google-mcp-token-secret -- --project <gcp-project> --alias <alias>
  tsx scripts/prove-google-mcp-token-secret.ts --project <gcp-project> --alias <alias>

Default is dry-run (no network). An explicit --project flag is required;
this script does not read gcloud config, ADC default project, or GOOGLE_CLOUD_PROJECT.

  --project <id>   GCP project (required). Interim pin if a comment must name one: myflow-260730.
  --alias <alias>  Account alias (required). --account is accepted. Does not touch other aliases.
  --secret-id <id> Override secret id (default google-mcp-token-<alias>).
  --live           Write a new google-mcp-token-<alias> version and read metadata back.
                   NOT for this PR. Do not pass --live until John says so.

Read-back prints version name / createTime / etag only — never the secret payload.
`;
}

export function parseProveArgs(argv: string[]): ProveParseResult {
  const value: ProveParseOk = {
    live: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      return { ok: true, value: { ...value, help: true } };
    }
    if (a === '--live') {
      value.live = true;
      continue;
    }
    if (a === '--project') {
      value.project = (argv[++i] || '').trim();
      continue;
    }
    if (a.startsWith('--project=')) {
      value.project = a.slice('--project='.length).trim();
      continue;
    }
    if (a === '--alias' || a === '--account') {
      value.alias = (argv[++i] || '').trim();
      continue;
    }
    if (a.startsWith('--alias=')) {
      value.alias = a.slice('--alias='.length).trim();
      continue;
    }
    if (a.startsWith('--account=')) {
      value.alias = a.slice('--account='.length).trim();
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
      error: `Unknown argument: ${a}. This script does not take a gcloud default project.`,
    };
  }
  if (value.help) return { ok: true, value };
  if (!value.project) {
    return {
      ok: false,
      error:
        'Missing --project. Pass an explicit GCP project flag. ' +
        'Do not use `gcloud config get-value project`. ' +
        'Interim operator pin if a comment must name a project: myflow-260730.',
    };
  }
  if (!value.alias) {
    return {
      ok: false,
      error: 'Missing --alias. Pass one account alias (or --account). Do not prove other aliases.',
    };
  }
  return { ok: true, value };
}

export function tokenSecretParentFromProject(
  project: string,
  alias: string,
  secretIdOverride?: string,
): string {
  const p = project.trim();
  if (!p) {
    throw new Error('GCP project must be explicit; refusing Secret Manager prove.');
  }
  const override = (secretIdOverride || '').trim();
  const aliasSafe = alias.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(aliasSafe)) {
    throw new Error('Invalid alias; refusing Secret Manager prove.');
  }
  if (override && !/^[a-zA-Z0-9_-]+$/.test(override)) {
    throw new Error('Invalid --secret-id; refusing Secret Manager prove.');
  }
  const secretId = override || `${GOOGLE_MCP_TOKEN_SECRET_PREFIX}${aliasSafe}`;
  return `projects/${p}/secrets/${secretId}`;
}

export function publicVersionMeta(raw: {
  name?: string | null;
  createTime?: unknown;
  etag?: string | null;
  payload?: unknown;
  data?: unknown;
}): PublicVersionMeta {
  return {
    name: raw.name ?? undefined,
    createTime: timestampToString(raw.createTime),
    etag: raw.etag ?? undefined,
  };
}

function timestampToString(t: unknown): string | undefined {
  if (t == null) return undefined;
  if (typeof t === 'string') return t;
  if (typeof t === 'object') {
    const rec = t as { seconds?: unknown; toISOString?: () => string };
    if (typeof rec.toISOString === 'function') {
      try {
        return rec.toISOString();
      } catch {
        /* fall through */
      }
    }
    if (rec.seconds != null) {
      const seconds = Number(rec.seconds);
      if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString();
    }
  }
  return undefined;
}

export function assertNoPayloadInPublicMeta(meta: PublicVersionMeta): void {
  const keys = Object.keys(meta);
  for (const k of keys) {
    if (k !== 'name' && k !== 'createTime' && k !== 'etag') {
      throw new Error(`Refusing to report Secret Manager field "${k}"; payload must never be printed.`);
    }
  }
}

export type ProveReport = {
  mode: 'dry-run' | 'live';
  live: boolean;
  network: boolean;
  parent: string;
  alias: string;
  version?: PublicVersionMeta;
  would?: string[];
  note: string;
};

export async function runProve(
  args: ProveParseOk,
  client?: TokenSecretProveClient,
): Promise<ProveReport> {
  if (args.help) {
    throw new Error('internal: help should be handled by the CLI');
  }
  if (!args.project) {
    throw new Error('Missing --project');
  }
  if (!args.alias) {
    throw new Error('Missing --alias');
  }
  const parent = tokenSecretParentFromProject(args.project, args.alias, args.secretId);
  const note = LIVE_NOT_FOR_THIS_PR;

  if (!args.live) {
    return {
      mode: 'dry-run',
      live: false,
      network: false,
      parent,
      alias: args.alias,
      would: [
        'accessSecretVersion latest (payload held in memory only, never printed)',
        'addSecretVersion (byte-copy of latest; does not remint Google tokens or read desk *.enc)',
        'getSecretVersion metadata only (name, createTime, etag)',
      ],
      note,
    };
  }

  const sm = client ?? (await createLiveProveClient());
  const payload = await sm.accessLatestPayload(parent);
  if (!payload || payload.length === 0) {
    throw new Error('latest google-mcp-token-* version has no payload; refusing write');
  }
  const added = await sm.addSecretVersion(parent, payload);
  if (!added.name) {
    throw new Error('addSecretVersion returned no version name; refusing to treat persist as proved');
  }
  const version = publicVersionMeta(await sm.getSecretVersionMeta(added.name));
  assertNoPayloadInPublicMeta(version);
  if (!version.name) {
    throw new Error('getSecretVersion returned no name; fail-closed');
  }
  return {
    mode: 'live',
    live: true,
    network: client ? false : true,
    parent,
    alias: args.alias,
    version,
    note,
  };
}

export async function createLiveProveClient(): Promise<TokenSecretProveClient> {
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const sm = new SecretManagerServiceClient();
  return {
    async accessLatestPayload(parent: string): Promise<Buffer> {
      const [resp] = await sm.accessSecretVersion({
        name: `${parent}/versions/latest`,
      });
      const data = resp.payload?.data;
      if (!data) {
        throw new Error('latest google-mcp-token-* version has no payload; refusing write');
      }
      return Buffer.from(data as Uint8Array);
    },
    async addSecretVersion(parent: string, payload: Buffer): Promise<{ name?: string }> {
      const [version] = await sm.addSecretVersion({
        parent,
        payload: { data: payload },
      });
      return { name: version?.name ?? undefined };
    },
    async getSecretVersionMeta(versionName: string): Promise<PublicVersionMeta> {
      const [version] = await sm.getSecretVersion({ name: versionName });
      return publicVersionMeta(version);
    },
  };
}

export async function runProveCli(
  argv: string[],
  io: { log: (s: string) => void; error: (s: string) => void } = {
    log: (s) => console.log(s),
    error: (s) => console.error(s),
  },
  client?: TokenSecretProveClient,
): Promise<number> {
  const parsed = parseProveArgs(argv);
  if (!parsed.ok) {
    io.error(parsed.error);
    io.error(proveUsage());
    return 1;
  }
  if (parsed.value.help) {
    io.log(proveUsage());
    return 0;
  }
  try {
    const report = await runProve(parsed.value, client);
    io.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.error(`Prove failed: ${message}`);
    return 1;
  }
}
