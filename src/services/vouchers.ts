import type { DB } from '../db/db.js';
import { id, nowIso, withTransaction } from '../db/db.js';
import { Errors } from '../domain/errors.js';
import { appendApproval } from './approvals.js';

/** 规范化凭证号与摘要，作为重复识别指纹（忽略大小写、空白与常见分隔符） */
export function fingerprintOf(voucherNo: string, summary: string): string {
  const normNo = voucherNo
    .toUpperCase()
    .replace(/[\s\-_/\\]+/g, '');
  const normSummary = summary
    .replace(/[\s\-_/\\]+/g, '')
    .toLowerCase();
  return `${normNo}#${normSummary}`;
}

export interface VoucherInput {
  voucherNo: string;
  summary: string;
  vendor?: string;
  amountCents: number;
  createdBy: string;
}

export interface AllocationInput {
  requestId: string;
  amountCents: number;
}

/**
 * 登记原始凭证并写入分摊明细。一张发票可拆分给多个申请（拆分发票）。
 * 同一指纹（票号+摘要）出现在两个及以上不同申请时，全部进入核对单，
 * 只标记疑似，绝不删除凭证或申请。
 */
export function createVoucher(
  db: DB,
  input: VoucherInput,
  allocations: AllocationInput[],
) {
  if (input.amountCents <= 0) throw Errors.validation('凭证金额必须为正');
  if (allocations.length === 0) throw Errors.validation('至少需要一条分摊明细');
  const totalAlloc = allocations.reduce((a, b) => a + b.amountCents, 0);
  if (totalAlloc > input.amountCents) {
    throw Errors.conflict(
      'ALLOCATION_EXCEEDS_VOUCHER',
      '分摊金额之和超过发票金额（拆分发票不得超额分摊）',
    );
  }

  return withTransaction(db, () => {
    const fp = fingerprintOf(input.voucherNo, input.summary);
    const voucherId = id('vch');
    db.prepare(
      `INSERT INTO vouchers
       (id, voucher_no, summary, vendor, amount_cents, fingerprint, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      voucherId,
      input.voucherNo,
      input.summary,
      input.vendor ?? null,
      input.amountCents,
      fp,
      input.createdBy,
      nowIso(),
    );

    for (const a of allocations) {
      addAllocationRow(db, voucherId, a.requestId, a.amountCents);
    }
    const group = reconcileFingerprint(db, fp);
    return { voucherId, fingerprint: fp, duplicateGroup: group };
  });
}

/** 给已存在的发票补一条分摊（同一发票继续拆分） */
export function appendAllocation(
  db: DB,
  voucherId: string,
  requestId: string,
  amountCents: number,
) {
  return withTransaction(db, () => {
    const v = db
      .prepare('SELECT * FROM vouchers WHERE id = ?')
      .get(voucherId) as any;
    if (!v) throw Errors.notFound('凭证');
    const used = db
      .prepare(
        'SELECT COALESCE(SUM(amount_cents),0) AS s FROM voucher_allocations WHERE voucher_id = ?',
      )
      .get(voucherId) as { s: number };
    if (used.s + amountCents > v.amount_cents) {
      throw Errors.conflict(
        'ALLOCATION_EXCEEDS_VOUCHER',
        '追加分摊后将超过发票金额',
      );
    }
    addAllocationRow(db, voucherId, requestId, amountCents);
    const group = reconcileFingerprint(db, v.fingerprint);
    return { duplicateGroup: group };
  });
}

function addAllocationRow(
  db: DB,
  voucherId: string,
  requestId: string,
  amountCents: number,
) {
  if (amountCents <= 0) throw Errors.validation('分摊金额必须为正');
  const req = db
    .prepare('SELECT id FROM requests WHERE id = ?')
    .get(requestId);
  if (!req) throw Errors.notFound('申请');
  db.prepare(
    `INSERT INTO voucher_allocations
     (id, voucher_id, request_id, amount_cents, dup_status, created_at)
     VALUES (?,?,?,?,'none',?)`,
  ).run(id('vac'), voucherId, requestId, amountCents, nowIso());
}

/**
 * 重新核对某指纹下的全部活跃分摊（已定性 confirmed/cleared 的终态分摊
 * 不再参与新一轮判定，避免重复建组）：
 * 跨 ≥2 个不同申请引用 → 建立/重开核对单，全部标记 suspected；
 * 否则保持 none。已被人工定性的组不会被自动覆盖。
 */
export function reconcileFingerprint(
  db: DB,
  fingerprint: string,
): { groupId: string | null; suspected: boolean } {
  const rows = db
    .prepare(
      `SELECT va.id AS alloc_id, va.request_id, va.dup_status, dgr.status AS group_status
       FROM voucher_allocations va
       JOIN vouchers v ON v.id = va.voucher_id
       LEFT JOIN duplicate_groups dgr ON dgr.id = va.dup_group_id
       WHERE v.fingerprint = ?
         AND va.dup_status NOT IN ('confirmed','cleared')`,
    )
    .all(fingerprint) as {
    alloc_id: string;
    request_id: string;
    dup_status: string;
    group_status: string | null;
  }[];

  const distinctRequests = new Set(rows.map((r) => r.request_id));
  if (distinctRequests.size < 2) return { groupId: null, suspected: false };

  // 疑似重复：确保有一个 open 核对单
  let group = db
    .prepare(
      `SELECT * FROM duplicate_groups
       WHERE fingerprint = ? AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(fingerprint) as any;
  if (!group) {
    const gid = id('dgr');
    db.prepare(
      `INSERT INTO duplicate_groups (id, fingerprint, status, created_at)
       VALUES (?,?,'open',?)`,
    ).run(gid, fingerprint, nowIso());
    group = { id: gid };
  }
  for (const r of rows) {
    if (r.group_status === 'confirmed' || r.group_status === 'cleared') continue;
    db.prepare(
      `UPDATE voucher_allocations
       SET dup_status = 'suspected', dup_group_id = ?
       WHERE id = ? AND dup_status NOT IN ('confirmed','cleared')`,
    ).run(group.id, r.alloc_id);
  }
  return { groupId: group.id, suspected: true };
}

export interface ResolveGroupInput {
  resolution: 'cleared' | 'confirmed';
  resolvedBy: string;
  note?: string;
}

/**
 * 人工处理核对单：
 *  cleared   —— 误报（如同号不同票），解除疑似，申请继续流转；
 *  confirmed —— 确系重复，未支付申请退回修改（释放占用，可改后重新提交），
 *               已支付申请不动账，由财务另走退款链追回（历史支付不可改写）。
 */
export function resolveDuplicateGroup(
  db: DB,
  groupId: string,
  input: ResolveGroupInput,
) {
  return withTransaction(db, () => {
    const group = db
      .prepare('SELECT * FROM duplicate_groups WHERE id = ?')
      .get(groupId) as any;
    if (!group) throw Errors.notFound('核对单');
    if (group.status !== 'open') {
      throw Errors.state('核对单已处理，不可重复定性');
    }

    db.prepare(
      `UPDATE duplicate_groups
       SET status = ?, resolution = ?, note = ?, resolved_by = ?, resolved_at = ?
       WHERE id = ?`,
    ).run(
      input.resolution,
      input.resolution,
      input.note ?? null,
      input.resolvedBy,
      nowIso(),
      groupId,
    );

    const allocs = db
      .prepare(
        `SELECT va.id, va.request_id FROM voucher_allocations va
         WHERE va.dup_group_id = ?`,
      )
      .all(groupId) as { id: string; request_id: string }[];

    if (input.resolution === 'cleared') {
      for (const a of allocs) {
        db.prepare(
          `UPDATE voucher_allocations SET dup_status = 'cleared' WHERE id = ?`,
        ).run(a.id);
      }
    } else {
      for (const a of allocs) {
        db.prepare(
          `UPDATE voucher_allocations SET dup_status = 'confirmed' WHERE id = ?`,
        ).run(a.id);
        const req = db
          .prepare('SELECT id, status, applicant_id FROM requests WHERE id = ?')
          .get(a.request_id) as any;
        if (['submitted', 'approved'].includes(req.status)) {
          releaseRequestForDuplicate(db, req, input.resolvedBy, groupId);
        }
      }
    }
    return { groupId, resolution: input.resolution };
  });
}

/** 重复确认：把未支付申请退回草稿并释放占用 */
function releaseRequestForDuplicate(
  db: DB,
  req: { id: string; status: string; applicant_id: string },
  actorId: string,
  groupId: string,
) {
  db.prepare(
    `UPDATE requests SET status = 'returned', version = version + 1 WHERE id = ?`,
  ).run(req.id);
  db.prepare(
    `INSERT INTO ledger_entries
     (id, budget_id, activity_id, request_id, entry_type,
      reserve_delta, idempotency_key, ref_label, created_at)
     SELECT @lid, a.budget_id, r.activity_id, r.id, 'release',
            -r.amount_cents, @key, @label, @now
     FROM requests r JOIN activities a ON a.id = r.activity_id
     WHERE r.id = @rid`,
  ).run({
    lid: id('le'),
    rid: req.id,
    key: `release:duplicate:${groupId}:${req.id}`,
    label: `重复凭证退回 ${req.id}`,
    now: nowIso(),
  });
  appendApproval(db, {
    requestId: req.id,
    action: 'duplicate_returned',
    actorId,
    comment: `凭证核对单 ${groupId} 确系重复，申请退回修改并释放占用`,
  });
}

/**
 * 移除一条分摊（学生修改被退回的申请时，摘掉误挂的重复发票）。
 * 仅草稿/退回状态的申请允许操作；移除后自动解除该指纹上的疑似状态。
 */
export function removeAllocation(db: DB, allocationId: string) {
  return withTransaction(db, () => {
    const alloc = db
      .prepare(
        `SELECT va.*, v.fingerprint, r.status AS request_status
         FROM voucher_allocations va
         JOIN vouchers v ON v.id = va.voucher_id
         JOIN requests r ON r.id = va.request_id
         WHERE va.id = ?`,
      )
      .get(allocationId) as any;
    if (!alloc) throw Errors.notFound('分摊明细');
    if (!['draft', 'returned'].includes(alloc.request_status)) {
      throw Errors.state('只有草稿或被退回的申请可以移除分摊明细');
    }
    db.prepare('DELETE FROM voucher_allocations WHERE id = ?').run(allocationId);
    autoClearResolvedFingerprint(db, alloc.fingerprint);
    reconcileFingerprint(db, alloc.fingerprint);
    return { removed: true };
  });
}

/**
 * 若某指纹下活跃分摊已不足两个申请引用，把残留疑似标记复位，
 * 并把仍 open 的核对单自动以「重复引用已解除」结案。
 */
function autoClearResolvedFingerprint(db: DB, fingerprint: string) {
  const rows = db
    .prepare(
      `SELECT va.id, va.request_id, va.dup_group_id
       FROM voucher_allocations va JOIN vouchers v ON v.id = va.voucher_id
       WHERE v.fingerprint = ? AND va.dup_status = 'suspected'`,
    )
    .all(fingerprint) as { id: string; request_id: string; dup_group_id: string | null }[];
  if (new Set(rows.map((r) => r.request_id)).size >= 2) return;
  for (const r of rows) {
    db.prepare("UPDATE voucher_allocations SET dup_status = 'none', dup_group_id = NULL WHERE id = ?").run(r.id);
  }
  const groupIds = [...new Set(rows.map((r) => r.dup_group_id).filter(Boolean) as string[])];
  for (const gid of groupIds) {
    db.prepare(
      `UPDATE duplicate_groups
       SET status = 'cleared', resolution = 'cleared',
           note = COALESCE(note, '重复引用已由申请人解除'), resolved_at = ?
       WHERE id = ? AND status = 'open'`,
    ).run(nowIso(), gid);
  }
}

export function listDuplicateGroups(db: DB, status?: string) {
  const where = status ? 'WHERE dgr.status = ?' : '';
  const groups = db
    .prepare(
      `SELECT dgr.* FROM duplicate_groups dgr ${where} ORDER BY dgr.created_at`,
    )
    .all(...(status ? [status] : [])) as any[];
  return groups.map((g) => ({
    ...g,
    allocations: db
      .prepare(
        `SELECT va.*, v.voucher_no, v.summary, v.amount_cents AS voucher_amount_cents,
                r.request_no, r.title AS request_title, r.status AS request_status
         FROM voucher_allocations va
         JOIN vouchers v ON v.id = va.voucher_id
         JOIN requests r ON r.id = va.request_id
         WHERE va.dup_group_id = ?`,
      )
      .all(g.id),
  }));
}
