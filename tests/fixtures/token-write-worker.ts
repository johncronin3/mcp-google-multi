import { parentPort, workerData } from 'node:worker_threads';
import { createTokenStore } from '../../src/token-store.js';

const data = workerData as { dir: string; alias: string; access: string; refresh: string; key: string };

try {
  const store = createTokenStore(data.dir, { resolveKey: () => data.key });
  store.writeToken(data.alias, { refresh_token: data.refresh, access_token: data.access });
  const read = store.readToken(data.alias);
  if (!read || read.refresh_token !== data.refresh || read.access_token !== data.access) {
    throw new Error(`alias ${data.alias} did not survive its own write`);
  }
  parentPort?.postMessage({ ok: true });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
