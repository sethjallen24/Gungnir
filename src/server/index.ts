// Starts the server and the publishing scheduler.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { createScheduler } from './scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Built layout: dist/server/server/index.js serves dist/web; in development Vite serves the UI.
const webDir = path.resolve(here, '../../web');

const db = openDatabase();
let scheduler: ReturnType<typeof createScheduler> | null = null;
const app = await buildApp({ db, webDir, kick: () => scheduler?.kick() });
scheduler = createScheduler(db, (msg, err) => app.log.error({ err }, msg));

await app.listen({ port: config.port, host: config.host });
scheduler.start();
app.log.info(`Gungnir is running at ${config.publicUrl}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    scheduler?.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
