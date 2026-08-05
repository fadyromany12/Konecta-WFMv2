/**
 * Vercel serverless entry point.
 *
 * An Express app is already a `(req, res)` handler, so it can be exported
 * directly. `createApp()` runs at module scope, which means the cold start
 * builds and seeds the in-memory database once and every request on that warm
 * instance reuses it.
 *
 * Locally the same app is served by `server/src/index.ts` with a real listener.
 */
import { createApp } from '../server/src/app.js';

export default createApp();
