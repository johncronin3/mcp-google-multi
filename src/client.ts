import { OAuth2Client } from 'googleapis-common';
import { ACCOUNT_CONFIG } from './accounts.js';
import type { Account } from './accounts.js';
import { assertAccountAllowed } from './session-grant.js';
import { deskMintError, isHostedHttp } from './hosted.js';
import { readToken, updateToken } from './token-store.js';

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

  oauth2Client.on('tokens', (tokens) => {
    updateToken(account, tokens);
  });

  return oauth2Client;
}
