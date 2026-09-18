import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import {
  clearSessionGrant,
  getGrantsPath,
  grantStatusSummary,
  isGrantEnforced,
  setSessionGrant,
} from '../session-grant.js';

function jsonResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

export function registerGrantTools(registry: ToolRegistry): void {
  registry.registerMeta(
    'set_grant',
    {
      description:
        'Set the session grant (layer 3): a slice of already-minted Google aliases. ' +
        'Not Google login and not the MCP HTTP token. REQUIRED before data tools when grants are enforced. ' +
        'Hosted Grok: prefer entering the grant code on /oauth/authorize so it is bound into the access token ' +
        '(works across Cloud Run replicas). CLI/stdio: call this once at session start. ' +
        'Codes live only in grants.json on the host — never commit them.',
      inputSchema: {
        grant_code: z.string().describe('Secret grant code from host-local grants.json'),
        label: z
          .string()
          .optional()
          .describe('Optional label (e.g. "StrombackBrain2", "cronin")'),
      },
    },
    async (args: unknown) => {
      try {
        const { grant_code, label } = (args ?? {}) as { grant_code?: string; label?: string };
        const state = setSessionGrant(grant_code ?? '', label);
        const st = grantStatusSummary();
        return jsonResult({
          ok: true,
          message: 'Session grant set',
          name: state.name,
          label: state.label ?? null,
          accounts: state.accounts,
          source: st.source,
          code_prefix: st.code_prefix,
          hint: 'Google tools may only use these account aliases until clear_grant. On hosted Grok, a grant bound into the access token survives across Cloud Run replicas; in-process set_grant does not.',
        });
      } catch (e) {
        return jsonResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true,
        );
      }
    },
  );

  registry.registerMeta(
    'clear_grant',
    {
      description:
        'Clear the session grant. Further Google tools fail closed until set_grant again ' +
        '(unless GOOGLE_GRANT_CODE env fallback is set).',
      inputSchema: {},
    },
    async () => {
      clearSessionGrant();
      const st = grantStatusSummary();
      return jsonResult({
        ok: true,
        message: st.authenticated
          ? 'Session grant cleared; env GOOGLE_GRANT_CODE still active (legacy fallback).'
          : 'Session grant cleared. Call set_grant before Google tools.',
        status: st,
      });
    },
  );

  registry.registerMeta(
    'grant_status',
    {
      description:
        'Show whether this session has a Google grant, which accounts it may use, and enforcement state. ' +
        'Does not print the full secret (prefix only).',
      inputSchema: {},
    },
    async () => {
      const st = grantStatusSummary();
      if (!st.enforced) {
        return jsonResult({
          ...st,
          message:
            'Grants not enforced (no grants file or GOOGLE_GRANTS_ENFORCE=false). ' +
            `All GOOGLE_ACCOUNTS remain usable. Optional grants path: ${getGrantsPath()}`,
        });
      }
      if (!st.authenticated) {
        return jsonResult({
          ...st,
          message:
            'Not authenticated. Call set_grant(grant_code=...) with the grant for this brain/session.',
        });
      }
      return jsonResult({
        ...st,
        message: `Authenticated as grant "${st.name}". Allowed accounts: ${st.accounts.join(', ')}.`,
      });
    },
  );

  // Surface enforce state once at registration time for operators watching stderr.
  if (isGrantEnforced()) {
    process.stderr.write(
      `[mcp-google-multi] grant enforcement ON (${getGrantsPath()}). Call set_grant before data tools.\n`,
    );
  }
}
