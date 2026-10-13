// Unit tests for the rules and helpers that are easy to get subtly wrong.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gungnir-unit-'));
const { chunkPlan } = await import('../src/server/platforms/tiktok.ts');
const { checkPost } = await import('../src/shared/rules.ts');
const { decrypt, encrypt, signedMediaUrl, checkMediaSignature, hashPassword, verifyPassword } = await import('../src/server/security.ts');

const MB = 1024 * 1024;

test('TikTok chunks: one chunk up to 64 MB, then 10 MB chunks with the remainder in the last', () => {
  assert.deepEqual(chunkPlan(3 * MB), { chunkSize: 3 * MB, count: 1 });
  assert.deepEqual(chunkPlan(64 * MB), { chunkSize: 64 * MB, count: 1 });
  const big = 64 * MB + 1;
  const plan = chunkPlan(big);
  assert.equal(plan.chunkSize, 10 * MB);
  assert.equal(plan.count, Math.floor(big / (10 * MB)));
  const last = big - (plan.count - 1) * plan.chunkSize;
  assert.ok(last >= 5 * MB && last <= 128 * MB, 'last chunk within TikTok limits');
  const huge = 4 * 1024 * MB;
  assert.ok(chunkPlan(huge).count <= 1000);
});

const account = (platform: string, meta: Record<string, unknown> = {}) =>
  ({ id: platform, clientId: 'c', platform, name: platform, handle: '', avatarUrl: '', status: 'ok', statusDetail: '', meta }) as any;
const media = (kind: 'video' | 'image', extra: Record<string, unknown> = {}) =>
  ({ id: Math.random().toString(), clientId: 'c', kind, fileName: 'f', mime: kind === 'video' ? 'video/mp4' : 'image/jpeg', size: 1, width: null, height: null, durationMs: 30_000, createdAt: 0, ...extra }) as any;
const messages = (input: Parameters<typeof checkPost>[0]) => checkPost(input).map((p) => p.message);

test('platform rules', () => {
  const video = [media('video')];
  assert.deepEqual(messages({ caption: 'hi', media: video, targets: [] }), ['Pick at least one account to post to.']);
  assert.deepEqual(messages({ caption: 'hi', media: video, targets: [{ account: account('youtube'), caption: null, options: { title: 'Title' } }] }), []);
  assert.ok(messages({ caption: 'hi', media: video, targets: [{ account: account('youtube'), caption: null, options: { title: 'a<b' } }] })[0].includes('< or >'));
  assert.ok(messages({ caption: 'hi', media: [media('image', { mime: 'image/png' })], targets: [{ account: account('instagram'), caption: null, options: {} }] })[0].includes('JPEG'));
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
  assert.ok(messages({ caption: tags, media: video, targets: [{ account: account('instagram'), caption: null, options: {} }] }).some((m) => m.includes('30 hashtags')));
  // A per-account caption is what gets checked for that account.
  assert.deepEqual(messages({ caption: tags, media: video, targets: [{ account: account('instagram'), caption: 'short', options: {} }] }), []);
  assert.ok(messages({ caption: 'x', media: [media('video'), media('image')], targets: [{ account: account('facebook'), caption: null, options: {} }] })[0].includes("can't mix"));
});

test('TikTok rules follow the account’s settings', () => {
  const tt = account('tiktok', { privacyOptions: ['SELF_ONLY'], maxVideoSec: 60 });
  const long = [media('video', { durationMs: 90_000 })];
  const m = messages({ caption: 'x', media: long, targets: [{ account: tt, caption: null, options: {} }] });
  assert.ok(m.some((x) => x.includes('up to 1 min')));
  assert.ok(m.includes('Choose who can see the TikTok post.'));
  assert.ok(messages({ caption: 'x', media: [media('video')], targets: [{ account: tt, caption: null, options: { tiktokPrivacy: 'PUBLIC_TO_EVERYONE' } }] })[0].includes('isn’t available'));
  assert.ok(
    messages({ caption: 'x', media: [media('video')], targets: [{ account: tt, caption: null, options: { tiktokPrivacy: 'SELF_ONLY', tiktokDisclose: true } }] })[0].includes('promotes your own brand'),
  );
});

test('tokens are encrypted and tamper-evident', () => {
  const sealed = encrypt('secret-token')!;
  assert.notEqual(sealed, 'secret-token');
  assert.equal(decrypt(sealed), 'secret-token');
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decrypt(parts.join('.')));
  assert.equal(encrypt(null), null);
});

test('signed media links expire and can’t be forged', () => {
  const url = new URL(signedMediaUrl('m1', 'a b.jpg', 60_000));
  assert.ok(checkMediaSignature('m1', url.searchParams.get('exp')!, url.searchParams.get('sig')!));
  assert.ok(!checkMediaSignature('m2', url.searchParams.get('exp')!, url.searchParams.get('sig')!));
  assert.ok(!checkMediaSignature('m1', String(Date.now() - 1), url.searchParams.get('sig')!));
});

test('passwords', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', h));
  assert.ok(!(await verifyPassword('wrong', h)));
});
