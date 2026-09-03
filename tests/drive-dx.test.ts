import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareLocalDest, resolveDriveUploadSource, resolveShareNotification } from '../src/tools/drive.js';
import { executeApiMethod, type ApiMethodRef } from '../src/executor.js';

describe('prepareLocalDest', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });

  it('creates a missing destination directory (recursively)', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-dx-'));
    created.push(parent);
    const savePath = path.join(parent, 'a', 'b', 'c');
    expect(fs.existsSync(savePath)).toBe(false);

    const dest = prepareLocalDest(savePath, 'report.pdf');

    expect(fs.existsSync(savePath)).toBe(true);
    expect(dest).toBe(path.join(savePath, 'report.pdf'));
  });

  it('basename-sanitizes the filename so it never escapes savePath', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-dx-'));
    created.push(parent);
    const savePath = path.join(parent, 'out');

    for (const malicious of ['../../etc/passwd', '/tmp/evil.sh', 'a/b/c.txt']) {
      const dest = prepareLocalDest(savePath, malicious);
      expect(path.resolve(dest).startsWith(path.resolve(savePath) + path.sep)).toBe(true);
    }
  });
});

describe('resolveShareNotification', () => {
  it('omits the param for anyone/domain permissions', () => {
    expect(resolveShareNotification({ type: 'anyone', role: 'reader' })).toBeUndefined();
    expect(resolveShareNotification({ type: 'domain', role: 'writer', sendNotification: false })).toBeUndefined();
  });

  it('forces notification on ownership transfers (cannot be disabled)', () => {
    expect(resolveShareNotification({ type: 'user', role: 'owner', sendNotification: false })).toBe(true);
    expect(resolveShareNotification({ type: 'user', role: 'writer', transferOwnership: true, sendNotification: false })).toBe(true);
  });

  it('honors the caller flag for regular user/group shares, defaulting to true', () => {
    expect(resolveShareNotification({ type: 'user', role: 'writer' })).toBe(true);
    expect(resolveShareNotification({ type: 'user', role: 'writer', sendNotification: false })).toBe(false);
    expect(resolveShareNotification({ type: 'group', role: 'reader', sendNotification: true })).toBe(true);
  });
});

describe('executeApiMethod binary/export steering', () => {
  const exportMethod: ApiMethodRef = {
    id: 'drive.files.export',
    httpMethod: 'GET',
    path: 'drive/v3/files/{fileId}/export',
    baseUrl: 'https://www.googleapis.com/',
    requiredParams: ['fileId', 'mimeType'],
  };

  async function payload(method: ApiMethodRef, args: Parameters<typeof executeApiMethod>[1]) {
    const res: any = await executeApiMethod(method, args);
    expect(res.isError).toBe(true);
    return JSON.parse(res.content[0].text);
  }

  it('steers drive.files.export to drive_export before any network call', async () => {
    const p = await payload(exportMethod, { account: 'test' });
    expect(p.error).toBe('binary_unsupported');
    expect(p.hint).toContain('drive_export');
  });

  it('still blocks alt=media downloads', async () => {
    const getMethod: ApiMethodRef = {
      id: 'drive.files.get',
      httpMethod: 'GET',
      path: 'drive/v3/files/{fileId}',
      baseUrl: 'https://www.googleapis.com/',
      requiredParams: ['fileId'],
    };
    const p = await payload(getMethod, { account: 'test', queryParams: { alt: 'media' } });
    expect(p.error).toBe('binary_unsupported');
    expect(p.hint).toContain('drive_download');
  });
});

describe('resolveDriveUploadSource (hosted vs desk)', () => {
  const sample = Buffer.from('hello-upload');
  const b64 = sample.toString('base64');

  it('hosted prefers contentBase64 when both provided', () => {
    const res = resolveDriveUploadSource({
      hosted: true,
      localPath: '/home/user/secret.pdf',
      contentBase64: b64,
      filename: 'report.pdf',
      mimeTypeArg: 'application/pdf',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.media.kind).toBe('bytes');
    if (res.media.kind !== 'bytes') return;
    expect(res.media.buffer.equals(sample)).toBe(true);
    expect(res.media.mimeType).toBe('application/pdf');
  });

  it('hosted with only localPath returns clear base64 error (no pretend read)', () => {
    const res = resolveDriveUploadSource({
      hosted: true,
      localPath: '/home/johncronin3/Git_Projects/foo.bin',
      filename: 'foo.bin',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/contentBase64/);
    expect(res.message).toMatch(/localPath was provided|cannot see/i);
    expect(res.message).not.toMatch(/ENOENT|createReadStream/);
  });

  it('hosted with neither source asks for contentBase64', () => {
    const res = resolveDriveUploadSource({
      hosted: true,
      filename: 'x.txt',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/contentBase64/);
  });

  it('hosted infers mime from filename when contentBase64 given', () => {
    const res = resolveDriveUploadSource({
      hosted: true,
      contentBase64: b64,
      filename: 'notes.txt',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.media.kind).toBe('bytes');
    if (res.media.kind !== 'bytes') return;
    expect(res.media.mimeType).toMatch(/text\/plain/);
  });

  it('hosted rejects empty decoded contentBase64', () => {
    const res = resolveDriveUploadSource({
      hosted: true,
      contentBase64: '',
      filename: 'empty.bin',
    });
    expect(res.ok).toBe(false);
  });

  it('prefers contentBase64 on desk when both given', () => {
    const res = resolveDriveUploadSource({
      hosted: false,
      localPath: '/tmp/desk-file.docx',
      contentBase64: b64,
      filename: 'report.pdf',
      mimeTypeArg: 'application/pdf',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.media.kind).toBe('bytes');
    if (res.media.kind !== 'bytes') return;
    expect(res.media.buffer.equals(sample)).toBe(true);
    expect(res.media.mimeType).toBe('application/pdf');
  });

  it('desk accepts contentBase64 alone', () => {
    const res = resolveDriveUploadSource({
      hosted: false,
      contentBase64: b64,
      filename: 'only-b64.txt',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.media.kind).toBe('bytes');
  });

  it('desk without either source requires localPath', () => {
    const res = resolveDriveUploadSource({
      hosted: false,
      filename: 'missing.txt',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/localPath is required on desk/);
  });

  it('desk localPath-only keeps createReadStream path source', () => {
    const res = resolveDriveUploadSource({
      hosted: false,
      localPath: '/tmp/desk-file.docx',
      filename: 'ignored-for-mime.docx',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.media.kind).toBe('path');
    if (res.media.kind !== 'path') return;
    expect(res.media.localPath).toBe('/tmp/desk-file.docx');
    expect(res.media.mimeType).toMatch(/wordprocessingml|msword|octet-stream/i);
  });
});

