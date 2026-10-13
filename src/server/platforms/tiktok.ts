// TikTok: Login Kit sign-in and the Content Posting API (direct post, video uploaded in chunks).
// Until TikTok audits the app, posts can only be private ("Only me") on private accounts.
import fs from 'node:fs';
import { config } from '../config.js';
import type { DB } from '../db.js';
import type { AccountRow, ConnectionRow } from '../repo.js';
import { encrypt, newId } from '../security.js';
import { PublishError, form, isTransient, query, readChunk, request, type HttpResult } from './http.js';
import { connectionToken } from './tokens.js';
import type { ProviderModule, PublisherModule, StepResult } from './types.js';

const SCOPES = ['user.info.basic', 'video.publish'];
const api = (path: string) => `${config.endpoints.tiktokApi}${path}`;

/** TikTok answers { data, error: { code, message } } with code "ok" on success. */
function check(res: HttpResult, what: string): any {
  const code: string = res.json?.error?.code ?? (res.status < 300 ? 'ok' : `http_${res.status}`);
  if (code === 'ok' && res.status < 300) return res.json?.data ?? {};
  const message: string = res.json?.error?.message || code;
  if (code === 'access_token_invalid' || code === 'scope_not_authorized' || res.status === 401) {
    throw new PublishError(`${what}: TikTok no longer accepts this sign-in. Connect the account again.`, { reconnect: true });
  }
  if (code === 'rate_limit_exceeded' || res.status === 429) throw new PublishError(`${what}: TikTok's rate limit was reached. It will try again shortly.`, { retryable: true, retryAfterMs: 2 * 60_000 });
  if (code === 'spam_risk_too_many_posts') throw new PublishError('TikTok says this account has posted too much today. Try again tomorrow.', { retryable: true, retryAfterMs: 12 * 3600_000 });
  if (code === 'unaudited_client_can_only_post_to_private_accounts') {
    throw new PublishError('Until TikTok approves this app, it can only post to accounts set to private, with "Only me" visibility.');
  }
  if (code === 'privacy_level_option_mismatch') throw new PublishError('That TikTok privacy setting isn’t allowed for this account any more. Edit the post and pick another.');
  throw new PublishError(`${what}: ${message}`, { retryable: isTransient(res.status) });
}

const post = async (path: string, token: string, body: unknown, what: string) =>
  check(
    await request(api(path), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body ?? {}),
    }),
    what,
  );

/** Facts TikTok requires the app to show and respect before each post. */
async function creatorInfo(token: string) {
  const d = await post('/v2/post/publish/creator_info/query/', token, {}, 'TikTok');
  return {
    nickname: String(d.creator_nickname ?? ''),
    username: String(d.creator_username ?? ''),
    avatarUrl: String(d.creator_avatar_url ?? ''),
    meta: {
      privacyOptions: (d.privacy_level_options as string[]) ?? [],
      maxVideoSec: Number(d.max_video_post_duration_sec ?? 0) || null,
      commentDisabled: !!d.comment_disabled,
      duetDisabled: !!d.duet_disabled,
      stitchDisabled: !!d.stitch_disabled,
      username: String(d.creator_username ?? ''),
      nickname: String(d.creator_nickname ?? ''),
      checkedAt: Date.now(),
    },
  };
}

function saveAccountInfo(db: DB, accountId: string, info: Awaited<ReturnType<typeof creatorInfo>>) {
  db.prepare("UPDATE accounts SET name = ?, handle = ?, avatar_url = ?, meta_json = ?, status = 'ok', status_detail = '' WHERE id = ?").run(
    info.nickname || info.username || 'TikTok account',
    info.username ? `@${info.username}` : '',
    info.avatarUrl,
    JSON.stringify(info.meta),
    accountId,
  );
}

export const tiktokProvider: ProviderModule = {
  provider: 'tiktok',
  label: 'TikTok',
  configured: () => !!(config.tiktok.clientKey && config.tiktok.clientSecret),

  authorizeUrl({ state, redirectUri }) {
    return query(config.endpoints.tiktokAuth, { client_key: config.tiktok.clientKey, response_type: 'code', scope: SCOPES.join(','), redirect_uri: redirectUri, state });
  },

  async complete({ db, clientId, userId, code, redirectUri }) {
    const tok = await request(api('/v2/oauth/token/'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
    });
    if (tok.status >= 300 || !tok.json?.access_token) throw new Error(tok.json?.error_description ?? tok.json?.error?.message ?? tok.json?.error ?? `HTTP ${tok.status}`);
    const t = tok.json;
    if (!String(t.scope ?? '').includes('video.publish')) throw new Error('TikTok didn’t grant permission to post. Connect again and allow posting.');
    const info = await creatorInfo(t.access_token);
    const now = Date.now();
    const existing = db.prepare("SELECT * FROM connections WHERE client_id = ? AND provider = 'tiktok' AND external_user_id = ?").get(clientId, t.open_id) as
      | ConnectionRow
      | undefined;
    const connectionId = existing?.id ?? newId();
    const name = info.nickname || info.username || 'TikTok account';
    db.transaction(() => {
      const values = [
        name,
        encrypt(t.access_token),
        encrypt(t.refresh_token),
        now + Number(t.expires_in ?? 86400) * 1000,
        t.refresh_expires_in ? now + Number(t.refresh_expires_in) * 1000 : null,
      ];
      if (existing) {
        db.prepare('UPDATE connections SET name = ?, access_enc = ?, refresh_enc = ?, expires_at = ?, refresh_expires_at = ?, updated_at = ? WHERE id = ?').run(...values, now, connectionId);
      } else {
        db.prepare(
          `INSERT INTO connections (id, client_id, provider, name, access_enc, refresh_enc, expires_at, refresh_expires_at, external_user_id, scopes, created_by, created_at, updated_at)
           VALUES (?, ?, 'tiktok', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(connectionId, clientId, ...values, t.open_id, String(t.scope ?? ''), userId, now, now);
      }
      db.prepare(
        `INSERT INTO accounts (id, client_id, connection_id, platform, external_id, name, created_at)
         VALUES (?, ?, ?, 'tiktok', ?, ?, ?)
         ON CONFLICT (client_id, platform, external_id) DO UPDATE SET connection_id = excluded.connection_id`,
      ).run(newId(), clientId, connectionId, t.open_id, name, now);
      const account = db.prepare("SELECT id FROM accounts WHERE client_id = ? AND platform = 'tiktok' AND external_id = ?").get(clientId, t.open_id) as { id: string };
      saveAccountInfo(db, account.id, info);
    })();
    return { connectionId, name, pick: false };
  },

  async refreshAccount(db: DB, account: AccountRow, connection: ConnectionRow) {
    saveAccountInfo(db, account.id, await creatorInfo(await connectionToken(db, connection)));
  },
};

const MB = 1024 * 1024;

/** TikTok's chunk rules: 5–64 MB chunks, files up to 64 MB in one, the last chunk takes the remainder. */
export function chunkPlan(size: number): { chunkSize: number; count: number } {
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

export const tiktokPublisher: PublisherModule = {
  platform: 'tiktok',
  async step(ctx): Promise<StepResult> {
    const token = await connectionToken(ctx.db, ctx.connection);
    const s = ctx.state;

    if (!s.publishId) {
      // TikTok requires reading the creator's current settings right before posting.
      const info = await creatorInfo(token);
      saveAccountInfo(ctx.db, ctx.account.id, info);
      const privacy = ctx.options.tiktokPrivacy;
      if (!privacy || !info.meta.privacyOptions.includes(privacy)) {
        throw new PublishError(`Pick who can see this TikTok post (allowed now: ${info.meta.privacyOptions.join(', ') || 'none'}).`);
      }
      const m = ctx.media[0];
      const sec = (m.duration_ms ?? 0) / 1000;
      if (info.meta.maxVideoSec && sec > info.meta.maxVideoSec) throw new PublishError(`This TikTok account can post videos up to ${info.meta.maxVideoSec} seconds.`);
      const path = ctx.filePath(m);
      const size = fs.statSync(path).size;
      const plan = chunkPlan(size);
      const init = await post(
        '/v2/post/publish/video/init/',
        token,
        {
          post_info: {
            title: ctx.caption,
            privacy_level: privacy,
            disable_comment: info.meta.commentDisabled || !!ctx.options.tiktokDisableComment,
            disable_duet: info.meta.duetDisabled || !!ctx.options.tiktokDisableDuet,
            disable_stitch: info.meta.stitchDisabled || !!ctx.options.tiktokDisableStitch,
            brand_content_toggle: !!(ctx.options.tiktokDisclose && ctx.options.tiktokBrandedContent),
            brand_organic_toggle: !!(ctx.options.tiktokDisclose && ctx.options.tiktokBrandOrganic),
          },
          source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count },
        },
        'TikTok',
      );
      const contentType = m.mime === 'video/quicktime' || m.mime === 'video/webm' ? m.mime : 'video/mp4';
      for (let i = 0; i < plan.count; i++) {
        const start = i * plan.chunkSize;
        const end = i === plan.count - 1 ? size - 1 : start + plan.chunkSize - 1;
        const res = await request(init.upload_url, {
          method: 'PUT',
          headers: { 'content-type': contentType, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` },
          body: await readChunk(path, start, end - start + 1),
          timeoutMs: 15 * 60_000,
        });
        if (res.status >= 300) throw new PublishError(`TikTok upload failed (HTTP ${res.status}).`, { retryable: true });
      }
      s.publishId = init.publish_id;
      s.username = info.username;
      s.privacy = privacy;
      s.uploadedAt = Date.now();
      ctx.save(s);
      return { status: 'wait', ms: 10_000 };
    }

    const st = await post('/v2/post/publish/status/fetch/', token, { publish_id: s.publishId }, 'TikTok');
    const status = String(st.status ?? '');
    if (status === 'FAILED') throw new PublishError(`TikTok couldn't publish the video: ${st.fail_reason ?? 'unknown reason'}.`);
    if (status !== 'PUBLISH_COMPLETE') return { status: 'wait', ms: 15_000 };
    const id = (st.publicaly_available_post_id as (string | number)[] | undefined)?.[0];
    // Public posts get an ID after TikTok's review (usually a minute); private ones never do.
    if (!id && s.privacy !== 'SELF_ONLY' && Date.now() - (s.uploadedAt ?? 0) < 30 * 60_000) return { status: 'wait', ms: 30_000 };
    return {
      status: 'done',
      externalId: id != null ? String(id) : String(s.publishId),
      url: id != null && s.username ? `https://www.tiktok.com/@${s.username}/video/${id}` : null,
    };
  },
};
