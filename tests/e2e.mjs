// End-to-end test: the built server, the real web UI in Chromium, and the stand-in platform APIs
// from mock-platforms.mjs. Covers setup, connecting all four platforms, posting a video
// everywhere, a photo carousel, an expired sign-in with reconnect and retry, scheduling,
// validation, security checks and team invites.
//
//   npm run build && CHROMIUM_PATH=/path/to/chromium node tests/e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startMock } from './mock-platforms.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = process.env.SCREENSHOT_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gungnir-test-'));
const port = 31000 + Math.floor(Math.random() * 2000);
const APP = `http://127.0.0.1:${port}`;

const mock = await startMock();
const server = spawn(process.execPath, [path.join(root, 'dist/server/server/index.js')], {
  env: {
    ...process.env,
    ...mock.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    PUBLIC_URL: APP,
    SCHEDULER_INTERVAL_MS: '200',
    PUBLISH_WAIT_SCALE: '0.002',
    NODE_ENV: 'test',
  },
  // Run from the temp folder so a developer's .env (with real credentials) isn't loaded.
  cwd: dataDir,
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${APP}/api/status`)).ok) break;
  } catch {
    /* starting */
  }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept());

/** Saves a screenshot when SCREENSHOT_DIR is set, for looking at the screens. */
const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/failure.png`, fullPage: true });
    await cleanup();
    throw err;
  }
}

async function cleanup() {
  await browser.close();
  server.kill();
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const api = async (url, opts = {}) => {
  const res = await page.request.fetch(`${APP}${url}`, { ...opts, headers: { 'x-gungnir': '1', ...(opts.headers ?? {}) } });
  return { status: res.status(), body: await res.json().catch(() => null) };
};
async function until(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
const allPublished = (id) => until(async () => {
  const p = (await api(`/api/posts/${id}`)).body;
  if (p.targets.some((t) => t.status === 'failed')) throw new Error(`A target failed: ${JSON.stringify(p.targets.map((t) => [t.status, t.error]))}`);
  return p.targets.every((t) => t.status === 'published') ? p : null;
}, 'every account to publish');
const postIdFromUrl = () => /#\/posts\/([\w-]+)/.exec(page.url())[1];
/** The composer's button for the account on a platform. */
const toggle = (platform) => page.locator('.account-toggle').filter({ has: page.locator(`.pf-${platform}`) }).first();

const videoBytes = crypto.randomBytes(3 * 1024 * 1024 + 123);
const videoFile = path.join(dataDir, 'clip.mp4');
fs.writeFileSync(videoFile, videoBytes);

console.log('Gungnir e2e');
await page.goto(APP);

await step('first visit sets up the admin account', async () => {
  await page.getByLabel('Your name').fill('Ada Admin');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create admin account' }).click();
  await page.locator('.sidebar').waitFor();
});

await step('API refuses requests without a session or the request header', async () => {
  assert.equal((await fetch(`${APP}/api/clients`)).status, 401);
  const res = await page.request.post(`${APP}/api/clients`, { data: { name: 'x' } });
  assert.equal(res.status(), 403);
});

await step('add a client', async () => {
  await page.locator('nav a', { hasText: 'Clients' }).first().click();
  await page.getByLabel('New client name').fill('Nova Rae');
  await page.getByRole('button', { name: 'Add client' }).click();
  await page.locator('h2', { hasText: 'Connected accounts' }).waitFor();
});

await step('connect Facebook & Instagram, picking only this client’s Page', async () => {
  await page.locator('.connect-option', { hasText: 'Facebook & Instagram' }).getByRole('link', { name: 'Connect' }).click();
  const modal = page.getByRole('dialog');
  await modal.waitFor();
  const rows = modal.locator('.pick-row');
  await until(async () => (await rows.count()) === 3, 'three candidates (both pages of results)');
  await rows.filter({ hasText: 'Nova Rae Music' }).locator('input').check();
  await rows.filter({ hasText: '@novarae' }).locator('input').check();
  await modal.getByRole('button', { name: 'Add 2 accounts' }).click();
  await page.locator('.account-row', { hasText: 'Nova Rae Music' }).waitFor();
  assert.equal(await page.locator('.account-row', { hasText: 'Another Client Page' }).count(), 0);
});

await step('connect TikTok and YouTube', async () => {
  await page.locator('.connect-option', { hasText: 'TikTok' }).getByRole('link', { name: 'Connect' }).click();
  await page.locator('.notice', { hasText: 'TikTok is connected' }).waitFor();
  await page.locator('.connect-option', { hasText: 'YouTube' }).getByRole('link', { name: 'Connect' }).click();
  await page.locator('.notice', { hasText: 'YouTube is connected' }).waitFor();
  assert.equal(await page.locator('.account-list .account-row').count(), 4);
  await shot('client');
});

let videoPostId;
await step('composer: checks each platform’s rules before posting', async () => {
  await page.getByRole('link', { name: 'New post' }).first().click();
  await page.getByLabel('Upload files').setInputFiles(videoFile);
  await page.locator('.media-strip .media-tile video').waitFor();
  await page.getByLabel('Caption').fill('New single out Friday 🎶\nPre-save link in bio #newmusic');
  for (const p of ['instagram', 'facebook', 'tiktok', 'youtube']) await toggle(p).click();
  await page.locator('.problem', { hasText: 'Choose who can see the TikTok post.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Schedule' }).isDisabled(), true);
  // TikTok: interactions off unless ticked; Stitch is off in the account's settings.
  const tiktok = page.locator('.target-card').filter({ has: page.locator('.pf-tiktok') });
  assert.equal(await tiktok.getByLabel('Allow comments').isChecked(), false);
  assert.equal(await tiktok.getByLabel('Allow Stitch').isDisabled(), true);
  await tiktok.getByLabel('Allow comments').check();
  await tiktok.locator('select').selectOption('PUBLIC_TO_EVERYONE');
  // YouTube title defaults to the caption's first line.
  const yt = page.locator('.target-card').filter({ has: page.locator('.pf-youtube') });
  assert.equal(await yt.getByLabel('Title').inputValue(), 'New single out Friday 🎶');
  assert.equal(await page.locator('.problem').count(), 0);
  await shot('composer');
  await page.locator('.settings').evaluate((el) => (el.scrollTop = 900));
  await shot('composer-2');
});

await step('post now: a video goes out to Instagram, TikTok, YouTube and Facebook', async () => {
  mock.state.failNext['youtube:interrupt'] = true;
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await page.getByRole('button', { name: 'Post now' }).click();
  await page.locator('h2', { hasText: 'Accounts' }).waitFor();
  videoPostId = postIdFromUrl();
  const post = await allPublished(videoPostId);
  const pub = (platform) => mock.state.published.find((x) => x.platform === platform);
  const reel = [...mock.state.containers.values()].find((c) => c.kind === 'reel');
  assert.equal(reel.bytes, videoBytes.length, 'Instagram got the whole video through the resumable upload');
  assert.equal(reel.caption, 'New single out Friday 🎶\nPre-save link in bio #newmusic');
  assert.equal(pub('youtube').size, videoBytes.length, 'YouTube got every byte');
  assert.equal([...mock.state.youtube.values()][0].resumed, true, 'the interrupted YouTube upload resumed');
  assert.equal(pub('youtube').title, 'New single out Friday 🎶');
  assert.equal(pub('tiktok').size, videoBytes.length);
  assert.equal(pub('tiktok').info.disable_comment, false);
  assert.equal(pub('tiktok').info.disable_duet, true);
  assert.equal(pub('tiktok').info.disable_stitch, true);
  assert.equal(pub('tiktok').info.brand_content_toggle, false);
  assert.equal(mock.state.fbUploads.find((u) => u.edge === 'videos').size, videoBytes.length);
  const urls = post.targets.map((t) => t.externalUrl).sort();
  assert.ok(urls.some((u) => u.startsWith('https://www.instagram.com/reel/')));
  assert.ok(urls.some((u) => /^https:\/\/www\.tiktok\.com\/@novarae\/video\/\d+$/.test(u)));
  assert.ok(urls.some((u) => u.startsWith('https://www.youtube.com/watch?v=')));
  assert.ok(urls.some((u) => u.startsWith('https://www.facebook.com/page1/videos/')));
  await page.locator('.target-status', { hasText: 'View post' }).nth(3).waitFor();
  await shot('post-detail');
});

await step('photo carousel: Instagram fetches each photo from a signed link; Facebook posts them together', async () => {
  const jpeg1 = path.join(dataDir, 'one.jpg');
  const jpeg2 = path.join(dataDir, 'two.jpg');
  fs.writeFileSync(jpeg1, await page.screenshot({ type: 'jpeg', clip: { x: 0, y: 0, width: 400, height: 400 } }));
  fs.writeFileSync(jpeg2, await page.screenshot({ type: 'jpeg', clip: { x: 400, y: 0, width: 400, height: 400 } }));
  await page.getByRole('link', { name: 'New post' }).first().click();
  await page.getByLabel('Upload files').setInputFiles([jpeg1, jpeg2]);
  await until(async () => (await page.locator('.media-strip .media-tile img').count()) === 2, 'two photos');
  await page.getByLabel('Caption').fill('Tour photos');
  await toggle('instagram').click();
  await toggle('facebook').click();
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await page.getByRole('button', { name: 'Post now' }).click();
  await page.locator('h2', { hasText: 'Accounts' }).waitFor();
  await allPublished(postIdFromUrl());
  const fetched = mock.state.fetchedMedia.filter((f) => f.type === 'image/jpeg');
  assert.equal(fetched.length, 2);
  assert.ok(fetched.every((f) => f.status === 200 && f.size > 1000));
  const feed = mock.state.fbUploads.find((u) => u.edge === 'feed');
  assert.equal(feed.attached.length, 2);
  assert.equal(feed.message, 'Tour photos');
  assert.equal(mock.state.fbUploads.filter((u) => u.edge === 'photos' && u.published === 'false').length, 2);
});

await step('signed media links reject a bad or expired signature', async () => {
  const media = (await api(`/api/clients/${(await api('/api/clients')).body[0].id}/media`)).body;
  const res = await fetch(`${APP}/m/${media[0].id}/x.jpg?exp=${Date.now() + 60_000}&sig=forged`);
  assert.equal(res.status, 403);
  const old = await fetch(`${APP}/m/${media[0].id}/x.jpg?exp=1000&sig=x`);
  assert.equal(old.status, 403);
});

await step('an expired Instagram sign-in fails the post and flags the account; reconnecting and retrying publishes it', async () => {
  mock.state.failNext['meta:publish'] = true;
  const clientId = (await api('/api/clients')).body[0].id;
  const ig = (await api(`/api/clients/${clientId}`)).body.accounts.find((a) => a.platform === 'instagram');
  const media = (await api(`/api/clients/${clientId}/media`)).body.find((m) => m.kind === 'image');
  const created = await api('/api/posts', { method: 'POST', data: { clientId, caption: 'Retry me', mediaIds: [media.id], scheduledAt: Date.now(), targets: [{ accountId: ig.id, caption: null, options: {} }] } });
  assert.equal(created.status, 200);
  await page.goto(`${APP}/#/posts/${created.body.id}`);
  await page.locator('.target-status .problem', { hasText: 'Connect the account again' }).waitFor({ timeout: 20_000 });
  await page.locator('.badge-failed', { hasText: 'Reconnect' }).first().waitFor();
  await page.goto(`${APP}/#/clients/${clientId}`);
  await page.locator('.connect-option', { hasText: 'Facebook & Instagram' }).getByRole('link', { name: 'Connect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Add/ }).click();
  await until(async () => (await api(`/api/clients/${clientId}`)).body.accounts.every((a) => a.status === 'ok'), 'the account to be OK again');
  await page.goto(`${APP}/#/posts/${created.body.id}`);
  await page.getByRole('button', { name: 'Try again' }).click();
  await allPublished(created.body.id);
});

await step('the server enforces the platform rules too', async () => {
  const clientId = (await api('/api/clients')).body[0].id;
  const yt = (await api(`/api/clients/${clientId}`)).body.accounts.find((a) => a.platform === 'youtube');
  const res = await api('/api/posts', { method: 'POST', data: { clientId, caption: 'x', mediaIds: [], scheduledAt: Date.now() + 3600_000, targets: [{ accountId: yt.id, caption: null, options: {} }] } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /YouTube needs exactly one video\. YouTube needs a title\./);
});

await step('schedule for later, see it under Upcoming, then cancel it', async () => {
  await page.getByRole('link', { name: 'New post' }).first().click();
  await page.getByRole('button', { name: 'From library' }).click();
  await page.getByRole('dialog').locator('.media-tile').first().click();
  await page.getByLabel('Caption').fill('Next week');
  await toggle('facebook').click();
  const later = new Date(Date.now() + 2 * 86400_000);
  const pad = (n) => String(n).padStart(2, '0');
  await page.getByLabel('Publish at').fill(`${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T10:30`);
  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.locator('.topbar .badge-scheduled').waitFor();
  const id = postIdFromUrl();
  await page.locator('nav a', { hasText: 'Posts' }).click();
  await page.getByRole('tab', { name: /Upcoming/ }).click();
  await page.locator('.post-row', { hasText: 'Next week' }).waitFor();
  await page.getByRole('tab', { name: /Published/ }).click();
  await shot('queue-published');
  await page.getByRole('tab', { name: /Upcoming/ }).click();
  await page.goto(`${APP}/#/posts/${id}`);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.topbar .badge-cancelled').waitFor();
});

await step('invite a teammate, who signs up from the link', async () => {
  await page.locator('nav a', { hasText: 'Team' }).click();
  await page.getByLabel('Invite email').fill('sam@example.com');
  await page.getByRole('button', { name: 'Create link' }).click();
  const link = await page.getByLabel('Invite link').inputValue();
  const other = await (await browser.newContext()).newPage();
  await other.goto(link);
  await other.getByText("You're joining as sam@example.com.").waitFor();
  await other.getByLabel('Your name').fill('Sam');
  await other.getByLabel('Choose a password').fill('another long password');
  await other.getByRole('button', { name: 'Join' }).click();
  await other.locator('nav a', { hasText: 'Nova Rae' }).waitFor();
  // The link works once.
  const again = await (await browser.newContext()).newPage();
  await again.goto(link);
  await again.getByText('Invite link not valid').waitFor();
});

assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
await cleanup();
console.log(`\n${passed} passed`);
