import type { Candidate, Platform } from '../../shared/types.js';
import type { DB } from '../db.js';
import type { AccountRow } from '../repo.js';
import { newId } from '../security.js';
import { googleProvider, youtubePublisher } from './google.js';
import { candidateRows, facebookPublisher, instagramPublisher, metaProvider } from './meta.js';
import { tiktokProvider, tiktokPublisher } from './tiktok.js';
import type { ProviderModule, PublisherModule } from './types.js';

export const PROVIDERS: ProviderModule[] = [metaProvider, tiktokProvider, googleProvider];

export const PUBLISHERS: Record<Platform, PublisherModule> = {
  instagram: instagramPublisher,
  facebook: facebookPublisher,
  youtube: youtubePublisher,
  tiktok: tiktokPublisher,
};

export const providerFor = (platform: Platform): ProviderModule =>
  platform === 'youtube' ? googleProvider : platform === 'tiktok' ? tiktokProvider : metaProvider;

/** Pages and Instagram accounts found in a Meta sign-in, for the picker. */
export function listCandidates(db: DB, connectionId: string): Candidate[] {
  const conn = db.prepare('SELECT client_id FROM connections WHERE id = ?').get(connectionId) as { client_id: string } | undefined;
  if (!conn) return [];
  return candidateRows(db, connectionId).map(({ id, data }) => ({
    id,
    platform: data.platform,
    name: data.name,
    handle: data.handle,
    avatarUrl: data.avatarUrl,
    added: !!db.prepare('SELECT 1 FROM accounts WHERE client_id = ? AND platform = ? AND external_id = ?').get(conn.client_id, data.platform, data.externalId),
  }));
}

/** Adds the picked candidates to the client as accounts (or refreshes ones already added). */
export function addCandidates(db: DB, connectionId: string, ids: string[]): AccountRow[] {
  const conn = db.prepare('SELECT client_id FROM connections WHERE id = ?').get(connectionId) as { client_id: string } | undefined;
  if (!conn) return [];
  const picked = candidateRows(db, connectionId).filter((c) => ids.includes(c.id));
  const now = Date.now();
  return db.transaction(() =>
    picked.map(({ data }) => {
      db.prepare(
        `INSERT INTO accounts (id, client_id, connection_id, platform, external_id, name, handle, avatar_url, token_enc, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (client_id, platform, external_id) DO UPDATE SET connection_id = excluded.connection_id, name = excluded.name,
           handle = excluded.handle, avatar_url = excluded.avatar_url, token_enc = excluded.token_enc, meta_json = excluded.meta_json,
           status = 'ok', status_detail = ''`,
      ).run(newId(), conn.client_id, connectionId, data.platform, data.externalId, data.name, data.handle, data.avatarUrl, data.tokenEnc, JSON.stringify(data.meta), now);
      return db.prepare('SELECT * FROM accounts WHERE client_id = ? AND platform = ? AND external_id = ?').get(conn.client_id, data.platform, data.externalId) as AccountRow;
    }),
  )();
}
