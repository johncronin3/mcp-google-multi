import { afterEach, describe, expect, it } from 'vitest';
import {
  assertHostedListenPort,
  deskMintMessage,
  isHostedHttp,
} from '../src/hosted.js';

describe('hosted mode (layer 1 desk-mint vs Cloud Run)', () => {
  const prevHosted = process.env.MCP_HOSTED;
  const prevK = process.env.K_SERVICE;

  afterEach(() => {
    if (prevHosted === undefined) delete process.env.MCP_HOSTED;
    else process.env.MCP_HOSTED = prevHosted;
    if (prevK === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = prevK;
  });

  it('MCP_HOSTED=1 is hosted even without K_SERVICE', () => {
    delete process.env.K_SERVICE;
    expect(isHostedHttp({ MCP_HOSTED: '1' })).toBe(true);
    expect(isHostedHttp({ K_SERVICE: 'google-multi-mcp' })).toBe(true);
    expect(isHostedHttp({ MCP_HOSTED: '0', K_SERVICE: 'google-multi-mcp' })).toBe(false);
    expect(isHostedHttp({})).toBe(false);
  });

  it('desk-mint message names the alias and forbids 8000/8787/4242', () => {
    const msg = deskMintMessage('personal', 'you@gmail.com');
    expect(msg).toContain('personal');
    expect(msg).toContain('you@gmail.com');
    expect(msg).toContain('8000/8787/4242');
    expect(msg).toContain('auth --account personal');
    expect(msg).toContain('layer 1');
    expect(msg).not.toMatch(/mega-?oauth/i);
  });

  it('refuses desk-only ports when hosted', () => {
    const env = { MCP_HOSTED: '1' };
    expect(() => assertHostedListenPort(8080, env)).not.toThrow();
    expect(() => assertHostedListenPort(8000, env)).toThrow(/8000/);
    expect(() => assertHostedListenPort(8787, env)).toThrow(/8787/);
    expect(() => assertHostedListenPort(4242, env)).toThrow(/4242/);
    expect(() => assertHostedListenPort(8787, { MCP_HOSTED: '0' })).not.toThrow();
  });
});
