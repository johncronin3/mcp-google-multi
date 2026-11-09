// Independent spec for the r1 token format (docs/internals.md); never imports token-store.js,
// so a bug there disagrees with this file instead of itself, and high generations are seeded directly rather than rotated.
import { createHash, createHmac, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { decryptToken, deriveKey, encryptToken } from '../src/token-store.js';

const specKeys = new Map<string, Buffer>();

/** A passphrase (anything but base64 of 32 bytes) goes through scrypt before HKDF. */
export function specKey(masterKey: string): Buffer {
  let k = specKeys.get(masterKey);
  if (!k) {
    const ikm = Buffer.from(masterKey, 'base64').length === 32
      ? deriveKey(masterKey)
      : scryptSync(masterKey, 'mcp-google-multi:refresh-mac:scrypt:v1', 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    k = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'mcp-google-multi:refresh-mac:v1', 32));
    specKeys.set(masterKey, k);
  }
  return k;
}

export function specMac(masterKey: string, body: Buffer): Buffer {
  return createHmac('sha256', specKey(masterKey)).update(Buffer.concat([Buffer.from('mcp-google-multi refresh r1\n'), body])).digest();
}

export interface SpecToken {
  token: string;
  /** The store's `cur` for this token. */
  cur: string;
  /** The family's map key. */
  fid: string;
  bytes: Buffer;
}

export function specToken(masterKey: string, fid: Buffer, gen: number, opts: { rand?: Buffer; mac?: Buffer } = {}): SpecToken {
  const g = Buffer.alloc(4);
  g.writeUInt32BE(gen);
  const body = Buffer.concat([fid, g, opts.rand ?? randomBytes(16)]);
  const bytes = Buffer.concat([body, opts.mac ?? specMac(masterKey, body)]);
  return { token: `r1.${bytes.toString('base64url')}`, cur: createHash('sha256').update(bytes).digest('base64url'), fid: fid.toString('base64url'), bytes };
}

/** The decoded bytes of an r1 token. */
export const r1Bytes = (token: string): Buffer => Buffer.from(token.slice(3), 'base64url');

/** The token a rotation of `presentedToken` mints, independently of src/mcp-token.ts:
 * generation + 1, random part = HMAC-SHA256(macKey, "...r1 successor\n" || presented body)[0..16]. */
export function specSuccessor(masterKey: string, presentedToken: string): SpecToken {
  const body = r1Bytes(presentedToken).subarray(0, 36);
  const fid = body.subarray(0, 16);
  const gen = body.readUInt32BE(16);
  const rand = createHmac('sha256', specKey(masterKey)).update(Buffer.concat([Buffer.from('mcp-google-multi refresh r1 successor\n'), body])).digest().subarray(0, 16);
  return specToken(masterKey, fid, gen + 1, { rand });
}

/** First 8 hex of sha256: a family id's bytes, or an earlier-release family id string. */
export const specTag = (family: Buffer | string): string => createHash('sha256').update(family).digest('hex').slice(0, 8);

/** A deterministic 43-character earlier-release token. */
export const legacyTok = (label: string): string => createHash('sha256').update(label).digest('base64url');

export interface StoreFile {
  format?: number;
  families: Record<string, { sub: string; gen: number; cur: string; createdAt: number; usedAt: number; legacy?: string; by?: string }>;
  active: Record<string, { sub: string; issuedAt: number; family: string }>;
  spent: Record<string, string>;
}

export function seedFamilies(
  file: string,
  masterKey: string,
  families: Record<string, unknown>,
  legacy: { active?: Record<string, unknown>; spent?: Record<string, unknown> } = {},
): void {
  writeFileSync(file, encryptToken({ format: 2, families, active: legacy.active ?? {}, spent: legacy.spent ?? {} }, masterKey), { mode: 0o600 });
}

/** A file as an earlier release wrote it: no `format`, no `families`. */
export function seedLegacy(file: string, masterKey: string, active: Record<string, unknown>, spent: Record<string, unknown> = {}): void {
  writeFileSync(file, encryptToken({ active, spent }, masterKey), { mode: 0o600 });
}

export const onDisk = (file: string, masterKey: string): StoreFile => decryptToken(readFileSync(file, 'utf-8'), masterKey) as unknown as StoreFile;
