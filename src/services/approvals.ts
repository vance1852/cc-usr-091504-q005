import { createHash } from 'node:crypto';
import type { DB } from '../db/db.js';
import { id, nowIso } from '../db/db.js';

export interface ApprovalInput {
  requestId?: string | null;
  refundId?: string | null;
  action: string;
  actorId: string;
  comment?: string | null;
}

function hashRecord(
  prev: string,
  parts: { requestId: string | null; refundId: string | null; action: string; actor: string; comment: string; at: string },
): string {
  return createHash('sha256')
    .update(
      [
        prev,
        parts.requestId ?? '',
        parts.refundId ?? '',
        parts.action,
        parts.actor,
        parts.comment,
        parts.at,
      ].join('|'),
    )
    .digest('hex');
}

/** 追加一条审批意见，与前一条串成哈希链；表触发器保证不可 UPDATE/DELETE */
export function appendApproval(db: DB, input: ApprovalInput): string {
  const at = nowIso();
  const requestId = input.requestId ?? null;
  const refundId = input.refundId ?? null;
  const comment = input.comment ?? '';

  const tail = db
    .prepare('SELECT hash FROM approvals ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get() as { hash: string } | undefined;
  const prevHash = tail?.hash ?? '';
  const hash = hashRecord(prevHash, {
    requestId,
    refundId,
    action: input.action,
    actor: input.actorId,
    comment,
    at,
  });

  db.prepare(
    `INSERT INTO approvals
     (id, request_id, refund_id, action, actor_id, comment, prev_hash, hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id('ap'),
    requestId,
    refundId,
    input.action,
    input.actorId,
    comment,
    prevHash,
    hash,
    at,
  );
  return hash;
}

export function listApprovals(db: DB, requestId: string) {
  return db
    .prepare(
      `SELECT ap.*, u.name AS actor_name, u.role AS actor_role
       FROM approvals ap JOIN users u ON u.id = ap.actor_id
       WHERE ap.request_id = ? ORDER BY ap.created_at, ap.rowid`,
    )
    .all(requestId);
}

/** 校验整条审批链未被篡改（触发器之外的第二道防线） */
export function verifyApprovalChain(db: DB): { ok: boolean; brokenAt?: string } {
  const rows = db
    .prepare('SELECT * FROM approvals ORDER BY created_at, rowid')
    .all() as any[];
  let prev = '';
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, brokenAt: r.id };
    const h = hashRecord(prev, {
      requestId: r.request_id,
      refundId: r.refund_id,
      action: r.action,
      actor: r.actor_id,
      comment: r.comment ?? '',
      at: r.created_at,
    });
    if (h !== r.hash) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true };
}
