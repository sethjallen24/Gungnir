// Publishes due posts. Every few seconds it claims targets that are due, runs one step of each
// (an upload, a status check, the final publish), and records the outcome. Progress is saved
// after each step, so a restart picks up where it stopped rather than posting twice.
import path from 'node:path';
import type { TargetOptions } from '../shared/types.js';
import { config } from './config.js';
import { logActivity, type DB } from './db.js';
import { PublishError } from './platforms/http.js';
import { PUBLISHERS } from './platforms/index.js';
import { connectionToken } from './platforms/tokens.js';
import type { AccountRow, ConnectionRow, MediaRow, PostRow, TargetRow } from './repo.js';
import { decrypt, signedMediaUrl } from './security.js';

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];
/** How long a claimed target is reserved for one step before another worker may take it. */
const LOCK_MS = 6 * 3600_000;
/** Give up on a post the platform is still processing after this long. */
const GIVE_UP_MS = 24 * 3600_000;
const CONCURRENCY = 3;

export interface Scheduler {
  start(): void;
  stop(): void;
  /** Look for due posts now. */
  kick(): void;
  /** Runs until nothing is due right now (for tests). */
  drain(): Promise<void>;
}

export function createScheduler(db: DB, log: (msg: string, err?: unknown) => void = () => undefined): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  const claim = (now: number): TargetRow[] => {
    const due = db
      .prepare(
        `SELECT t.* FROM targets t JOIN posts p ON p.id = t.post_id
         WHERE t.status IN ('scheduled', 'publishing') AND t.next_attempt_at <= ? AND (t.locked_until IS NULL OR t.locked_until < ?)
         ORDER BY t.next_attempt_at LIMIT ?`,
      )
      .all(now, now, CONCURRENCY) as TargetRow[];
    return due.filter(
      (t) =>
        db
          .prepare(
            "UPDATE targets SET status = 'publishing', locked_until = ?, updated_at = ? WHERE id = ? AND (locked_until IS NULL OR locked_until < ?) AND status IN ('scheduled', 'publishing')",
          )
          .run(now + LOCK_MS, now, t.id, now).changes === 1,
    );
  };

  async function runOne(t: TargetRow): Promise<void> {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(t.post_id) as PostRow;
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(t.account_id) as AccountRow | undefined;
    const fail = (message: string) => {
      db.prepare("UPDATE targets SET status = 'failed', error = ?, locked_until = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(message, Date.now(), t.id);
      logActivity(db, { clientId: post.client_id, postId: post.id, message: `couldn't publish to ${account?.name ?? 'an account'}: ${message}` });
    };
    if (!account) return fail('The account was removed.');
    const connection = db.prepare('SELECT * FROM connections WHERE id = ?').get(account.connection_id) as ConnectionRow;
    const ids = JSON.parse(post.media_json) as string[];
    const media = ids.map((id) => db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined);
    if (media.some((m) => !m)) return fail('A file in the post was deleted.');
    const state = JSON.parse(t.state_json) as Record<string, any>;
    state.startedAt ??= Date.now();
    if (Date.now() - state.startedAt > GIVE_UP_MS) return fail('The platform was still processing the post after 24 hours.');

    const publisher = PUBLISHERS[account.platform];
    try {
      const result = await publisher.step({
        db,
        target: t,
        account,
        connection,
        media: media as MediaRow[],
        caption: t.caption ?? post.caption,
        options: JSON.parse(t.options_json) as TargetOptions,
        state,
        save: (s) => db.prepare('UPDATE targets SET state_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(s), Date.now(), t.id),
        accessToken: () => connectionToken(db, connection),
        accountToken: () => {
          const tok = decrypt(account.token_enc);
          if (!tok) throw new PublishError('This account has no saved sign-in. Connect it again.', { reconnect: true });
          return tok;
        },
        filePath: (m) => path.join(config.mediaDir, m.stored_name),
        publicUrl: (m) => signedMediaUrl(m.id, m.file_name),
      });
      const now = Date.now();
      if (result.status === 'wait') {
        db.prepare('UPDATE targets SET state_json = ?, next_attempt_at = ?, locked_until = NULL, updated_at = ? WHERE id = ?').run(
          JSON.stringify(state),
          now + result.ms * config.waitScale,
          now,
          t.id,
        );
        return;
      }
      db.prepare(
        "UPDATE targets SET status = 'published', external_id = ?, external_url = ?, published_at = ?, error = NULL, locked_until = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
      ).run(result.externalId, result.url, now, now, t.id);
      logActivity(db, { clientId: post.client_id, postId: post.id, message: `published to ${account.name} (${account.platform})` });
    } catch (err) {
      const e = err instanceof PublishError ? err : new PublishError((err as Error).message || String(err), { retryable: true });
      if (!(err instanceof PublishError)) log(`Unexpected error publishing target ${t.id}`, err);
      if (e.opts.reconnect) {
        db.prepare("UPDATE accounts SET status = 'reconnect', status_detail = ? WHERE id = ?").run(e.message, account.id);
        return fail(e.message);
      }
      const attempts = t.attempts + 1;
      if (e.opts.retryable && attempts < MAX_ATTEMPTS) {
        const wait = Math.max(e.opts.retryAfterMs ?? 0, BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
        db.prepare("UPDATE targets SET status = 'scheduled', attempts = ?, error = ?, state_json = ?, next_attempt_at = ?, locked_until = NULL, updated_at = ? WHERE id = ?").run(
          attempts,
          `${e.message} (will retry)`,
          e.opts.resetState ? '{}' : JSON.stringify(state),
          Date.now() + wait * config.waitScale,
          Date.now(),
          t.id,
        );
        return;
      }
      if (e.opts.resetState) db.prepare("UPDATE targets SET state_json = '{}' WHERE id = ?").run(t.id);
      db.prepare('UPDATE targets SET attempts = ? WHERE id = ?').run(attempts, t.id);
      fail(e.message);
    }
  }

  async function tick(): Promise<void> {
    for (;;) {
      const claimed = claim(Date.now());
      if (!claimed.length) return;
      await Promise.all(claimed.map((t) => runOne(t).catch((err) => log(`Scheduler error on ${t.id}`, err))));
    }
  }

  const run = () => {
    if (running) {
      again = true;
      return running;
    }
    running = tick()
      .catch((err) => log('Scheduler tick failed', err))
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          void run();
        }
      });
    return running;
  };

  return {
    start() {
      // Steps cut short by a restart are unlocked so they run again.
      db.prepare("UPDATE targets SET locked_until = NULL WHERE status = 'publishing'").run();
      timer = setInterval(() => void run(), config.schedulerIntervalMs);
      void run();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    kick() {
      setImmediate(() => void run());
    },
    async drain() {
      await run();
      while (running) await running;
    },
  };
}
