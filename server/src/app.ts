import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from './routes/index.js';
import { planning } from './routes/planning.js';
import { events } from './routes/events.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { PRODUCT } from './domain/reference.js';
import { db, ensureSchema, storageDescription, ENDPOINT_KIND, USING_POSTGRES } from './db/index.js';
import { diagnose } from './db/diagnose.js';
import { seed } from './db/seed.js';

/**
 * Build the Express app. Kept separate from the listener so the same app can be
 * served by `node dist/index.js` locally and exported as a serverless handler
 * on Vercel.
 */
export function createApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Nothing may touch the database before the tables exist. On a long-running
  // server this resolves once during the first request; on a serverless cold
  // start it is the only chance to create the schema and put data in place.
  app.use(readyGate);

  app.get(['/api/health', '/health'], async (_req, res) => {
    const users = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    res.json({
      ok: true,
      product: PRODUCT.name,
      storage: storageDescription(),
      users: Number(users?.n ?? 0),
      time: new Date().toISOString(),
    });
  });

  app.use('/api', api);
  app.use('/api', planning);
  app.use('/api', events);

  // In a single-process deployment the API also serves the built front end.
  // On Vercel the static files are served by the platform and this is skipped.
  const webDist = resolve(process.cwd(), '../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/, wantsHtml, (_req, res) => {
      res.sendFile(resolve(webDist, 'index.html'));
    });
  }

  // A platform rewrite can deliver the request with the /api prefix already
  // stripped, so the same routers are mounted at the root as a fallback.
  //
  // This has to come *after* the front-end fallback, not before it. Several
  // screens share a path with an endpoint — /admin/audit, /reports/query,
  // /reports/exceptions are both a page and an API route — so mounting the API
  // at the root first meant a browser asking for the *page* was answered with
  // the endpoint, and a hard refresh on those screens returned 401 JSON instead
  // of the application. Anything that says it wants HTML gets the app; the
  // stripped-prefix API call, which asks for JSON, still reaches the router.
  app.use(api);
  app.use(planning);
  app.use(events);

  app.use('/api', notFound);
  app.use(errorHandler);

  return app;
}

/**
 * Let a request through to the front-end fallback only when it looks like a
 * browser asking for a page. An XHR or fetch sends `Accept: application/json`
 * (or at least does not ask for HTML), so it falls through to the API routers
 * mounted below.
 */
function wantsHtml(req: Request, _res: Response, next: NextFunction): void {
  const accept = req.headers.accept ?? '';
  if (accept.includes('text/html') || accept === '*/*' || accept === '') next();
  else next('route');
}

/**
 * Memoised so concurrent requests on a cold start wait for one migration rather
 * than racing to run several. A failure is not cached: the next request tries
 * again, which matters when the cause was a database that was briefly asleep.
 */
let readiness: Promise<void> | null = null;

export function ready(): Promise<void> {
  readiness ??= prepare().catch((err) => {
    readiness = null;
    throw err;
  });
  return readiness;
}

async function prepare(): Promise<void> {
  await ensureSchema();
  await ensureSeeded();
}

function readyGate(_req: Request, res: Response, next: NextFunction): void {
  ready().then(
    () => next(),
    (err) => {
      console.error('Storage is not ready:', err);
      if (!USING_POSTGRES) {
        res.status(503).json({ error: 'The database could not be opened.' });
        return;
      }
      // Name the cause. The person looking at the sign-in screen is usually
      // not the person who can read the platform logs, and one message that
      // fits every possible failure sends them to the wrong one.
      const { reason, fix, code } = diagnose(err, ENDPOINT_KIND);
      res.status(503).json({ error: `${reason} ${fix}`, reason, fix, code });
    },
  );
}

/**
 * An empty database seeds itself. Locally it saves a step the first time; on a
 * fresh Postgres it is what makes the deployment usable without a manual step.
 */
async function ensureSeeded(): Promise<void> {
  try {
    const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    if (Number(row?.n ?? 0) > 0) return;
    const started = Date.now();
    await seed({ quiet: true });
    console.log(`${PRODUCT.name}: seeded an empty database in ${Date.now() - started}ms`);
  } catch (err) {
    // A seeding failure must not take the process down — an operator can still
    // reach /api/health to find out what is wrong.
    console.error('Could not seed the database:', err);
  }
}
