// Passwords, session tokens, encrypted platform tokens and signed media links.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** A random token for a cookie or link; only its hash is stored. */
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const newId = () => crypto.randomUUID();

/** AES-256-GCM, so platform tokens are useless if the database file leaks without the key. */
export function encrypt(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.secretKey, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

export function decrypt(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1') throw new Error('Unknown token format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.secretKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

const sign = (value: string) => crypto.createHmac('sha256', config.secretKey).update(value).digest('base64url');

/**
 * A link the platforms can fetch a media file from without signing in (Instagram and Facebook
 * fetch images by URL). It stops working after `ttlMs`.
 */
export function signedMediaUrl(mediaId: string, fileName: string, ttlMs = 6 * 3600_000): string {
  const exp = Date.now() + ttlMs;
  return `${config.publicUrl}/m/${mediaId}/${encodeURIComponent(fileName)}?exp=${exp}&sig=${sign(`${mediaId}.${exp}`)}`;
}

export function checkMediaSignature(mediaId: string, exp: string, sig: string): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = Buffer.from(sign(`${mediaId}.${exp}`));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
