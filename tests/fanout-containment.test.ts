import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/registry.js';
import { runFanout } from '../src/fanout.js';
import { setHintProvider } from '../src/hint-provider.js';
import type { Policy } from '../src/write-control.js';
import type { AccountSet } from '../src/accounts.js';
import type { Metrics } from '../src/usage-metrics.js';

afterEach(() => setHintProvider(null));

// S1.8 containment (the #162 shape): a '*' selector against a registry built
// with one alias set must never enumerate another registry's (or the global)
// alias set. Red-first: against the accessor-less registry this fans out over
// the GLOBAL account set instead of the registry's own.

const POLICY: Policy = { profile: 'read-only', readOnly: true, allow: [], deny: [] };

const set = (aliases: string[]): AccountSet =>
  ({
    aliases,
    configs: {},
    scopeProfiles: { base: { bundles: [] } },
    source: 'env',
    stamp: 'env:0',
  }) as AccountSet;

type Handler = (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function buildRegistryWith(aliases: string[], metrics: Metrics | null = null): { registry: ToolRegistry; handlers: Record<string, Handler> } {
  const handlers: Record<string, Handler> = {};
  const stub = {
    registerTool: (name: string, _cfg: unknown, h: Handler) => {
      handlers[name] = h;
      return 'ok';
    },
    sendToolListChanged: vi.fn(),
    server: { setRequestHandler: () => {} },
  };
  const registry = new ToolRegistry(stub as never, POLICY, 'eager', metrics, () => set(aliases));
  registry.registerTool(
    'thing_search',
    {
      description: 'a read tool with an account enum (fan-out eligible)',
      inputSchema: { account: z.enum(aliases as [string, ...string[]]).optional().describe('Google account alias') },
    },
    (async ({ account }: { account: string }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ account, ok: true }) }],
    })) as never,
  );
  return { registry, handlers };
}

function fannedAccounts(envelope: { content: { text: string }[] }): string[] {
  const parsed = JSON.parse(envelope.content[0].text) as { results?: { account: string }[] };
  return (parsed.results ?? []).map((r) => r.account);
}

describe('fan-out containment (S1.8, #162 shape)', () => {
  it("'*' on registry A enumerates exactly A's aliases, never B's or the global set", async () => {
    const a = buildRegistryWith(['a1', 'a2']);
    const b = buildRegistryWith(['b1']);

    const aResult = await a.handlers['thing_search']({ account: '*' });
    const bResult = await b.handlers['thing_search']({ account: '*' });

    expect(fannedAccounts(aResult)).toEqual(['a1', 'a2']);
    expect(fannedAccounts(bResult)).toEqual(['b1']);
    // the global test registry alias ('test') must never appear in either
    expect(JSON.stringify(aResult)).not.toContain('test');
    expect(JSON.stringify(bResult)).not.toContain('a1');
  });

  it("a CSV naming another registry's alias is rejected with a hint listing only OUR aliases", async () => {
    const a = buildRegistryWith(['a1', 'a2']);
    const res = await a.handlers['thing_search']({ account: 'a1,b1' });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { error: string; message: string; hint?: string };
    expect(payload.error).toBe('validation_error');
    expect(payload.message).toContain('b1');
    expect(payload.hint).toContain('a1');
    expect(payload.hint).not.toContain('b1,');
  });

  it('a single alias resolves against the registry set, not the global', async () => {
    const a = buildRegistryWith(['a1', 'a2']);
    const ok = await a.handlers['thing_search']({ account: 'a2' });
    expect(JSON.parse(ok.content[0].text)).toEqual({ account: 'a2', ok: true });
    // the GLOBAL set's alias is invalid here even though getAccountSet() knows it
    const bad = await a.handlers['thing_search']({ account: 'test' });
    expect(bad.isError).toBe(true);
  });

  it('the metrics fan-out width counts the registry aliases, not the global set', async () => {
    const widths: number[] = [];
    const metrics = {
      wrap: (_e: unknown, h: (...a: unknown[]) => Promise<unknown>, width: (a: unknown) => number) =>
        async (...a: unknown[]) => {
          widths.push(width(a[0]));
          return h(...a);
        },
    } as unknown as Metrics;
    const x = buildRegistryWith(['x1', 'x2'], metrics);
    expect(x.registry.accountSet().aliases).toEqual(['x1', 'x2']);
    await x.handlers['thing_search']({ account: 'x1,x2' });
    expect(widths).toEqual([2]);
  });
});

describe('runFanout per-account throw (H3)', () => {
  it('with no provider the per-account throw renders internal with no hint field (unchanged)', async () => {
    const res = await runFanout(async () => { throw new Error('boom'); }, [{}], ['a1']);
    const payload = JSON.parse(res.content[0].text) as { results: { error: { error: string; message: string; hint?: string } }[] };
    expect(payload.results[0].error).toEqual({ error: 'internal', message: 'boom', retriable: false, account: 'a1' });
    expect('hint' in payload.results[0].error).toBe(false);
  });

  it('a provider renders internal for the per-account throw, message and hint included', async () => {
    const seen: unknown[] = [];
    setHintProvider({
      render: (c) => {
        seen.push(c);
        return { hint: 'tell the operator', message: 'server error' };
      },
    });
    const res = await runFanout(async () => { throw new Error('boom'); }, [{}], ['a1']);
    const payload = JSON.parse(res.content[0].text) as { results: { error: { error: string; message: string; hint?: string } }[] };
    expect(payload.results[0].error).toEqual({ error: 'internal', message: 'server error', hint: 'tell the operator', retriable: false, account: 'a1' });
    expect(seen).toEqual([{ kind: 'internal', account: 'a1' }]);
  });

  it('a throwing provider never rejects runFanout, and the other accounts\' results stay intact (red by mutation: drop the catch in hints())', async () => {
    setHintProvider({
      render: () => {
        throw new Error('provider blew up');
      },
    });
    const res = await runFanout(
      async (args: unknown) => {
        const { account } = args as { account: string };
        if (account === 'a1') throw new Error('boom');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ account, ok: true }) }] };
      },
      [{}],
      ['a1', 'a2'],
    );
    const payload = JSON.parse(res.content[0].text) as {
      results: ({ account: string; ok: true; data: unknown } | { account: string; ok: false; error: { message: string } })[];
      partial: boolean;
    };
    const a1 = payload.results.find((r) => r.account === 'a1')!;
    const a2 = payload.results.find((r) => r.account === 'a2')!;
    expect(a1.ok).toBe(false);
    expect((a1 as { error: { message: string } }).error.message).toBe('boom');
    expect(a2).toEqual({ account: 'a2', ok: true, data: { account: 'a2', ok: true } });
    expect(payload.partial).toBe(true);
  });
});
