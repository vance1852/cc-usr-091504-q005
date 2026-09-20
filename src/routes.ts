import type { FastifyInstance } from 'fastify';
import type { DB } from './db/db.js';
import { Errors } from './domain/errors.js';
import * as Catalog from './services/catalog.js';
import * as Requests from './services/requests.js';
import * as Vouchers from './services/vouchers.js';
import {
  drillDown,
  getActivityBalance,
  getBudgetBalance,
} from './services/ledger.js';
import { verifyApprovalChain } from './services/approvals.js';
import { parseYuan } from './http/validate.js';

export interface RouteDeps {
  db: DB;
}

/** 从请求头 x-user-id 解析当前操作人；/admin 引导接口（尚无用户时）豁免 */
function auth(app: FastifyInstance, db: DB) {
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/admin/')) return;
    const userId = req.headers['x-user-id'];
    if (!userId || Array.isArray(userId)) {
      return reply.code(401).send({ error: 'UNAUTHENTICATED', message: '缺少 x-user-id 请求头' });
    }
    try {
      (req as any).actor = Catalog.getUser(db, userId);
    } catch {
      return reply.code(401).send({ error: 'UNAUTHENTICATED', message: '用户不存在' });
    }
  });
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const db = deps.db;
  auth(app, db);

  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof Error && error.constructor.name === 'AppError') {
      const err = error as any;
      return reply.code(err.statusCode ?? 400).send({ error: err.code, message: err.message });
    }
    if ((error as any)?.code === 'SQLITE_CONSTRAINT_TRIGGER') {
      return reply.code(409).send({ error: 'IMMUTABLE_RECORD', message: (error as Error).message });
    }
    app.log.error(error as Error);
    return reply.code(500).send({ error: 'INTERNAL', message: (error as Error).message });
  });

  // ---------- 基础档案 ----------
  app.post('/admin/users', async (req) => {
    const b = req.body as any;
    return Catalog.createUser(db, {
      name: b.name,
      role: b.role,
      clubId: b.clubId ?? null,
    });
  });

  app.post('/admin/clubs', async (req) => {
    const b = req.body as any;
    return Catalog.createClub(db, b.name, b.advisorUserId);
  });

  app.post('/admin/terms', async (req) => {
    const b = req.body as any;
    return Catalog.createTerm(db, { name: b.name, seq: b.seq });
  });

  app.post('/budgets', async (req) => {
    const b = req.body as any;
    return Catalog.createBudget(db, {
      clubId: b.clubId,
      termId: b.termId,
      amountCents: parseYuan(b.amountYuan),
      createdBy: (req as any).actor.id,
    });
  });

  app.post('/activities', async (req) => {
    const b = req.body as any;
    return Catalog.createActivity(db, {
      budgetId: b.budgetId,
      name: b.name,
      quotaCents: parseYuan(b.quotaYuan),
      createdBy: (req as any).actor.id,
    });
  });

  // ---------- 跨学期结转 ----------
  app.post('/budgets/carry-over', async (req) => {
    const b = req.body as any;
    return Catalog.carryOver(db, {
      clubId: b.clubId,
      fromTermId: b.fromTermId,
      toTermId: b.toTermId,
    });
  });

  // ---------- 申请 ----------
  app.post('/requests', async (req) => {
    const b = req.body as any;
    return Requests.createDraft(db, {
      activityId: b.activityId,
      actor: (req as any).actor,
      title: b.title,
      amountCents: parseYuan(b.amountYuan),
    });
  });

  app.patch('/requests/:id', async (req) => {
    const p = req.params as any;
    const b = req.body as any;
    return Requests.editDraft(
      db,
      p.id,
      (req as any).actor,
      {
        title: b.title,
        amountCents: b.amountYuan !== undefined ? parseYuan(b.amountYuan) : undefined,
      },
    );
  });

  app.post('/requests/:id/submit', async (req) => {
    const p = req.params as any;
    const b = (req.body ?? {}) as any;
    return Requests.submit(db, p.id, (req as any).actor, b.comment);
  });

  app.post('/requests/:id/advisor-review', async (req) => {
    const p = req.params as any;
    const b = req.body as any;
    return Requests.advisorReview(db, p.id, (req as any).actor, b.decision, b.comment);
  });

  app.post('/requests/:id/pay', async (req) => {
    const p = req.params as any;
    const b = req.body as any;
    return Requests.financePay(db, p.id, (req as any).actor, {
      eventId: b.eventId,
      comment: b.comment,
    });
  });

  /** 支付渠道异步回调（重复回调幂等） */
  app.post('/callbacks/payment', async (req) => {
    const b = req.body as any;
    return Requests.paymentCallback(db, b.eventId, b.requestNo, b.payload ?? b);
  });

  app.post('/activities/:id/cancel', async (req) => {
    const p = req.params as any;
    const b = req.body as any;
    return Requests.cancelActivity(db, p.id, (req as any).actor, b.reason ?? '活动取消');
  });

  app.post('/requests/:id/refunds', async (req) => {
    const p = req.params as any;
    const b = req.body as any;
    return Requests.requestRefund(db, p.id, (req as any).actor, {
      amountCents: parseYuan(b.amountYuan),
      reason: b.reason,
    });
  });

  app.post('/refunds/:id/decision', async (req) => {
    const p = req.params as any;
    const b = req.body as any;
    return Requests.decideRefund(db, p.id, (req as any).actor, b.decision, {
      eventId: b.eventId,
      comment: b.comment,
    });
  });

  // ---------- 凭证与分摊 ----------
  app.post('/vouchers', async (req) => {
    const b = req.body as any;
    return Vouchers.createVoucher(
      db,
      {
        voucherNo: b.voucherNo,
        summary: b.summary,
        vendor: b.vendor,
        amountCents: parseYuan(b.amountYuan),
        createdBy: (req as any).actor.id,
      },
      (b.allocations as any[]).map((a) => ({
        requestId: a.requestId,
        amountCents: parseYuan(a.amountYuan),
      })),
    );
  });

  app.post('/vouchers/:id/allocations', async (req) => {
    const p = req.params as any;
    const b = req.body as any;
    return Vouchers.appendAllocation(
      db,
      p.id,
      b.requestId,
      parseYuan(b.amountYuan),
    );
  });

  /** 移除误挂的分摊（仅草稿/被退回申请），自动解除疑似重复 */
  app.delete('/allocations/:id', async (req) => {
    const p = req.params as any;
    return Vouchers.removeAllocation(db, p.id);
  });

  app.get('/duplicate-groups', async (req) => {
    const q = req.query as any;
    return Vouchers.listDuplicateGroups(db, q.status);
  });

  app.post('/duplicate-groups/:id/resolve', async (req) => {
    const p = req.params as any;
    const b = req.body as any;
    return Vouchers.resolveDuplicateGroup(db, p.id, {
      resolution: b.resolution,
      resolvedBy: (req as any).actor.id,
      note: b.note,
    });
  });

  // ---------- 查询与下钻 ----------
  app.get('/requests/:id', async (req) => {
    const p = req.params as any;
    return Requests.getRequest(db, p.id);
  });

  app.get('/budgets/:id/balance', async (req) => {
    const p = req.params as any;
    return getBudgetBalance(db, p.id);
  });

  app.get('/activities/:id/balance', async (req) => {
    const p = req.params as any;
    return getActivityBalance(db, p.id);
  });

  /** 余额下钻：构成余额的申请、凭证、退款与逐条流水 */
  app.get('/budgets/:id/drilldown', async (req) => {
    const p = req.params as any;
    return drillDown(db, p.id);
  });

  app.get('/requests/:id/approvals', async (req) => {
    const p = req.params as any;
    return Requests.getRequest(db, p.id).approvals;
  });

  app.get('/audit/approval-chain', async () => verifyApprovalChain(db));
}
