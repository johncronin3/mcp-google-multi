/**
 * Test guard, ported from quickbooks-multicompany-mcp
 * tests/setup/no-real-secret-manager.cjs (PR #12) and extended so constructing
 * a real Google API client throws too. A plain `{ request }` test double is
 * still allowed: tool tests inject that instead of an OAuth2Client.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import path from 'node:path';

export const GUARD_MESSAGE =
  'Real Google or Secret Manager client used in tests (blocked by tests/setup/no-real-google-clients.ts)';

const require = createRequire(import.meta.url);

function isTestDoubleAuth(auth: unknown): boolean {
  if (auth === null || typeof auth !== 'object') return false;
  const rec = auth as { request?: unknown };
  // Class instances (OAuth2Client, GoogleAuth, JWT) are real clients.
  // Tool tests pass a plain object whose request never leaves the process.
  return typeof rec.request === 'function' && (auth as object).constructor === Object;
}

function wrapFactory(mod: Record<string, unknown>, name: string): void {
  const original = mod[name];
  if (typeof original !== 'function' || (original as { __houseTestGuard?: boolean }).__houseTestGuard) return;
  const guarded = function guardedFactory(this: unknown, versionOrOptions?: unknown) {
    const opts =
      versionOrOptions !== null && typeof versionOrOptions === 'object'
        ? (versionOrOptions as { auth?: unknown })
        : {};
    if (!isTestDoubleAuth(opts.auth)) {
      throw new Error(`${GUARD_MESSAGE}: ${name}`);
    }
    return (original as (this: unknown, opts?: unknown) => unknown).call(this, versionOrOptions);
  };
  Object.defineProperty(guarded, '__houseTestGuard', { value: true });
  mod[name] = guarded;
}

function guardGoogleApis(): void {
  const root = path.dirname(require.resolve('@googleapis/gmail/package.json'));
  const scope = path.dirname(root);
  for (const name of readdirSync(scope)) {
    let mod: Record<string, unknown>;
    try {
      mod = require(`@googleapis/${name}`) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const key of Object.keys(mod)) {
      const val = mod[key];
      if (typeof val === 'function' && key === val.name && /^[a-z]/.test(key)) {
        wrapFactory(mod, key);
      }
    }
  }
}

function guardSecretManager(): void {
  const sm = require('@google-cloud/secret-manager') as {
    SecretManagerServiceClient?: new (...args: unknown[]) => unknown;
    v1?: { SecretManagerServiceClient?: { prototype: object } };
  };
  const classes = [sm.SecretManagerServiceClient, sm.v1?.SecretManagerServiceClient].filter(Boolean) as Array<{
    prototype: object;
    __houseTestGuard?: boolean;
  }>;
  for (const Cls of classes) {
    if (Cls.__houseTestGuard) continue;
    for (const name of Object.getOwnPropertyNames(Cls.prototype)) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(Cls.prototype, name);
      if (!desc || typeof desc.value !== 'function') continue;
      Object.defineProperty(Cls.prototype, name, {
        ...desc,
        value() {
          throw new Error(`${GUARD_MESSAGE}: SecretManagerServiceClient.${name}`);
        },
      });
    }
    Object.defineProperty(Cls, '__houseTestGuard', { value: true });
  }
  function RefusedSecretManager(this: unknown) {
    throw new Error(`${GUARD_MESSAGE}: SecretManagerServiceClient`);
  }
  Object.defineProperty(RefusedSecretManager, '__houseTestGuard', { value: true });
  (sm as { SecretManagerServiceClient: unknown }).SecretManagerServiceClient = RefusedSecretManager;
}

guardSecretManager();
guardGoogleApis();
