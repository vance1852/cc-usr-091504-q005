# 学生社团经费核销服务

面向学生社团、指导老师与学校财务的经费核销系统。围绕**学期预算、活动额度、预支申请、原始凭证、分摊明细、审核意见、退款**建立可追溯账目，清楚回答“这笔钱是被占用、已支付还是已冲回”。

技术栈：**Node.js + TypeScript + Fastify + SQLite (better-sqlite3)**。

## 核心账目规则

### 1. 金额与拆分
- 所有金额一律以**整数分**存储与计算，杜绝浮点误差；提供 `parseYuan/formatYuan` 做元↔分转换。
- 拆分发票用**最大余数法（Hamilton）**，`splitByWeights/splitEvenly` 保证各份之和**精确等于票面总额**（如 100.00 元分 3 份 = 33.34 / 33.33 / 33.33）。

### 2. 预算三态分列
对每个“学期 × 社团”（活动额度则按“活动”）分别累计：

| 字段 | 含义 |
|---|---|
| `reserved_cents`  | 已提交/已核准但**尚未支付**的占用 |
| `paid_cents`      | 累计**实际支付**总额（毛额，永不回冲） |
| `refunded_cents`  | 累计**退回**金额 |
| `net_paid_cents`  | `paid - refunded` |
| `available_cents` | `budget_total - reserved - net_paid`，即可用余额 |

每次变动写入只追加的 `budget_entries` 流水（`reserve / release / pay / refund`），**任一余额都可由流水逐笔下钻**。

### 3. 凭证判重与核对（疑似重复不删除）
- 凭证身份 = **凭证号 + 规范化摘要**（去空白/标点/大小写）。
- 同一张发票被再次引用时，新凭证置为 `under_review` 并生成 `duplicate_reviews` 核对单，**绝不删除**。
- 核对结论：
  - `cleared`（确属合用）：把新凭证的分摊**并入原实物发票**（状态 `merged` 保留留痕），此后跨组共同受“分摊合计 ≤ 票面金额”约束。
  - `confirmed_duplicate`（确认重复报销）：新凭证置 `invalid_duplicate`（仍留档），并阻断支付（`E_VOUCHERS_NOT_PAYABLE`）。
- 一张合法发票可由多个小组按 `voucher_allocations` 分摊，但合计不得超过票面金额。

### 4. 角色与职责分离
- **学生负责人**（`student_leader`）：只能为**本社团**创建/提交草稿、挂凭证、申请退款。
- **指导老师**（`advisor`，须在 `club_advisors` 中）：确认活动真实性。
- **财务**（`finance`）：批准支付与退款。
- **申请人不能审批自己的支出/退款**（`E_SELF_APPROVAL`，在角色校验之前判定）。

申请状态机：
```
draft ──submit──▶ submitted ──advisor approve──▶ approved ──finance pay──▶ paid
  ▲                  │  reject(release)            │ finance reject(release)
  └──── rework ── rejected / released          released
paid ──refund(部分/全额, 可链式 parent_refund_id)──▶ refunded(全额时)
```

### 5. 活动取消
- 取消时，`submitted/approved` 的**未支付**申请自动写 `release` 流水、释放占用（状态 `released`）。
- **已支付**款项不做反向冲销，保留在 `paid`，通过**退款链**退回（毛支付始终可见）。

### 6. 并发与幂等
- 所有写操作在 `BEGIN IMMEDIATE` 事务内执行，并在持锁后**重算余额**再写流水，两个并发审批串行化，第二个看到第一个已提交的结果 → 防止超额。
- **预算池按社团级校验，活动额度按活动级校验**（二者作用域不同，混用会让不同活动各自“看到空池子”而超支——见 `assertCapacity`）。
- 支付/退款回调携带 `idempotency_key`，重复回调返回同一结果且**只产生一笔流水**（`idempotent_ops` + 流水唯一索引）。

### 7. 历史不可改写
- `approvals` 审核意见表带 `BEFORE UPDATE/DELETE` 触发器，物理上禁止改写或删除。
- 凭证、核对单、退款均保留终态记录（`merged/invalid_duplicate`、`rejected` 等）。

### 8. 跨学期结转
- 关闭学期时，仍有占用（`submitted/approved`）将被拒绝；需先支付/驳回/取消。
- 每个社团把 `预算总额 - 净支付`（退款已回流为可用）作为 `carryover` 预算行结入新学期，并记录来源学期（`from_semester_id`），旧学期置 `closed`。

## 目录结构
```
src/
  db.ts                 SQLite schema、触发器、withImmediate 事务
  money.ts              整数分、最大余数法拆分、元/分转换
  errors.ts             带 HTTP 状态码与稳定错误码的 AppError
  app.ts                Fastify 路由与 X-User-Id 鉴权
  server.ts             启动入口
  services/
    org.ts              社团/用户/学期/预算/活动
    budget.ts           三态余额、容量校验、流水、下钻
    vouchers.ts         凭证判重、分摊、核对单裁决
    requests.ts         申请草稿/提交/两级审批/支付/取消
    refunds.ts          退款申请/批准/驳回、退款链
    semester.ts         跨学期结转
tests/                  node:test 用例（含 worker 线程真实并发）
```

## 运行
```bash
npm install
npm run dev        # tsx 直接启动（默认 DB ./data/club-funds.sqlite, 端口 3000）
npm run build      # tsc 编译到 dist/
npm start          # 运行编译产物
DB_FILE=/tmp/x.sqlite PORT=3000 npm start
```

鉴权（演示方案）：每个需身份的请求带 `X-User-Id: <用户id>` 头；生产环境应替换为令牌。

## 主要接口
- 管理：`POST /admin/clubs|users|advisors|semesters|budgets|activities`
- 申请：`POST /requests`、`POST /requests/:id/vouchers`、`PUT /requests/:id/vouchers`、
  `POST /requests/:id/submit|advisor-review|pay|finance-reject`
- 取消：`POST /activities/:id/cancel`
- 退款：`POST /requests/:id/refunds`、`POST /refunds/:id/approve|reject`
- 核对：`GET /reviews`、`POST /reviews/:id/resolve`
- 余额/下钻：`GET /budgets?semester_id=&club_id=[&activity_id=]`、`GET /budgets/drilldown?...`
- 结转：`POST /semesters/:from/close-into/:to`

支付/退款批准的请求体可带 `{"idempotency_key":"..."}` 实现回调幂等。

## 测试
```bash
npm test
```
覆盖（28 个）：
- **拆分发票**：两组合用一张发票（60/40）、确认重复留档并阻断支付、分摊超额在核对放行时拦截；
- **舍入差异**：最大余数法多组拆分总和恒等、按权重拆分、元/分解析；
- **重复回调**：同幂等键并发支付只产生一笔流水、退款回调重放；
- **并发超额**：worker 线程屏障下并发提交/支付/退款审批，社团预算与已付额度不被突破；
- **跨学期结转**：净支付结转、退款回流、有占用时拒绝关账、取消后放行；
- 还包括角色越权、自审批、三态余额、取消自动释放、退款链、下钻构成与审核历史只追加。
