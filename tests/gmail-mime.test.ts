import { describe, it, expect } from 'vitest';
import {
  normalizeBodyLineEndings,
  buildReplyHeaders,
  htmlToText,
  encodeBase64Mime,
  buildAttachmentPart,
  buildMultipartMixed,
  buildRfc822Message,
  localPathUnavailableMessage,
  type MimeAttachment,
} from '../src/tools/gmail-mime.js';

describe('normalizeBodyLineEndings', () => {
  it('returns empty input unchanged', () => {
    expect(normalizeBodyLineEndings('')).toBe('');
  });

  it('leaves an already-CRLF body unchanged', () => {
    expect(normalizeBodyLineEndings('a\r\nb\r\nc')).toBe('a\r\nb\r\nc');
  });

  it('converts bare LF to CRLF', () => {
    expect(normalizeBodyLineEndings('line1\nline2\n\nline3'))
      .toBe('line1\r\nline2\r\n\r\nline3');
  });

  it('converts bare CR to CRLF', () => {
    expect(normalizeBodyLineEndings('a\rb\rc')).toBe('a\r\nb\r\nc');
  });

  it('normalizes mixed CRLF + LF + CR', () => {
    expect(normalizeBodyLineEndings('a\r\nb\nc\rd')).toBe('a\r\nb\r\nc\r\nd');
  });

  it('preserves blank lines between paragraphs', () => {
    expect(normalizeBodyLineEndings('p1\n\np2\n\np3'))
      .toBe('p1\r\n\r\np2\r\n\r\np3');
  });

  it('does not double-encode an existing CRLF', () => {
    expect(normalizeBodyLineEndings('a\r\nb')).not.toContain('\r\r');
    expect(normalizeBodyLineEndings('a\r\nb')).not.toContain('\n\n');
  });
});

describe('htmlToText', () => {
  it('strips style, script, and head blocks including their content', () => {
    const html = '<head><title>T</title></head><style>body { color: red; }</style>'
      + '<script>if (1 < 2) { alert("x"); }</script><p>Content</p>';
    expect(htmlToText(html)).toBe('Content');
  });

  it('strips HTML comments', () => {
    expect(htmlToText('before<!-- secret note -->after')).toBe('beforeafter');
  });

  it('maps paragraphs to blank-line-separated blocks', () => {
    expect(htmlToText('<p>Hello</p><p>World</p>')).toBe('Hello\n\nWorld');
  });

  it('maps br, headings, list items, and table rows to newlines', () => {
    expect(htmlToText('one<br>two')).toBe('one\ntwo');
    expect(htmlToText('<h1>Title</h1>Body')).toBe('Title\nBody');
    expect(htmlToText('<ul><li>One</li><li>Two</li></ul>')).toBe('One\nTwo');
    expect(htmlToText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'))
      .toBe('a b\nc');
  });

  it('collapses HTML source newlines inside a paragraph to spaces', () => {
    expect(htmlToText('<p>line one\n   line two</p>')).toBe('line one line two');
  });

  it('renders links as "text (href)"', () => {
    expect(htmlToText('<a href="https://example.com/page">Read more</a>'))
      .toBe('Read more (https://example.com/page)');
    expect(htmlToText('<a class="btn" href=\'https://y.io\' target="_blank">Click</a>'))
      .toBe('Click (https://y.io)');
  });

  it('omits the href when it duplicates the text or is an anchor', () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>'))
      .toBe('https://example.com');
    expect(htmlToText('<a href="#section">Jump</a>')).toBe('Jump');
    expect(htmlToText('<a href="mailto:a@b.co">a@b.co</a>')).toBe('a@b.co');
  });

  it('strips remaining inline tags without adding whitespace', () => {
    expect(htmlToText('<p>Hello <strong>bold</strong> and <em>italic</em></p>'))
      .toBe('Hello bold and italic');
  });

  it('decodes named entities', () => {
    expect(htmlToText('Fish &amp; Chips &lt;tag&gt; &quot;q&quot; &apos;a&apos; &#39;b&#39; A&nbsp;B'))
      .toBe('Fish & Chips <tag> "q" \'a\' \'b\' A B');
  });

  it('decodes decimal and hex numeric entities', () => {
    expect(htmlToText('caf&#233; caf&#xE9; &#x1F600;')).toBe('café café 😀');
  });

  it('decodes double-encoded entities exactly once', () => {
    expect(htmlToText('&amp;lt;')).toBe('&lt;');
  });

  it('leaves unknown and invalid entities untouched', () => {
    expect(htmlToText('&bogus; &#xDFFF; &#1114112;')).toBe('&bogus; &#xDFFF; &#1114112;');
  });

  it('collapses 3+ newlines to 2 and trims line-edge whitespace', () => {
    expect(htmlToText('<p>a</p><br><br><br><p>b</p>')).toBe('a\n\nb');
    expect(htmlToText('<p>text &nbsp; </p><p>next</p>')).toBe('text\n\nnext');
  });
});

describe('buildReplyHeaders', () => {
  it('uses the parent Message-ID for both headers when there are no prior references', () => {
    expect(buildReplyHeaders('gmailid123', '<abc@mail.example.com>', ''))
      .toEqual({ inReplyTo: '<abc@mail.example.com>', references: '<abc@mail.example.com>' });
  });

  it('appends the parent Message-ID to the existing references chain', () => {
    expect(buildReplyHeaders('gmailid123', '<c@x.com>', '<a@x.com> <b@x.com>'))
      .toEqual({ inReplyTo: '<c@x.com>', references: '<a@x.com> <b@x.com> <c@x.com>' });
  });

  it('unfolds folded references whitespace into single spaces', () => {
    expect(buildReplyHeaders('g', '<c@x.com>', '<a@x.com>\r\n <b@x.com>').references)
      .toBe('<a@x.com> <b@x.com> <c@x.com>');
  });

  it('falls back to the Gmail API id when the Message-ID header is absent', () => {
    expect(buildReplyHeaders('gmailid123', '', ''))
      .toEqual({ inReplyTo: 'gmailid123', references: 'gmailid123' });
    expect(buildReplyHeaders('gmailid123', '   ', '<a@x.com>'))
      .toEqual({ inReplyTo: 'gmailid123', references: 'gmailid123' });
  });
});

function decodeEncodedWord(encoded: string): string {
  const m = encoded.match(/^=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
  if (!m) throw new Error(`Not a base64 encoded-word: ${encoded}`);
  return Buffer.from(m[1], 'base64').toString('utf-8');
}


function fakePdf(): Buffer {
  return Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\nfake-pdf-bytes\n%%EOF\n');
}

function extractBase64Payloads(mime: string): Buffer[] {
  const parts = mime.split(/\r\n--/);
  const out: Buffer[] = [];
  for (const part of parts) {
    if (!/Content-Transfer-Encoding: base64/i.test(part)) continue;
    const blank = part.indexOf('\r\n\r\n');
    if (blank < 0) continue;
    let payload = part.slice(blank + 4);
    payload = payload.replace(/\r\n--.*$/s, '');
    payload = payload.replace(/--\s*$/, '');
    const b64 = payload.replace(/\r\n/g, '').trim();
    if (b64) out.push(Buffer.from(b64, 'base64'));
  }
  return out;
}

describe('encodeBase64Mime', () => {
  it('emits RFC 2045 76-char lines and round-trips a binary buffer', () => {
    const data = Buffer.alloc(200, 0x5a);
    data[0] = 0x25;
    data[1] = 0x50;
    data[2] = 0x44;
    data[3] = 0x46;
    const encoded = encodeBase64Mime(data);
    for (const line of encoded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').equals(data)).toBe(true);
  });
});

describe('buildAttachmentPart', () => {
  it('uses encodeHeaderValue for a non-ASCII filename', () => {
    const att: MimeAttachment = {
      filename: 'résumé.pdf',
      mimeType: 'application/pdf',
      data: fakePdf(),
    };
    const part = buildAttachmentPart(att);
    expect(part).toContain('Content-Transfer-Encoding: base64');
    expect(part).toContain('Content-Disposition: attachment; filename=');
    const encodedName = encodeHeaderValue('résumé.pdf').replace(/\r\n /g, ' ');
    expect(part).toContain(`filename="${encodedName}"`);
    expect(part).toContain(`name="${encodedName}"`);
  });

  it('leaves an ASCII filename unencoded', () => {
    const part = buildAttachmentPart({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      data: fakePdf(),
    });
    expect(part).toContain('filename="invoice.pdf"');
  });
});

describe('buildMultipartMixed', () => {
  it('wraps a plain body plus a fake PDF and round-trips the bytes', () => {
    const pdf = fakePdf();
    const { contentType, body } = buildMultipartMixed(
      'text/plain; charset="UTF-8"',
      'Please find the PDF attached.',
      [{ filename: 'tiny.pdf', mimeType: 'application/pdf', data: pdf }],
    );
    expect(contentType).toMatch(/^multipart\/mixed; boundary="[^"]+"$/);
    const boundary = contentType.match(/boundary="([^"]+)"/)![1];
    expect(body).toContain(`--${boundary}\r\nContent-Type: text/plain`);
    expect(body).toContain('Content-Transfer-Encoding: 8bit');
    expect(body).toContain('Please find the PDF attached.');
    expect(body).toContain('Content-Type: application/pdf; name="tiny.pdf"');
    expect(body).toContain('Content-Disposition: attachment; filename="tiny.pdf"');
    const payloads = extractBase64Payloads(body);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].equals(pdf)).toBe(true);
    expect(payloads[0].subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('nests an existing multipart/alternative as the first part', () => {
    const alt = buildMultipartAlternative('plain', '<p>html</p>');
    const pdf = fakePdf();
    const { contentType, body } = buildMultipartMixed(alt.contentType, alt.body, [
      { filename: 'tiny.pdf', mimeType: 'application/pdf', data: pdf },
    ]);
    expect(contentType).toMatch(/^multipart\/mixed;/);
    expect(body).toContain('Content-Type: multipart/alternative;');
    expect(body).toContain('Content-Type: text/plain');
    expect(body).toContain('Content-Type: text/html');
    const mixedIdx = body.indexOf('Content-Type: multipart/alternative');
    const pdfIdx = body.indexOf('Content-Type: application/pdf');
    expect(mixedIdx).toBeGreaterThan(-1);
    expect(pdfIdx).toBeGreaterThan(mixedIdx);
    expect(extractBase64Payloads(body)[0].equals(pdf)).toBe(true);
  });

  it('emits one mixed part per attachment', () => {
    const a = Buffer.from('AAA');
    const b = Buffer.from('BBB');
    const { body } = buildMultipartMixed('text/plain; charset="UTF-8"', 'hi', [
      { filename: 'a.bin', mimeType: 'application/octet-stream', data: a },
      { filename: 'b.bin', mimeType: 'application/octet-stream', data: b },
    ]);
    const payloads = extractBase64Payloads(body);
    expect(payloads).toHaveLength(2);
    expect(payloads[0].equals(a)).toBe(true);
    expect(payloads[1].equals(b)).toBe(true);
  });
});

describe('buildRfc822Message', () => {
  it('keeps text/plain + 8bit when there are no attachments', () => {
    const raw = buildRfc822Message({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hello',
      body: 'line1\nline2',
    });
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Transfer-Encoding: 8bit');
    expect(raw).toContain('line1\r\nline2');
    expect(raw).not.toContain('multipart/mixed');
  });

  it('uses multipart/mixed around a fake PDF attachment', () => {
    const pdf = fakePdf();
    const raw = buildRfc822Message({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'PDF attached',
      body: 'See attached.',
      attachments: [{ filename: 'tiny.pdf', mimeType: 'application/pdf', data: pdf }],
    });
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="/);
    const headerBlock = raw.slice(0, raw.indexOf('\r\n\r\n'));
    expect(headerBlock).toContain('multipart/mixed');
    expect(headerBlock).not.toContain('Content-Transfer-Encoding: 8bit');
    const payloads = extractBase64Payloads(raw);
    expect(payloads[0].equals(pdf)).toBe(true);
  });

  it('wraps html alternative plus attachment', () => {
    const pdf = fakePdf();
    const raw = buildRfc822Message({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Rich',
      body: 'plain',
      htmlBody: '<p>html</p>',
      attachments: [{ filename: 'tiny.pdf', mimeType: 'application/pdf', data: pdf }],
    });
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('<p>html</p>');
    expect(extractBase64Payloads(raw)[0].equals(pdf)).toBe(true);
  });
});

describe('localPathUnavailableMessage', () => {
  it('says hosted Cloud Run cannot see laptop paths', () => {
    const msg = localPathUnavailableMessage('/home/user/docs/file.pdf');
    expect(msg).toContain('/home/user/docs/file.pdf');
    expect(msg).toMatch(/hosted Cloud Run cannot see laptop paths/i);
    expect(msg).toMatch(/desktop-only/i);
    expect(msg).toMatch(/driveFileId/i);
  });
});
