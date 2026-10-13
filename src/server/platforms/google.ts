// YouTube: a Google sign-in for one channel, and resumable video uploads.
import fs from 'node:fs';
import { config } from '../config.js';
import type { ConnectionRow } from '../repo.js';
import { encrypt, newId } from '../security.js';
import { PublishError, fileBody, form, isTransient, query, request, type HttpResult } from './http.js';
import { connectionToken } from './tokens.js';
import type { ProviderModule, PublisherModule, StepResult } from './types.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

export const googleProvider: ProviderModule = {
  provider: 'google',
  label: 'YouTube',
  configured: () => !!(config.google.clientId && config.google.clientSecret),

  authorizeUrl({ state, redirectUri }) {
    return query(config.endpoints.googleAuth, {
      client_id: config.google.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      // Always ask, so Google sends a refresh token even when access was granted before.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
  },

  async complete({ db, clientId, userId, code, redirectUri }) {
    const tok = await request(config.endpoints.googleToken, {
      method: 'POST',
      body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: config.google.clientId, client_secret: config.google.clientSecret }),
    });
    if (tok.status >= 300 || !tok.json?.access_token) throw new Error(tok.json?.error_description ?? tok.json?.error ?? `HTTP ${tok.status}`);
    const access = tok.json.access_token as string;
    const ch = await request(query(`${config.endpoints.googleApis}/youtube/v3/channels`, { part: 'snippet', mine: 'true' }), {
      headers: { authorization: `Bearer ${access}` },
    });
    const channel = ch.json?.items?.[0];
    if (!channel) throw new Error('This Google account has no YouTube channel.');
    const now = Date.now();
    const existing = db.prepare("SELECT * FROM connections WHERE client_id = ? AND provider = 'google' AND external_user_id = ?").get(clientId, channel.id) as
      | ConnectionRow
      | undefined;
    const connectionId = existing?.id ?? newId();
    const name = channel.snippet?.title ?? 'YouTube channel';
    const expiresAt = now + Number(tok.json.expires_in ?? 3600) * 1000;
    db.transaction(() => {
      if (existing) {
        db.prepare('UPDATE connections SET name = ?, access_enc = ?, refresh_enc = COALESCE(?, refresh_enc), expires_at = ?, updated_at = ? WHERE id = ?').run(
          name,
          encrypt(access),
          encrypt(tok.json.refresh_token),
          expiresAt,
          now,
          connectionId,
        );
      } else {
        db.prepare(
          `INSERT INTO connections (id, client_id, provider, external_user_id, name, access_enc, refresh_enc, expires_at, scopes, created_by, created_at, updated_at)
           VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(connectionId, clientId, channel.id, name, encrypt(access), encrypt(tok.json.refresh_token), expiresAt, String(tok.json.scope ?? ''), userId, now, now);
      }
      db.prepare(
        `INSERT INTO accounts (id, client_id, connection_id, platform, external_id, name, handle, avatar_url, created_at)
         VALUES (?, ?, ?, 'youtube', ?, ?, ?, ?, ?)
         ON CONFLICT (client_id, platform, external_id) DO UPDATE SET connection_id = excluded.connection_id, name = excluded.name,
           handle = excluded.handle, avatar_url = excluded.avatar_url, status = 'ok', status_detail = ''`,
      ).run(newId(), clientId, connectionId, channel.id, name, channel.snippet?.customUrl ?? '', channel.snippet?.thumbnails?.default?.url ?? '', now);
    })();
    return { connectionId, name, pick: false };
  },
};

function check(res: HttpResult, what: string): any {
  if (res.status < 300) return res.json;
  const reason = res.json?.error?.errors?.[0]?.reason ?? '';
  const message = res.json?.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 401) throw new PublishError(`${what}: Google rejected the sign-in. Connect the channel again.`, { reconnect: true });
  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') {
    throw new PublishError("YouTube's daily upload allowance for this app is used up. It will try again in a few hours.", { retryable: true, retryAfterMs: 3 * 3600_000 });
  }
  if (reason === 'uploadLimitExceeded') throw new PublishError('This channel has reached its daily YouTube upload limit.', { retryable: true, retryAfterMs: 6 * 3600_000 });
  throw new PublishError(`${what}: ${message}`, { retryable: isTransient(res.status) });
}

export const youtubePublisher: PublisherModule = {
  platform: 'youtube',
  async step(ctx): Promise<StepResult> {
    const token = await connectionToken(ctx.db, ctx.connection);
    const m = ctx.media[0];
    const path = ctx.filePath(m);
    const size = fs.statSync(path).size;
    const s = ctx.state;
    const auth = { authorization: `Bearer ${token}` };

    if (!s.sessionUrl) {
      const res = await request(query(`${config.endpoints.googleApis}/upload/youtube/v3/videos`, { uploadType: 'resumable', part: 'snippet,status' }), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(size), 'x-upload-content-type': m.mime },
        body: JSON.stringify({
          snippet: { title: ctx.options.title ?? '', description: ctx.caption, categoryId: '22' },
          status: { privacyStatus: ctx.options.youtubePrivacy ?? 'public', selfDeclaredMadeForKids: ctx.options.youtubeMadeForKids ?? false },
        }),
      });
      check(res, 'YouTube');
      const location = res.headers.get('location');
      if (!location) throw new PublishError('YouTube didn’t start the upload.', { retryable: true });
      s.sessionUrl = location;
      ctx.save(s);
    }

    // Find out how much YouTube already has (after a restart), then send the rest.
    let offset = 0;
    if (s.uploadStarted) {
      const probe = await request(s.sessionUrl, { method: 'PUT', headers: { ...auth, 'content-range': `bytes */${size}`, 'content-length': '0' } });
      if (probe.status === 200 || probe.status === 201) return done(probe.json?.id);
      if (probe.status === 404 || probe.status === 410) throw new PublishError('The YouTube upload session expired.', { retryable: true, resetState: true });
      if (probe.status !== 308) check(probe, 'YouTube');
      const range = probe.headers.get('range');
      offset = range ? Number(range.split('-')[1]) + 1 : 0;
    }
    s.uploadStarted = true;
    ctx.save(s);
    const res = await request(s.sessionUrl, {
      method: 'PUT',
      headers: { ...auth, 'content-type': m.mime, 'content-length': String(size - offset), ...(offset ? { 'content-range': `bytes ${offset}-${size - 1}/${size}` } : {}) },
      ...fileBody(path, offset),
      timeoutMs: 6 * 3600_000,
    });
    if (res.status === 200 || res.status === 201) return done(res.json?.id);
    if (res.status === 308 || res.status >= 500) throw new PublishError('The YouTube upload was interrupted. It will resume.', { retryable: true, retryAfterMs: 60_000 });
    check(res, 'YouTube upload');
    throw new PublishError(`YouTube upload: unexpected response ${res.status}`, { retryable: true });

    function done(id: string | undefined): StepResult {
      if (!id) throw new PublishError('YouTube finished the upload but didn’t return a video ID.', { retryable: false });
      return { status: 'done', externalId: id, url: `https://www.youtube.com/watch?v=${id}` };
    }
  },
};
