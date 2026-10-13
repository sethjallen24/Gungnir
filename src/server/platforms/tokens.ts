// Access tokens for a connection, refreshed shortly before they expire. Google tokens last an
// hour and TikTok's a day; both come with a refresh token. Meta's Page tokens don't expire.
import { config } from '../config.js';
import type { DB } from '../db.js';
import type { ConnectionRow } from '../repo.js';
import { decrypt, encrypt } from '../security.js';
import { PublishError, form, request } from './http.js';

const MARGIN_MS = 5 * 60_000;

async function refreshGoogle(c: ConnectionRow) {
  const refresh = decrypt(c.refresh_enc);
  if (!refresh) throw new PublishError('The YouTube sign-in has no refresh token. Connect the channel again.', { reconnect: true });
  const res = await request(config.endpoints.googleToken, {
    method: 'POST',
    body: form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: config.google.clientId, client_secret: config.google.clientSecret }),
  });
  if (res.json?.error === 'invalid_grant') {
    throw new PublishError('Google no longer accepts this YouTube sign-in (it was revoked, or expired after 7 days because the Google app is still in Testing). Connect the channel again.', {
      reconnect: true,
    });
  }
  if (res.status >= 300 || !res.json?.access_token) throw new PublishError(`Couldn't refresh the YouTube sign-in: ${res.json?.error_description ?? res.json?.error ?? res.status}`, { retryable: true });
  return { access: res.json.access_token as string, expiresIn: Number(res.json.expires_in ?? 3600), refresh: (res.json.refresh_token as string) ?? refresh, refreshExpiresIn: null };
}

async function refreshTikTok(c: ConnectionRow) {
  const refresh = decrypt(c.refresh_enc);
  if (!refresh || (c.refresh_expires_at && c.refresh_expires_at < Date.now())) {
    throw new PublishError('The TikTok sign-in expired. Connect the account again.', { reconnect: true });
  }
  const res = await request(`${config.endpoints.tiktokApi}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, grant_type: 'refresh_token', refresh_token: refresh }),
  });
  if (res.json?.error === 'invalid_grant' || res.json?.error?.code === 'invalid_grant') {
    throw new PublishError('TikTok no longer accepts this sign-in. Connect the account again.', { reconnect: true });
  }
  if (res.status >= 300 || !res.json?.access_token) {
    throw new PublishError(`Couldn't refresh the TikTok sign-in: ${res.json?.error_description ?? res.json?.error?.message ?? res.json?.error ?? res.status}`, { retryable: true });
  }
  // TikTok can rotate the refresh token, so always keep the one it sends back.
  return {
    access: res.json.access_token as string,
    expiresIn: Number(res.json.expires_in ?? 86400),
    refresh: (res.json.refresh_token as string) ?? refresh,
    refreshExpiresIn: res.json.refresh_expires_in ? Number(res.json.refresh_expires_in) : null,
  };
}

/** A working access token for the connection, refreshing (and saving) it when it's about to expire. */
export async function connectionToken(db: DB, c: ConnectionRow): Promise<string> {
  const current = decrypt(c.access_enc);
  if (current && (c.expires_at == null || c.expires_at - MARGIN_MS > Date.now())) return current;
  if (c.provider === 'meta') {
    if (current) return current;
    throw new PublishError('The Facebook sign-in expired. Connect the account again.', { reconnect: true });
  }
  const r = c.provider === 'google' ? await refreshGoogle(c) : await refreshTikTok(c);
  const now = Date.now();
  db.prepare('UPDATE connections SET access_enc = ?, refresh_enc = ?, expires_at = ?, refresh_expires_at = COALESCE(?, refresh_expires_at), updated_at = ? WHERE id = ?').run(
    encrypt(r.access),
    encrypt(r.refresh),
    now + r.expiresIn * 1000,
    r.refreshExpiresIn ? now + r.refreshExpiresIn * 1000 : null,
    now,
    c.id,
  );
  c.access_enc = encrypt(r.access);
  c.expires_at = now + r.expiresIn * 1000;
  return r.access;
}
