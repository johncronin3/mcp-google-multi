// Over stdio the fix is the `auth --account` CLI; over HTTP it's a clickable,
// server-signed link instead, installed by the AS bootstrap. See docs/internals.md.

import { hints } from './hint-provider.js';

let httpReauthLink: ((alias: string) => string) | null = null;

export function setHttpReauthLink(linker: ((alias: string) => string) | null): void {
  httpReauthLink = linker;
}

export function reauthHint(account: string): string {
  const rendered = hints()?.render({ kind: 'reauth', account });
  if (rendered) return rendered.hint;
  if (httpReauthLink) {
    return `Re-authenticate "${account}" in your browser, then retry: ${httpReauthLink(account)}`;
  }
  return `Run: npx mcp-google-multi auth --account ${account}`;
}
