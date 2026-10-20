import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WRITE_PROFILES } from '../src/write-control.js';
import {
  REVIEWED_DELTAS,
  buildHostedGrantSurface,
  surfaceDrift,
  type SurfaceRow,
} from './hosted-grant-surface.js';

/**
 * Wall test 3. The hosted tool surface is built the same way production
 * builds it and compared to tests/fixtures/hosted-grant-surface.json.
 * That fixture is the reviewed post-fix surface (per grant × tool × profile).
 * A tool that is newly callable, or newly listed at connect, fails until the
 * fixture is edited on purpose. See REVIEWED_DELTAS for the d656bec deltas.
 */

const TRASH = ['gmail_trash', 'drive_trash', 'gmail_users_threads_trash'] as const;
const COSMOS_ALIASES = ['personal', 'opcenter', 'buildcoin'] as const;

const surface = buildHostedGrantSurface();
const fixture = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/hosted-grant-surface.json'), 'utf8'),
) as { reviewedDeltasFromD656bec: { tool: string; change: string; why: string }[]; rows: SurfaceRow[] };

describe('per-grant hosted tool surface', () => {
  it('Cosmos-related aliases stay on Personal Brain Grant 3 only', () => {
    const byName = new Map(surface.grants.map((grant) => [grant.name, grant.accounts]));
    expect(byName.get('Personal Brain Grant 3')).toEqual(['personal', 'stromback', 'opcenter', 'buildcoin']);
    expect(byName.get('StrombackBrain2')).toEqual(['stromback']);
    for (const alias of COSMOS_ALIASES) {
      expect(byName.get('Personal Brain Grant 3')).toContain(alias);
      expect(byName.get('StrombackBrain2')).not.toContain(alias);
    }
    for (const grant of surface.grants) {
      for (const alias of grant.accounts) {
        if (/cosmos/i.test(alias)) expect(grant.name).toBe('Personal Brain Grant 3');
      }
    }
  });

  it('matches the reviewed per-grant snapshot', () => {
    expect(fixture.reviewedDeltasFromD656bec.map((delta) => delta.tool)).toEqual(
      REVIEWED_DELTAS.map((delta) => delta.tool),
    );
    for (const delta of fixture.reviewedDeltasFromD656bec) {
      expect(delta.why.length, delta.tool).toBeGreaterThan(20);
    }
    const names = new Set(surface.rows.map((row) => row.tool));
    expect(names.has('calendar_respond_event')).toBe(true);
    expect(names.has('gmail_delete_draft')).toBe(true);
    expect(names.has('sheets_copy_sheet_to')).toBe(true);
    expect(names.has('gmail_users_drafts_delete')).toBe(false);
    const drift = surfaceDrift(surface.rows, fixture.rows);
    expect(drift, drift.slice(0, 30).join('\n')).toEqual([]);
  });

  it('Trash is denied for every grant under every write profile', () => {
    expect(surface.grants.map((grant) => grant.name)).toEqual(
      expect.arrayContaining(['Personal Brain Grant 3', 'StrombackBrain2']),
    );
    expect(WRITE_PROFILES).toEqual(['read-only', 'safe-writes', 'full-writes']);
    for (const grant of surface.grants) {
      for (const profile of WRITE_PROFILES) {
        for (const name of TRASH) {
          const row = surface.rows.find((entry) => entry.grant === grant.name && entry.profile === profile && entry.tool === name);
          expect(row, `${grant.name} ${profile} ${name}`).toBeTruthy();
          expect(row?.callable, `${grant.name} ${profile} ${name}`).toBe(false);
        }
      }
    }
  });

  it('the read-only default blocks every non-read tool, including destructive ones', () => {
    const nonRead = surface.rows.filter((row) => row.profile === 'read-only' && row.cud !== 'read');
    expect(nonRead.length).toBeGreaterThan(0);
    for (const row of nonRead) {
      expect(row.callable, `${row.grant} ${row.tool}`).toBe(false);
    }
    const driveTrash = surface.tools.find((tool) => tool.name === 'drive_trash');
    expect(driveTrash?.destructive).toBe(true);
    expect(driveTrash?.listed).toBe(true);
    const destructiveWrites = surface.tools.filter((tool) => tool.destructive && tool.cud !== 'read');
    expect(destructiveWrites.length).toBeGreaterThan(0);
    for (const tool of destructiveWrites) {
      for (const grant of surface.grants) {
        const row = surface.rows.find(
          (entry) => entry.grant === grant.name && entry.profile === 'read-only' && entry.tool === tool.name,
        );
        expect(row?.callable, `${grant.name} ${tool.name}`).toBe(false);
      }
    }
  });
});
