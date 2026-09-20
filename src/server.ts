import { buildApp } from './app.js';
import { openDb } from './db/db.js';

const dbPath = process.env.DB_PATH ?? './data/finance.sqlite';
const port = Number(process.env.PORT ?? 3000);

const db = openDb(dbPath);
const app = buildApp(db);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`社团经费核销服务已启动: http://localhost:${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
