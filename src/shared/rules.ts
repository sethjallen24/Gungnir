// What each platform accepts, checked in the composer as you type and again on the server
// before anything is scheduled. Limits are from each platform's publishing API docs.
import type { Account, Media, Platform, TargetOptions } from './types.js';

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
  tiktok: 'TikTok',
};

export const PLATFORM_ORDER: Platform[] = ['instagram', 'tiktok', 'youtube', 'facebook'];

export const LIMITS = {
  instagram: { caption: 2200, hashtags: 30, mentions: 20, carouselMax: 10, reelMinSec: 3, reelMaxSec: 15 * 60 },
  facebook: { caption: 63206, photosMax: 10 },
  youtube: { title: 100, description: 5000 },
  tiktok: { caption: 2200, maxSecFallback: 600 },
} as const;

/** Characters as the platforms count them (code points, so an emoji counts once). */
export const charCount = (s: string) => [...s].length;
const countMatches = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

export interface Problem {
  /** Which account it's about; absent for the post as a whole. */
  accountId?: string;
  message: string;
}

export interface CheckInput {
  caption: string;
  media: Media[];
  targets: { account: Account; caption: string | null; options: TargetOptions }[];
}

/** Everything that would stop a post from publishing, in plain words. */
export function checkPost(input: CheckInput): Problem[] {
  const problems: Problem[] = [];
  const videos = input.media.filter((m) => m.kind === 'video');
  const images = input.media.filter((m) => m.kind === 'image');
  if (!input.targets.length) problems.push({ message: 'Pick at least one account to post to.' });
  for (const t of input.targets) {
    const a = t.account;
    const caption = t.caption ?? input.caption;
    const add = (message: string) => problems.push({ accountId: a.id, message });
    if (a.status === 'reconnect') add(`${a.name} needs to be reconnected before it can post.`);
    switch (a.platform) {
      case 'instagram': {
        const L = LIMITS.instagram;
        if (!input.media.length) add('Instagram needs a photo or video.');
        if (input.media.length > L.carouselMax) add(`Instagram allows up to ${L.carouselMax} items in a carousel.`);
        if (images.some((m) => m.mime !== 'image/jpeg')) add('Instagram only accepts JPEG photos.');
        if (input.media.length === 1 && videos.length === 1) {
          const sec = (videos[0].durationMs ?? 0) / 1000;
          if (sec && (sec < L.reelMinSec || sec > L.reelMaxSec)) add('Instagram Reels must be between 3 seconds and 15 minutes.');
        }
        if (charCount(caption) > L.caption) add(`Instagram captions are limited to ${L.caption} characters.`);
        if (countMatches(caption, /(^|\s)#[^\s#]+/g) > L.hashtags) add(`Instagram allows at most ${L.hashtags} hashtags.`);
        if (countMatches(caption, /(^|\s)@[\w.]+/g) > L.mentions) add(`Instagram allows at most ${L.mentions} @mentions.`);
        break;
      }
      case 'facebook': {
        const L = LIMITS.facebook;
        if (videos.length && images.length) add("Facebook posts can't mix photos and videos.");
        if (videos.length > 1) add('Facebook posts take one video.');
        if (images.length > L.photosMax) add(`Facebook posts take up to ${L.photosMax} photos.`);
        if (!input.media.length && !caption.trim()) add('A Facebook post needs text, a photo or a video.');
        if (charCount(caption) > L.caption) add(`Facebook posts are limited to ${L.caption} characters.`);
        break;
      }
      case 'youtube': {
        const L = LIMITS.youtube;
        if (videos.length !== 1 || images.length) add('YouTube needs exactly one video.');
        const title = t.options.title?.trim() ?? '';
        if (!title) add('YouTube needs a title.');
        if (charCount(title) > L.title) add(`YouTube titles are limited to ${L.title} characters.`);
        if (/[<>]/.test(title) || /[<>]/.test(caption)) add('YouTube titles and descriptions can’t contain < or >.');
        if (new TextEncoder().encode(caption).length > L.description) add(`YouTube descriptions are limited to ${L.description} bytes.`);
        break;
      }
      case 'tiktok': {
        const L = LIMITS.tiktok;
        if (videos.length !== 1 || images.length) add('TikTok needs exactly one video.');
        const maxSec = Number(a.meta.maxVideoSec) || L.maxSecFallback;
        const sec = (videos[0]?.durationMs ?? 0) / 1000;
        if (sec > maxSec) add(`This TikTok account can post videos up to ${Math.floor(maxSec / 60)} min ${maxSec % 60} s.`);
        if (charCount(caption) > L.caption) add(`TikTok captions are limited to ${L.caption} characters.`);
        const allowed = (a.meta.privacyOptions as string[] | undefined) ?? [];
        if (!t.options.tiktokPrivacy) add('Choose who can see the TikTok post.');
        else if (allowed.length && !allowed.includes(t.options.tiktokPrivacy)) add('That TikTok privacy setting isn’t available for this account.');
        if (t.options.tiktokDisclose && !t.options.tiktokBrandOrganic && !t.options.tiktokBrandedContent) {
          add('Say whether the TikTok post promotes your own brand or is branded content, or turn off the disclosure.');
        }
        if (t.options.tiktokBrandedContent && t.options.tiktokPrivacy === 'SELF_ONLY') add('Branded content can’t be private on TikTok.');
        break;
      }
    }
  }
  return problems;
}

export const TIKTOK_PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};
