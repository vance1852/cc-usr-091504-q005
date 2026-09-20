import createFastify, { type FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { AppError } from './errors.js';
import * as org from './services/org.js';
import {
  attachVoucher,
  advisorReview,
  cancelActivity,
  createDraft,
  financePay,
  financeReject,
  getRequestView,
  reworkEvidence,
  submitRequest,
} from './services/requests.js';
import { approveRefund, rejectRefund, requestRefund } from './services/refunds.js';
import { listOpenReviews, resolveDuplicateReview } from './services/vouchers.js';
import { drilldown, getBalances } from './services/budget.js';
import { closeSemester } from './services/semester.js';

export interface AppDeps {
  db: DB;
}

declare module 'fastify' {
  interface FastifyRequest {
    actorId: number | null;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = createFastify({ logger: true });
  const db = deps.db;

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
      return;
    }
    req.log.error(err);
    reply.status(500).send({ error: 'E_INTERNAL', message: (err as Error).message });
  });

  // Authenticate via X-User-Id (demo scheme; a real deployment would use tokens).
  const auth = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const raw = req.headers['x-user-id'];
    const id = Number(Array.isArray(raw) ? raw[0] : raw);
    if (!Number.isInteger(id)) {
      reply.status(401).send({ error: 'E_UNAUTHORIZED', message: 'X-User-Id header required' });
      return;
    }
    try {
      org.getUser(db, id);
    } catch {
      reply.status(401).send({ error: 'E_UNAUTHORIZED', message: 'unknown user' });
      return;
    }
    req.actorId = id;
  };

  // ---------- admin / setup ----------
  app.post('/admin/clubs', async (req) => {
    const { name } = req.body as { name: string };
    return { id: org.createClub(db, name) };
  });
  app.post('/admin/users', async (req) => {
    const { name, role, club_id } = req.body as {
      name: string;
      role: 'student_leader' | 'advisor' | 'finance';
      club_id?: number | null;
    };
    return { id: org.createUser(db, name, role, club_id ?? null) };
  });
  app.post('/admin/advisors', async (req) => {
    const { club_id, user_id } = req.body as { club_id: number; user_id: number };
    org.addAdvisor(db, club_id, user_id);
    return { ok: true };
  });
  app.post('/admin/semesters', async (req) => {
    const { name } = req.body as { name: string };
    return { id: org.createSemester(db, name) };
  });
  app.post('/admin/budgets', async (req) => {
    const { semester_id, club_id, amount_cents, created_by } = req.body as {
      semester_id: number;
      club_id: number;
      amount_cents: number;
      created_by?: number | null;
    };
    return {
      id: org.createBudget(db, semester_id, club_id, amount_cents, created_by ?? null),
    };
  });
  app.post('/admin/activities', async (req) => {
    const { club_id, semester_id, name, quota_cents, created_by } = req.body as {
      club_id: number;
      semester_id: number;
      name: string;
      quota_cents: number;
      created_by: number;
    };
    return {
      id: org.createActivity(db, club_id, semester_id, name, quota_cents, created_by),
    };
  });

  // ---------- requests ----------
  app.post(
    '/requests',
    { preHandler: auth },
    async (req): Promise<number | object> => {
      const { activity_id, title, amount_cents } = req.body as {
        activity_id: number;
        title: string;
        amount_cents: number;
      };
      return { id: createDraft(db, req.actorId!, { activityId: activity_id, title, amountCents: amount_cents }) };
    },
  );

  app.get('/requests/:id', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    return getRequestView(db, Number(id));
  });

  app.post('/requests/:id/vouchers', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const v = req.body as {
      voucher_no: string;
      summary: string;
      amount_cents: number;
      share_cents: number;
    };
    return attachVoucher(db, req.actorId!, Number(id), {
      voucherNo: v.voucher_no,
      summary: v.summary,
      amountCents: v.amount_cents,
      shareCents: v.share_cents,
    });
  });

  app.put('/requests/:id/vouchers', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const items = (req.body as { items: Array<{
      voucher_no: string; summary: string; amount_cents: number; share_cents: number;
    }> }).items;
    const result = reworkEvidence(
      db,
      req.actorId!,
      Number(id),
      items.map((v) => ({
        voucherNo: v.voucher_no,
        summary: v.summary,
        amountCents: v.amount_cents,
        shareCents: v.share_cents,
      })),
    );
    return { vouchers: result };
  });

  app.post('/requests/:id/submit', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    submitRequest(db, req.actorId!, Number(id));
    return { ok: true };
  });

  app.post('/requests/:id/advisor-review', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const { decision, comment } = req.body as { decision: 'approve' | 'reject'; comment?: string };
    advisorReview(db, req.actorId!, Number(id), decision, comment);
    return { ok: true };
  });

  app.post('/requests/:id/pay', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const { idempotency_key } = (req.body ?? {}) as { idempotency_key?: string };
    return financePay(db, req.actorId!, Number(id), idempotency_key);
  });

  app.post('/requests/:id/finance-reject', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const { comment } = (req.body ?? {}) as { comment?: string };
    financeReject(db, req.actorId!, Number(id), comment);
    return { ok: true };
  });

  app.post('/activities/:id/cancel', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    return cancelActivity(db, req.actorId!, Number(id), reason);
  });

  // ---------- refunds ----------
  app.post('/requests/:id/refunds', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const { amount_cents, reason, parent_refund_id } = req.body as {
      amount_cents: number;
      reason?: string;
      parent_refund_id?: number | null;
    };
    return {
      id: requestRefund(db, req.actorId!, Number(id), amount_cents, reason, parent_refund_id ?? null),
    };
  });

  app.post('/refunds/:id/approve', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const { idempotency_key } = (req.body ?? {}) as { idempotency_key?: string };
    return approveRefund(db, req.actorId!, Number(id), idempotency_key);
  });

  app.post('/refunds/:id/reject', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const { comment } = (req.body ?? {}) as { comment?: string };
    rejectRefund(db, req.actorId!, Number(id), comment);
    return { ok: true };
  });

  // ---------- duplicate reconciliation ----------
  app.get('/reviews', { preHandler: auth }, async () => listOpenReviews(db));
  app.post('/reviews/:id/resolve', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const { resolution, note } = req.body as {
      resolution: 'cleared' | 'confirmed_duplicate';
      note?: string;
    };
    resolveDuplicateReview(db, Number(id), resolution, req.actorId!, note);
    return { ok: true };
  });

  // ---------- balances & drill-down ----------
  app.get('/budgets', { preHandler: auth }, async (req) => {
    const q = req.query as { semester_id: string; club_id: string; activity_id?: string };
    const scope = {
      semesterId: Number(q.semester_id),
      clubId: Number(q.club_id),
      activityId: q.activity_id != null ? Number(q.activity_id) : undefined,
    };
    return q.activity_id != null ? drilldown(db, scope) : { scope, balances: getBalances(db, scope) };
  });

  app.get('/budgets/drilldown', { preHandler: auth }, async (req) => {
    const q = req.query as { semester_id: string; club_id: string; activity_id?: string };
    return drilldown(db, {
      semesterId: Number(q.semester_id),
      clubId: Number(q.club_id),
      activityId: q.activity_id != null ? Number(q.activity_id) : undefined,
    });
  });

  // ---------- semester carryover ----------
  app.post('/semesters/:from/close-into/:to', { preHandler: auth }, async (req) => {
    const { from, to } = req.params as { from: string; to: string };
    return {
      carryovers: closeSemester(db, Number(from), Number(to), req.actorId!),
    };
  });

  return app;
}
