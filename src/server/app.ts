// The HTTP server: the JSON API under /api, platform sign-in callbacks under /oauth, signed media
// links under /m for the platforms to fetch, and the built web app for everything else.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { ActivityEntry, Candidate, PostInput, Provider, Role, ServerStatus } from '../shared/types.js';
import { checkPost } from '../shared/rules.js';
import { config } from './config.js';
import { logActivity, type DB } from './db.js';
import { PublishError } from './platforms/http.js';
import { PROVIDERS, addCandidates, listCandidates, providerFor } from './platforms/index.js';
import {
  getClient,
  getPost,
  listClients,
  toAccount,
  toMedia,
  toPost,
  toUser,
  type AccountRow,
  type ClientRow,
  type ConnectionRow,
  type MediaRow,
  type PostRow,
  type TargetRow,
  type UserRow,
} from './repo.js';
import { checkMediaSignature, hashPassword, hashToken, newId, newToken, verifyPassword } from './security.js';

const SESSION_COOKIE = 'gungnir_session';
const SESSION_MS = 30 * 86400_000;
const INVITE_MS = 7 * 86400_000;

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

/** API paths that work without signing in. */
const PUBLIC_API = new Set(['/api/status', '/api/login', '/api/setup', '/api/invites/accept', '/api/invites/check']);

export interface AppOptions {
  db: DB;
  /** Asks the scheduler to look for due posts now (after "Post now"). */
  kick?: () => void;
  /** Serve the built web app from this folder. */
  webDir?: string;
}

export async function buildApp({ db, kick = () => undefined, webDir }: AppOptions) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : { level: 'info' }, bodyLimit: 1024 * 1024, trustProxy: config.trustProxy });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
  await app.register(fastifyStatic, { root: config.mediaDir, serve: false });
  if (webDir && fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', decorateReply: false, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.type('text/html').send(fs.createReadStream(path.join(webDir, 'index.html')));
    });
  }

  app.decorateRequest('user', null);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on the server.' });
  });

  // Sessions, and a header that cross-site forms can't send, on everything that changes data.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-gungnir'] !== '1') fail(403, 'Missing request header.');
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const row = db
        .prepare(
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
        )
        .get(hashToken(token), Date.now()) as UserRow | undefined;
      req.user = row ?? null;
    }
    const pathOnly = req.url.split('?')[0];
    if (!req.user && !PUBLIC_API.has(pathOnly)) fail(401, 'Sign in first.');
  });

  const me = (req: FastifyRequest) => req.user!;
  const requireAdmin = (req: FastifyRequest) => {
    if (me(req).role !== 'admin') fail(403, 'Only admins can do that.');
  };
  const startSession = (reply: FastifyReply, userId: string) => {
    const token = newToken();
    const now = Date.now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hashToken(token), userId, now, now + SESSION_MS);
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: SESSION_MS / 1000 });
  };
  const userCount = () => (db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n;
  const str = (v: unknown, field: string, max = 500): string => {
    if (typeof v !== 'string') fail(400, `${field} is required.`);
    const s = (v as string).trim();
    if (!s) fail(400, `${field} is required.`);
    if (s.length > max) fail(400, `${field} is too long.`);
    return s;
  };
  const password = (v: unknown) => {
    if (typeof v !== 'string' || v.length < 10) fail(400, 'Passwords need at least 10 characters.');
    return v as string;
  };

  // ---- status, setup, sign-in ---------------------------------------------------------

  app.get('/api/status', async (): Promise<ServerStatus> => ({
    publicUrl: config.publicUrl,
    providers: Object.fromEntries(PROVIDERS.map((p) => [p.provider, p.configured()])) as Record<Provider, boolean>,
    needsSetup: userCount() === 0,
  }));

  /** The first person to open a new installation creates the admin account. */
  app.post('/api/setup', async (req, reply) => {
    const body = req.body as { email?: string; name?: string; password?: string };
    if (userCount() > 0) fail(409, 'This installation is already set up.');
    const id = newId();
    db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      str(body.email, 'Email').toLowerCase(),
      str(body.name, 'Name'),
      await hashPassword(password(body.password)),
      'admin',
      Date.now(),
    );
    startSession(reply, id);
    return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow);
  });

  const failures = new Map<string, { count: number; until: number }>();
  app.post('/api/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    const email = str(body.email, 'Email').toLowerCase();
    const key = `${req.ip}|${email}`;
    const f = failures.get(key);
    if (f && f.count >= 5 && f.until > Date.now()) fail(429, 'Too many attempts. Try again in a few minutes.');
    const row = db.prepare('SELECT * FROM users WHERE email = ? AND disabled_at IS NULL').get(email) as UserRow | undefined;
    if (!row || !(await verifyPassword(String(body.password ?? ''), row.password_hash))) {
      failures.set(key, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60_000 });
      fail(401, 'That email and password don’t match.');
    }
    failures.delete(key);
    startSession(reply, row!.id);
    return toUser(row!);
  });

  app.post('/api/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => toUser(me(req)));

  app.put('/api/me/password', async (req) => {
    const body = req.body as { current?: string; password?: string };
    if (!(await verifyPassword(String(body.current ?? ''), me(req).password_hash))) fail(400, 'Your current password is wrong.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password(body.password)), me(req).id);
    return { ok: true };
  });

  // ---- team -----------------------------------------------------------------------------

  app.get('/api/users', async () => (db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all() as UserRow[]).map(toUser));

  app.patch('/api/users/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = req.body as { role?: Role; disabled?: boolean };
    if (id === me(req).id) fail(400, "You can't change your own role or access.");
    if (body.role) {
      if (body.role !== 'admin' && body.role !== 'member') fail(400, 'Unknown role.');
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, id);
    }
    if (body.disabled != null) {
      db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(body.disabled ? Date.now() : null, id);
      if (body.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow);
  });

  app.get('/api/invites', async (req) => {
    requireAdmin(req);
    return db
      .prepare('SELECT token_hash id, email, role, expires_at expiresAt FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC')
      .all(Date.now());
  });

  /** Makes a one-time sign-up link; the admin sends it to the person. */
  app.post('/api/invites', async (req) => {
    requireAdmin(req);
    const body = req.body as { email?: string; role?: Role };
    const email = str(body.email, 'Email').toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'Someone with that email is already on the team.');
    const token = newToken();
    const role: Role = body.role === 'admin' ? 'admin' : 'member';
    db.prepare('INSERT INTO invites (token_hash, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      hashToken(token),
      email,
      role,
      me(req).id,
      Date.now(),
      Date.now() + INVITE_MS,
    );
    return { link: `${config.publicUrl}/#/invite/${token}`, email, role };
  });

  app.delete('/api/invites/:id', async (req) => {
    requireAdmin(req);
    db.prepare('DELETE FROM invites WHERE token_hash = ?').run((req.params as { id: string }).id);
    return { ok: true };
  });

  const findInvite = (token: unknown) =>
    db.prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(hashToken(String(token ?? '')), Date.now()) as
      | { token_hash: string; email: string; role: Role }
      | undefined;

  app.get('/api/invites/check', async (req) => {
    const invite = findInvite((req.query as { token?: string }).token);
    if (!invite) fail(404, 'This invite link has expired or was already used. Ask for a new one.');
    return { email: invite!.email };
  });

  app.post('/api/invites/accept', async (req, reply) => {
    const body = req.body as { token?: string; name?: string; password?: string };
    const invite = findInvite(body.token);
    if (!invite) fail(404, 'This invite link has expired or was already used. Ask for a new one.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(invite!.email)) fail(409, 'That email already has an account. Sign in instead.');
    const id = newId();
    db.transaction(() => {
      db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        invite!.email,
        str(body.name, 'Name'),
        '',
        invite!.role,
        Date.now(),
      );
      db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').run(Date.now(), invite!.token_hash);
    })();
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password(body.password)), id);
    startSession(reply, id);
    return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow);
  });

  // ---- clients and accounts -------------------------------------------------------------

  const clientOr404 = (id: string) => {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow | undefined;
    if (!c) fail(404, 'That client no longer exists.');
    return c!;
  };

  app.get('/api/clients', async () => listClients(db));
  app.get('/api/clients/:id', async (req) => getClient(db, clientOr404((req.params as { id: string }).id).id));

  app.post('/api/clients', async (req) => {
    const body = req.body as { name?: string; notes?: string };
    const id = newId();
    db.prepare('INSERT INTO clients (id, name, notes, created_at) VALUES (?, ?, ?, ?)').run(id, str(body.name, 'Name', 120), String(body.notes ?? ''), Date.now());
    logActivity(db, { userId: me(req).id, clientId: id, message: 'added the client' });
    return getClient(db, id);
  });

  app.patch('/api/clients/:id', async (req) => {
    const c = clientOr404((req.params as { id: string }).id);
    const body = req.body as { name?: string; notes?: string; archived?: boolean };
    if (body.name != null) db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(str(body.name, 'Name', 120), c.id);
    if (body.notes != null) db.prepare('UPDATE clients SET notes = ? WHERE id = ?').run(String(body.notes), c.id);
    if (body.archived != null) db.prepare('UPDATE clients SET archived_at = ? WHERE id = ?').run(body.archived ? Date.now() : null, c.id);
    return getClient(db, c.id);
  });

  app.delete('/api/clients/:id', async (req) => {
    requireAdmin(req);
    const c = clientOr404((req.params as { id: string }).id);
    const files = db.prepare('SELECT stored_name FROM media WHERE client_id = ?').all(c.id) as { stored_name: string }[];
    db.prepare('DELETE FROM clients WHERE id = ?').run(c.id);
    for (const f of files) fs.rmSync(path.join(config.mediaDir, f.stored_name), { force: true });
    return { ok: true };
  });

  app.delete('/api/accounts/:id', async (req) => {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get((req.params as { id: string }).id) as AccountRow | undefined;
    if (!a) fail(404, 'That account was already removed.');
    const pending = db.prepare("SELECT COUNT(*) n FROM targets WHERE account_id = ? AND status IN ('scheduled', 'publishing')").get(a!.id) as { n: number };
    if (pending.n) fail(409, `${a!.name} has ${pending.n} scheduled post${pending.n === 1 ? '' : 's'}. Remove it from those posts first.`);
    db.transaction(() => {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(a!.id);
      // Drop the platform sign-in once nothing uses it.
      db.prepare('DELETE FROM connections WHERE id = ? AND NOT EXISTS (SELECT 1 FROM accounts WHERE connection_id = ?)').run(a!.connection_id, a!.connection_id);
    })();
    logActivity(db, { userId: me(req).id, clientId: a!.client_id, message: `removed ${a!.name} (${a!.platform})` });
    return { ok: true };
  });

  /** Re-reads an account's details from its platform (TikTok's current privacy options). */
  app.post('/api/accounts/:id/refresh', async (req) => {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get((req.params as { id: string }).id) as AccountRow | undefined;
    if (!a) fail(404, 'That account was removed.');
    const p = providerFor(a!.platform);
    if (p.refreshAccount) {
      const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(a!.connection_id) as ConnectionRow;
      try {
        await p.refreshAccount(db, a!, conn);
      } catch (err) {
        if (err instanceof PublishError && err.opts.reconnect) {
          db.prepare("UPDATE accounts SET status = 'reconnect', status_detail = ? WHERE id = ?").run(err.message, a!.id);
        } else fail(502, (err as Error).message);
      }
    }
    return toAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(a!.id) as AccountRow);
  });

  // ---- connecting platform accounts -------------------------------------------------------

  /** Starts a platform sign-in for a client; the browser is sent to the platform. */
  app.get('/api/connect/:provider/start', async (req, reply) => {
    const { provider } = req.params as { provider: Provider };
    const { clientId } = req.query as { clientId?: string };
    const p = PROVIDERS.find((x) => x.provider === provider);
    if (!p) fail(404, 'Unknown platform.');
    if (!p!.configured()) fail(400, `${p!.label} isn't set up on the server yet (see README).`);
    clientOr404(String(clientId));
    const state = newToken();
    const verifier = newToken();
    db.prepare('INSERT INTO oauth_states (state, provider, client_id, user_id, verifier, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      state,
      provider,
      clientId,
      me(req).id,
      verifier,
      Date.now(),
    );
    return reply.redirect(p!.authorizeUrl({ state, redirectUri: redirectUri(provider), verifier }));
  });

  app.get('/oauth/:provider/callback', async (req, reply) => {
    const { provider } = req.params as { provider: Provider };
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string; error_reason?: string };
    const row = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(String(q.state ?? ''), provider) as
      | { client_id: string; user_id: string; verifier: string; created_at: number }
      | undefined;
    db.prepare('DELETE FROM oauth_states WHERE state = ? OR created_at < ?').run(String(q.state ?? ''), Date.now() - 3600_000);
    if (!row || row.created_at < Date.now() - 3600_000) return reply.redirect('/#/clients?error=' + encodeURIComponent('That sign-in link expired. Try connecting again.'));
    const back = (params: Record<string, string>) => reply.redirect(`/#/clients/${row.client_id}?${new URLSearchParams(params)}`);
    if (q.error || !q.code) return back({ error: q.error_description || q.error_reason || q.error || 'The platform didn’t complete the sign-in.' });
    const p = PROVIDERS.find((x) => x.provider === provider)!;
    try {
      const result = await p.complete({ db, clientId: row.client_id, userId: row.user_id, code: q.code, redirectUri: redirectUri(provider), verifier: row.verifier });
      logActivity(db, { userId: row.user_id, clientId: row.client_id, message: `connected ${p.label} (${result.name})` });
      return result.pick ? back({ pick: result.connectionId }) : back({ connected: p.label });
    } catch (err) {
      req.log.error(err);
      return back({ error: `${p.label} sign-in failed: ${(err as Error).message}` });
    }
  });

  app.get('/api/connect/candidates/:connectionId', async (req): Promise<Candidate[]> => listCandidates(db, (req.params as { connectionId: string }).connectionId));

  app.post('/api/connect/candidates/:connectionId', async (req) => {
    const { connectionId } = req.params as { connectionId: string };
    const ids = (req.body as { ids?: string[] }).ids ?? [];
    if (!Array.isArray(ids) || !ids.length) fail(400, 'Pick at least one account.');
    const added = addCandidates(db, connectionId, ids);
    return added.map(toAccount);
  });

  // ---- media ------------------------------------------------------------------------------

  app.post('/api/clients/:id/media', async (req) => {
    const c = clientOr404((req.params as { id: string }).id);
    const file = await req.file();
    if (!file) fail(400, 'No file was uploaded.');
    const mime = file!.mimetype;
    const kind = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : null;
    if (!kind) fail(400, 'Upload a video or an image.');
    const id = newId();
    const ext = path.extname(file!.filename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8) || (kind === 'video' ? '.mp4' : '.jpg');
    const storedName = `${id}${ext}`;
    const dest = path.join(config.mediaDir, storedName);
    await pipeline(file!.file, fs.createWriteStream(dest));
    if (file!.file.truncated) {
      fs.rmSync(dest, { force: true });
      fail(413, `That file is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`);
    }
    const num = (name: string) => {
      const v = Number((file!.fields[name] as { value?: string } | undefined)?.value);
      return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
    };
    db.prepare(
      `INSERT INTO media (id, client_id, kind, file_name, mime, size, stored_name, width, height, duration_ms, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, c.id, kind, file!.filename.slice(0, 200), mime, fs.statSync(dest).size, storedName, num('width'), num('height'), num('durationMs'), me(req).id, Date.now());
    return toMedia(db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow);
  });

  app.get('/api/clients/:id/media', async (req) =>
    (db.prepare('SELECT * FROM media WHERE client_id = ? ORDER BY created_at DESC').all((req.params as { id: string }).id) as MediaRow[]).map(toMedia),
  );

  const mediaOr404 = (id: string) => {
    const m = db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
    if (!m) fail(404, 'That file no longer exists.');
    return m!;
  };

  app.get('/api/media/:id/file', async (req, reply) => {
    const m = mediaOr404((req.params as { id: string }).id);
    return reply.header('content-type', m.mime).sendFile(m.stored_name);
  });

  /** Signed links the platforms fetch media from (no sign-in; the signature expires). */
  app.get('/m/:id/:name', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!checkMediaSignature(id, String(exp ?? ''), String(sig ?? ''))) return reply.code(403).send('Link expired');
    const m = mediaOr404(id);
    return reply.header('content-type', m.mime).header('cache-control', 'private, max-age=3600').sendFile(m.stored_name);
  });

  app.delete('/api/media/:id', async (req) => {
    const m = mediaOr404((req.params as { id: string }).id);
    const inUse = (db.prepare('SELECT media_json FROM posts WHERE client_id = ?').all(m.client_id) as { media_json: string }[]).some((p) =>
      (JSON.parse(p.media_json) as string[]).includes(m.id),
    );
    if (inUse) fail(409, 'A post uses this file. Remove it from the post first.');
    db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
    fs.rmSync(path.join(config.mediaDir, m.stored_name), { force: true });
    return { ok: true };
  });

  // ---- posts ------------------------------------------------------------------------------

  app.get('/api/posts', async (req) => {
    const q = req.query as { clientId?: string; from?: string; to?: string };
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.clientId) {
      where.push('client_id = ?');
      args.push(q.clientId);
    }
    if (q.from) {
      where.push('(scheduled_at IS NULL OR scheduled_at >= ?)');
      args.push(Number(q.from));
    }
    if (q.to) {
      where.push('(scheduled_at IS NULL OR scheduled_at < ?)');
      args.push(Number(q.to));
    }
    const rows = db.prepare(`SELECT * FROM posts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY scheduled_at IS NULL, scheduled_at, created_at`).all(...args) as PostRow[];
    const targets = rows.length
      ? (db.prepare(`SELECT * FROM targets WHERE post_id IN (${rows.map(() => '?').join(',')}) ORDER BY rowid`).all(...rows.map((r) => r.id)) as TargetRow[])
      : [];
    return rows.map((r) => toPost(r, targets.filter((t) => t.post_id === r.id)));
  });

  const postOr404 = (id: string) => {
    const p = getPost(db, id);
    if (!p) fail(404, 'That post no longer exists.');
    return p!;
  };

  app.get('/api/posts/:id', async (req) => postOr404((req.params as { id: string }).id));

  app.get('/api/posts/:id/activity', async (req): Promise<ActivityEntry[]> =>
    db
      .prepare('SELECT a.at, u.name userName, a.message FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.post_id = ? ORDER BY a.id')
      .all((req.params as { id: string }).id) as ActivityEntry[],
  );

  /** Checks a post and returns what would be saved, or fails with every problem found. */
  const validate = (input: PostInput) => {
    const client = clientOr404(String(input.clientId));
    if (typeof input.caption !== 'string') fail(400, 'Caption is required.');
    if (!Array.isArray(input.mediaIds) || !Array.isArray(input.targets)) fail(400, 'Malformed post.');
    const media = input.mediaIds.map((id) => {
      const m = mediaOr404(id);
      if (m.client_id !== client.id) fail(400, "A file belongs to a different client.");
      return toMedia(m);
    });
    const seen = new Set<string>();
    const targets = input.targets.map((t) => {
      const a = db.prepare('SELECT * FROM accounts WHERE id = ? AND client_id = ?').get(t.accountId, client.id) as AccountRow | undefined;
      if (!a) fail(400, "An account isn't connected to this client any more.");
      if (seen.has(a!.id)) fail(400, 'An account is listed twice.');
      seen.add(a!.id);
      return { account: toAccount(a!), caption: typeof t.caption === 'string' ? t.caption : null, options: t.options ?? {} };
    });
    // Drafts can be incomplete; anything scheduled must pass every check.
    if (input.scheduledAt != null) {
      const problems = checkPost({ caption: input.caption, media, targets });
      if (problems.length) fail(400, problems.map((p) => p.message).join(' '));
    }
    return { client, targets };
  };

  /** Writes a post's targets; published and in-flight ones are kept as they are. */
  const writeTargets = (postId: string, scheduledAt: number | null, targets: ReturnType<typeof validate>['targets']) => {
    const now = Date.now();
    const existing = db.prepare('SELECT * FROM targets WHERE post_id = ?').all(postId) as TargetRow[];
    const keep = new Set(targets.map((t) => t.account.id));
    for (const e of existing) {
      if (!keep.has(e.account_id) && (e.status === 'draft' || e.status === 'scheduled' || e.status === 'failed' || e.status === 'cancelled')) {
        db.prepare('DELETE FROM targets WHERE id = ?').run(e.id);
      }
    }
    const status = scheduledAt == null ? 'draft' : 'scheduled';
    const due = scheduledAt == null ? null : Math.max(scheduledAt, 0);
    for (const t of targets) {
      const e = existing.find((x) => x.account_id === t.account.id);
      if (e && (e.status === 'published' || e.status === 'publishing')) continue;
      if (e) {
        db.prepare(
          `UPDATE targets SET caption = ?, options_json = ?, status = ?, next_attempt_at = ?, attempts = 0, error = NULL, state_json = '{}', updated_at = ? WHERE id = ?`,
        ).run(t.caption, JSON.stringify(t.options), status, due, now, e.id);
      } else {
        db.prepare(
          `INSERT INTO targets (id, post_id, account_id, caption, options_json, status, next_attempt_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(newId(), postId, t.account.id, t.caption, JSON.stringify(t.options), status, due, now);
      }
    }
  };

  app.post('/api/posts', async (req) => {
    const input = req.body as PostInput;
    const { client, targets } = validate(input);
    const id = newId();
    const now = Date.now();
    db.transaction(() => {
      db.prepare('INSERT INTO posts (id, client_id, caption, media_json, scheduled_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        client.id,
        input.caption,
        JSON.stringify(input.mediaIds),
        input.scheduledAt,
        me(req).id,
        now,
        now,
      );
      writeTargets(id, input.scheduledAt, targets);
    })();
    logActivity(db, { userId: me(req).id, clientId: client.id, postId: id, message: input.scheduledAt == null ? 'saved a draft' : 'scheduled the post' });
    if (input.scheduledAt != null && input.scheduledAt <= Date.now()) kick();
    return getPost(db, id);
  });

  app.put('/api/posts/:id', async (req) => {
    const post = postOr404((req.params as { id: string }).id);
    const input = req.body as PostInput;
    if (input.clientId !== post.clientId) fail(400, "A post can't move to another client.");
    const { targets } = validate(input);
    db.transaction(() => {
      db.prepare('UPDATE posts SET caption = ?, media_json = ?, scheduled_at = ?, updated_at = ? WHERE id = ?').run(
        input.caption,
        JSON.stringify(input.mediaIds),
        input.scheduledAt,
        Date.now(),
        post.id,
      );
      writeTargets(post.id, input.scheduledAt, targets);
    })();
    logActivity(db, { userId: me(req).id, clientId: post.clientId, postId: post.id, message: input.scheduledAt == null ? 'edited the draft' : 'edited and scheduled the post' });
    if (input.scheduledAt != null && input.scheduledAt <= Date.now()) kick();
    return getPost(db, post.id);
  });

  /** Stops whatever hasn't published yet. */
  app.post('/api/posts/:id/cancel', async (req) => {
    const post = postOr404((req.params as { id: string }).id);
    db.prepare("UPDATE targets SET status = 'cancelled', next_attempt_at = NULL, updated_at = ? WHERE post_id = ? AND status IN ('draft', 'scheduled', 'failed')").run(
      Date.now(),
      post.id,
    );
    logActivity(db, { userId: me(req).id, clientId: post.clientId, postId: post.id, message: 'cancelled the post' });
    return getPost(db, post.id);
  });

  app.post('/api/targets/:id/retry', async (req) => {
    const t = db.prepare('SELECT * FROM targets WHERE id = ?').get((req.params as { id: string }).id) as TargetRow | undefined;
    if (!t) fail(404, 'That post no longer exists.');
    if (t!.status !== 'failed' && t!.status !== 'cancelled') fail(409, 'Only failed or cancelled posts can be retried.');
    db.prepare("UPDATE targets SET status = 'scheduled', next_attempt_at = ?, attempts = 0, error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), t!.id);
    const post = getPost(db, t!.post_id)!;
    logActivity(db, { userId: me(req).id, clientId: post.clientId, postId: post.id, message: 'retried publishing' });
    kick();
    return post;
  });

  app.delete('/api/posts/:id', async (req) => {
    const post = postOr404((req.params as { id: string }).id);
    if (post.targets.some((t) => t.status === 'published' || t.status === 'publishing')) {
      fail(409, "This post has already gone out on some accounts, so it can't be deleted here. Delete it on the platform.");
    }
    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
    return { ok: true };
  });

  return app;
}

export const redirectUri = (provider: Provider) => `${config.publicUrl}/oauth/${provider}/callback`;
