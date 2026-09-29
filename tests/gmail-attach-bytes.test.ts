import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerGmailTools } from '../src/tools/gmail.js';
import { composeRaw, mimeOmitsAttachmentBytes } from '../src/tools/gmail-mime.js';

const BYTES = Buffer.from('Baumgartner-lean-marker-%PDF-one-small-file');

type Req = { url?: string; data?: { raw?: string; message?: { raw?: string } }; params?: Record<string, unknown>; responseType?: string };
type ToolResult = { content: { text: string }[]; isError?: boolean };

function mimeOf(req: Req | undefined): string {
  const raw = req?.data?.message?.raw ?? req?.data?.raw ?? '';
  return Buffer.from(raw, 'base64url').toString('latin1').replace(/\r\n/g, '');
}

function harness(requestImpl: (req: Req) => Promise<{ data: unknown; headers: Headers }>) {
  const calls: Req[] = [];
  const schemas: Record<string, { attachments?: { parse: (v: unknown) => unknown } }> = {};
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {};
  const server = {
    accountAliases: () => ['test'],
    accountSet: () => ({ aliases: ['test'], configs: { test: { email: 'olga@stromback.com' } } }),
    registerTool: (
      name: string,
      config: { inputSchema?: { attachments?: { parse: (v: unknown) => unknown } } },
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => {
      handlers[name] = handler;
      schemas[name] = config.inputSchema ?? {};
    },
  };
  registerGmailTools(server as never, {
    getClientFn: async () => ({
      request: async (req: Req) => {
        calls.push(req);
        return requestImpl(req);
      },
    }),
    localFiles: true,
  });
  return { handlers, calls, schemas };
}

const okDraft = async () => ({ data: { id: 'D1', message: { id: 'M1', threadId: 'T1' } }, headers: new Headers() });
const okSend = async () => ({ data: { id: 'M1', threadId: 'T1' }, headers: new Headers() });

describe('gmail attachment bytes are in the Gmail request', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  it('keeps inline base64 when a laptop path is also present', () => {
    const { schemas } = harness(okDraft);
    const parsed = schemas.gmail_create_draft.attachments!.parse([{
      path: '/Users/olga/Docampo-bio.docx',
      filename: 'bio.docx',
      content: BYTES.toString('base64'),
    }]) as Array<{ content?: string; path?: string }>;
    expect(parsed[0].content).toBe(BYTES.toString('base64'));
  });

  it('puts one small file in the draft MIME and the send MIME', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gmail-attach-'));
    const file = path.join(dir, 'note.txt');
    writeFileSync(file, BYTES);
    for (const tool of ['gmail_create_draft', 'gmail_send'] as const) {
      const { handlers, calls } = harness(tool === 'gmail_send' ? okSend : okDraft);
      const res = await handlers[tool]({
        account: 'test',
        to: 'john@usa-house.com',
        subject: 'lean',
        body: 'one small file',
        attachments: [{ path: file, filename: 'note.txt' }],
      });
      expect(res.isError, res.content[0].text).toBeFalsy();
      const hit = calls.find((c) => /\/drafts|\/messages\/send/.test(String(c.url)));
      expect(hit, JSON.stringify(calls.map((c) => c.url))).toBeDefined();
      const mime = mimeOf(hit);
      expect(mime).toContain(BYTES.toString('base64'));
      expect(mime).toContain('filename=note.txt');
    }
  });

  it('uses inline bytes and does not need the laptop path', async () => {
    const prev = process.env.MCP_HOSTED;
    process.env.MCP_HOSTED = '1';
    try {
      const { handlers, calls } = harness(okDraft);
      const res = await handlers.gmail_create_draft({
        account: 'test',
        to: 'john@usa-house.com',
        subject: 'lean',
        body: 'inline',
        attachments: [{
          path: '/Users/olga/Docampo-bio.docx',
          filename: 'bio.docx',
          content: BYTES.toString('base64'),
        }],
      });
      expect(res.isError, res.content[0].text).toBeFalsy();
      const hit = calls.find((c) => String(c.url).includes('/drafts'));
      expect(mimeOf(hit)).toContain(BYTES.toString('base64'));
    } finally {
      if (prev === undefined) delete process.env.MCP_HOSTED;
      else process.env.MCP_HOSTED = prev;
    }
  });

  it('errors on a zero-byte file and does not call Gmail', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gmail-attach-'));
    const file = path.join(dir, 'empty.txt');
    writeFileSync(file, Buffer.alloc(0));
    const { handlers, calls } = harness(okDraft);
    const res = await handlers.gmail_create_draft({
      account: 'test',
      to: 'john@usa-house.com',
      subject: 'lean',
      body: 'empty',
      attachments: [{ path: file, filename: 'empty.txt' }],
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.slug).toBe('E_ATTACHMENT_EMPTY');
    expect(body.message).toMatch(/Nothing was sent/);
    expect(calls.some((c) => /\/drafts|\/messages\/send/.test(String(c.url)))).toBe(false);
  });

  it('errors when Drive media is empty and does not create the draft', async () => {
    const { handlers, calls } = harness(async (req) => {
      const url = String(req.url ?? '');
      const params = JSON.stringify(req.params ?? {});
      if (url.includes('/drafts') || url.includes('/messages/send')) {
        return { data: { id: 'D1', message: { threadId: 'T1' } }, headers: new Headers() };
      }
      if (url.includes('drive') && (params.includes('media') || url.includes('alt=media') || req.responseType === 'arraybuffer')) {
        return { data: Buffer.alloc(0), headers: new Headers() };
      }
      if (url.includes('drive')) {
        return { data: { id: 'F1', name: 'headshot.jpg', mimeType: 'image/jpeg' }, headers: new Headers() };
      }
      throw new Error(`unexpected ${url} params=${params} responseType=${req.responseType ?? ''}`);
    });
    const res = await handlers.gmail_create_draft({
      account: 'test',
      to: 'john@usa-house.com',
      subject: 'lean',
      body: 'headshot',
      attachments: [{ driveFileId: 'F1', filename: 'headshot.jpg' }],
    });
    expect(res.isError, res.content[0].text).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.slug).toBe('E_ATTACHMENT_EMPTY');
    expect(calls.some((c) => String(c.url).includes('/drafts'))).toBe(false);
  });
});

describe('mimeOmitsAttachmentBytes', () => {
  it('accepts a wrapped base64 part and rejects a text-only raw message', async () => {
    const data = Buffer.alloc(200, 0x5a);
    data[0] = 0x25;
    const encoded = await composeRaw({
      from: 'olga@stromback.com',
      to: 'john@usa-house.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
      attachments: [{ filename: 'tiny.bin', content: data, contentType: 'application/octet-stream' }],
    });
    expect(mimeOmitsAttachmentBytes(encoded, [{ filename: 'tiny.bin', content: data, contentType: 'application/octet-stream' }])).toEqual([]);
    const bare = await composeRaw({ from: 'a@b.c', to: 'd@e.f', subject: 's', text: 'only text' });
    expect(mimeOmitsAttachmentBytes(bare, [{ filename: 'tiny.bin', content: data, contentType: 'application/octet-stream' }])).toEqual(['tiny.bin']);
  });
});
