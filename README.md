# 学生社团经费核销服务

面向学生社团、指导教师和学校财务人员的经费核销后端。基于 **Fastify + SQLite（better-sqlite3）+ TypeScript**，
围绕「学期预算 → 活动额度 → 预支申请 → 原始凭证 → 分摊明细 → 审核意见 → 退款」建立**全程可追溯账目**。

## 解决的问题

- 同一张材料发票被两个小组分别引用：用**凭证号码 + 内容摘要指纹**识别，疑似重复进入**核对单**核对，**绝不直接删除**。
- 预付款因活动取消退回：未支付申请**自动释放占用**；已支付款项通过**退款链**（支持多笔部分退款）冲回。
- 预算口径不清：**占用、实际支付、退回金额分桶记账**，任何时点都能分别算出。
- 任一预算余额都可**下钻**到构成它的每一条流水、申请、凭证与退款。

## 快速开始

```bash
npm install
npm test          # 运行全部测试（29 个，含并发 worker）
npm run build     # tsc 类型检查
npm start         # 启动 HTTP 服务（默认 DB_PATH=./data/finance.sqlite, PORT=3000）
```

所有写接口通过请求头 `x-user-id: <用户ID>` 标识操作人（简化鉴权，便于测试；生产应替换为会话/JWT）。
`/admin/*` 为引导接口（创建首批用户/社团/学期），免鉴权。

## 角色与职责分离

| 角色 | 能做 | 不能做 |
|---|---|---|
| 学生负责人 `student_leader` | 提交/修改**本社团**草稿、提交申请、发起退款 | 不能替别社团提交、不能审核、不能付款 |
| 指导老师 `advisor` | 确认活动**真实性**（通过/驳回）、取消活动 | 不能起草、不能付款 |
| 财务人员 `finance` | 批准**支付**、批准**退款**、取消活动、定性核对单 | 不能起草 |

**申请人不能审批自己的支出**：指导老师审核、财务支付/退款批准时都强制校验 `applicant_id ≠ actor_id`。

## 申请状态机与账目动作

```
draft ──submit──▶ submitted ──advisor approve──▶ approved ──finance pay──▶ paid
                    │                                │                        │
                    └─advisor reject─▶ rejected      │                        │
                                     （释放占用）     │                        │
   submitted/approved ──活动取消──▶ released（自动释放占用）                     │
   paid ──活动取消──▶ refunding ──refund approve（可多笔部分退款）──▶ 余额恢复    │
   submitted/approved ──核对确认重复──▶ returned（释放占用，可改后重新提交）◀─────┘
```

## 三桶记账模型（ledger_entries）

金额一律以**分（整数）**存储，杜绝浮点误差。分类账每条流水带幂等键、仅追加：

| entry_type | reserve_delta | pay_delta | refund_delta | carry_delta | 含义 |
|---|---:|---:|---:|---:|---|
| `reserve` | +申请额 | | | | 提交时占用预算 |
| `release` | −申请额 | | | | 驳回/取消/确认重复，释放占用 |
| `pay` | −申请额 | +申请额 | | | 支付：占用转为实际支出（同一笔钱不会同时占两桶） |
| `refund` | | | +退款额 | | 退款到账，恢复余额 |
| `carry_out/in` | | | | ∓金额 | 跨学期结转 |

余额口径：

```
净预算 = 新拨预算 + 上学期结转入 − 结转出
净支出 = 累计支付 − 累计退款
可用余额 = 净预算 − 当前占用 − 净支出
```

`GET /budgets/:id/balance` 一次返回全部桶；`GET /budgets/:id/drilldown` 下钻到申请/凭证/退款/逐条流水。

## 并发防超额

- 所有写事务使用 SQLite **BEGIN IMMEDIATE**，写入在全库范围串行化；
- 提交占用、财务支付前都在事务内**实时重算**活动额度与学期预算余额；
- 申请行带 `version` 乐观锁，支付/退款的状态推进用 `WHERE status=? AND version=?` 条件更新；
- 分类账幂等键（`reserve:<id>:v<ver>`、`pay:<id>`、`refund:<id>`、回调 `event_id`）保证重复操作不重复记账。

测试用 **worker_threads 打开独立连接**模拟跨进程并发支付，验证恰好一笔成功、绝不重复出账。

## 原始凭证、拆分发票与疑似重复

- 凭证指纹：`规范化票号 # 规范化摘要`（忽略大小写、空白与 `- _ / \` 等分隔符）。
- 一张发票可通过 `voucher_allocations` **拆分**到多个申请；各分摊之和**不得超过发票金额**。
- 同一指纹被 **≥2 个不同申请**引用时：自动建立 `open` 核对单，相关分摊标记 `suspected`，
  财务在核对清楚前**不能付款**；凭证与申请均保留，不删除。
- 人工定性：
  - `cleared` 误报（如连号两本各开一张）→ 解除疑似，正常付款；
  - `confirmed` 确系重复 → 未支付申请退回 `returned` 并释放占用；已支付的不动历史账，由财务另走退款链追回。
- 被退回申请可 `DELETE /allocations/:id` 摘掉误挂发票、换新凭证后重新提交；引用解除后核对单自动结案。

## 退款链

- 仅 `paid/refunding` 申请可发起退款；`parent_refund_id + seq` 把多笔部分退款串成链；
- 累计「已批退款 + 待批退款」不得超过支付额，批准时再次在事务内校验；
- 退款到账 `event_id` 幂等；审批/记账仅追加。

## 历史不可改写

- `approvals`（审批意见）、`ledger_entries`（分类账）、`payment_callbacks`（回调流水）
  均由 SQLite 触发器禁止 `UPDATE`/`DELETE`；
- 审批记录用前一条哈希串成 **SHA-256 哈希链**，`GET /audit/approval-chain` 可校验整条链是否被篡改。

## 支付回调幂等

- `POST /requests/:id/pay` 携带渠道 `eventId`；同一事件号重复支付返回 `{idempotent:true}`，不重复出账；
- `POST /callbacks/payment` 每次投递都留痕，首条 `processed=1`，重复投递记 `processed=0` 且业务忽略；
  早于财务批准到达的回调只登记、不自动付款。

## 主要接口

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | `/requests` | 学生负责人 | 创建本社团草稿 |
| PATCH | `/requests/:id` | 申请人 | 修改草稿/退回件金额 |
| POST | `/requests/:id/submit` | 申请人 | 提交并占用预算 |
| POST | `/requests/:id/advisor-review` | 本社团指导老师 | `{decision:"approve\|reject"}` 真实性审核 |
| POST | `/requests/:id/pay` | 财务 | `{eventId}` 批准支付（幂等） |
| POST | `/callbacks/payment` | — | 渠道异步回调（重复留痕忽略） |
| POST | `/activities/:id/cancel` | 指导老师/财务/本社学生 | 取消：释放占用 + 已付转退款 |
| POST | `/requests/:id/refunds` | 申请人/财务 | 发起（部分）退款 |
| POST | `/refunds/:id/decision` | 财务 | 批准/驳回退款 |
| POST | `/vouchers` | 学生 | 登记发票 + 分摊（可拆多行/多申请） |
| POST | `/vouchers/:id/allocations` | 学生 | 对已存在发票追加分摊 |
| DELETE | `/allocations/:id` | 申请人 | 移除退回件上的误挂分摊 |
| GET | `/duplicate-groups?status=open` | 财务等 | 列出疑似重复核对单 |
| POST | `/duplicate-groups/:id/resolve` | 财务 | `cleared` / `confirmed` |
| POST | `/budgets/carry-over` | 财务 | 跨学期结转（要求占用结清，幂等） |
| GET | `/budgets/:id/balance` | 已登录 | 分桶余额 |
| GET | `/activities/:id/balance` | 已登录 | 活动额度余额 |
| GET | `/budgets/:id/drilldown` | 已登录 | **余额下钻** |
| GET | `/requests/:id` | 已登录 | 申请详情（凭证/支付/退款/审批链） |
| GET | `/audit/approval-chain` | 已登录 | 审批哈希链校验 |

## 代码结构

```
src/
  db/schema.sql            # 表结构 + 不可改写触发器
  db/db.ts                 # 连接、立即事务、ID/时间工具
  domain/money.ts          # 元/分换算、最大余数法分摊（舍入差异）
  domain/errors.ts         # 业务错误码
  services/
    catalog.ts             # 用户/社团/学期/预算/活动/跨学期结转
    requests.ts            # 申请状态机、审核、支付、回调、取消、退款
    vouchers.ts            # 凭证指纹、拆分、核对单、去重闭环
    ledger.ts              # 分类账、分桶余额、下钻
    approvals.ts           # 审批意见哈希链
  http/validate.ts         # 入参金额校验
  routes.ts  app.ts  server.ts
tests/
  money.test.ts            # 金额换算 + 三等分/按权重分摊的舍入差异
  workflow.test.ts         # 权限、分桶、取消、拆票、重复核对、并发(worker)、回调幂等、下钻、不可改写
  carryover.test.ts        # 跨学期结转、幂等、结转金额再使用
  api.test.ts              # Fastify inject 端到端
```

## 测试覆盖的关键场景

- **拆分发票**：一张发票多行/多申请分摊，金额守恒、超额分摊被拒；
- **舍入差异**：100 元三等分得 33.34/33.33/33.33（最大余数法，合计精确等于 100.00），按权重拆分误差 ≤1 分；
- **重复回调**：同 `eventId` 重复支付/回调不重复出账，每次投递留痕；
- **跨学期结转**：净余额（含退款后）结转、幂等、结转资金在下学期可继续占用支付并可下钻到来源。
