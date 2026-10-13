import { describe, it, expect, afterEach } from 'vitest';
import { setHttpReauthLink, reauthHint } from '../src/reauth-hint.js';
import { setHintProvider } from '../src/hint-provider.js';

afterEach(() => {
  setHttpReauthLink(null);
  setHintProvider(null);
});

describe('reauthHint (BV-1)', () => {
  it('defaults to the stdio auth CLI', () => {
    setHttpReauthLink(null);
    expect(reauthHint('personal')).toBe('Run: npx mcp-google-multi auth --account personal');
  });
  it('becomes the server-signed re-auth link once the HTTP linker is set', () => {
    const asked: string[] = [];
    setHttpReauthLink((alias) => {
      asked.push(alias);
      return `https://mcp.example.com/authorize?flow=alias_reauth&alias=${encodeURIComponent(alias)}&exp=1&sig=s`;
    });
    expect(reauthHint('a b')).toBe('Re-authenticate "a b" in your browser, then retry: https://mcp.example.com/authorize?flow=alias_reauth&alias=a%20b&exp=1&sig=s');
    expect(asked).toEqual(['a b']);
  });

  // H3 PR1: a host-installed provider wins over BOTH the linker and the CLI
  // default, so a multi-tenant host never needs core's linker to speak
  // in-band over HTTP.
  it('a host-installed hint provider wins over the linker and the CLI default', () => {
    setHttpReauthLink(() => 'https://mcp.example.com/authorize?flow=alias_reauth');
    setHintProvider({ render: (c) => ({ hint: `provider:${c.kind}:${(c as { account: string }).account}` }) });
    expect(reauthHint('personal')).toBe('provider:reauth:personal');
  });
});
