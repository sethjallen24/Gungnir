// Settings come from environment variables (see README). Only PUBLIC_URL and the platform app
// credentials matter in production; everything else has a working default for local use.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Settings can also live in a .env file next to package.json (see .env.example).
try {
  process.loadEnvFile(path.resolve('.env'));
} catch {
  /* no .env file */
}

const env = (name: string, fallback = ''): string => process.env[name]?.trim() || fallback;

const dataDir = path.resolve(env('DATA_DIR', 'data'));
fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });

/** The key that encrypts platform tokens. From SECRET_KEY, else generated once into the data folder. */
function secretKey(): Buffer {
  const fromEnv = env('SECRET_KEY');
  if (fromEnv) {
    const key = /^[0-9a-f]{64}$/i.test(fromEnv) ? Buffer.from(fromEnv, 'hex') : crypto.createHash('sha256').update(fromEnv).digest();
    return key;
  }
  const file = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

const publicUrl = env('PUBLIC_URL', `http://localhost:${env('PORT', '3000')}`).replace(/\/+$/, '');

export const config = {
  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0'),
  /** Where the app is reached from the internet: OAuth redirects and media links for the platforms. */
  publicUrl,
  secureCookies: publicUrl.startsWith('https://'),
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  dbFile: path.join(dataDir, 'gungnir.sqlite'),
  secretKey: secretKey(),
  /** Largest upload, in bytes. */
  maxUploadBytes: Number(env('MAX_UPLOAD_MB', '1024')) * 1024 * 1024,
  /** How often the scheduler looks for posts that are due (ms). */
  schedulerIntervalMs: Number(env('SCHEDULER_INTERVAL_MS', '15000')),
  /** Multiplies waits between publishing steps and retries; tests set it near 0. */
  waitScale: Number(env('PUBLISH_WAIT_SCALE', '1')),
  meta: {
    appId: env('META_APP_ID'),
    appSecret: env('META_APP_SECRET'),
    /** Facebook Login for Business configuration; when set it replaces the scope list. */
    configId: env('META_CONFIG_ID'),
    graphVersion: env('META_GRAPH_VERSION', 'v26.0'),
  },
  google: { clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET') },
  tiktok: { clientKey: env('TIKTOK_CLIENT_KEY'), clientSecret: env('TIKTOK_CLIENT_SECRET') },
  /** Platform addresses; tests point these at a local stand-in. */
  endpoints: {
    facebookWww: env('META_WWW_URL', 'https://www.facebook.com'),
    graph: env('META_GRAPH_URL', 'https://graph.facebook.com'),
    rupload: env('META_RUPLOAD_URL', 'https://rupload.facebook.com'),
    googleAuth: env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    googleToken: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    googleApis: env('GOOGLE_API_URL', 'https://www.googleapis.com'),
    tiktokAuth: env('TIKTOK_AUTH_URL', 'https://www.tiktok.com/v2/auth/authorize/'),
    tiktokApi: env('TIKTOK_API_URL', 'https://open.tiktokapis.com'),
  },
};

export type Config = typeof config;
