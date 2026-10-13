// What each platform module provides: a sign-in (provider) and a publisher per platform.
import type { Platform, Provider, TargetOptions } from '../../shared/types.js';
import type { DB } from '../db.js';
import type { AccountRow, ConnectionRow, MediaRow, TargetRow } from '../repo.js';

export interface ProviderModule {
  provider: Provider;
  label: string;
  configured(): boolean;
  authorizeUrl(args: { state: string; redirectUri: string; verifier: string }): string;
  /** Finishes a sign-in: stores the connection and its accounts (or candidates to pick from). */
  complete(args: { db: DB; clientId: string; userId: string; code: string; redirectUri: string; verifier: string }): Promise<{
    connectionId: string;
    name: string;
    /** True when the user still has to pick which accounts to add. */
    pick: boolean;
  }>;
  /** Re-reads an account's details from the platform (TikTok's privacy options, for one). */
  refreshAccount?(db: DB, account: AccountRow, connection: ConnectionRow): Promise<void>;
}

export interface PublishContext {
  db: DB;
  target: TargetRow;
  account: AccountRow;
  connection: ConnectionRow;
  media: MediaRow[];
  caption: string;
  options: TargetOptions;
  /** Progress saved between steps, so a restart resumes instead of posting twice. */
  state: Record<string, any>;
  save(state: Record<string, any>): void;
  /** The connection's access token, refreshed when needed. */
  accessToken(): Promise<string>;
  /** The account's own token (a Facebook Page token). */
  accountToken(): string;
  filePath(m: MediaRow): string;
  /** A temporary public link to a file, for platforms that fetch media by URL. */
  publicUrl(m: MediaRow): string;
}

export type StepResult =
  | { status: 'done'; externalId: string | null; url: string | null }
  /** Not finished (the platform is processing); call again after `ms`. */
  | { status: 'wait'; ms: number };

export interface PublisherModule {
  platform: Platform;
  /** Does the next piece of work. Called repeatedly until it returns done or throws. */
  step(ctx: PublishContext): Promise<StepResult>;
}
