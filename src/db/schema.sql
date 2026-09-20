-- 社团经费核销服务数据库结构
-- 设计要点：
-- 1) 金额一律为「分」整数；2) 占用/支付/退回分桶记账（ledger_entries）；
-- 3) 审批与流水仅追加，触发器禁止改写；4) 凭证疑似重复进入核对单而非删除。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 用户：学生负责人 / 指导老师 / 财务人员
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('student_leader','advisor','finance')),
  club_id     TEXT,                      -- 学生负责人/指导老师所属社团
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clubs (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  advisor_user_id   TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,            -- 如 2026 春季学期
  start_date  TEXT,
  end_date    TEXT,
  seq         INTEGER NOT NULL UNIQUE   -- 学期先后顺序，用于结转
);

-- 学期预算：每个社团每学期一条
CREATE TABLE IF NOT EXISTS budgets (
  id                TEXT PRIMARY KEY,
  club_id           TEXT NOT NULL REFERENCES clubs(id),
  term_id           TEXT NOT NULL REFERENCES terms(id),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),   -- 本学期新拨预算
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL,
  UNIQUE (club_id, term_id)
);

-- 活动额度
CREATE TABLE IF NOT EXISTS activities (
  id            TEXT PRIMARY KEY,
  budget_id     TEXT NOT NULL REFERENCES budgets(id),
  name          TEXT NOT NULL,
  quota_cents   INTEGER NOT NULL CHECK (quota_cents >= 0),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','cancelled')),
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  cancelled_at  TEXT
);

-- 预支/报销申请
-- 状态机：
--   draft --submit--> submitted --advisor--> approved --finance pay--> paid
--                              \--reject--> rejected（释放占用）
--   submitted/approved --活动取消--> released（释放占用）
--   paid --活动取消/退款--> refunding（占用为 0，支付保留，退款链冲回）
--   任一未支付状态被核对确认重复 --> returned（退回修改，释放占用，可重新 submit）
CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  request_no    TEXT NOT NULL UNIQUE,
  activity_id   TEXT NOT NULL REFERENCES activities(id),
  applicant_id  TEXT NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),  -- 申请/占用金额
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN (
                    'draft','submitted','approved','rejected',
                    'paid','released','refunding','returned'
                  )),
  version       INTEGER NOT NULL DEFAULT 0,   -- 乐观锁，防并发重复审批
  created_at    TEXT NOT NULL,
  submitted_at  TEXT,
  paid_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_activity ON requests(activity_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

-- 原始凭证（发票）。同票号+摘要被不同申请引用时，各自留档并进入核对单
CREATE TABLE IF NOT EXISTS vouchers (
  id            TEXT PRIMARY KEY,
  voucher_no    TEXT NOT NULL,          -- 凭证号码
  summary       TEXT NOT NULL,          -- 内容摘要
  vendor        TEXT,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  fingerprint   TEXT NOT NULL,          -- 规范化票号+摘要，用于识别重复
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vouchers_fp ON vouchers(fingerprint);

-- 凭证核对单（疑似重复分组）
CREATE TABLE IF NOT EXISTS duplicate_groups (
  id            TEXT PRIMARY KEY,
  fingerprint   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','cleared','confirmed')),
  resolution    TEXT,                   -- cleared=误报 / confirmed=确系重复
  note          TEXT,
  resolved_by   TEXT REFERENCES users(id),
  resolved_at   TEXT,
  created_at    TEXT NOT NULL
);

-- 分摊明细：一张发票可拆分到多个申请（拆分发票）
CREATE TABLE IF NOT EXISTS voucher_allocations (
  id                TEXT PRIMARY KEY,
  voucher_id        TEXT NOT NULL REFERENCES vouchers(id),
  request_id        TEXT NOT NULL REFERENCES requests(id),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  dup_status        TEXT NOT NULL DEFAULT 'none'
                      CHECK (dup_status IN ('none','suspected','confirmed','cleared')),
  dup_group_id      TEXT REFERENCES duplicate_groups(id),
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alloc_request ON voucher_allocations(request_id);
CREATE INDEX IF NOT EXISTS idx_alloc_voucher ON voucher_allocations(voucher_id);

-- 支付：一笔申请至多一条支付
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL UNIQUE REFERENCES requests(id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  event_id      TEXT NOT NULL UNIQUE,   -- 支付渠道回调事件号（幂等）
  paid_by       TEXT NOT NULL REFERENCES users(id),
  paid_at       TEXT NOT NULL
);

-- 支付回调流水（仅追加；同一事件号可能有多条投递记录，首条 processed=1，其余 0）
CREATE TABLE IF NOT EXISTS payment_callbacks (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL,
  request_no    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  processed     INTEGER NOT NULL,       -- 1=首次处理 0=重复回调忽略
  received_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_callbacks_event ON payment_callbacks(event_id);

-- 退款链：已支付款项只能通过退款逐笔冲回，支持多次部分退款；
-- parent_refund_id 把同一申请的退款串成链。
CREATE TABLE IF NOT EXISTS refunds (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL REFERENCES requests(id),
  parent_refund_id  TEXT REFERENCES refunds(id),
  seq               INTEGER NOT NULL,   -- 链上序号，从 1 开始
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested','approved','rejected')),
  requested_by      TEXT NOT NULL REFERENCES users(id),
  approved_by       TEXT REFERENCES users(id),
  event_id          TEXT UNIQUE,        -- 退款到账回调事件号（幂等）
  created_at        TEXT NOT NULL,
  decided_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_refunds_request ON refunds(request_id);

-- 预算分类账（核心账目）：
--   reserve_delta  >0 占用（提交）；<0 释放（驳回/取消/支付转结/退回修改）
--   pay_delta      >0 实际支付（同时等额冲减占用）
--   refund_delta   >0 退款到账（余额恢复）
--   carry_delta    <0 结转出；>0 上学期结转入
-- 每条流水带幂等键，重复回调/重复审批不会重复记账。
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              TEXT PRIMARY KEY,
  budget_id       TEXT NOT NULL REFERENCES budgets(id),
  activity_id     TEXT REFERENCES activities(id),
  request_id      TEXT REFERENCES requests(id),
  refund_id       TEXT REFERENCES refunds(id),
  entry_type      TEXT NOT NULL
                    CHECK (entry_type IN (
                      'reserve','release','pay','refund','carry_out','carry_in'
                    )),
  reserve_delta   INTEGER NOT NULL DEFAULT 0,
  pay_delta       INTEGER NOT NULL DEFAULT 0,
  refund_delta    INTEGER NOT NULL DEFAULT 0,
  carry_delta     INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  ref_label       TEXT,                 -- 可读来源（申请号/退款号/结转）
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_budget ON ledger_entries(budget_id);

-- 审批意见（历史审批，哈希链 + 触发器禁改禁删）
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES requests(id),
  refund_id   TEXT REFERENCES refunds(id),
  action      TEXT NOT NULL,            -- submit/advisor_approve/reject/pay/...
  actor_id    TEXT NOT NULL REFERENCES users(id),
  comment     TEXT,
  prev_hash   TEXT NOT NULL DEFAULT '',
  hash        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_request ON approvals(request_id);

-- 触发器：历史审批、分类账、回调流水一律不可改写/删除
CREATE TRIGGER IF NOT EXISTS trg_approvals_no_update
BEFORE UPDATE ON approvals
BEGIN SELECT RAISE(ABORT, '历史审批记录不可改写'); END;
CREATE TRIGGER IF NOT EXISTS trg_approvals_no_delete
BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, '历史审批记录不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_update
BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, '分类账流水不可改写'); END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_delete
BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, '分类账流水不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_callbacks_no_update
BEFORE UPDATE ON payment_callbacks
BEGIN SELECT RAISE(ABORT, '回调流水不可改写'); END;
CREATE TRIGGER IF NOT EXISTS trg_callbacks_no_delete
BEFORE DELETE ON payment_callbacks
BEGIN SELECT RAISE(ABORT, '回调流水不可删除'); END;
