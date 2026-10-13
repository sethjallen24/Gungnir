// Row types and conversions between database rows and API shapes.
import type { Account, Client, Media, Post, Target, TargetOptions, User } from '../shared/types.js';
import type { DB } from './db.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: 'admin' | 'member';
  created_at: number;
  disabled_at: number | null;
}

export interface ClientRow {
  id: string;
  name: string;
  notes: string;
  created_at: number;
  archived_at: number | null;
}

export interface ConnectionRow {
  id: string;
  client_id: string;
  provider: 'meta' | 'google' | 'tiktok';
  external_user_id: string;
  name: string;
  access_enc: string | null;
  refresh_enc: string | null;
  expires_at: number | null;
  refresh_expires_at: number | null;
  scopes: string;
  created_at: number;
  updated_at: number;
}

export interface AccountRow {
  id: string;
  client_id: string;
  connection_id: string;
  platform: Account['platform'];
  external_id: string;
  name: string;
  handle: string;
  avatar_url: string;
  token_enc: string | null;
  meta_json: string;
  status: 'ok' | 'reconnect';
  status_detail: string;
  created_at: number;
}

export interface MediaRow {
  id: string;
  client_id: string;
  kind: 'video' | 'image';
  file_name: string;
  mime: string;
  size: number;
  stored_name: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  created_by: string | null;
  created_at: number;
}

export interface PostRow {
  id: string;
  client_id: string;
  caption: string;
  media_json: string;
  scheduled_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface TargetRow {
  id: string;
  post_id: string;
  account_id: string;
  caption: string | null;
  options_json: string;
  status: Target['status'];
  attempts: number;
  next_attempt_at: number | null;
  locked_until: number | null;
  state_json: string;
  external_id: string | null;
  external_url: string | null;
  error: string | null;
  published_at: number | null;
  updated_at: number;
}

export const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, role: r.role, disabled: r.disabled_at != null });

export const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  clientId: r.client_id,
  platform: r.platform,
  name: r.name,
  handle: r.handle,
  avatarUrl: r.avatar_url,
  status: r.status,
  statusDetail: r.status_detail,
  meta: JSON.parse(r.meta_json) as Record<string, unknown>,
});

export const toMedia = (r: MediaRow): Media => ({
  id: r.id,
  clientId: r.client_id,
  kind: r.kind,
  fileName: r.file_name,
  mime: r.mime,
  size: r.size,
  width: r.width,
  height: r.height,
  durationMs: r.duration_ms,
  createdAt: r.created_at,
});

export const toTarget = (r: TargetRow): Target => ({
  id: r.id,
  accountId: r.account_id,
  caption: r.caption,
  options: JSON.parse(r.options_json) as TargetOptions,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  externalUrl: r.external_url,
  error: r.error,
  publishedAt: r.published_at,
});

export function getClient(db: DB, id: string): Client | null {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow | undefined;
  if (!row) return null;
  const accounts = db.prepare('SELECT * FROM accounts WHERE client_id = ? ORDER BY platform, name').all(id) as AccountRow[];
  return { id: row.id, name: row.name, notes: row.notes, archived: row.archived_at != null, accounts: accounts.map(toAccount) };
}

export function listClients(db: DB): Client[] {
  const rows = db.prepare('SELECT * FROM clients ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE').all() as ClientRow[];
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY platform, name').all() as AccountRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    notes: r.notes,
    archived: r.archived_at != null,
    accounts: accounts.filter((a) => a.client_id === r.id).map(toAccount),
  }));
}

export function getPost(db: DB, id: string): Post | null {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as PostRow | undefined;
  if (!row) return null;
  const targets = db.prepare('SELECT * FROM targets WHERE post_id = ? ORDER BY rowid').all(id) as TargetRow[];
  return toPost(row, targets);
}

export function toPost(r: PostRow, targets: TargetRow[]): Post {
  return {
    id: r.id,
    clientId: r.client_id,
    caption: r.caption,
    mediaIds: JSON.parse(r.media_json) as string[],
    scheduledAt: r.scheduled_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    targets: targets.map(toTarget),
  };
}
