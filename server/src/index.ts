import { createApp, ready } from './app.js';
import { PRODUCT } from './domain/reference.js';
import { ENDPOINT_KIND, storageDescription } from './db/index.js';
import { diagnose } from './db/diagnose.js';

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
    // The same diagnosis the 503 gives, because a self-hosted run fails here
    // instead — it refuses to listen at all rather than serving an error page,
    // so without this the better message would only ever be seen on Vercel.
    const { reason, fix, code } = diagnose(err, ENDPOINT_KIND);
    console.error(`${PRODUCT.name} could not start: ${reason}`);
    console.error(`  ${fix}`);
    if (code) console.error(`  (driver code ${code})`);
    process.exit(1);
  });
