/**
 * Side-by-side Google consent scopes at fe6161d and at this tree.
 * Executes both copies. Fixture emails only. No grants file and no token.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const OLD = 'fe6161d85d7c28c8d8ebb8956467722590c049f4';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(REPO, 'scripts', 'consent-scope-probe.ts');

const KEEP = 'https://www.googleapis.com/auth/keep';
const CLOUD_IDENTITY = [
  'https://www.googleapis.com/auth/cloud-identity.groups',
  'https://www.googleapis.com/auth/cloud-identity.devices',
];
const DIRECTORY = 'https://www.googleapis.com/auth/directory.readonly';
const NOT_ON_DEFAULT = [KEEP, ...CLOUD_IDENTITY, DIRECTORY];

interface BundleInfo {
  scopes: string[];
  orgOnly: boolean;
  workspaceOnly: boolean;
}
interface Row {
  mode: string;
  email: string;
  home: string;
  profile: string;
  hostedCli: 'refused' | string[];
  deskCli: string[];
  aliasReauth: string[];
  ownerLogin: string[];
  allBundles: string[];
}
interface Report {
  bundles: Record<string, BundleInfo>;
  admin: string[];
  rows: Row[];
}

function runProbe(cwd: string): Report {
  const xdg = mkdtempSync(path.join(tmpdir(), 'consent-probe-xdg-'));
  const out = execFileSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(cwd, 'scripts', 'consent-scope-probe.ts')], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GOOGLE_ACCOUNTS: 'a:me@example.com',
      GOOGLE_GRANTS_ENFORCE: 'false',
      XDG_CONFIG_HOME: xdg,
      TOKEN_STORE_PATH: path.join(xdg, 'tokens'),
      GOOGLE_OPTIONAL_SCOPES: '',
      GOOGLE_HOME_DOMAINS: '',
      MCP_HOSTED: '',
      K_SERVICE: '',
    },
  });
  rmSync(xdg, { recursive: true, force: true });
  return JSON.parse(out) as Report;
}

function archiveOld(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'consent-fe6161d-'));
  const tarPath = path.join(dir, 'src.tar');
  execFileSync('git', ['archive', `--output=${tarPath}`, OLD, 'src'], { cwd: REPO });
  execFileSync('tar', ['-x', '-C', dir, '-f', tarPath]);
  rmSync(tarPath);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  cpSync(PROBE, path.join(dir, 'scripts', 'consent-scope-probe.ts'));
  symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

function row(report: Report, mode: string, home: string, profile: string): Row {
  const found = report.rows.find((r) => r.mode === mode && r.home === home && r.profile === profile);
  if (!found) throw new Error(`missing row ${mode} home=${home} profile=${profile}`);
  return found;
}

function scopesOf(report: Report, bundles: string[], includeBase = true): string[] {
  const scopes = includeBase ? [...report.rows.find((r) => r.profile === 'base')!.deskCli] : [];
  for (const name of bundles) {
    const info = report.bundles[name];
    if (!info) throw new Error(`bundle ${name} missing`);
    scopes.push(...info.scopes);
  }
  return [...new Set(scopes)];
}

describe('consent scopes at fe6161d and at this tree', () => {
  const dir = archiveOld();
  const old = runProbe(dir);
  const head = runProbe(REPO);
  rmSync(dir, { recursive: true, force: true });

  it('hosted CLI remint is refused before any Google consent URL at both commits', () => {
    for (const src of [
      readFileSync(path.join(REPO, 'src', 'auth.ts'), 'utf8'),
      execFileSync('git', ['show', `${OLD}:src/auth.ts`], { cwd: REPO, encoding: 'utf8' }),
    ]) {
      const guard = src.indexOf('if (isHostedHttp())');
      const url = src.indexOf('generateAuthUrl');
      expect(guard).toBeGreaterThan(0);
      expect(url).toBeGreaterThan(guard);
    }
    for (const report of [old, head]) {
      for (const r of report.rows) expect(r.hostedCli).toBe('refused');
    }
  });

  it('a normal base re-consent requests the same scopes at both commits, with no keep, cloudidentity, or directory', () => {
    for (const mode of ['personal', 'workspace', 'external']) {
      for (const home of ['', 'corp.example']) {
        const before = row(old, mode, home, 'base');
        const after = row(head, mode, home, 'base');
        expect(after.deskCli, `${mode} home=${home || 'unset'}`).toEqual(before.deskCli);
        expect(after.aliasReauth).toEqual(before.aliasReauth);
        expect(after.ownerLogin).toEqual(['openid', 'email']);
        expect(before.ownerLogin).toEqual(['openid', 'email']);
        for (const scope of NOT_ON_DEFAULT) {
          expect(after.deskCli, scope).not.toContain(scope);
          expect(after.aliasReauth, scope).not.toContain(scope);
        }
        expect(after.deskCli).toEqual([
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/documents',
          'https://www.googleapis.com/auth/contacts',
          'https://www.googleapis.com/auth/webmasters',
          'https://www.googleapis.com/auth/tasks',
          'https://www.googleapis.com/auth/meetings.space.readonly',
        ]);
      }
    }
  });

  it('admin re-consent adds the same four admin scopes and nothing else', () => {
    for (const mode of ['personal', 'workspace', 'external']) {
      for (const home of ['', 'corp.example']) {
        const before = row(old, mode, home, 'admin');
        const after = row(head, mode, home, 'admin');
        expect(after.deskCli).toEqual(before.deskCli);
        expect(head.admin).toEqual(old.admin);
        for (const scope of NOT_ON_DEFAULT) expect(after.deskCli).not.toContain(scope);
      }
    }
  });

  it('every bundle that existed at fe6161d still has the same scope URLs', () => {
    for (const [name, info] of Object.entries(old.bundles)) {
      expect(head.bundles[name], name).toBeDefined();
      expect(head.bundles[name].scopes, name).toEqual(info.scopes);
    }
    const added = Object.keys(head.bundles).filter((name) => !old.bundles[name]);
    expect(added).toEqual(['directory']);
    expect(head.bundles.directory.scopes).toEqual([DIRECTORY]);
    expect(head.bundles.directory.orgOnly).toBe(false);
    expect(head.bundles.keep.orgOnly).toBe(true);
    expect(head.bundles.cloudidentity.orgOnly).toBe(true);
    expect(old.bundles.keep.orgOnly).toBe(false);
    expect(old.bundles.cloudidentity.orgOnly).toBe(false);
  });

  it('a saved profile that names one old bundle re-consents the same URLs', () => {
    for (const name of Object.keys(old.bundles)) {
      if (name === 'admin') continue;
      for (const mode of ['personal', 'workspace', 'external']) {
        for (const home of ['', 'corp.example']) {
          const before = row(old, mode, home, name);
          const after = row(head, mode, home, name);
          expect(after.deskCli, `${name} ${mode} ${home || 'unset'}`).toEqual(before.deskCli);
          expect(after.deskCli).toEqual(scopesOf(head, [name]));
        }
      }
    }
  });

  it('allBundles is opt-in and is the only path that changes keep, cloudidentity, or directory', () => {
    const personal = row(head, 'personal', '', 'base').allBundles;
    const personalHome = row(head, 'personal', 'corp.example', 'base').allBundles;
    const workspaceUnset = row(head, 'workspace', '', 'base').allBundles;
    const workspaceHome = row(head, 'workspace', 'corp.example', 'base').allBundles;
    const externalUnset = row(head, 'external', '', 'base').allBundles;
    const externalHome = row(head, 'external', 'corp.example', 'base').allBundles;
    const oldAll = row(old, 'personal', '', 'base').allBundles;

    expect(oldAll).toContain('keep');
    expect(oldAll).toContain('cloudidentity');
    expect(oldAll).not.toContain('directory');
    expect(row(old, 'workspace', 'corp.example', 'base').allBundles).toEqual(oldAll);

    for (const list of [personal, personalHome, externalHome]) {
      expect(list).not.toContain('keep');
      expect(list).not.toContain('cloudidentity');
      expect(list).toContain('directory');
    }
    for (const list of [workspaceUnset, workspaceHome, externalUnset]) {
      expect(list).toContain('keep');
      expect(list).toContain('cloudidentity');
      expect(list).toContain('directory');
    }
  });
});
