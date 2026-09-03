import { afterEach, describe, expect, it } from 'vitest';
import {
  assertHostedListenPort,
  decodeContentBase64,
  deskMintMessage,
  deskSavePathRequiredMessage,
  deskUploadNeedsLocalPathMessage,
  hostedBytesPayload,
  hostedUploadRequiresBase64Message,
  isHostedHttp,
  mcpJsonResult,
} from '../src/hosted.js';

describe('hosted mode (layer 1 desk-mint vs Cloud Run)', () => {
  const prevHosted = process.env.MCP_HOSTED;
  const prevK = process.env.K_SERVICE;

  afterEach(() => {
    if (prevHosted === undefined) delete process.env.MCP_HOSTED;
    else process.env.MCP_HOSTED = prevHosted;
    if (prevK === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = prevK;
  });

  it('MCP_HOSTED=1 is hosted even without K_SERVICE', () => {
    delete process.env.K_SERVICE;
    expect(isHostedHttp({ MCP_HOSTED: '1' })).toBe(true);
    expect(isHostedHttp({ K_SERVICE: 'google-multi-mcp' })).toBe(true);
    expect(isHostedHttp({ MCP_HOSTED: '0', K_SERVICE: 'google-multi-mcp' })).toBe(false);
    expect(isHostedHttp({})).toBe(false);
  });

  it('desk-mint message names the alias and forbids 8000/8787/4242', () => {
    const msg = deskMintMessage('personal', 'you@gmail.com');
    expect(msg).toContain('personal');
    expect(msg).toContain('you@gmail.com');
    expect(msg).toContain('8000/8787/4242');
    expect(msg).toContain('auth --account personal');
    expect(msg).toContain('layer 1');
    expect(msg).not.toMatch(/mega-?oauth/i);
  });

  it('refuses desk-only ports when hosted', () => {
    const env = { MCP_HOSTED: '1' };
    expect(() => assertHostedListenPort(8080, env)).not.toThrow();
    expect(() => assertHostedListenPort(8000, env)).toThrow(/8000/);
    expect(() => assertHostedListenPort(8787, env)).toThrow(/8787/);
    expect(() => assertHostedListenPort(4242, env)).toThrow(/4242/);
    expect(() => assertHostedListenPort(8787, { MCP_HOSTED: '0' })).not.toThrow();
  });
});

describe('hosted download bytes payload', () => {
  it('returns base64 payload with filename/mime/size', () => {
    const data = Buffer.from('hello-bytes');
    const payload = hostedBytesPayload({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      data,
    });
    expect(payload).toEqual({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: data.length,
      encoding: 'base64',
      data: data.toString('base64'),
    });
    expect(Buffer.from(payload.data, 'base64').toString('utf8')).toBe('hello-bytes');
  });

  it('basename-sanitizes filename and notes ignored savePath', () => {
    const payload = hostedBytesPayload({
      filename: '../../etc/passwd',
      mimeType: 'text/plain',
      data: Buffer.from('x'),
      savePathProvided: true,
    });
    expect(payload.filename).toBe('passwd');
    expect(payload.note).toMatch(/savePath is not applicable/);
  });

  it('mcpJsonResult wraps JSON text content', () => {
    const res = mcpJsonResult({ ok: true });
    expect(res.content[0].type).toBe('text');
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
  });

  it('deskSavePathRequiredMessage mentions hosted omit', () => {
    const msg = deskSavePathRequiredMessage();
    expect(msg).toMatch(/savePath is required on desk/);
    expect(msg).toMatch(/omit savePath/);
  });
});

describe('hosted upload base64 messages + decode', () => {
  it('hostedUploadRequiresBase64Message tells caller to pass contentBase64', () => {
    const withPath = hostedUploadRequiresBase64Message(true);
    expect(withPath).toMatch(/localPath was provided/);
    expect(withPath).toMatch(/contentBase64/);
    expect(withPath).toMatch(/Cloud Run/);
    const bare = hostedUploadRequiresBase64Message(false);
    expect(bare).not.toMatch(/localPath was provided/);
    expect(bare).toMatch(/contentBase64/);
  });

  it('deskUploadNeedsLocalPathMessage mentions hosted contentBase64', () => {
    const msg = deskUploadNeedsLocalPathMessage();
    expect(msg).toMatch(/localPath is required on desk/);
    expect(msg).toMatch(/contentBase64/);
  });

  it('decodeContentBase64 validates and decodes standard base64', () => {
    const buf = decodeContentBase64(Buffer.from('hello-upload').toString('base64'));
    expect(buf.toString('utf8')).toBe('hello-upload');
  });

  it('decodeContentBase64 rejects empty and invalid alphabet', () => {
    expect(() => decodeContentBase64('')).toThrow(/empty/i);
    expect(() => decodeContentBase64('   ')).toThrow(/empty/i);
    expect(() => decodeContentBase64('!!!not-base64!!!')).toThrow(/not valid base64/i);
  });
});

