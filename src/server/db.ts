// SQLite database (one file in DATA_DIR). Migrations run in order on start; each is applied once,
// tracked by PRAGMA user_version.
import Database from 'better-sqlite3';
import { config } from './config.js';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_at INTEGER NOT NULL,
    disabled_at INTEGER
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  -- One sign-in with a platform (a Meta, Google or TikTok login) for a client.
  CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('meta', 'google', 'tiktok')),
    external_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    access_enc TEXT,
    refresh_enc TEXT,
    expires_at INTEGER,
    refresh_expires_at INTEGER,
    scopes TEXT NOT NULL DEFAULT '',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- An account posts can go to: a Page, an Instagram account, a YouTube channel, a TikTok account.
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook', 'youtube', 'tiktok')),
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    handle TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    -- A Page's own token (Facebook and Instagram); other platforms use the connection's token.
    token_enc TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'reconnect')),
    status_detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (client_id, platform, external_id)
  );
  -- Pages and Instagram accounts found during a Meta sign-in, waiting to be picked.
  CREATE TABLE connect_candidates (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    verifier TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE media (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('video', 'image')),
    file_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    caption TEXT NOT NULL DEFAULT '',
    media_json TEXT NOT NULL DEFAULT '[]',
    -- Null for a draft.
    scheduled_at INTEGER,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- One per account a post goes to; each publishes, fails and retries on its own.
  CREATE TABLE targets (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    caption TEXT,
    options_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    locked_until INTEGER,
    state_json TEXT NOT NULL DEFAULT '{}',
    external_id TEXT,
    external_url TEXT,
    error TEXT,
    published_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (post_id, account_id)
  );
  CREATE INDEX targets_due ON targets (status, next_attempt_at);
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user_id TEXT,
    client_id TEXT,
    post_id TEXT,
    message TEXT NOT NULL
  );
  `,
];

export type DB = Database.Database;

export function openDatabase(file = config.dbFile): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

export function logActivity(db: DB, entry: { userId?: string | null; clientId?: string | null; postId?: string | null; message: string }): void {
  db.prepare('INSERT INTO activity (at, user_id, client_id, post_id, message) VALUES (?, ?, ?, ?, ?)').run(
    Date.now(),
    entry.userId ?? null,
    entry.clientId ?? null,
    entry.postId ?? null,
    entry.message,
  );
}
