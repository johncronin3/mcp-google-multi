import { OAuth2Client } from 'googleapis-common';
import { getAccountSet, refreshAccountSetIfStale } from './accounts.js';
import type { Account } from './accounts.js';
import { assertAccountAllowed } from './session-grant.js';
import { deskMintError, isHostedHttp } from './hosted.js';
import { persistRotatedTokenUpdates } from './token-secret.js';
import { readToken, updateToken } from './token-store.js';
import { reauthHint } from './reauth-hint.js';

/** A local precondition failure, carrying a code the error mapper classifies
 * on. Without it these land on the generic floor and read as Google errors. */
function tagged(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

type RefreshHook = {
  refreshTokenNoCache: (refreshToken?: string | null) => Promise<{ tokens: object; res?: unknown }>;
  credentials: object;
  setCredentials: (c: object) => void;
};

/** Await SM persist before the client adopts rotated credentials. See docs/internals.md. */
export function attachRefreshPersist(client: OAuth2Client, account: string): void {
  const hook = client as unknown as RefreshHook;
  if (typeof hook.refreshTokenNoCache !== 'function') {
    if (isHostedHttp()) {
      throw new Error(
        'Hosted refresh persist requires OAuth2Client.refreshTokenNoCache; refusing local-file fallback',
      );
    }
    client.on('tokens', (tokens) => {
      updateToken(account, tokens);
    });
    return;
  }
  const orig = hook.refreshTokenNoCache.bind(client);
  hook.refreshTokenNoCache = async (refreshToken) => {
    const previous = { ...hook.credentials };
    const result = await orig(refreshToken);
    try {
      await persistRotatedTokenUpdates(account, result.tokens);
    } catch (err) {
      hook.setCredentials(previous);
      throw err;
    }
    return result;
  };
}

export async function getClient(account: Account) {
  assertAccountAllowed(account);
  // BR-7: lazy cross-process reload — one stat per dispatch, no watcher;
  // reload failures keep the last-good registry, never kill the server.
  refreshAccountSetIfStale();
  const config = getAccountSet().configs[account];
  if (!config) {
    // Tagged so mapGoogleError can classify it. Untagged, a caller's typo in
    // an alias came back as `upstream_error` with "Unclassified error", i.e.
    // the server blaming Google for a local argument mistake.
    throw tagged(
      `Unknown account "${account}". Valid aliases: ${getAccountSet().aliases.join(', ')}`,
      'E_UNKNOWN_ACCOUNT',
    );
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw tagged(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set. ' +
        'Check that .env exists in the project root or pass them as env vars.',
      'E_NO_OAUTH_CLIENT',
    );
  }

  // Redirect URI is unused on the refresh-token grant; consent flows bind an
  // ephemeral loopback port at auth time (oauth-consent.ts).
  const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost/oauth2callback',
  );

  const tokenData = readToken(account);
  if (!tokenData) {
    if (isHostedHttp()) throw deskMintError(account, config.email);
    throw tagged(`No token found for account "${account}" (${config.email}). ${reauthHint(account)}`, 'E_NO_TOKEN');
  }

  oauth2Client.setCredentials(tokenData);
  attachRefreshPersist(oauth2Client, account);

  return oauth2Client;
}
