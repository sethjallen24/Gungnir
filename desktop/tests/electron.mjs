// Smoke test of the Mac app against a real Gungnir server (the root project's build). Checks the
// connect page refuses wrong addresses, that the server opens in the window with no bridge or
// Node, that links to other sites go to the browser, that a failed post shows in the window
// title, that the address and sign-in are remembered, and the message when the server is down.
//
//   (cd .. && npm run build) && node tests/electron.mjs     (Linux CI: xvfb-run node tests/electron.mjs)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(appDir);
// The server's own SQLite driver, to add a failed post directly.
const Database = createRequire(path.join(root, 'package.json'))('better-sqlite3');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gungnir-desktop-test-'));
const userData = path.join(tmp, 'user-data');
const dataDir = path.join(tmp, 'server-data');
fs.mkdirSync(dataDir);
const port = 33000 + Math.floor(Math.random() * 2000);
const SERVER = `http://127.0.0.1:${port}`;
// Chromium refuses to run as root with its sandbox (only relevant in containers).
const args = [appDir, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])];

function startServer() {
  const server = spawn(process.execPath, [path.join(root, 'dist/server/server/index.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, PUBLIC_URL: SERVER, NODE_ENV: 'test' },
    cwd: dataDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return server;
}

async function waitFor(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** The window's title bar (not the page's document title). */
const windowTitle = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());

async function launch() {
  const app = await electron.launch({ args, env: { ...process.env, GUNGNIR_USER_DATA: userData, GUNGNIR_POLL_MS: '500' } });
  const win = await app.firstWindow();
  // Record links sent to the default browser instead of opening them.
  await app.evaluate(({ shell }) => {
    globalThis.openedExternally = [];
    shell.openExternal = async (url) => void globalThis.openedExternally.push(url);
  });
  return { app, win };
}

console.log('Gungnir desktop smoke test');

let server = startServer();
// Don't leave the server running if a check fails.
process.on('exit', () => server.kill());
await waitFor(async () => (await fetch(`${SERVER}/api/status`)).ok, 'the server to start');
// Something that answers but isn't Gungnir.
const other = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Hello</h1>'));
await new Promise((r) => other.listen(0, '127.0.0.1', r));
const OTHER = `http://127.0.0.1:${other.address().port}`;

let { app, win } = await launch();
await win.waitForSelector('h1:has-text("Connect to Gungnir")');
assert.equal(await win.evaluate(() => typeof window.gungnir?.setServer), 'function');
assert.equal(await win.evaluate(() => typeof window.require), 'undefined', 'no Node in the renderer');

const tryAddress = async (address) => {
  await win.getByLabel('Server address').fill(address);
  await win.getByRole('button', { name: 'Connect' }).click();
};
await tryAddress(OTHER);
await win.locator('#error', { hasText: 'doesn’t look like a Gungnir server' }).waitFor();
await tryAddress('http://127.0.0.1:1');
await win.locator('#error', { hasText: 'Couldn’t reach http://127.0.0.1:1' }).waitFor();
await tryAddress('not a url');
await win.locator('#error', { hasText: 'isn’t a web address' }).waitFor();
console.log('  ✓ the connect page refuses addresses that aren’t a Gungnir server');

// A path or trailing slash is dropped; only the server's origin is kept.
await tryAddress(`${SERVER}/some/page/`);
await win.waitForSelector('button:has-text("Create admin account")');
assert.equal(win.url(), `${SERVER}/`);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')), { serverUrl: SERVER });
assert.equal(await win.evaluate(() => typeof window.gungnir), 'undefined', 'server pages get no bridge');
assert.equal(await win.evaluate(() => typeof window.require), 'undefined');
assert.doesNotMatch(await win.evaluate(() => navigator.userAgent), /Electron|Gungnir/);
console.log('  ✓ a good address opens the server in the window, without the bridge');

await win.getByLabel('Your name').fill('Ada Admin');
await win.getByLabel('Email').fill('ada@example.com');
await win.getByLabel('Password').fill('correct horse battery');
await win.getByRole('button', { name: 'Create admin account' }).click();
await win.locator('.sidebar').waitFor();
console.log('  ✓ sign-in works inside the app');

await win.evaluate(() => {
  location.href = 'https://example.com/elsewhere';
});
await waitFor(() => app.evaluate(() => globalThis.openedExternally.length === 1), 'the link to open in the browser');
await win.evaluate(() => window.open('https://www.tiktok.com/legal/page/global/music-usage-confirmation/en'));
await waitFor(() => app.evaluate(() => globalThis.openedExternally.length === 2), 'the new window to open in the browser');
assert.deepEqual(await app.evaluate(() => globalThis.openedExternally), ['https://example.com/elsewhere', 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en']);
assert.ok(win.url().startsWith(SERVER), 'the window stays on the server');
assert.equal((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)), 1);
console.log('  ✓ other sites and new windows open in the default browser');

// A post whose publish failed, as the scheduler leaves it.
const db = new Database(path.join(dataDir, 'gungnir.sqlite'));
const now = Date.now();
db.exec(`
  INSERT INTO clients (id, name, created_at) VALUES ('c1', 'Nova Rae', ${now});
  INSERT INTO connections (id, client_id, provider, external_user_id, name, created_at, updated_at) VALUES ('k1', 'c1', 'tiktok', 'u1', 'Nova', ${now}, ${now});
  INSERT INTO accounts (id, client_id, connection_id, platform, external_id, name, created_at) VALUES ('a1', 'c1', 'k1', 'tiktok', 'u1', 'Nova', ${now});
  INSERT INTO posts (id, client_id, caption, scheduled_at, created_at, updated_at) VALUES ('p1', 'c1', 'Tour dates out now', ${now}, ${now}, ${now});
  INSERT INTO targets (id, post_id, account_id, status, error, updated_at) VALUES ('t1', 'p1', 'a1', 'failed', 'The video was rejected', ${now});
`);
db.close();
await waitFor(async () => (await windowTitle(app)) === 'Gungnir (1 failed)', 'the title to show the failed post', 10_000);
console.log('  ✓ the window title counts failed posts');

await app.close();
({ app, win } = await launch());
await win.locator('.sidebar').waitFor();
assert.ok(win.url().startsWith(SERVER));
await waitFor(async () => (await windowTitle(app)) === 'Gungnir (1 failed)', 'the failed count after relaunch', 10_000);
console.log('  ✓ the server and the sign-in are remembered on the next launch');
await app.close();

server.kill();
await new Promise((r) => server.once('exit', r));
({ app, win } = await launch());
await win.locator('#error', { hasText: `Couldn’t open 127.0.0.1:${port}` }).waitFor();
assert.equal(await win.getByLabel('Server address').inputValue(), SERVER);
await win.getByRole('button', { name: 'Try again' }).waitFor();
server = startServer();
await waitFor(async () => (await fetch(`${SERVER}/api/status`)).ok, 'the server to restart');
await win.getByRole('button', { name: 'Try again' }).click();
await win.locator('.sidebar').waitFor();
console.log('  ✓ an unreachable server shows Try again, which reopens it');

await app.close();
server.kill();
other.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nall passed');
