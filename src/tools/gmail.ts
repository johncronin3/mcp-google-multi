import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { coerceArray, coerceBoolean, coerceJson } from './_coerce.js';
import { gmail as gmailClient } from '@googleapis/gmail';
import { drive as driveClient } from '@googleapis/drive';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';
import {
  deskSavePathRequiredMessage,
  hostedBytesPayload,
  isHostedHttp,
  mcpJsonResult,
} from '../hosted.js';
import {
  buildRfc822Message,
  buildReplyHeaders,
  htmlToText,
  localPathUnavailableMessage,
  type MimeAttachment,
} from './gmail-mime.js';
import mime from 'mime-types';
import { sliceClean } from '../trim.js';
import type { GmailMessageHeader, GmailMessageFull, GmailAttachment } from '../types.js';
import * as path from 'path';
import * as fs from 'fs';

const accountEnum = z.enum(ACCOUNTS);

function getHeader(
  headers: { name?: string | null; value?: string | null }[] | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function collectTextParts(part: any, plain: string[], html: string[], topLevel = false): void {
  if (!part) return;
  const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
  if (!isAttachment && part.body?.data) {
    const decoded = Buffer.from(part.body.data, 'base64url').toString('utf-8');
    if (part.mimeType === 'text/html') html.push(decoded);
    // Simple (non-multipart) messages can carry any mimeType at the top level;
    // returning their raw body preserves pre-collect behavior.
    else if (part.mimeType === 'text/plain' || !part.mimeType || topLevel) plain.push(decoded);
  }
  for (const child of part.parts ?? []) {
    collectTextParts(child, plain, html);
  }
}

function decodeBody(
  payload: any,
  rawHtml = false,
): { body: string; bodyOrigin?: 'text/plain' | 'text/html' } {
  const plain: string[] = [];
  const html: string[] = [];
  collectTextParts(payload, plain, html, true);
  // Concatenating every plain leaf keeps forwarded/mixed messages whole;
  // any plain content beats HTML because alternatives duplicate the same body.
  if (plain.length > 0) return { body: plain.join('\n\n'), bodyOrigin: 'text/plain' };
  if (html.length > 0) {
    const joined = html.join('\n\n');
    return { body: rawHtml ? joined : htmlToText(joined), bodyOrigin: 'text/html' };
  }
  return { body: '' };
}

function getAttachments(payload: any): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];
  if (payload.filename && payload.body?.attachmentId) {
    const disposition = getHeader(payload.headers, 'Content-Disposition');
    const inline = disposition.toLowerCase().startsWith('inline')
      || getHeader(payload.headers, 'Content-ID') !== '';
    attachments.push({
      filename: payload.filename,
      attachmentId: payload.body.attachmentId,
      mimeType: payload.mimeType ?? 'application/octet-stream',
      ...(typeof payload.body.size === 'number' ? { sizeBytes: payload.body.size } : {}),
      ...(payload.partId ? { partId: payload.partId } : {}),
      ...(inline ? { inline: true } : {}),
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...getAttachments(part));
    }
  }
  return attachments;
}

async function resolveReplyHeaders(
  gmail: any,
  replyToMessageId: string,
): Promise<{ inReplyTo: string; references: string }> {
  try {
    const meta = await gmail.users.messages.get({
      userId: 'me',
      id: replyToMessageId,
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'References'],
    });
    const headers = meta.data.payload?.headers;
    return buildReplyHeaders(
      replyToMessageId,
      getHeader(headers, 'Message-ID'),
      getHeader(headers, 'References'),
    );
  } catch {
    // Degrade to the API id (pre-lookup behavior) rather than blocking the send.
    return { inReplyTo: replyToMessageId, references: replyToMessageId };
  }
}

const BODY_CAP_CHARS = 50_000;

export function parseMessage(
  msg: any,
  bodyCap?: number,
  opts?: { rawHtml?: boolean },
): GmailMessageFull {
  const headers = msg.payload?.headers ?? [];
  const { body, bodyOrigin } = decodeBody(msg.payload, opts?.rawHtml === true);
  const capped = bodyCap !== undefined && body.length > bodyCap;
  const messageIdHeader = getHeader(headers, 'Message-ID');
  const inReplyTo = getHeader(headers, 'In-Reply-To');
  const references = getHeader(headers, 'References');
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    date: getHeader(headers, 'Date'),
    body: capped ? sliceClean(body, bodyCap) : body,
    ...(bodyOrigin ? { bodyOrigin } : {}),
    ...(capped ? { bodyTruncated: true, bodyTotalChars: body.length } : {}),
    ...(messageIdHeader ? { messageIdHeader } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
    ...(msg.labelIds ? { labelIds: msg.labelIds } : {}),
    ...(msg.internalDate ? { internalDate: msg.internalDate } : {}),
    attachments: getAttachments(msg.payload),
  };
}

type AttachmentSpec = {
  driveFileId?: string;
  messageId?: string;
  attachmentId?: string;
  path?: string;
  filename?: string;
  mimeType?: string;
};

const attachmentSpecSchema = z.object({
  driveFileId: z.string().optional()
    .describe('Drive file ID — hosted-safe; Cloud Run fetches bytes via Drive API on this account'),
  messageId: z.string().optional()
    .describe('Gmail message ID to copy an attachment from (requires attachmentId)'),
  attachmentId: z.string().optional()
    .describe('Gmail attachment ID from gmail_read (requires messageId)'),
  path: z.string().optional()
    .describe('Absolute path on the MCP host disk. Desktop-only; hosted Cloud Run cannot see laptop paths'),
  filename: z.string().optional().describe('Override filename on the MIME part'),
  mimeType: z.string().optional().describe('Override MIME type'),
}).superRefine((val, ctx) => {
  const hasDrive = Boolean(val.driveFileId);
  const hasPath = Boolean(val.path);
  const hasGmail = Boolean(val.messageId) || Boolean(val.attachmentId);
  const n = Number(hasDrive) + Number(hasPath) + Number(hasGmail);
  if (n !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Each attachment needs exactly one source: driveFileId, path, or messageId+attachmentId',
    });
    return;
  }
  if (hasGmail && (!val.messageId || !val.attachmentId)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Gmail copy attachments require both messageId and attachmentId',
    });
  }
});

const attachmentsField = coerceJson(z.array(attachmentSpecSchema)).optional()
  .describe(
    'Optional attachments. Hosted: pass driveFileId (Drive is the hosted path) or messageId+attachmentId. ' +
    'path is desktop-only; hosted Cloud Run cannot see laptop paths.',
  );

function asBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') return Buffer.from(data, 'binary');
  throw new Error('Drive files.get alt=media returned no binary data');
}

function findAttachmentMeta(
  payload: any,
  attachmentId: string,
): { filename: string; mimeType: string } | undefined {
  if (payload?.body?.attachmentId === attachmentId) {
    return {
      filename: payload.filename || 'attachment',
      mimeType: payload.mimeType || 'application/octet-stream',
    };
  }
  for (const part of payload?.parts ?? []) {
    const found = findAttachmentMeta(part, attachmentId);
    if (found) return found;
  }
  return undefined;
}

async function resolveOneAttachment(
  gmail: any,
  drive: any,
  spec: AttachmentSpec,
): Promise<MimeAttachment> {
  if (spec.path) {
    if (isHostedHttp()) {
      throw new Error(localPathUnavailableMessage(spec.path));
    }
    try {
      await fs.promises.access(spec.path, fs.constants.R_OK);
    } catch {
      throw new Error(localPathUnavailableMessage(spec.path));
    }
    const data = await fs.promises.readFile(spec.path);
    const filename = spec.filename || path.basename(spec.path);
    const looked = mime.lookup(spec.path);
    const mimeType = spec.mimeType || (looked || 'application/octet-stream');
    return { filename, mimeType, data };
  }

  if (spec.driveFileId) {
    const meta = await drive.files.get({
      fileId: spec.driveFileId,
      fields: 'id,name,mimeType',
      supportsAllDrives: true,
    });
    const name = meta.data.name ?? 'attachment';
    const mimeType = meta.data.mimeType ?? 'application/octet-stream';
    if (typeof mimeType === 'string' && mimeType.startsWith('application/vnd.google-apps.')) {
      throw new Error(
        `Drive file "${name}" is a Google Workspace native type (${mimeType}); ` +
          'files.get alt=media cannot download it. Export a binary (drive_export) and attach that file id instead.',
      );
    }
    const res = await drive.files.get(
      { fileId: spec.driveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    );
    return {
      filename: spec.filename || name,
      mimeType: spec.mimeType || mimeType,
      data: asBuffer(res.data),
    };
  }

  if (spec.messageId && spec.attachmentId) {
    let filename = spec.filename;
    let mimeType = spec.mimeType;
    if (!filename || !mimeType) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: spec.messageId,
        format: 'full',
      });
      const meta = findAttachmentMeta(msg.data.payload, spec.attachmentId);
      filename = filename || meta?.filename || 'attachment';
      mimeType = mimeType || meta?.mimeType || 'application/octet-stream';
    }
    const res = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: spec.messageId,
      id: spec.attachmentId,
    });
    const raw = res.data.data;
    if (!raw) throw new Error('No attachment data returned');
    return {
      filename,
      mimeType,
      data: Buffer.from(raw, 'base64url'),
    };
  }

  throw new Error('Each attachment needs exactly one source: driveFileId, path, or messageId+attachmentId');
}

async function resolveAttachments(
  gmail: any,
  auth: any,
  specs: AttachmentSpec[] | undefined,
): Promise<MimeAttachment[]> {
  if (!specs?.length) return [];
  const drive = driveClient({ version: 'v3', auth });
  const out: MimeAttachment[] = [];
  for (const spec of specs) {
    out.push(await resolveOneAttachment(gmail, drive, spec));
  }
  return out;
}

async function composeEncodedRaw(
  account: Account,
  gmail: any,
  auth: any,
  args: {
    to: string;
    subject: string;
    body: string;
    htmlBody?: string;
    cc?: string;
    replyToMessageId?: string;
    attachments?: AttachmentSpec[];
  },
): Promise<string> {
  const config = (await import('../accounts.js')).ACCOUNT_CONFIG[account];
  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (args.replyToMessageId) {
    const h = await resolveReplyHeaders(gmail, args.replyToMessageId);
    inReplyTo = h.inReplyTo;
    references = h.references;
  }
  const attachments = await resolveAttachments(gmail, auth, args.attachments);
  const rawMessage = buildRfc822Message({
    from: config.email,
    to: args.to,
    subject: args.subject,
    body: args.body,
    htmlBody: args.htmlBody,
    cc: args.cc,
    inReplyTo,
    references,
    attachments,
  });
  return Buffer.from(rawMessage, 'utf-8').toString('base64url');
}

export function registerGmailTools(server: ToolRegistry): void {
  server.registerTool(
    'gmail_search',
    {
      description: 'Search messages in a Gmail account',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        query: z.string().describe('Gmail search syntax, e.g. "from:monaam is:unread"'),
        maxResults: z.number().min(1).max(100).default(20).optional()
          .describe('Max results to return (default: 20, max: 100)'),
      },
    },
    async ({ account, query, maxResults }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });

        const listRes = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: maxResults ?? 20,
        });

        const messages = listRes.data.messages ?? [];
        const results: GmailMessageHeader[] = [];

        // Bounded parallelism: chunked Promise.all keeps order and avoids
        // hammering the per-user quota with an unbounded fan-out.
        const CHUNK_SIZE = 10;
        for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
          const details = await Promise.all(
            messages.slice(i, i + CHUNK_SIZE).map((m) => gmail.users.messages.get({
              userId: 'me',
              id: m.id!,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date'],
            })),
          );
          for (const detail of details) {
            results.push({
              id: detail.data.id ?? '',
              threadId: detail.data.threadId ?? '',
              subject: getHeader(detail.data.payload?.headers, 'Subject'),
              from: getHeader(detail.data.payload?.headers, 'From'),
              to: getHeader(detail.data.payload?.headers, 'To'),
              date: getHeader(detail.data.payload?.headers, 'Date'),
              snippet: detail.data.snippet ?? '',
              labelIds: detail.data.labelIds ?? [],
            });
          }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );
  server.registerTool(
    'gmail_read',
    {
      description: 'Read a full Gmail message by ID (body capped at 50k chars unless full=true)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('Gmail message ID'),
        full: coerceBoolean.optional().describe('Return the entire body without the character cap'),
        rawHtml: coerceBoolean.optional()
          .describe('Return the HTML body unconverted instead of the plain-text rendering (HTML-only messages)'),
      },
    },
    async ({ account, messageId, full, rawHtml }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });

        const res = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        });

        const result = parseMessage(res.data, full ? undefined : BODY_CAP_CHARS, { rawHtml });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );
  server.registerTool(
    'gmail_read_thread',
    {
      description: 'Read all messages in a Gmail thread (bodies capped at 50k chars each unless full=true). mode=summary returns headers + snippets only.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        threadId: z.string().describe('Gmail thread ID'),
        full: coerceBoolean.optional().describe('Return entire bodies without the character cap'),
        rawHtml: coerceBoolean.optional()
          .describe('Return HTML bodies unconverted instead of the plain-text rendering (HTML-only messages)'),
        mode: z.enum(['full', 'summary']).default('full')
          .describe('full = complete bodies; summary = per-message headers and snippet only'),
      },
    },
    async ({ account, threadId, full, rawHtml, mode }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });

        if (mode === 'summary') {
          const res = await gmail.users.threads.get({
            userId: 'me',
            id: threadId,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID'],
          });
          const summaries = (res.data.messages ?? []).map((m) => ({
            id: m.id ?? '',
            from: getHeader(m.payload?.headers, 'From'),
            to: getHeader(m.payload?.headers, 'To'),
            subject: getHeader(m.payload?.headers, 'Subject'),
            date: getHeader(m.payload?.headers, 'Date'),
            snippet: m.snippet ?? '',
            labelIds: m.labelIds ?? [],
          }));
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(summaries, null, 2) }],
          };
        }

        const res = await gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        });

        const messages = (res.data.messages ?? []).map((m) => parseMessage(m, full ? undefined : BODY_CAP_CHARS, { rawHtml }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );
  server.registerTool(
    'gmail_send',
    {
      description: 'Send an email from a Gmail account, optionally with attachments',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        to: z.string().describe('Recipient(s), comma-separated'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Plain text body (always required; also used as fallback when htmlBody is set)'),
        htmlBody: z.string().optional()
          .describe('Optional HTML body. When set, sends multipart/alternative so HTML-capable clients render the rich version. Use bare tags only: <p>, <a>, <br>, <strong>, <em>, <ul><li>.'),
        cc: z.string().optional().describe('CC recipients, comma-separated'),
        replyToMessageId: z.string().optional()
          .describe('Message ID to reply to (sets In-Reply-To and References headers)'),
        replyToThreadId: z.string().optional()
          .describe('Thread ID to send the message in'),
        attachments: attachmentsField,
      },
    },
    async ({ account, to, subject, body, htmlBody, cc, replyToMessageId, replyToThreadId, attachments }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const encoded = await composeEncodedRaw(account as Account, gmail, auth, {
          to, subject, body, htmlBody, cc, replyToMessageId, attachments,
        });

        const sendParams: any = {
          userId: 'me',
          requestBody: { raw: encoded },
        };

        if (replyToThreadId) {
          sendParams.requestBody.threadId = replyToThreadId;
        }

        const res = await gmail.users.messages.send(sendParams);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ id: res.data.id, threadId: res.data.threadId }, null, 2),
          }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );
  server.registerTool(
    'gmail_download_attachment',
    {
      description:
        'Download an email attachment. Desk/stdio: writes to savePath on local disk. ' +
        'Hosted Cloud Run: returns base64 bytes in the MCP result (savePath ignored). ' +
        'Use gmail_read first to get the attachmentId.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('The Gmail message ID'),
        attachmentId: z.string().describe('The attachment ID from gmail_read response'),
        filename: z.string().describe('Filename to save as (e.g. report.xlsx)'),
        savePath: z.string().optional().describe(
          'Desk only: absolute directory path to save into (e.g. /home/user/Downloads). ' +
          'Ignored on hosted Cloud Run — bytes are returned in the tool result.',
        ),
      },
    },
    async ({ account, messageId, attachmentId, filename, savePath }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });

        const res = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: attachmentId,
        });

        const data = res.data.data;
        if (!data) throw new Error('No attachment data returned');

        const buffer = Buffer.from(data, 'base64url');
        const safeName = path.basename(filename);
        const looked = mime.lookup(safeName);
        const mimeType = (looked || 'application/octet-stream') as string;

        if (isHostedHttp()) {
          return mcpJsonResult(
            hostedBytesPayload({
              filename: safeName,
              mimeType,
              data: buffer,
              savePathProvided: Boolean(savePath),
            }),
          );
        }

        if (!savePath) {
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: deskSavePathRequiredMessage() }],
          };
        }

        // Strip path components so callers can't escape savePath via "../".
        const fullPath = path.join(savePath, safeName);
        await fs.promises.writeFile(fullPath, buffer, { mode: 0o600 });

        return {
          content: [{ type: 'text' as const, text: `Saved to ${fullPath} (${buffer.length} bytes)` }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );
  server.registerTool(
    'gmail_create_draft',
    {
      description: 'Create a Gmail draft without sending, optionally with attachments',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        to: z.string().describe('Recipient(s), comma-separated'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Plain text body (always required; also used as fallback when htmlBody is set)'),
        htmlBody: z.string().optional()
          .describe('Optional HTML body. When set, drafts as multipart/alternative so HTML-capable clients render the rich version. Use bare tags only: <p>, <a>, <br>, <strong>, <em>, <ul><li>.'),
        cc: z.string().optional().describe('CC recipients, comma-separated'),
        replyToMessageId: z.string().optional()
          .describe('Message ID to reply to (sets In-Reply-To and References headers)'),
        replyToThreadId: z.string().optional()
          .describe('Thread ID to associate the draft with'),
        attachments: attachmentsField,
      },
    },
    async ({ account, to, subject, body, htmlBody, cc, replyToMessageId, replyToThreadId, attachments }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const encoded = await composeEncodedRaw(account as Account, gmail, auth, {
          to, subject, body, htmlBody, cc, replyToMessageId, attachments,
        });

        const draftParams: any = {
          userId: 'me',
          requestBody: {
            message: { raw: encoded },
          },
        };

        if (replyToThreadId) {
          draftParams.requestBody.message.threadId = replyToThreadId;
        }

        const res = await gmail.users.drafts.create(draftParams);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              { draftId: res.data.id, threadId: res.data.message?.threadId },
              null,
              2,
            ),
          }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_modify_labels',
    {
      description: 'Add or remove labels on a Gmail message. Use system label IDs like STARRED, UNREAD, INBOX, TRASH, or custom label IDs from gmail_list_labels.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('Gmail message ID'),
        addLabelIds: coerceArray(z.string()).optional().describe('Label IDs to add'),
        removeLabelIds: coerceArray(z.string()).optional().describe('Label IDs to remove'),
      },
    },
    async ({ account, messageId, addLabelIds, removeLabelIds }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: {
            addLabelIds: addLabelIds ?? [],
            removeLabelIds: removeLabelIds ?? [],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_trash',
    {
      description: 'Move a Gmail message to Trash (recoverable)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('Gmail message ID'),
      },
    },
    async ({ account, messageId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.messages.trash({ userId: 'me', id: messageId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_delete',
    {
      description: 'Permanently and irreversibly delete a Gmail message. No recovery possible.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('Gmail message ID'),
      },
    },
    async ({ account, messageId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        await gmail.users.messages.delete({ userId: 'me', id: messageId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, messageId }, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_batch_modify',
    {
      description: 'Add/remove labels across up to 1000 Gmail messages at once. Useful for bulk archiving, marking as read, etc.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageIds: coerceArray(z.string()).describe('Message IDs (up to 1000)'),
        addLabelIds: coerceArray(z.string()).optional().describe('Label IDs to add'),
        removeLabelIds: coerceArray(z.string()).optional().describe('Label IDs to remove'),
      },
    },
    async ({ account, messageIds, addLabelIds, removeLabelIds }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        await gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: messageIds,
            addLabelIds: addLabelIds ?? [],
            removeLabelIds: removeLabelIds ?? [],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ modified: messageIds.length }, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_batch_delete',
    {
      description: 'Permanently delete multiple Gmail messages. Irreversible.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageIds: coerceArray(z.string()).describe('Message IDs (up to 1000)'),
      },
    },
    async ({ account, messageIds }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        await gmail.users.messages.batchDelete({
          userId: 'me',
          requestBody: { ids: messageIds },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: messageIds.length }, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_list_drafts',
    {
      description: 'List all drafts in a Gmail mailbox',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        maxResults: z.number().min(1).max(100).default(20).optional()
          .describe('Max results to return (default: 20)'),
        query: z.string().optional().describe('Gmail search syntax to filter drafts'),
      },
    },
    async ({ account, maxResults, query }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.drafts.list({
          userId: 'me',
          maxResults: maxResults ?? 20,
          q: query,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.drafts ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_get_draft',
    {
      description: 'Read the full content of a specific Gmail draft',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        draftId: z.string().describe('Draft ID'),
      },
    },
    async ({ account, draftId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.drafts.get({
          userId: 'me',
          id: draftId,
          format: 'full',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_send_draft',
    {
      description: 'Send an existing Gmail draft by its draft ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        draftId: z.string().describe('Draft ID to send'),
      },
    },
    async ({ account, draftId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.drafts.send({
          userId: 'me',
          requestBody: { id: draftId },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_list_labels',
    {
      description: 'List all Gmail labels (system and user-defined). Use to get label IDs for gmail_modify_labels.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
      },
    },
    async ({ account }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.labels.list({ userId: 'me' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.labels ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_create_label',
    {
      description: 'Create a new custom Gmail label',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        name: z.string().describe('Label name, e.g. "Ideacrafters/ComptaLegal"'),
        messageListVisibility: z.enum(['show', 'hide']).optional()
          .describe('Whether messages with this label show in message list (default: show)'),
        labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional()
          .describe('Whether the label appears in the label list (default: labelShow)'),
      },
    },
    async ({ account, name, messageListVisibility, labelListVisibility }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name,
            messageListVisibility: messageListVisibility ?? 'show',
            labelListVisibility: labelListVisibility ?? 'labelShow',
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_delete_label',
    {
      description: 'Permanently delete a Gmail label and remove it from all messages',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        labelId: z.string().describe('Label ID to delete'),
      },
    },
    async ({ account, labelId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        await gmail.users.labels.delete({ userId: 'me', id: labelId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, labelId }, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_get_profile',
    {
      description: 'Get Gmail account profile: email address, total messages, total threads, and current history ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
      },
    },
    async ({ account }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.getProfile({ userId: 'me' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_list_history',
    {
      description: 'Get all mailbox changes since a given historyId. Useful for detecting new emails since last check.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        startHistoryId: z.string().describe('History ID from a previous gmail_get_profile or gmail_read response'),
        maxResults: z.number().min(1).max(500).default(100).optional()
          .describe('Max results to return (default: 100)'),
        historyTypes: coerceArray(z.enum(['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'])).optional()
          .describe('Filter by history event types'),
      },
    },
    async ({ account, startHistoryId, maxResults, historyTypes }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          maxResults: maxResults ?? 100,
          historyTypes: historyTypes as any,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_get_vacation',
    {
      description: 'Read current Gmail vacation responder settings',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
      },
    },
    async ({ account }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.settings.getVacation({ userId: 'me' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_set_vacation',
    {
      description: 'Enable or disable Gmail vacation responder with a custom message',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        enableAutoReply: coerceBoolean.describe('Whether to enable the vacation responder'),
        responseSubject: z.string().optional().describe('Subject line for auto-reply'),
        responseBodyPlainText: z.string().optional().describe('Plain text body for auto-reply'),
        startTime: z.string().optional().describe('Start time as Unix timestamp in ms'),
        endTime: z.string().optional().describe('End time as Unix timestamp in ms'),
        restrictToContacts: coerceBoolean.optional().describe('Only reply to contacts (default: false)'),
        restrictToDomain: coerceBoolean.optional().describe('Only reply to same domain (default: false)'),
      },
    },
    async ({ account, enableAutoReply, responseSubject, responseBodyPlainText, startTime, endTime, restrictToContacts, restrictToDomain }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.settings.updateVacation({
          userId: 'me',
          requestBody: {
            enableAutoReply,
            responseSubject,
            responseBodyPlainText,
            startTime,
            endTime,
            restrictToContacts: restrictToContacts ?? false,
            restrictToDomain: restrictToDomain ?? false,
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );
}

function handleGmailError(error: any, account: Account) {
  return handleGoogleApiError(error, account);
}
