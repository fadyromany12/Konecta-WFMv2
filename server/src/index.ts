import { createApp } from './app.js';
import { PRODUCT } from './domain/reference.js';

const PORT = Number(process.env.PORT ?? 4000);

createApp().listen(PORT, () => {
  console.log(`${PRODUCT.name} API listening on http://localhost:${PORT}`);
});
