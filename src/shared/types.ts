// Shapes the API sends and receives, shared by the server and the web app.

export type Platform = 'instagram' | 'facebook' | 'youtube' | 'tiktok';
export type Provider = 'meta' | 'google' | 'tiktok';
export type Role = 'admin' | 'member';
export type TargetStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
}

export interface Account {
  id: string;
  clientId: string;
  platform: Platform;
  name: string;
  handle: string;
  avatarUrl: string;
  status: 'ok' | 'reconnect';
  statusDetail: string;
  /** Platform-specific facts used for checks, e.g. TikTok's allowed privacy levels. */
  meta: Record<string, unknown>;
}

export interface Client {
  id: string;
  name: string;
  notes: string;
  archived: boolean;
  accounts: Account[];
}

export interface Media {
  id: string;
  clientId: string;
  kind: 'video' | 'image';
  fileName: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: number;
}

/** Options a post can set per platform. */
export interface TargetOptions {
  /** YouTube: video title (required there). */
  title?: string;
  /** YouTube: public, unlisted or private. */
  youtubePrivacy?: 'public' | 'unlisted' | 'private';
  youtubeMadeForKids?: boolean;
  /** TikTok: one of the account's allowed privacy levels. */
  tiktokPrivacy?: string;
  tiktokDisableComment?: boolean;
  tiktokDisableDuet?: boolean;
  tiktokDisableStitch?: boolean;
  /** TikTok: the post promotes a brand, product or service (content disclosure). */
  tiktokDisclose?: boolean;
  /** TikTok: promoting the creator's own business ("Promotional content"). */
  tiktokBrandOrganic?: boolean;
  /** TikTok: paid partnership with a third party ("Paid partnership"). */
  tiktokBrandedContent?: boolean;
  /** Instagram: also show a Reel in the profile grid. */
  instagramShareToFeed?: boolean;
}

export interface Target {
  id: string;
  accountId: string;
  /** Caption for this account; null uses the post's caption. */
  caption: string | null;
  options: TargetOptions;
  status: TargetStatus;
  attempts: number;
  nextAttemptAt: number | null;
  externalUrl: string | null;
  error: string | null;
  publishedAt: number | null;
}

export interface Post {
  id: string;
  clientId: string;
  caption: string;
  mediaIds: string[];
  scheduledAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  targets: Target[];
}

export interface PostInput {
  clientId: string;
  caption: string;
  mediaIds: string[];
  /** Epoch ms; null saves a draft; 0 or a past time publishes now. */
  scheduledAt: number | null;
  targets: { accountId: string; caption: string | null; options: TargetOptions }[];
}

export interface Candidate {
  id: string;
  platform: Platform;
  name: string;
  handle: string;
  avatarUrl: string;
  /** Already added to this client. */
  added: boolean;
}

export interface ServerStatus {
  publicUrl: string;
  providers: Record<Provider, boolean>;
  needsSetup: boolean;
}

export interface ActivityEntry {
  at: number;
  userName: string | null;
  message: string;
}
