import express, { type Express } from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from './routes/index.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { PRODUCT } from './domain/reference.js';
import { db, IS_MEMORY } from './db/index.js';
import { seed } from './db/seed.js';

/**
 * Build the Express app. Kept separate from the listener so the same app can be
 * served by `node dist/index.js` locally and exported as a serverless handler
 * on Vercel.
 */
export function createApp(): Express {
  ensureSeeded();

  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get(['/api/health', '/health'], (_req, res) => {
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    res.json({
      ok: true,
      product: PRODUCT.name,
      storage: IS_MEMORY ? 'in-memory (ephemeral)' : 'file',
      users: users.n,
      time: new Date().toISOString(),
    });
  });

  app.use('/api', api);
  // A platform rewrite can deliver the request with the /api prefix already
  // stripped, so the same router is mounted at the root as well. Harmless in a
  // single-process deployment, and it keeps routing independent of how the
  // request was rewritten on the way in.
  app.use(api);

  // In a single-process deployment the API also serves the built front end.
  // On Vercel the static files are served by the platform and this is skipped.
  const webDist = resolve(process.cwd(), '../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(resolve(webDist, 'index.html'));
    });
  }

  app.use('/api', notFound);
  app.use(errorHandler);

  return app;
}

/**
 * An empty database seeds itself. On a serverless cold start this is the only
 * chance to put data in place; locally it just saves a step the first time.
 */
function ensureSeeded(): void {
  try {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    if (n > 0) return;
    const started = Date.now();
    seed({ quiet: true });
    console.log(`${PRODUCT.name}: seeded an empty database in ${Date.now() - started}ms`);
  } catch (err) {
    console.error('Could not seed the database:', err);
  }
}
