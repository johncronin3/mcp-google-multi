import { describe, it, expect } from 'vitest';
import { toolHarness, accountSet, parseResult, type GoogleRequest } from './_tool-harness.js';

const GA4_RESPONSE = { dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers', type: 'TYPE_INTEGER' }], rows: [] };

const WITH_ANALYTICS = () =>
  accountSet(
    { test: { email: 'test@harness.example', scopeProfile: 'full' } },
    { defaultAccount: 'test', scopeProfiles: { full: { bundles: ['analytics'] } } },
  );

describe('analytics_run_report native GA4 request shapes', () => {
  it('still accepts the plain startDate/endDate + string metrics/dimensions form', async () => {
    const h = toolHarness({ accounts: WITH_ANALYTICS(), respond: () => GA4_RESPONSE });
    const res = await h.call('analytics_run_report', {
      account: 'test',
      property: '213025502',
      startDate: '28daysAgo',
      endDate: 'today',
      metrics: ['activeUsers'],
      dimensions: ['country'],
    });
    expect(res.isError).toBeFalsy();
    const body = h.requests()[0].data as { dateRanges: unknown[]; metrics: unknown[]; dimensions: unknown[] };
    expect(body.dateRanges).toEqual([{ startDate: '28daysAgo', endDate: 'today' }]);
    expect(body.metrics).toEqual([{ name: 'activeUsers' }]);
    expect(body.dimensions).toEqual([{ name: 'country' }]);
  });

  it('accepts a single-entry dateRanges and {name} metrics/dimensions, normalized to the current fields', async () => {
    const h = toolHarness({ accounts: WITH_ANALYTICS(), respond: () => GA4_RESPONSE });
    const res = await h.call('analytics_run_report', {
      account: 'test',
      property: '213025502',
      dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
      metrics: [{ name: 'sessions' }],
      dimensions: [{ name: 'deviceCategory' }],
    });
    expect(res.isError).toBeFalsy();
    const body = (h.requests()[0] as GoogleRequest).data as { dateRanges: unknown[]; metrics: unknown[]; dimensions: unknown[] };
    expect(body.dateRanges).toEqual([{ startDate: '7daysAgo', endDate: 'yesterday' }]);
    expect(body.metrics).toEqual([{ name: 'sessions' }]);
    expect(body.dimensions).toEqual([{ name: 'deviceCategory' }]);
  });

  it('rejects more than one dateRanges entry with a clear message, without calling Google', async () => {
    const h = toolHarness({ accounts: WITH_ANALYTICS(), respond: () => GA4_RESPONSE });
    const res = await h.call('analytics_run_report', {
      account: 'test',
      property: '213025502',
      dateRanges: [
        { startDate: '7daysAgo', endDate: 'yesterday' },
        { startDate: '28daysAgo', endDate: '14daysAgo' },
      ],
      metrics: ['activeUsers'],
    });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain('dateRanges');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('rejects a call with neither startDate/endDate nor dateRanges', async () => {
    const h = toolHarness({ accounts: WITH_ANALYTICS(), respond: () => GA4_RESPONSE });
    const res = await h.call('analytics_run_report', { account: 'test', property: '213025502', metrics: ['activeUsers'] });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(h.request).not.toHaveBeenCalled();
  });
});
