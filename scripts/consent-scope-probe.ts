/**
 * Print the Google consent scope matrix for this tree.
 * Run with tsx from a checkout. Does not open a browser or read a grants file.
 */
import { resolveScopesForAccount } from '../src/auth.js';
import type { AccountSet } from '../src/accounts.js';
import { ADMIN_SCOPES, BUNDLE_CATALOG } from '../src/scope-catalog.js';
import { isHostedHttp } from '../src/hosted.js';
import { ownerAuthUrlOptions } from '../src/oauth-consent.js';
import { validateAddForm } from '../src/tools/account-wizard.js';

const EMAILS = {
  personal: 'me@gmail.com',
  workspace: 'me@corp.example',
  external: 'me@other.example',
} as const;

function accountSet(email: string, profile: { bundles: string[]; admin?: boolean }): AccountSet {
  return {
    aliases: ['a'],
    configs: {
      a: {
        email,
        tokenPath: '/nonexistent/a/token.json',
        encPath: '/nonexistent/a.enc',
        source: 'config',
        scopeProfile: 'p',
        ...(profile.admin ? { admin: true } : {}),
      },
    },
    scopeProfiles: {
      base: { bundles: [] },
      p: { bundles: profile.bundles, ...(profile.admin ? { admin: true } : {}) },
    },
    source: 'file',
    stamp: 'probe',
  };
}

delete process.env.GOOGLE_OPTIONAL_SCOPES;
delete process.env.GOOGLE_ADMIN_ACCOUNTS;
delete process.env.MCP_HOSTED;
delete process.env.K_SERVICE;

const profiles: Array<{ name: string; bundles: string[]; admin?: boolean }> = [
  { name: 'base', bundles: [] },
  { name: 'admin', bundles: [], admin: true },
  ...Object.keys(BUNDLE_CATALOG)
    .filter((name) => name !== 'admin')
    .map((name) => ({ name, bundles: [name] })),
];

const homes: Array<string | undefined> = [undefined, 'corp.example'];
const rows: unknown[] = [];

for (const [mode, email] of Object.entries(EMAILS)) {
  for (const home of homes) {
    if (home) process.env.GOOGLE_HOME_DOMAINS = home;
    else delete process.env.GOOGLE_HOME_DOMAINS;
    const added = validateAddForm({ alias: 'new', email, allBundles: true }, []);
    if (!added.ok) throw new Error(`allBundles form refused for ${mode} home=${home ?? ''}: ${added.message}`);
    for (const profile of profiles) {
      const scopes = resolveScopesForAccount('a', accountSet(email, profile));
      const scopeList = (opts: { scope?: string | string[] } | undefined): string[] => {
        const scope = opts?.scope;
        if (scope === undefined) return [];
        return Array.isArray(scope) ? scope : [scope];
      };
      rows.push({
        mode,
        email,
        home: home ?? '',
        profile: profile.name,
        hostedCli: isHostedHttp({ MCP_HOSTED: '1' }) ? 'refused' : scopes,
        deskCli: scopes,
        aliasReauth: scopeList(
          ownerAuthUrlOptions({ flow: 'alias_reauth', alias: 'a', state: 'probe' }, () => scopes),
        ),
        ownerLogin: scopeList(ownerAuthUrlOptions({ flow: 'login', state: 'probe' }, () => scopes)),
        allBundles: added.bundles,
      });
    }
  }
}

const report = {
  bundles: Object.fromEntries(
    Object.entries(BUNDLE_CATALOG).map(([name, entry]) => [
      name,
      { scopes: entry.scopes, orgOnly: entry.orgOnly === true, workspaceOnly: entry.workspaceOnly === true },
    ]),
  ),
  admin: ADMIN_SCOPES,
  rows,
};

process.stdout.write(`${JSON.stringify(report)}\n`);
