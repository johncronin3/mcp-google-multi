import type { Account } from '../accounts.js';

export interface ErrorEnvelope {
  error: string;
  message: string;
  hint?: string;
  retriable: boolean;
  account: string;
}

function statusOf(error: any): number | undefined {
  const c = error?.code ?? error?.status ?? error?.response?.status;
  const n = typeof c === 'string' ? Number(c) : c;
  return Number.isFinite(n) ? n : undefined;
}

function reasonOf(error: any): string | undefined {
  return (
    error?.errors?.[0]?.reason ??
    error?.response?.data?.error?.errors?.[0]?.reason ??
    error?.response?.data?.error?.status
  );
}

function messageOf(error: any): string {
  return error?.response?.data?.error?.message ?? error?.message ?? String(error);
}

// Connect/DNS syscall codes. ENOTFOUND (no such name) is the one non-transient
// member. node-fetch flattens the happy-eyeballs AggregateError to a bare code
// with an empty message, so the code is the only surviving signal to surface.
const RETRIABLE_NET_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENETUNREACH',
  'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const NET_CODES = new Set([...RETRIABLE_NET_CODES, 'ENOTFOUND']);

/** First known network code on the error or its cause chain (GaxiosError.cause
 * -> FetchError; undici TypeError.cause -> AggregateError.errors). */
function netCodeOf(error: any): string | undefined {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause ?? e.error, depth++) {
    if (typeof e.code === 'string' && NET_CODES.has(e.code)) return e.code;
    if (Array.isArray(e.errors)) {
      const sub = e.errors.find((x: any) => typeof x?.code === 'string' && NET_CODES.has(x.code));
      if (sub) return sub.code;
    }
  }
  return undefined;
}

export function mapGoogleError(
  error: any,
  account: Account,
  forbiddenHint?: string,
): ErrorEnvelope {
  const status = statusOf(error);
  const reason = reasonOf(error);
  const message = messageOf(error);

  if (status === 401) {
    return {
      error: 'auth_required',
      message: `Authentication failed for account "${account}".`,
      hint: `Run: npx mcp-google-multi auth --account ${account}`,
      retriable: false,
      account,
    };
  }
  if (status === 403) {
    const scopeIssue =
      reason === 'insufficientPermissions' ||
      reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ||
      /insufficient.*scope/i.test(message);
    if (scopeIssue) {
      return {
        error: 'insufficient_scope',
        message,
        hint: forbiddenHint ?? `Re-auth "${account}" with the scope this operation needs.`,
        retriable: false,
        account,
      };
    }
    return { error: 'forbidden', message, hint: forbiddenHint, retriable: false, account };
  }
  if (status === 400 && /invalid[_ ]scope/i.test(message)) {
    return { error: 'invalid_scope', message, retriable: false, account };
  }
  if (status === 404) {
    return { error: 'not_found', message, retriable: false, account };
  }
  if (status === 429) {
    const retryAfter = error?.response?.headers?.['retry-after'];
    return {
      error: 'rate_limited',
      message,
      hint: retryAfter ? `Retry after ${retryAfter}s.` : 'Back off and retry.',
      retriable: true,
      account,
    };
  }
  if (status !== undefined && status >= 500) {
    return { error: 'upstream_error', message, retriable: true, account };
  }
  if (status === undefined) {
    const netCode = netCodeOf(error);
    if (netCode) {
      return {
        error: 'network_error',
        message: message.includes(netCode) ? message : message.endsWith('reason: ') ? `${message}${netCode}` : `${message} (${netCode})`,
        hint:
          `Network failure (${netCode}) before reaching Google - not an auth or API problem. Usually transient: retry. ` +
          'If it persists on a high-latency or broken-IPv6 link, raise the happy-eyeballs budget: NODE_OPTIONS=--network-family-autoselection-attempt-timeout=4000 (server default 2000ms), and check connectivity with curl.',
        retriable: RETRIABLE_NET_CODES.has(netCode),
        account,
      };
    }
  }
  return { error: 'upstream_error', message, retriable: false, account };
}

export function handleGoogleApiError(error: any, account: Account, forbiddenHint?: string) {
  const envelope = mapGoogleError(error, account, forbiddenHint);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    isError: true as const,
  };
}
