// A stand-in for the Meta, Google/YouTube and TikTok APIs, following the request sequences in
// their docs. It checks what Gungnir sends (tokens, upload headers, byte counts, chunk sizes)
// and records every call so tests can assert on them.
import http from 'node:http';

const VER = 'v26.0';

export async function startMock() {
  const state = {
    calls: [],
    /** Set a key to make the next matching call fail: 'meta:publish', 'tiktok:init', 'youtube:interrupt'. */
    failNext: {},
    containers: new Map(),
    published: [],
    youtube: new Map(),
    tiktok: new Map(),
    fbUploads: [],
    fetchedMedia: [],
    tokens: { googleAccess: 'g-access-1', tiktokAccess: 'tt-access-1' },
  };
  let seq = 0;
  const next = (p) => `${p}-${++seq}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const ct = req.headers['content-type'] ?? '';
    let body = {};
    if (ct.includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw.toString()));
    else if (ct.includes('application/json') && raw.length) body = JSON.parse(raw.toString());
    else if (ct.includes('multipart/form-data')) {
      const fd = await new Response(raw, { headers: { 'content-type': ct } }).formData();
      body = {};
      for (const [k, v] of fd.entries()) body[k] = typeof v === 'string' ? v : { size: v.size, type: v.type, name: v.name };
    }
    const q = Object.fromEntries(url.searchParams);
    state.calls.push({ method: req.method, path: url.pathname, query: q, body: ct.includes('multipart') || ct.includes('json') || ct.includes('urlencoded') ? body : undefined, bytes: raw.length });
    const json = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    const redirect = (to) => {
      res.writeHead(302, { location: to });
      res.end();
    };
    const p = url.pathname;
    const metaErr = (message, code = 100) => json(400, { error: { message, type: 'OAuthException', code } });

    // ---- Meta ----------------------------------------------------------------------------
    if (p === `/meta-www/${VER}/dialog/oauth`) return redirect(`${q.redirect_uri}?code=META_CODE&state=${q.state}`);
    if (p.startsWith(`/graph/${VER}/`)) {
      const token = q.access_token ?? body.access_token;
      const rest = p.slice(`/graph/${VER}`.length);
      if (rest === '/oauth/access_token') {
        if (q.code === 'META_CODE') return json(200, { access_token: 'short-user', token_type: 'bearer', expires_in: 3600 });
        if (q.grant_type === 'fb_exchange_token' && q.fb_exchange_token === 'short-user') return json(200, { access_token: 'long-user', token_type: 'bearer', expires_in: 5184000 });
        return metaErr('bad code');
      }
      if (rest === '/me') return token === 'long-user' ? json(200, { id: 'u1', name: 'Agency Person' }) : metaErr('Invalid token', 190);
      if (rest === '/me/accounts') {
        if (token !== 'long-user') return metaErr('Invalid token', 190);
        // Two pages of results, to exercise paging.
        if (!q.after) {
          return json(200, {
            data: [{ id: 'page1', name: 'Nova Rae Music', access_token: 'page1-token', picture: { data: { url: '' } }, instagram_business_account: { id: 'ig1', username: 'novarae', name: 'Nova Rae' } }],
            paging: { next: `${base}/graph/${VER}/me/accounts?access_token=long-user&after=x` },
          });
        }
        return json(200, { data: [{ id: 'page2', name: 'Another Client Page', access_token: 'page2-token' }], paging: {} });
      }
      const pageMatch = /^\/(page\d)\/(videos|photos|feed)$/.exec(rest);
      if (pageMatch) {
        if (token !== `${pageMatch[1]}-token`) return metaErr('Invalid page token', 190);
        const [, page, edge] = pageMatch;
        if (edge === 'videos') {
          if (!body.source?.size) return metaErr('No video file');
          state.fbUploads.push({ page, edge, size: body.source.size, description: body.description });
          return json(200, { id: next('fbv') });
        }
        if (edge === 'photos') {
          if (!body.source?.size) return metaErr('No photo file');
          state.fbUploads.push({ page, edge, size: body.source.size, published: body.published ?? 'true', caption: body.caption });
          const id = next('photo');
          return json(200, body.published === 'false' ? { id } : { id, post_id: `${page}_${id}` });
        }
        const attached = Object.keys(body).filter((k) => k.startsWith('attached_media')).map((k) => JSON.parse(body[k]).media_fbid);
        state.fbUploads.push({ page, edge, message: body.message, attached });
        return json(200, { id: `${page}_${next('post')}` });
      }
      const igMatch = /^\/(ig\d)\/(media|media_publish|content_publishing_limit)$/.exec(rest);
      if (igMatch) {
        if (token !== 'page1-token') return metaErr('Invalid token', 190);
        if (igMatch[2] === 'media') {
          const fetchMedia = async (u) => {
            const r = await fetch(u);
            const buf = Buffer.from(await r.arrayBuffer());
            state.fetchedMedia.push({ url: u, status: r.status, size: buf.length, type: r.headers.get('content-type') });
            return r.ok;
          };
          if (body.media_type === 'REELS' && body.upload_type === 'resumable') {
            const id = next('c-reel');
            state.containers.set(id, { kind: 'reel', uploaded: false, polls: 0, caption: body.caption, shareToFeed: body.share_to_feed });
            return json(200, { id, uri: `${base}/rupload/ig-api-upload/${VER}/${id}` });
          }
          if (body.media_type === 'CAROUSEL') {
            const children = String(body.children).split(',');
            if (!children.every((c) => state.containers.get(c)?.status === 'FINISHED')) return metaErr('Children not ready');
            const id = next('c-carousel');
            state.containers.set(id, { kind: 'carousel', children, polls: 0, caption: body.caption });
            return json(200, { id });
          }
          const src = body.image_url ?? body.video_url;
          if (!src || !(await fetchMedia(src))) return metaErr('Media could not be fetched from the URL');
          const id = next(body.is_carousel_item ? 'c-child' : 'c-image');
          state.containers.set(id, { kind: body.is_carousel_item ? 'child' : 'image', polls: 0, caption: body.caption });
          return json(200, { id });
        }
        if (igMatch[2] === 'media_publish') {
          if (state.failNext['meta:publish']) {
            delete state.failNext['meta:publish'];
            return metaErr('Error validating access token: Session has expired', 190);
          }
          const c = state.containers.get(body.creation_id);
          if (!c || c.status !== 'FINISHED') return json(400, { error: { message: 'Media ID is not available', code: 9007 } });
          c.status = 'PUBLISHED';
          const id = next('igm');
          state.published.push({ platform: 'instagram', id, container: body.creation_id, kind: c.kind, caption: c.caption });
          return json(200, { id });
        }
      }
      const node = /^\/([\w-]+)$/.exec(rest);
      if (node && req.method === 'GET') {
        const c = state.containers.get(node[1]);
        if (c && q.fields?.includes('status_code')) {
          if (c.status === 'PUBLISHED') return json(200, { status_code: 'PUBLISHED', id: node[1] });
          c.polls++;
          // Video needs its upload first; everything takes one poll of "processing".
          c.status = c.kind === 'reel' && !c.uploaded ? 'IN_PROGRESS' : c.polls >= 2 || c.kind !== 'reel' ? 'FINISHED' : 'IN_PROGRESS';
          return json(200, { status_code: c.status, status: c.status === 'FINISHED' ? 'Finished: Media has been uploaded and it is ready to be published.' : 'In Progress', id: node[1] });
        }
        if (q.fields === 'permalink') return json(200, { permalink: `https://www.instagram.com/reel/${node[1]}/`, id: node[1] });
      }
      return metaErr(`Unknown Graph path ${rest}`);
    }
    if (p.startsWith(`/rupload/ig-api-upload/${VER}/`)) {
      const id = p.split('/').pop();
      const c = state.containers.get(id);
      if (!c) return json(400, { debug_info: { message: 'Unknown container' } });
      if (req.headers.authorization !== 'OAuth page1-token') return json(401, { debug_info: { message: 'Bad auth' } });
      if (req.headers.offset !== '0' || Number(req.headers.file_size) !== raw.length) return json(400, { debug_info: { message: `Size mismatch ${req.headers.file_size} vs ${raw.length}` } });
      c.uploaded = true;
      c.bytes = raw.length;
      return json(200, { success: true, message: 'Upload successful.' });
    }

    // ---- Google / YouTube -----------------------------------------------------------------
    if (p === '/google/auth') return redirect(`${q.redirect_uri}?code=G_CODE&state=${q.state}`);
    if (p === '/google/token') {
      if (body.grant_type === 'authorization_code' && body.code === 'G_CODE') {
        return json(200, { access_token: state.tokens.googleAccess, expires_in: 3599, refresh_token: 'g-refresh', scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly', token_type: 'Bearer' });
      }
      if (body.grant_type === 'refresh_token' && body.refresh_token === 'g-refresh') {
        state.tokens.googleAccess = next('g-access');
        return json(200, { access_token: state.tokens.googleAccess, expires_in: 3599, token_type: 'Bearer' });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (p.startsWith('/google-api/')) {
      if (req.headers.authorization !== `Bearer ${state.tokens.googleAccess}` && !p.startsWith('/google-api/upload/session/')) {
        return json(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });
      }
      if (p === '/google-api/youtube/v3/channels') return json(200, { items: [{ id: 'UC1', snippet: { title: 'Nova Rae', customUrl: '@novarae', thumbnails: { default: { url: '' } } } }] });
      if (p === '/google-api/upload/youtube/v3/videos' && q.uploadType === 'resumable') {
        const size = Number(req.headers['x-upload-content-length']);
        if (!size || !body.snippet?.title) return json(400, { error: { code: 400, message: 'Missing title or size', errors: [{ reason: 'invalid' }] } });
        const id = next('session');
        state.youtube.set(id, { size, received: Buffer.alloc(0), meta: body, interrupt: !!state.failNext['youtube:interrupt'] });
        delete state.failNext['youtube:interrupt'];
        return json(200, {}, { location: `${base}/google-api/upload/session/${id}` });
      }
      if (p.startsWith('/google-api/upload/session/') && req.method === 'PUT') {
        const s = state.youtube.get(p.split('/').pop());
        if (!s) return json(404, { error: { code: 404, message: 'Session not found' } });
        const range = req.headers['content-range'];
        const done = () => {
          s.videoId = s.videoId ?? next('yt');
          state.published.push({ platform: 'youtube', id: s.videoId, size: s.received.length, title: s.meta.snippet.title, privacy: s.meta.status.privacyStatus });
          return json(200, { id: s.videoId, kind: 'youtube#video', snippet: s.meta.snippet, status: { uploadStatus: 'uploaded' } });
        };
        if (range?.startsWith('bytes */')) {
          if (s.received.length >= s.size) return done();
          return s.received.length ? json(308, {}, { range: `bytes=0-${s.received.length - 1}` }) : json(308, {});
        }
        const start = range ? Number(/bytes (\d+)-/.exec(range)[1]) : 0;
        if (start !== s.received.length) return json(400, { error: { code: 400, message: `Expected offset ${s.received.length}, got ${start}` } });
        if (s.interrupt) {
          // Keep half and fail, like a dropped connection; the client must resume from there.
          s.interrupt = false;
          s.received = Buffer.concat([s.received, raw.subarray(0, Math.floor(raw.length / 2))]);
          s.resumed = true;
          return json(503, { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } });
        }
        s.received = Buffer.concat([s.received, raw]);
        return s.received.length >= s.size ? done() : json(308, {}, { range: `bytes=0-${s.received.length - 1}` });
      }
    }

    // ---- TikTok ---------------------------------------------------------------------------
    if (p === '/tiktok/auth') return redirect(`${q.redirect_uri}?code=T_CODE&state=${q.state}`);
    if (p === '/tiktok-api/v2/oauth/token/') {
      if (body.grant_type === 'authorization_code' && body.code === 'T_CODE') {
        return json(200, { open_id: 'tt-open-1', access_token: state.tokens.tiktokAccess, expires_in: 86400, refresh_token: 'tt-refresh-1', refresh_expires_in: 31536000, scope: 'user.info.basic,video.publish', token_type: 'Bearer' });
      }
      if (body.grant_type === 'refresh_token' && body.refresh_token === 'tt-refresh-1') {
        state.tokens.tiktokAccess = next('tt-access');
        return json(200, { open_id: 'tt-open-1', access_token: state.tokens.tiktokAccess, expires_in: 86400, refresh_token: 'tt-refresh-1', refresh_expires_in: 31536000, scope: 'user.info.basic,video.publish' });
      }
      return json(400, { error: 'invalid_grant', error_description: 'bad code' });
    }
    if (p.startsWith('/tiktok-api/v2/post/publish/')) {
      const ok = (data) => json(200, { data, error: { code: 'ok', message: '', log_id: 'log' } });
      const err = (status, code, message) => json(status, { data: {}, error: { code, message, log_id: 'log' } });
      if (req.headers.authorization !== `Bearer ${state.tokens.tiktokAccess}`) return err(401, 'access_token_invalid', 'The access token is invalid');
      if (p.endsWith('/creator_info/query/')) {
        return ok({
          creator_nickname: 'Nova Rae',
          creator_username: 'novarae',
          creator_avatar_url: '',
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: true,
          max_video_post_duration_sec: 600,
        });
      }
      if (p.endsWith('/video/init/')) {
        if (state.failNext['tiktok:init']) {
          const code = state.failNext['tiktok:init'];
          delete state.failNext['tiktok:init'];
          return err(403, code, 'Simulated failure');
        }
        const { post_info: info, source_info: src } = body;
        if (!['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'].includes(info?.privacy_level)) return err(403, 'privacy_level_option_mismatch', 'bad privacy');
        if (src?.source !== 'FILE_UPLOAD') return err(400, 'invalid_params', 'source');
        const { video_size: size, chunk_size: chunk, total_chunk_count: count } = src;
        const valid = size <= 64 * 1024 * 1024 ? count === 1 && chunk === size : chunk >= 5 * 1024 * 1024 && chunk <= 64 * 1024 * 1024 && count === Math.floor(size / chunk);
        if (!valid) return err(400, 'invalid_params', 'chunk rules');
        const id = next('v_pub');
        state.tiktok.set(id, { size, received: 0, info, polls: 0 });
        return ok({ publish_id: id, upload_url: `${base}/tiktok-upload/${id}?upload_token=abc` });
      }
      if (p.endsWith('/status/fetch/')) {
        const t = state.tiktok.get(body.publish_id);
        if (!t) return err(400, 'invalid_publish_id', 'unknown');
        t.polls++;
        if (t.received < t.size || t.polls < 2) return ok({ status: 'PROCESSING_UPLOAD' });
        if (!t.done) {
          t.done = true;
          t.postId = 7300000000000000000 + seq;
          state.published.push({ platform: 'tiktok', id: String(t.postId), size: t.received, title: t.info.title, privacy: t.info.privacy_level, info: t.info });
        }
        return ok({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: t.info.privacy_level === 'SELF_ONLY' ? [] : [String(t.postId)] });
      }
    }
    if (p.startsWith('/tiktok-upload/')) {
      const t = state.tiktok.get(p.split('/').pop());
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers['content-range'] ?? '');
      if (!t || !m || Number(m[3]) !== t.size || Number(m[1]) !== t.received || Number(m[2]) - Number(m[1]) + 1 !== raw.length) {
        return json(416, { error: 'range' });
      }
      t.received += raw.length;
      res.writeHead(t.received >= t.size ? 201 : 206);
      return res.end();
    }

    json(404, { error: `mock: no route for ${req.method} ${p}` });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    env: {
      META_WWW_URL: `${base}/meta-www`,
      META_GRAPH_URL: `${base}/graph`,
      META_RUPLOAD_URL: `${base}/rupload`,
      GOOGLE_AUTH_URL: `${base}/google/auth`,
      GOOGLE_TOKEN_URL: `${base}/google/token`,
      GOOGLE_API_URL: `${base}/google-api`,
      TIKTOK_AUTH_URL: `${base}/tiktok/auth`,
      TIKTOK_API_URL: `${base}/tiktok-api`,
      META_APP_ID: 'meta-app',
      META_APP_SECRET: 'meta-secret',
      GOOGLE_CLIENT_ID: 'g-client',
      GOOGLE_CLIENT_SECRET: 'g-secret',
      TIKTOK_CLIENT_KEY: 'tt-key',
      TIKTOK_CLIENT_SECRET: 'tt-secret',
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
