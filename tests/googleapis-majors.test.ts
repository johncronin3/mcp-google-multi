/**
 * Isolate contract for bakissation Dependabot #177 (@googleapis/admin 33,
 * chat 47, drive 22). No live Google calls — constructors + method surface only.
 * Hosted drive_upload contentBase64 lives on feat/hosted-drive-upload-base64,
 * not this house `dev` isolate tip; media.body still covers Readable/Buffer.
 */
import { describe, expect, it } from 'vitest';
import { admin as adminClient } from '@googleapis/admin';
import { chat as chatClient } from '@googleapis/chat';
import { drive as driveClient } from '@googleapis/drive';
import { gmail as gmailClient } from '@googleapis/gmail';

describe('googleapis majors client surface (no credentials)', () => {
  it('Drive v3 still exposes files.create / get / export / update', () => {
    const drive = driveClient({ version: 'v3' });
    expect(typeof drive.files.create).toBe('function');
    expect(typeof drive.files.get).toBe('function');
    expect(typeof drive.files.export).toBe('function');
    expect(typeof drive.files.update).toBe('function');
    expect(typeof drive.files.list).toBe('function');
  });

  it('Gmail v1 still exposes messages.send / get and drafts.create', () => {
    const gmail = gmailClient({ version: 'v1' });
    expect(typeof gmail.users.messages.send).toBe('function');
    expect(typeof gmail.users.messages.get).toBe('function');
    expect(typeof gmail.users.messages.attachments.get).toBe('function');
    expect(typeof gmail.users.drafts.create).toBe('function');
  });

  it('Chat v1 still exposes spaces.list and spaces.messages.create', () => {
    const chat = chatClient({ version: 'v1' });
    expect(typeof chat.spaces.list).toBe('function');
    expect(typeof chat.spaces.get).toBe('function');
    expect(typeof chat.spaces.messages.create).toBe('function');
    expect(typeof chat.spaces.messages.list).toBe('function');
  });

  it('Admin directory_v1 and reports_v1 still construct', () => {
    const directory = adminClient({ version: 'directory_v1' });
    const reports = adminClient({ version: 'reports_v1' });
    expect(typeof directory.users.list).toBe('function');
    expect(typeof reports.activities.list).toBe('function');
  });
});

describe('house multi-layer still loads after googleapis majors', () => {
  it('Streamable HTTP listener and session-grant helpers export', async () => {
    const http = await import('../src/http.js');
    const grant = await import('../src/session-grant.js');
    expect(typeof http.createHttpRequestListener).toBe('function');
    expect(typeof http.publicMcpHost).toBe('function');
    expect(typeof grant.setSessionGrant).toBe('function');
    expect(typeof grant.allowedAccounts).toBe('function');
    expect(typeof grant.assertAccountAllowed).toBe('function');
  });
});
