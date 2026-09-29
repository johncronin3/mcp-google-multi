import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerDriveTools, resolveDriveUploadSource } from '../src/tools/drive.js';

const BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0x01]);
const B64 = BYTES.toString('base64');

type ToolResult = { content: { text: string }[]; isError?: boolean };
type SchemaField = { safeParse: (v: unknown) => { success: boolean } };

function readBody(data: unknown): Promise<Buffer> {
  if (!data) return Promise.resolve(Buffer.alloc(0));
  if (Buffer.isBuffer(data)) return Promise.resolve(data);
  if (typeof data === 'string') return Promise.resolve(Buffer.from(data));
  const asyncIter = (data as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[Symbol.asyncIterator];
  if (typeof asyncIter !== 'function') return Promise.resolve(Buffer.alloc(0));
  return (async () => {
    const chunks: Buffer[] = [];
    for await (const c of data as AsyncIterable<unknown>) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    }
    return Buffer.concat(chunks);
  })();
}

function harness(sizeFor: (body: Buffer) => string = () => String(BYTES.length)) {
  const calls: { url?: string; body: Buffer }[] = [];
  let clientCalls = 0;
  const schemas: Record<string, Record<string, SchemaField>> = {};
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {};
  const server = {
    accountAliases: () => ['test'],
    registerTool: (
      name: string,
      config: { inputSchema?: Record<string, SchemaField> },
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => {
      handlers[name] = handler;
      schemas[name] = config.inputSchema ?? {};
    },
  };
  registerDriveTools(server as never, {
    getClientFn: async () => {
      clientCalls += 1;
      return {
        request: async (opts: { url?: string; data?: unknown }) => {
          const body = await readBody(opts.data);
          calls.push({ url: opts.url, body });
          return {
            data: {
              id: 'FILE123',
              name: 'seed.bin',
              mimeType: 'application/octet-stream',
              size: sizeFor(body),
              webViewLink: 'https://drive.google.com/file/d/FILE123/view',
            },
          };
        },
      };
    },
    localFiles: true,
  });
  return { handlers, calls, schemas, clientCalls: () => clientCalls };
}

async function withHosted(hosted: boolean, fn: () => Promise<void>) {
  const prev = process.env.MCP_HOSTED;
  const prevK = process.env.K_SERVICE;
  process.env.MCP_HOSTED = hosted ? '1' : '0';
  delete process.env.K_SERVICE;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.MCP_HOSTED;
    else process.env.MCP_HOSTED = prev;
    if (prevK === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = prevK;
  }
}

describe('resolveDriveUploadSource', () => {
  it('hosted contentBase64 decodes to the original bytes', () => {
    const res = resolveDriveUploadSource({
      hosted: true,
      contentBase64: B64,
      filename: 'seed.bin',
      mimeTypeArg: 'application/pdf',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.media.kind).toBe('bytes');
    if (res.media.kind !== 'bytes') return;
    expect(res.media.buffer.equals(BYTES)).toBe(true);
    expect(res.media.mimeType).toBe('application/pdf');
  });

  it('hosted content is the same inline bytes, including base64url and a data URL', () => {
    const url = BYTES.toString('base64url');
    const res = resolveDriveUploadSource({ hosted: true, content: url, filename: 'seed.bin' });
    expect(res.ok).toBe(true);
    if (!res.ok || res.media.kind !== 'bytes') return;
    expect(res.media.buffer.equals(BYTES)).toBe(true);
    const dataUrl = resolveDriveUploadSource({
      hosted: true,
      content: `data:application/pdf;base64,${B64}`,
      filename: 'seed.bin',
    });
    expect(dataUrl.ok).toBe(true);
    if (!dataUrl.ok || dataUrl.media.kind !== 'bytes') return;
    expect(dataUrl.media.buffer.equals(BYTES)).toBe(true);
    expect(dataUrl.media.mimeType).toBe('application/octet-stream');
  });

  it('hosted with only localPath fails closed and does not pretend to read it', () => {
    const res = resolveDriveUploadSource({
      hosted: true,
      localPath: '/home/olga/seed.bin',
      filename: 'seed.bin',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/contentBase64/);
    expect(res.message).toMatch(/localPath was provided/);
    expect(res.message).not.toMatch(/ENOENT/);
  });

  it('hosted with neither source asks for inline bytes', () => {
    const res = resolveDriveUploadSource({ hosted: true, filename: 'seed.bin' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/contentBase64/);
  });

  it('rejects empty, whitespace, and non-base64 inline bytes', () => {
    for (const content of ['', '   ', '!!!not-base64!!!']) {
      const res = resolveDriveUploadSource({ hosted: true, content, filename: 'seed.bin' });
      expect(res.ok, content).toBe(false);
    }
  });

  it('rejects disagreeing content and contentBase64', () => {
    const res = resolveDriveUploadSource({
      hosted: true,
      content: B64,
      contentBase64: Buffer.from('other').toString('base64'),
      filename: 'seed.bin',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/do not match/);
  });

  it('desk localPath stays a path source and inline bytes win when both are set', () => {
    const pathOnly = resolveDriveUploadSource({
      hosted: false,
      localPath: '/tmp/desk-file.pdf',
      filename: 'ignored.pdf',
    });
    expect(pathOnly.ok).toBe(true);
    if (!pathOnly.ok || pathOnly.media.kind !== 'path') return;
    expect(pathOnly.media.localPath).toBe('/tmp/desk-file.pdf');
    expect(pathOnly.media.mimeType).toMatch(/pdf/);

    const both = resolveDriveUploadSource({
      hosted: false,
      localPath: '/tmp/missing.bin',
      content: B64,
      filename: 'seed.bin',
    });
    expect(both.ok).toBe(true);
    if (!both.ok || both.media.kind !== 'bytes') return;
    expect(both.media.buffer.equals(BYTES)).toBe(true);
  });

  it('desk with neither source requires a path or inline bytes', () => {
    const res = resolveDriveUploadSource({ hosted: false, filename: 'seed.bin' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/localPath/);
    expect(res.message).toMatch(/contentBase64/);
  });
});

describe('drive_upload handler', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('advertises inline byte fields and an optional localPath', () => {
    const { schemas } = harness();
    const shape = schemas.drive_upload;
    expect(shape.localPath.safeParse(undefined).success).toBe(true);
    expect(shape.content.safeParse(B64).success).toBe(true);
    expect(shape.contentBase64.safeParse(B64).success).toBe(true);
    expect(shape.filename.safeParse('seed.bin').success).toBe(true);
  });

  it('hosted contentBase64 uploads the bytes and returns a fileId', async () => {
    await withHosted(true, async () => {
      const { handlers, calls, clientCalls } = harness();
      const res = await handlers.drive_upload({
        account: 'test',
        filename: 'seed.bin',
        contentBase64: B64,
        mimeType: 'application/octet-stream',
      });
      expect(res.isError, res.content[0].text).toBeFalsy();
      const body = JSON.parse(res.content[0].text);
      expect(body.id).toBe('FILE123');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toMatch(/\/upload\/drive\/v3\/files/);
      expect(calls[0].body.includes(BYTES)).toBe(true);
      expect(calls[0].body.includes(B64)).toBe(false);
      expect(clientCalls()).toBe(1);
    });
  });

  it('hosted content uploads the same bytes without a localPath', async () => {
    await withHosted(true, async () => {
      const { handlers, calls } = harness();
      const res = await handlers.drive_upload({
        account: 'test',
        filename: 'seed.bin',
        content: BYTES.toString('base64url'),
        localPath: '/Users/olga/does-not-exist.bin',
      });
      expect(res.isError, res.content[0].text).toBeFalsy();
      expect(JSON.parse(res.content[0].text).id).toBe('FILE123');
      expect(calls[0].body.includes(BYTES)).toBe(true);
    });
  });

  it('desk localPath still streams the file on disk', async () => {
    await withHosted(false, async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'drive-upload-'));
      const file = path.join(dir, 'seed.bin');
      writeFileSync(file, BYTES);
      const { handlers, calls } = harness();
      const res = await handlers.drive_upload({
        account: 'test',
        filename: 'seed.bin',
        localPath: file,
      });
      expect(res.isError, res.content[0].text).toBeFalsy();
      expect(JSON.parse(res.content[0].text).id).toBe('FILE123');
      expect(calls).toHaveLength(1);
      expect(calls[0].body.includes(BYTES)).toBe(true);
    });
  });

  it('fails closed when neither path nor bytes are provided', async () => {
    await withHosted(true, async () => {
      const { handlers, calls, clientCalls } = harness();
      const res = await handlers.drive_upload({ account: 'test', filename: 'seed.bin' });
      expect(res.isError).toBe(true);
      const env = JSON.parse(res.content[0].text);
      expect(env.error).toBe('invalid_params');
      expect(env.message).toMatch(/contentBase64/);
      expect(calls).toHaveLength(0);
      expect(clientCalls()).toBe(0);
    });
    await withHosted(false, async () => {
      const { handlers, clientCalls } = harness();
      const res = await handlers.drive_upload({ account: 'test', filename: 'seed.bin' });
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).message).toMatch(/localPath/);
      expect(clientCalls()).toBe(0);
    });
  });

  it('fails closed on empty inline bytes and an empty local file', async () => {
    await withHosted(true, async () => {
      const { handlers, clientCalls } = harness();
      for (const args of [
        { content: '' },
        { contentBase64: '   ' },
        { content: '!!!' },
      ]) {
        const res = await handlers.drive_upload({ account: 'test', filename: 'seed.bin', ...args });
        expect(res.isError, JSON.stringify(args)).toBe(true);
        expect(JSON.parse(res.content[0].text).error).toBe('invalid_params');
      }
      expect(clientCalls()).toBe(0);
    });
    await withHosted(false, async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'drive-upload-empty-'));
      const file = path.join(dir, 'empty.bin');
      writeFileSync(file, Buffer.alloc(0));
      const { handlers, calls } = harness();
      const res = await handlers.drive_upload({ account: 'test', filename: 'empty.bin', localPath: file });
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).message).toMatch(/0 bytes/);
      expect(calls).toHaveLength(0);
    });
  });

  it('hosted localPath of a real file is not read', async () => {
    await withHosted(true, async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'drive-upload-hosted-path-'));
      const file = path.join(dir, 'seed.bin');
      writeFileSync(file, BYTES);
      const { handlers, calls, clientCalls } = harness();
      const res = await handlers.drive_upload({ account: 'test', filename: 'seed.bin', localPath: file });
      expect(res.isError).toBe(true);
      const env = JSON.parse(res.content[0].text);
      expect(env.error).toBe('invalid_params');
      expect(env.message).toMatch(/contentBase64/);
      expect(env.message).not.toMatch(/ENOENT/);
      expect(calls).toHaveLength(0);
      expect(clientCalls()).toBe(0);
    });
  });

  it('fails closed when Drive reports size 0', async () => {
    await withHosted(true, async () => {
      const { handlers } = harness(() => '0');
      const res = await handlers.drive_upload({
        account: 'test',
        filename: 'seed.bin',
        contentBase64: B64,
      });
      expect(res.isError).toBe(true);
      const env = JSON.parse(res.content[0].text);
      expect(env.error).toBe('invalid_params');
      expect(env.message).toMatch(/size 0/);
      expect(env.message).toMatch(/FILE123/);
    });
  });
});
