import { OAuth2Client } from 'googleapis-common';
import { ACCOUNT_CONFIG } from './accounts.js';
import type { Account } from './accounts.js';
import { assertAccountAllowed } from './session-grant.js';
import { deskMintError, isHostedHttp } from './hosted.js';
import { persistRotatedTokenUpdates } from './token-secret.js';
import { readToken, updateToken } from './token-store.js';

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
  const config = ACCOUNT_CONFIG[account];

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set. ' +
        'Check that .env exists in the project root or pass them as env vars.',
    );
  }

  const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:4242/oauth2callback',
  );

  const tokenData = readToken(account);
  if (!tokenData) {
    if (isHostedHttp()) throw deskMintError(account, config.email);
    throw new Error(
      `No token found for account "${account}" (${config.email}). ` +
        `Run: npx mcp-google-multi auth --account ${account}`,
    );
  }

  oauth2Client.setCredentials(tokenData);
  attachRefreshPersist(oauth2Client, account);

  return oauth2Client;
}
