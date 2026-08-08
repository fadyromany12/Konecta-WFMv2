import { createApp, ready } from './app.js';
import { PRODUCT } from './domain/reference.js';
import { storageDescription } from './db/index.js';

const PORT = Number(process.env.PORT ?? 4000);

// Prepare storage before accepting traffic, so the first request does not pay
// for the migration and a broken database is reported at startup rather than
// discovered by whoever tries to sign in first.
ready()
  .then(() => {
    createApp().listen(PORT, () => {
      console.log(`${PRODUCT.name} API listening on http://localhost:${PORT}`);
      console.log(`Storage: ${storageDescription()}`);
    });
  })
  .catch((err) => {
    console.error(`${PRODUCT.name} could not start:`, err);
    process.exit(1);
  });
