import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * gcloud source deploy follows .gcloudignore with gitignore rules.
 * git check-ignore is the matcher: a deciding pattern that starts with `!`
 * is uploaded; every other match is left out. A negation inside a directory
 * (`!src/**`) only wins when that path exists, so the scratch repo materializes
 * the allowlisted files.
 */

const ROOT = process.cwd();
const ROOT_ALLOW = ['Dockerfile', 'package.json', 'package-lock.json', 'tsconfig.json', 'docker/entrypoint.sh'];
const PROBES = ['bin/loose.mjs', 'scripts/measure-tools.mjs', 'loose.mjs', 'src/loose.mjs'];

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      out.push(rel);
      continue;
    }
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else out.push(rel);
  }
  return out;
}

function materialize(scratch: string, rel: string): void {
  const dest = path.join(scratch, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, '');
}

function uploadSet(files: string[]): { uploaded: string[]; excluded: string[] } {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gcloudignore-'));
  writeFileSync(path.join(scratch, '.gitignore'), readFileSync(path.join(ROOT, '.gcloudignore'), 'utf8'));
  const init = spawnSync('git', ['init', '-q'], { cwd: scratch });
  expect(init.status, init.stderr?.toString()).toBe(0);
  for (const rel of files) {
    if (rel.startsWith('src/') || ROOT_ALLOW.includes(rel)) materialize(scratch, rel);
  }
  for (const rel of PROBES) materialize(scratch, rel);

  const probed = [...new Set([...files, ...PROBES])];
  const uploaded: string[] = [];
  const excluded: string[] = [];
  for (let i = 0; i < probed.length; i += 4000) {
    const chunk = probed.slice(i, i + 4000);
    const proc = spawnSync('git', ['check-ignore', '-v', '--no-index', '--stdin'], {
      cwd: scratch,
      input: `${chunk.join('\n')}\n`,
      encoding: 'utf8',
    });
    expect(proc.status === 0 || proc.status === 1, proc.stderr).toBe(true);
    const decided = new Map<string, string>();
    for (const line of proc.stdout.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      expect(tab, line).toBeGreaterThan(0);
      const pattern = line.slice(0, tab).replace(/^.*:\d+:/, '');
      decided.set(line.slice(tab + 1), pattern);
    }
    for (const rel of chunk) {
      const pattern = decided.get(rel);
      if (pattern?.startsWith('!')) uploaded.push(rel);
      else excluded.push(rel);
    }
  }
  return { uploaded, excluded };
}

describe('.gcloudignore upload set', () => {
  it('uploads the Dockerfile COPY inputs plus the Dockerfile, and drops bin/ and *.mjs', () => {
    const files = walk(ROOT);
    const { uploaded, excluded } = uploadSet(files);
    const expected = [
      ...ROOT_ALLOW,
      ...files.filter((rel) => rel.startsWith('src/') && !rel.endsWith('.mjs')),
    ].sort();
    expect(uploaded.sort()).toEqual(expected);
    expect(uploaded.some((rel) => rel === 'bin' || rel.startsWith('bin/'))).toBe(false);
    expect(uploaded.some((rel) => rel.endsWith('.mjs'))).toBe(false);
    for (const rel of [...PROBES, 'docs/hosted-mcp.md', 'grants.example.json', 'node_modules']) {
      if (rel === 'node_modules') {
        expect(excluded.some((item) => item.startsWith('node_modules/'))).toBe(true);
      } else {
        expect(excluded, rel).toContain(rel);
      }
    }
    expect(excluded.length).toBeGreaterThan(uploaded.length);
  });
});
