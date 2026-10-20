import path from 'node:path';
import { buildRegistry } from '../src/compose.js';
import { invalidateAccountSet } from '../src/accounts.js';
import { buildIdentityContext, isOwnerContext } from '../src/identity.js';
import { connectTimeDiscoveryMode, type Cud } from '../src/registry.js';
import {
  allowedAccounts,
  clearSessionGrant,
  loadGrantsFile,
  resetGrantsFileCache,
  resolveGrantByName,
  runWithGrant,
} from '../src/session-grant.js';
import { isAllowed, WRITE_PROFILES, type Policy, type Profile } from '../src/write-control.js';

/**
 * Hosted connect-time surface, built the way Cloud Run does: owner
 * `buildIdentityContext({transport:'http'})`, `connectTimeDiscoveryMode()`,
 * grants resolved by `resolveGrantByName` + `allowedAccounts` (not copied
 * from one grant onto another). One row per grant × tool × profile.
 *
 * The committed fixture is this reviewed surface, not the d656bec dump.
 * Equality fails when a tool is newly registered, newly listed, or newly
 * callable. The four deltas from d656bec are named in REVIEWED_DELTAS so
 * that edit stays visible; a side allowlist could hide the next new name.
 */
export const REVIEWED_DELTAS = [
  {
    tool: 'calendar_respond_event',
    change: 'listed at connect; absent at d656bec',
    why: 'Upstream curated RSVP (cud update). Denied under the read-only Cloud Run default. Allowed under safe-writes and full-writes. Reviewed; it does not widen the read-only allow-set.',
  },
  {
    tool: 'gmail_delete_draft',
    change: 'listed at connect; absent at d656bec',
    why: 'Curated irreversible draft delete. Denied under read-only and safe-writes. Allowed only under full-writes. Replaces the generated tool below.',
  },
  {
    tool: 'sheets_copy_sheet_to',
    change: 'listed at connect; absent at d656bec',
    why: 'Curated create. Denied under the read-only default. Allowed under safe-writes and full-writes. Reviewed; it does not widen the read-only allow-set.',
  },
  {
    tool: 'gmail_users_drafts_delete',
    change: 'removed from the registry',
    why: 'Generated twin replaced by gmail_delete_draft. It was hidden and denied under read-only and safe-writes. A reappearance fails this snapshot.',
  },
] as const;

const HOSTED_ACCOUNTS =
  'personal:personal@example.com,stromback:stromback@example.com,opcenter:opcenter@example.com,buildcoin:buildcoin@example.com,usa-house:usa-house@example.com,olga:olga@example.com';

const ENV_KEYS = [
  'GOOGLE_ACCOUNTS',
  'MCP_HOSTED',
  'GOOGLE_GRANTS_PATH',
  'GOOGLE_GRANTS_ENFORCE',
  'GOOGLE_GRANT_CODE',
  'GOOGLE_PROFILE',
  'GOOGLE_WRITE_ALLOW',
  'GOOGLE_WRITE_DENY',
  'GOOGLE_READ_ONLY',
  'GOOGLE_TOOLSETS',
  'GOOGLE_DISCOVERY',
  'GOOGLE_OPTIONAL_SCOPES',
  'GOOGLE_ADMIN_ACCOUNTS',
] as const;

export interface SurfaceRow {
  grant: string;
  accounts: string[];
  profile: Profile;
  tool: string;
  cud: Cud;
  callable: boolean;
  listed: boolean;
}

export interface SurfaceTool {
  name: string;
  cud: Cud;
  destructive: boolean;
  listed: boolean;
}

export interface BuiltSurface {
  mode: string;
  grants: { name: string; accounts: string[] }[];
  rows: SurfaceRow[];
  tools: SurfaceTool[];
}

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function buildHostedGrantSurface(): BuiltSurface {
  const saved = snapshotEnv();
  try {
    process.env.GOOGLE_ACCOUNTS = HOSTED_ACCOUNTS;
    process.env.MCP_HOSTED = '1';
    process.env.GOOGLE_GRANTS_PATH = path.join(process.cwd(), 'grants.example.json');
    process.env.GOOGLE_GRANTS_ENFORCE = 'true';
    delete process.env.GOOGLE_GRANT_CODE;
    delete process.env.GOOGLE_PROFILE;
    delete process.env.GOOGLE_WRITE_ALLOW;
    delete process.env.GOOGLE_WRITE_DENY;
    delete process.env.GOOGLE_READ_ONLY;
    delete process.env.GOOGLE_TOOLSETS;
    delete process.env.GOOGLE_DISCOVERY;
    delete process.env.GOOGLE_OPTIONAL_SCOPES;
    delete process.env.GOOGLE_ADMIN_ACCOUNTS;
    invalidateAccountSet();
    resetGrantsFileCache();
    clearSessionGrant();

    const file = loadGrantsFile(true);
    if (!file) throw new Error('grants.example.json did not load');
    for (const grant of file.grants) {
      if (grant.code !== 'REPLACE_WITH_HOST_LOCAL_CODE') {
        throw new Error(`grant ${grant.name} does not use the placeholder code`);
      }
    }

    const ctx = buildIdentityContext(process.env, { transport: 'http' });
    if (!isOwnerContext(ctx)) throw new Error('hosted build did not produce an owner context');
    if (ctx.policy.profile !== 'read-only' || ctx.policy.allow.length !== 0 || ctx.policy.deny.length !== 0) {
      throw new Error(`hosted policy is not the Cloud Run default: ${ctx.policy.profile}`);
    }
    const mode = connectTimeDiscoveryMode(process.env);
    if (mode !== 'curated') throw new Error(`connect-time discovery mode is ${mode}`);
    const server = {
      registerTool: () => 'ok',
      sendToolListChanged: () => {},
      server: { setRequestHandler: () => {}, getClientCapabilities: () => undefined },
    };
    const registry = buildRegistry(server as never, ctx, mode);

    const grants: BuiltSurface['grants'] = [];
    const rows: SurfaceRow[] = [];
    for (const rec of file.grants) {
      const resolved = resolveGrantByName(rec.name);
      if (!resolved) throw new Error(`grant ${rec.name} did not resolve`);
      const accounts = runWithGrant(resolved, () => allowedAccounts());
      grants.push({ name: resolved.name, accounts: [...accounts] });
      for (const profile of WRITE_PROFILES) {
        const policy: Policy = { profile, readOnly: false, allow: [], deny: [] };
        for (const tool of registry.tools) {
          rows.push({
            grant: resolved.name,
            accounts: [...accounts],
            profile,
            tool: tool.name,
            cud: tool.cud,
            callable: isAllowed(
              { name: tool.name, service: tool.service, cud: tool.cud, scopes: tool.requiredScopes },
              policy,
            ),
            listed: registry.isVisible(tool),
          });
        }
      }
    }

    const tools: SurfaceTool[] = registry.tools.map((tool) => ({
      name: tool.name,
      cud: tool.cud,
      destructive: tool.annotations.destructiveHint === true,
      listed: registry.isVisible(tool),
    }));
    return { mode, grants, rows, tools };
  } finally {
    clearSessionGrant();
    restoreEnv(saved);
    invalidateAccountSet();
    resetGrantsFileCache();
  }
}

export function surfaceDrift(actual: SurfaceRow[], expected: SurfaceRow[]): string[] {
  const key = (row: SurfaceRow) => `${row.grant}\t${row.profile}\t${row.tool}`;
  const got = new Map(actual.map((row) => [key(row), row]));
  const want = new Map(expected.map((row) => [key(row), row]));
  const lines: string[] = [];
  for (const [id, row] of got) {
    const prev = want.get(id);
    if (!prev) {
      lines.push(`added ${id} callable=${row.callable} listed=${row.listed} cud=${row.cud}`);
      continue;
    }
    if (prev.callable !== row.callable || prev.listed !== row.listed || prev.cud !== row.cud) {
      lines.push(
        `changed ${id} callable ${prev.callable}->${row.callable} listed ${prev.listed}->${row.listed} cud ${prev.cud}->${row.cud}`,
      );
    }
    if (prev.accounts.join(',') !== row.accounts.join(',')) {
      lines.push(`accounts ${id} ${prev.accounts.join(',')} -> ${row.accounts.join(',')}`);
    }
  }
  for (const id of want.keys()) {
    if (!got.has(id)) lines.push(`removed ${id}`);
  }
  return lines;
}
