import { openDb } from './db.js';
import { buildApp } from './app.js';

const dbFile = process.env.DB_FILE ?? './data/club-funds.sqlite';
const port = Number(process.env.PORT ?? 3000);

const db = openDb(dbFile);
const app = buildApp({ db });

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
