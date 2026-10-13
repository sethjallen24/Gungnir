// Meta: one Facebook login gives access to the Pages the person manages and the Instagram
// professional accounts linked to them. Both publish with the Page's own token, which doesn't
// expire when it comes from a long-lived user token.
import fs from 'node:fs';
import { config } from '../config.js';
import type { DB } from '../db.js';
import { encrypt, newId } from '../security.js';
import type { ConnectionRow } from '../repo.js';
import { PublishError, form, isTransient, query, request, type HttpResult } from './http.js';
import type { PublishContext, ProviderModule, PublisherModule, StepResult } from './types.js';

const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management'];

const graph = (path: string) => `${config.endpoints.graph}/${config.meta.graphVersion}${path}`;

/** Meta's error codes for an expired or revoked sign-in, and for throttling. */
const AUTH_CODES = new Set([102, 190, 200, 10]);
const LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002]);

function check(res: HttpResult, what: string): any {
  if (res.status < 300 && !res.json?.error) return res.json;
  const e = res.json?.error ?? {};
  const message = e.error_user_msg || e.message || `HTTP ${res.status}`;
  const code = Number(e.code);
  if (AUTH_CODES.has(code)) {
    throw new PublishError(`${what}: Meta no longer accepts this sign-in (${message}). Connect the account again.`, { reconnect: true });
  }
  if (LIMIT_CODES.has(code)) throw new PublishError(`${what}: Meta's rate limit was reached. It will try again later.`, { retryable: true, retryAfterMs: 15 * 60_000 });
  throw new PublishError(`${what}: ${message}`, { retryable: e.is_transient === true || isTransient(res.status) });
}

const get = async (path: string, token: string, fields: Record<string, string | number> = {}) =>
  check(await request(query(graph(path), { ...fields, access_token: token })), 'Meta');

const post = async (path: string, token: string, fields: Record<string, string | number | boolean | undefined>, what: string) =>
  check(await request(graph(path), { method: 'POST', body: form({ ...fields, access_token: token }) }), what);

interface CandidateData {
  platform: 'facebook' | 'instagram';
  externalId: string;
  name: string;
  handle: string;
  avatarUrl: string;
  tokenEnc: string | null;
  meta: Record<string, unknown>;
}

export const metaProvider: ProviderModule = {
  provider: 'meta',
  label: 'Facebook & Instagram',
  configured: () => !!(config.meta.appId && config.meta.appSecret),

  authorizeUrl({ state, redirectUri }) {
    return query(`${config.endpoints.facebookWww}/${config.meta.graphVersion}/dialog/oauth`, {
      client_id: config.meta.appId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      ...(config.meta.configId ? { config_id: config.meta.configId } : { scope: SCOPES.join(',') }),
    });
  },

  async complete({ db, clientId, userId, code, redirectUri }) {
    const { appId, appSecret } = config.meta;
    const short = check(
      await request(query(graph('/oauth/access_token'), { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code })),
      'Meta sign-in',
    );
    const long = check(
      await request(
        query(graph('/oauth/access_token'), { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token }),
      ),
      'Meta sign-in',
    );
    const userToken: string = long.access_token;
    const me = await get('/me', userToken, { fields: 'id,name' });

    // Every Page the person manages, with its linked Instagram account.
    const pages: any[] = [];
    let next: string | null = query(graph('/me/accounts'), {
      fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
      limit: 100,
      access_token: userToken,
    });
    while (next && pages.length < 1000) {
      const page: any = check(await request(next), 'Meta sign-in');
      pages.push(...(page.data ?? []));
      next = page.paging?.next ?? null;
    }
    if (!pages.length) throw new Error('This Facebook login doesn’t manage any Pages. Instagram and Facebook posting both need a Page.');

    const now = Date.now();
    const existing = db.prepare("SELECT * FROM connections WHERE client_id = ? AND provider = 'meta' AND external_user_id = ?").get(clientId, me.id) as
      | ConnectionRow
      | undefined;
    const connectionId = existing?.id ?? newId();
    const expiresAt = long.expires_in ? now + Number(long.expires_in) * 1000 : null;
    if (existing) {
      db.prepare('UPDATE connections SET name = ?, access_enc = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(me.name, encrypt(userToken), expiresAt, now, connectionId);
    } else {
      db.prepare(
        `INSERT INTO connections (id, client_id, provider, external_user_id, name, access_enc, expires_at, scopes, created_by, created_at, updated_at)
         VALUES (?, ?, 'meta', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(connectionId, clientId, me.id, me.name, encrypt(userToken), expiresAt, SCOPES.join(','), userId, now, now);
    }

    const candidates: CandidateData[] = [];
    for (const p of pages) {
      const tokenEnc = encrypt(p.access_token);
      candidates.push({ platform: 'facebook', externalId: p.id, name: p.name, handle: '', avatarUrl: p.picture?.data?.url ?? '', tokenEnc, meta: {} });
      const ig = p.instagram_business_account;
      if (ig?.id) {
        candidates.push({
          platform: 'instagram',
          externalId: ig.id,
          name: ig.name || ig.username || p.name,
          handle: ig.username ? `@${ig.username}` : '',
          avatarUrl: ig.profile_picture_url ?? '',
          tokenEnc,
          meta: { pageId: p.id, pageName: p.name },
        });
      }
    }
    db.transaction(() => {
      db.prepare('DELETE FROM connect_candidates WHERE connection_id = ?').run(connectionId);
      const insert = db.prepare('INSERT INTO connect_candidates (id, connection_id, data_json, created_at) VALUES (?, ?, ?, ?)');
      for (const c of candidates) insert.run(newId(), connectionId, JSON.stringify(c), now);
      // Reconnecting refreshes the tokens of accounts already added from this login.
      const update = db.prepare("UPDATE accounts SET token_enc = ?, connection_id = ?, status = 'ok', status_detail = '' WHERE client_id = ? AND platform = ? AND external_id = ?");
      for (const c of candidates) update.run(c.tokenEnc, connectionId, clientId, c.platform, c.externalId);
    })();
    return { connectionId, name: me.name, pick: true };
  },
};

export function candidateRows(db: DB, connectionId: string): { id: string; data: CandidateData }[] {
  return (db.prepare('SELECT id, data_json FROM connect_candidates WHERE connection_id = ? ORDER BY rowid').all(connectionId) as { id: string; data_json: string }[]).map(
    (r) => ({ id: r.id, data: JSON.parse(r.data_json) as CandidateData }),
  );
}

// ---- publishing ---------------------------------------------------------------------------

const permalink = async (id: string, token: string): Promise<string | null> => {
  try {
    return ((await get(`/${id}`, token, { fields: 'permalink' })).permalink as string) ?? null;
  } catch {
    return null;
  }
};

/** Container states: IN_PROGRESS, FINISHED, PUBLISHED, ERROR, EXPIRED. */
async function containerStatus(id: string, token: string): Promise<{ code: string; detail: string }> {
  const r = await get(`/${id}`, token, { fields: 'status_code,status' });
  return { code: String(r.status_code ?? ''), detail: String(r.status ?? '') };
}

async function uploadReel(ctx: PublishContext, token: string, containerId: string, uri: string | undefined) {
  const m = ctx.media[0];
  const size = fs.statSync(ctx.filePath(m)).size;
  const url = uri || `${config.endpoints.rupload}/ig-api-upload/${config.meta.graphVersion}/${containerId}`;
  const res = await request(url, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(size), 'content-type': 'application/octet-stream' },
    body: await fs.promises.readFile(ctx.filePath(m)),
    timeoutMs: 30 * 60_000,
  });
  if (res.status >= 300 || res.json?.success === false) {
    const msg = res.json?.debug_info?.message || res.json?.error?.message || `HTTP ${res.status}`;
    throw new PublishError(`Instagram video upload failed: ${msg}`, { retryable: true, resetState: true });
  }
}

export const instagramPublisher: PublisherModule = {
  platform: 'instagram',
  async step(ctx): Promise<StepResult> {
    const token = ctx.accountToken();
    const ig = ctx.account.external_id;
    const s = ctx.state;
    const video = ctx.media.length === 1 && ctx.media[0].kind === 'video';

    if (!s.creationId && ctx.media.length > 1) {
      // Carousel: a container per item first, then the carousel itself once they're ready.
      s.children ??= [];
      for (let i = s.children.length; i < ctx.media.length; i++) {
        const m = ctx.media[i];
        const r = await post(
          `/${ig}/media`,
          token,
          m.kind === 'video' ? { media_type: 'VIDEO', video_url: ctx.publicUrl(m), is_carousel_item: true } : { image_url: ctx.publicUrl(m), is_carousel_item: true },
          'Instagram carousel item',
        );
        s.children.push(r.id);
        ctx.save(s);
      }
      for (const child of s.children as string[]) {
        const st = await containerStatus(child, token);
        if (st.code === 'ERROR' || st.code === 'EXPIRED') throw new PublishError(`Instagram rejected a carousel item: ${st.detail || st.code}`, { resetState: true });
        if (st.code !== 'FINISHED') return { status: 'wait', ms: 15_000 };
      }
      const r = await post(`/${ig}/media`, token, { media_type: 'CAROUSEL', children: (s.children as string[]).join(','), caption: ctx.caption }, 'Instagram carousel');
      s.creationId = r.id;
      ctx.save(s);
      return { status: 'wait', ms: 5_000 };
    }

    if (!s.creationId) {
      if (video) {
        const r = await post(
          `/${ig}/media`,
          token,
          { media_type: 'REELS', upload_type: 'resumable', caption: ctx.caption, share_to_feed: ctx.options.instagramShareToFeed ?? true },
          'Instagram',
        );
        s.creationId = r.id;
        s.uploadUri = r.uri;
        ctx.save(s);
        await uploadReel(ctx, token, r.id, r.uri);
        s.uploaded = true;
        ctx.save(s);
        return { status: 'wait', ms: 20_000 };
      }
      const r = await post(`/${ig}/media`, token, { image_url: ctx.publicUrl(ctx.media[0]), caption: ctx.caption }, 'Instagram');
      s.creationId = r.id;
      ctx.save(s);
      return { status: 'wait', ms: 3_000 };
    }

    if (video && !s.uploaded) {
      // A restart interrupted the upload: send the file again (it starts at offset 0).
      await uploadReel(ctx, token, s.creationId, s.uploadUri);
      s.uploaded = true;
      ctx.save(s);
      return { status: 'wait', ms: 20_000 };
    }
    const st = await containerStatus(s.creationId, token);
    if (st.code === 'IN_PROGRESS' || st.code === '') return { status: 'wait', ms: video ? 20_000 : 5_000 };
    if (st.code === 'ERROR') throw new PublishError(`Instagram couldn't process the media: ${st.detail || 'unknown error'}`, { resetState: true });
    if (st.code === 'EXPIRED') throw new PublishError('The Instagram upload expired before it was published.', { retryable: true, resetState: true });
    if (st.code === 'PUBLISHED') return { status: 'done', externalId: s.mediaId ?? null, url: s.mediaId ? await permalink(s.mediaId, token) : null };

    const published = await post(`/${ig}/media_publish`, token, { creation_id: s.creationId }, 'Instagram');
    s.mediaId = published.id;
    ctx.save(s);
    return { status: 'done', externalId: published.id, url: await permalink(published.id, token) };
  },
};

/** Multipart upload of a file to a Page edge (videos and photos). */
async function postFile(path: string, token: string, file: { path: string; mime: string; name: string }, fields: Record<string, string>, what: string) {
  const body = new FormData();
  body.set('access_token', token);
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  body.set('source', await fs.openAsBlob(file.path, { type: file.mime }), file.name);
  return check(await request(graph(path), { method: 'POST', body, timeoutMs: 30 * 60_000 }), what);
}

export const facebookPublisher: PublisherModule = {
  platform: 'facebook',
  async step(ctx): Promise<StepResult> {
    const token = ctx.accountToken();
    const page = ctx.account.external_id;
    const s = ctx.state;
    const videos = ctx.media.filter((m) => m.kind === 'video');
    const images = ctx.media.filter((m) => m.kind === 'image');
    const file = (m: (typeof ctx.media)[number]) => ({ path: ctx.filePath(m), mime: m.mime, name: m.file_name });

    if (videos.length) {
      const fields: Record<string, string> = { description: ctx.caption };
      if (ctx.options.title) fields.title = ctx.options.title;
      const r = await postFile(`/${page}/videos`, token, file(videos[0]), fields, 'Facebook video');
      return { status: 'done', externalId: r.id, url: `https://www.facebook.com/${page}/videos/${r.id}` };
    }
    if (images.length === 1) {
      const r = await postFile(`/${page}/photos`, token, file(images[0]), { caption: ctx.caption }, 'Facebook photo');
      const id = r.post_id ?? r.id;
      return { status: 'done', externalId: id, url: `https://www.facebook.com/${id}` };
    }
    if (images.length > 1) {
      // Several photos: upload each unpublished, then one post that attaches them all.
      s.photoIds ??= [];
      for (let i = s.photoIds.length; i < images.length; i++) {
        const r = await postFile(`/${page}/photos`, token, file(images[i]), { published: 'false' }, 'Facebook photo');
        s.photoIds.push(r.id);
        ctx.save(s);
      }
      const fields: Record<string, string> = { message: ctx.caption };
      (s.photoIds as string[]).forEach((id, i) => (fields[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
      const r = await post(`/${page}/feed`, token, fields, 'Facebook post');
      return { status: 'done', externalId: r.id, url: `https://www.facebook.com/${r.id}` };
    }
    const r = await post(`/${page}/feed`, token, { message: ctx.caption }, 'Facebook post');
    return { status: 'done', externalId: r.id, url: `https://www.facebook.com/${r.id}` };
  },
};
