import Fastify, { type FastifyInstance } from 'fastify';
import type { DB } from './db/db.js';
import { registerRoutes } from './routes.js';

export function buildApp(db: DB): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(registerRoutes, { db });
  return app;
}
