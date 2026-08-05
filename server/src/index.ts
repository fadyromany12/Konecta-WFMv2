import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from './routes/index.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { PRODUCT } from './domain/reference.js';
import './db/index.js';

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, product: PRODUCT.name, time: new Date().toISOString() });
});

app.use('/api', api);

// Serve the built front end when it exists, so a production build runs from a
// single process.
const webDist = resolve(process.cwd(), '../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(resolve(webDist, 'index.html'));
  });
}

app.use('/api', notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`${PRODUCT.name} API listening on http://localhost:${PORT}`);
});
