// HTTP helpers and the error type publishers throw.
import fs from 'node:fs';
import { Readable } from 'node:stream';

/** Why a publish step failed, and what the scheduler should do about it. */
export class PublishError extends Error {
  constructor(
    message: string,
    public opts: {
      /** Worth trying again later (rate limits, outages, timeouts). */
      retryable?: boolean;
      /** The account's sign-in no longer works; it must be connected again. */
      reconnect?: boolean;
      /** Start over from scratch on retry (e.g. an expired upload). */
      resetState?: boolean;
      /** Wait at least this long before retrying. */
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
  }
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

const TIMEOUT_MS = 120_000;

export async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS) });
  } catch (err) {
    throw new PublishError(`Couldn't reach ${new URL(url).host} (${(err as Error).message}).`, { retryable: true });
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

export const form = (fields: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v != null) p.set(k, String(v));
  return p;
};

export const query = (url: string, fields: Record<string, string | number | boolean | undefined | null>) => {
  const q = form(fields).toString();
  return q ? `${url}${url.includes('?') ? '&' : '?'}${q}` : url;
};

/** A file, or part of it, as a request body that streams from disk. */
export function fileBody(path: string, start = 0, end?: number): { body: ReadableStream; duplex: 'half' } {
  const stream = fs.createReadStream(path, { start, end });
  return { body: Readable.toWeb(stream) as unknown as ReadableStream, duplex: 'half' };
}

export async function readChunk(path: string, start: number, length: number): Promise<Buffer> {
  const fh = await fs.promises.open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Retryable HTTP statuses: rate limits and server-side trouble. */
export const isTransient = (status: number) => status === 429 || status >= 500;
