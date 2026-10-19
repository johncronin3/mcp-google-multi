import * as fs from 'fs';
import * as path from 'path';
import { stringifyEnvelope } from './_errors.js';

/** Refusal for a host-file argument on a context that may not touch the
 * server's disk: the host belongs to its operator, not to every caller. */
export function hostFilesRefused(account: string | undefined, what: string) {
  return {
    content: [{
      type: 'text' as const,
      text: stringifyEnvelope({
        error: 'forbidden',
        message: `${what}: this caller may not read files on the machine running the server.`,
        hint: 'Put the file in Drive first and work from its Drive id.',
        retriable: false,
        account,
      }),
    }],
    isError: true as const,
  };
}

// path.basename() is a traversal guard — a caller-supplied filename must never escape savePath.
export function prepareLocalDest(savePath: string, filename: string): string {
  const name = path.basename(filename);
  // Agents routinely repeat the leaf in both savePath and filename; a blind
  // join would bury the download in a directory named like the file itself.
  const dir = path.basename(savePath) === name ? path.dirname(savePath) : savePath;
  const dest = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dest;
}

// createReadStream's open failure surfaces as an unhandled 'error' event that
// kills the process; opening the fd first turns it into a normal rejection.
export async function openLocalReadStream(localPath: string): Promise<fs.ReadStream> {
  const handle = await fs.promises.open(localPath, 'r');
  // open() succeeds on a directory; fail it here rather than as an async read error.
  if ((await handle.stat()).isDirectory()) {
    await handle.close();
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${localPath}'`), {
      code: 'EISDIR',
      path: localPath,
    });
  }
  const stream = handle.createReadStream();
  // Mid-read errors still reach the consumer through its own listeners; this
  // one only closes the unhandled-'error' crash path.
  stream.on('error', () => {});
  return stream;
}
