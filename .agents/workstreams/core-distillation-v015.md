# workstream: core-distillation-v015

- **identity**: agent `flash`, task pack `dsh-notifier-flash-complete-taskpack` (T01–T30)
- **branch**: `codex/core-distillation-v015` (off `dev`)
- **status**: in progress — T01–T11 done (T06 partial)
- **owner scope**: core authority convergence, Native/Recovery UX, local config export/import, dsh-im
  bridge, remote URL, optional CF Tunnel, Workers/Pages extension package, docs/tests/delivery.
- **explicitly out of scope**: `main`, tags, npm publish, real cloud deploy, full encrypted secret
  backup, new multi-account product model, dsh-im bidirectional approval/session interop.

## T01 — baseline & drift

### Baseline (recorded 2026-09-30)

| Fact | Value |
|---|---|
| repo | `THEWOLFWALKER/dsh-notifier`, two-branch (`dev` dev / `main` release) |
| taskpack research baseline | `ae71ef7` (stale — do not lock HEAD to it) |
| current `dev` HEAD | `3326189` (`docs(v0.14): record audit-fixpack Stage G final gate`) |
| `origin/dev` | `3326189` (in sync; tree clean before branch) |
| version authority | `package.json` `0.13.1` (bumped only at release close) |
| test baseline | `npm test` → **2166 tests / 2166 pass / 0 fail / 0 skip** (~178s) |
| gates | `verify:release` ok (documented tests=2166); `gen-channel-matrix --check` ok (28); `npm pack --dry-run` ok (338 files) |
| runtime | Node ESM ≥22, zero mandatory runtime deps, no build step |
| channels | 28 outbound adapters, 6 inbound control channels |

### Drift: taskpack baseline → current dev

The pack's research baseline `ae71ef7` is 7 commits behind current `dev`. Those 7 commits are the
**v0.14 dev audit fixpack** (Stages A–G) already landed:

| commit | stage | concern |
|---|---|---|
| `2978f31` | A | separate adapter live runtime object from frozen projections (fixes #45/#46) |
| `ce150ff` | B | atomic multi-key commits + commit-before-publish session state |
| `f5c6f35` | C | unify outbound runtime truth across projection and diagnostics |
| `3c4ac28` | D | merge caller abort signal with local question race signal |
| `74adde9` | E | native session detail, destructive confirms, redacted identifiers |
| `e309f54` | F | single revision/activity owner + support-report secret audit |
| `3326189` | G | final gate record |

**Consequence for this pack**: several pack tasks are partially pre-satisfied. Per pack rule
("已经修好的问题验证后标 done，不重复实现"), T08 (frozen resolved config via real assembly) and
T04 (narrow transaction semantics) must start from the *post-Stage-A/B* state, not rebuild it.

### Open issues / PRs (remote, 2026-09-30)

| # | kind | title | disposition |
|---|---|---|---|
| 46 | issue | outbound config deep-frozen → qq-bot/wecom-app send fails | root cause fixed in Stage A (`2978f31`); verify + close |
| 45 | issue | v0.12 outbound source JSON-clones + deep-freezes resolved adapter config | same as #46; verify + close |
| 26 | issue | QQ C2C markdown+keyboard real device: buttons not rendered | **stays open** — real-device evidence gap, not a code task |
| 25 | issue | announcement (maintainer exam period) | informational only |
| — | PRs | none open (latest merged PR #44 `release: land v0.13.1 follow-up`) | n/a |

### Host capability drift

- Declared peer: `@deepseek-ai/dsh-session` **exact** allow-list
  `0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2` (optional peer).
- npm registry `dist-tags`: `latest=0.0.1-rc.1`, `alpha=0.1.7-alpha.2`, **`next=0.2.0-rc.2`**.
  So the pack's DSH target `0.2.0-rc.2` exists upstream but is **not** in the declared range.
- Pack rule: **do not auto-widen** the declared range (T13 audits seams; range change only after
  source-seam audit + fixture tests + real-host smoke, and only if explicitly re-verified).
- `@deepseek-ai/cordis` peer `^4.0.1`.

### Writer inventory (store key → production writers)

Baseline store primitive: `src/inbound/store.mjs` `createStore().transact(mutator)` returns
`{ ok, committed, durable, code, value }`; lock is acquired before read, mutator gets a **detached
draft**, disk+memory publish only after atomic `renameSync`. Helpers `setDurable` / `transactDurable`
/ `deleteDurable` (store.mjs L455/L476/L497) normalize the committed judgement. `false` is **not** an
abort signal; only explicit failure is failure; `undefined` from legacy mock stores counts as success.

| store key / record | production writer(s) | owner verdict |
|---|---|---|
| `inbound:bindings` | `inbound/identity.mjs` (`writeBindings` L140, clean L173, migrate L369, redeem L493) | single module — OK |
| `inbound:pending` | `inbound/identity.mjs` (L193, L466, L492, L535) | single module — OK |
| `inbound:migrated` | `inbound/identity.mjs` (L362; same tx as bindings L369) | single module — OK |
| `inbound:pairing` | `inbound/pairing.mjs` (prune L135, redeem tx L304) | single module — OK |
| `inbound:pairing:lockout` | `inbound/pairing.mjs` (L171) | single module — OK |
| `route:agents` | `routing/agent-router.mjs` (`setAgentBinding`), via CLI/admin/router | router is owner |
| `route:channels` | `routing/agent-router.mjs` (`setChannelDefault`) | router is owner |
| **`route:sessions`** | **`routing/agent-router.mjs` (commitSessions L178-197, outbound diff L502-559)** **+** **`routing/session-registry.mjs` (persist L195-254)** | **TWO writers — T14 target** |
| `channel:<type>:outbound` | `control-surface/outbound-config.mjs` (L212/287/294/298/378), `control-surface/channel-config-migration.mjs` (L63) | multi-writer — T08 target |
| inbound `channel:…` / account keys | `inbound/channel-config.mjs` (L179/191/241/249), `inbound/_feishu-register.mjs` (`feishu:account` L158), `inbound/_qq-scan.mjs` (L125) | multi-writer — T08 target |
| `aq:<id>` (questions) | `questions/router.mjs` (L314, L1056) | single — OK |
| approval rows | `approval/router.mjs` (L346, L597) | single — OK |
| action rows | `actions.mjs` (L132, L161) | single — OK |
| interaction ledger rows | `interaction/ledger.mjs` (L65/77/86/141/154) | single — OK |
| inbound dedup rows | `inbound/bus.mjs` (L129, L143) | single — OK |
| conversation bindings | `inbound/conversation.mjs` (L336, L646, L763) | single — OK |
| `taskselect:*` | `routing/task-selection.mjs` (L128) | single — OK |
| `tg:offset` | `inbound/telegram-bot.mjs` (L320) | single — OK |
| `wechat:sync_buf`, wechat ctx token | `channels/wechat-ilink/legacy-core.mjs` (L353, L208) | single — OK |
| `dingtalk:robot-code` | `inbound/dingtalk-stream.mjs` (L360) | single — OK |
| `wxpusher:webhookPath` | `assembly/inbound-signals.mjs` (L108) | single — OK |
| `wxpusher:bind:<uid>` | `inbound/wxpusher-callback.mjs` (L219) | single — OK |
| `admin:token-hash` | `assembly/admin-token.mjs` (L38) | single — OK |
| `state:schema-version` | `control-surface/channel-config-migration.mjs` (L11/L63) | single — OK |

**Highest-priority multi-owner keys**: `route:sessions` (T14), outbound/inbound channel config
(T08). These two are the pack's core convergence targets and are confirmed still multi-writer after
the v0.14 fixpack.

### Risks carried into execution

- `.agents/` is git-ignored but force-tracked (273 files); new workstream files need `git add -f`.
- Pack forbids widening the DSH peer range; 0.2.0-rc.2 seam work is audit-only unless evidence lands.
- Real-device/provider evidence (QQ keyboard #26, Feishu P2P, DingTalk stream, QQ gateway) stays
  `unverified`; must not be relabeled.

## T02 — 行为契约与旧 oracle

### 交付

- `docs/behavior-contract.md`（新增）：行为契约索引。字段：ID / 分类 / 事实 owner / 适用版本 /
  输入前置 / 公开执行入口 / 结果 / durable diff / effect trace / 禁止动作 / 证据链接 / 旧 test 映射。
  分类词表固定为 `MUST_PRESERVE` / `BUG_FIX` / `SECURITY_FIX` / `UNKNOWN` / `OBSERVATION_ONLY`；
  UNKNOWN 不上调。
- fixtures（新增 2 条，脱敏）：`test/fixtures/legacy/inbound-bindings-mixed.json`、
  `test/fixtures/legacy/channel-config-legacy.json`。仅补旧 reader/迁移缺的文件级旧形状快照；
  其余不变式的输入在现有测试内联构造，未重复造。

### 条目与必测 oracle 覆盖

| 域 | 条目 | 必测矩阵 | 旧 oracle |
|---|---|---|---|
| 配置 | CFG-01 同 key 兄弟 patch | **K02** | `v014-stage-b-persistence-tx.test.mjs:187,233` |
| 配置 | CFG-02 写盘失败语义 | **K01/K05** | `store.test.mjs:24,34,51` |
| 配置 | CFG-03 冻结 resolved 经真实装配 | **C01** | `runtime-mutability-v014.test.mjs:47,90` |
| 配置 | CFG-04 深冻结发送失败 | BUG_FIX/C01 | `runtime-mutability-v014.test.mjs:127` |
| 配置 | CFG-05 secret patch / CFG-06 canonical 键权威 | C02 | `channel-config-migration-v013.test.mjs:22,155,173` |
| 成员 | MEM-01 末位 owner | **K03** | `members-control-service-v014.test.mjs:156` |
| 成员 | MEM-02 storage-failed≠not-found | K01/K05 | `v014-stage-b-persistence-tx.test.mjs:75` |
| 成员 | MEM-03 绑定读盘防御 | **M01/M02** | `identity.test.mjs:166,87` |
| 成员 | MEM-04 pending→binding 原子 | K04 | `identity.test.mjs:253` |
| 路由 | RT-01 session 兄弟不 clobber | K02 | `agent-router.test.mjs:549` |
| 路由 | RT-02 双表单事务 / RT-03 优先级 / RT-04 失败如实 | K02/K04/K01 | `routing-control-service-v014.test.mjs:82,161,183` |
| 交互 | INT-01 迟到问题卡终态话术 | **H02** | `questions-web-first.test.mjs:227,277,301,321` |
| 交互 | INT-02 claim 失败零 effect | **I02** | `actions.test.mjs:470` |
| 交互 | INT-03 claim 后 kill→uncertain | **I03** | `actions.test.mjs:496`; `terminal-cleanup-v013.test.mjs:215` |
| 交互 | INT-04 来源会话校验 / INT-05 首达 | I01/I04 | `actions.test.mjs:213,255,72` |
| provider | PRV-01 QQ 分段 msg_seq | P02 | `adapters.test.mjs:297,317` |
| provider | PRV-02 token single-flight/代际 | P01 | `tokens.test.mjs:27,52` |
| provider | PRV-03 TG offset durable 游标 | P03 | `inbound.telegram.test.mjs:1010,1066` |
| provider | PRV-04 payload golden | C01 | `adapters.test.mjs` + `fixtures/channels/*` |
| provider | PRV-05 QQ C2C 键盘真机 | **UNKNOWN** | 无仓内 oracle（`v0.14-evidence-matrix.md`） |
| Host | HST-01 缺/晚/撤服务降级 | H01 | `host-seam-audit.test.mjs:106,175` |
| Host | HST-02 peer 范围/fixture | H03 | `host-seam-audit.test.mjs:58,78,85` |
| Host | HST-03 attachments 防御 | H03 | `host-seam-audit.test.mjs:128,146,163` |
| Host | HST-04 alpha.2/rc.1 真机走查 | **UNKNOWN** | 无（`compatibility-matrix.md`） |
| migration | MIG-01 备份一次/幂等/损坏 fail-closed | **M01/K06** | `channel-config-migration-v013.test.mjs:22,197` |
| migration | MIG-02 旧 reader 读新 metadata | **M02** | `actions.test.mjs:289,322`; `identity.test.mjs:166` |
| migration | MIG-03 回退读最新 | M03 | `identity.test.mjs:69,77` |

### 七个必测 oracle：找到 vs UNKNOWN

- 找到（均有具体 test 文件:行 oracle）：same-key（K02）、last-owner（K03）、storage 失败（K01/K05）、
  frozen config（C01）、claim（I02/I03）、late question（H02）、旧 reader（M01/M02）。
- 标记 **UNKNOWN**（无仓内 oracle，未上调）：PRV-05（QQ C2C 键盘真机，issue #26）、
  HST-04（alpha.2/rc.1 真机走查）。二者在证据矩阵中已是 `external-evidence-pending`。

### 证据与校验

- 引用的全部 `test` 行号已用 `sed -n Np` 逐条回读核对（命中对应 `test(...)` 标题）。
- 2 条新 fixture 通过 `node` 的 `JSON.parse` 校验，且字段形状对齐既有测试内联构造。
- 未改 `src/**`、未改任何 `test/*.test.mjs` 断言、未加依赖、未动 `package.json`、未跑全量 `npm test`。

### reader 兼容性

新增文件为 spec 与静态 fixture，不改变任何 reader/写入路径，故无 reader 兼容问题。

### 下一任务

T03（真实装配与 DOM 测试底座），依赖 T02。

## T03 — 真实装配与 DOM 测试底座

### 交付

- 新增隔离测试工作区 `test/dom/`（独立 `package.json`，`private:true`，devDependencies
  `jsdom@^25.0.1` / `react@^18.3.1` / `react-dom@^18.3.1`）。**不进核心 `npm install`**：
  仓库根 `npm test` glob 为 `test/*.test.mjs`（不递归），故 `test/dom/**` 不在其内；
  `test/dom/node_modules` 与 `test/dom/package-lock.json` 由根 `.gitignore` 命中（已核验）。
- `test/dom/dom-globals.mjs`：在 `react-dom` 求值前安装 jsdom 的 window/document
  （react-dom 在模块加载期冻结浏览器探测），每个用例前可重装。
- `test/dom/harness.mjs`：按 DSH 宿主真实装载契约（IIFE → `window.__ModuleLoader__.load({ id, factory })`
  → factory `require('react')`）加载**真实** `client.js`，注入真 `react`/`react-dom`，并提供
  `mount/click/typeInput/buttonByText/flush/actAsync`。以 splice `__test` 导出内部组件
  （与 `test/client-module.test.mjs` 同法，不改生产代码）。
- `test/dom/ui-dom.test.mjs`：真 React DOM 渲染 6 例——装配+保存+测试链路；受控输入跨状态
  更新保持 DOM 节点与焦点（U05）；写忙态与二次点击不重复 RPC（U02）；提交成功后刷新失败
  不误报提交失败（U01）；查询失败不伪造空态（U04）；延迟失败的保存保留草稿并报错。
- `test/dom/assembly-harness.mjs`：临时隔离 DSH_HOME + fake HTTP/WS/SDK + 最小 Cordis 替身
  （`effect`/`on`/`inject`/`provide`/`emit`/`logger`）。
- `test/dom/assembly-smoke.test.mjs`：启动真 `apply()`；**晚注入** host `connection`/`webServer`
  被采纳并在 fake webServer 上挂 `/dsh-notifier` prefix 路由（并分发一条合成 RPC 得到
  server-response 信封）；`dispose()` 撤销 host listener、卸载路由、撤回 notifier 服务；
  同一 DSH_HOME 重建后可再次完整装配与拆除。
- `test/dom/run.mjs`：独立 runner，命令 `node test/dom/run.mjs`（带 `--test-force-exit`
  与 30s `--test-timeout`，任何泄漏句柄导致失败而非挂起）。

### Cordis 可用性（诚实说明）

沙箱内**没有**真实 `@deepseek-ai/cordis`（peer dependency，未安装；`src/` 亦无其运行时
`import`）。故 `assembly-harness.mjs` 用**最小忠实替身**模拟本插件实际消费的 Cordis 面；
它只覆盖上述用例触达的缝，不是官方 runtime。若日后真 Cordis 可安装，替换 `createFakeCordis`
即可，fake HTTP/SDK 与冒烟断言不变。

### 校验

- `node test/dom/run.mjs` → **8 pass / 0 fail / 0 skip**（spec reporter，真实退出码 0，约 1.3s）。
- 未改 `src/**`、未改根 `package.json`、未加核心运行依赖、未新增绕过 auth 的公开入口。

### reader 兼容性

纯新增测试底座，不触碰任何持久格式或 reader；`client.js` 与 `src/**` 零改动。

### 下一任务

T04（窄事务与失败语义，依赖 T02；不受 T03 阻塞）。

## T04 — 窄事务与失败语义

**Result**: `src/inbound/store.mjs` gains an explicit **business-abort** sentinel plus the narrow
helper `transactOutcome(store, mutator)`.

- `transact(mutator)` unchanged for existing callers: `false`/`undefined` are still *not* aborts, and
  every pre-existing caller still commits normally.
- The mutator may now take `(draft, control)` and call `control.abort(reason)`. On a real store this
  performs **zero disk write and zero memory publish** and returns
  `{ ok:false, committed:false, durable:false, aborted:true, code:'BUSINESS_ABORT', reason }`.
- Failure taxonomy is now separable at the call site: `BUSINESS_ABORT` (business rejection),
  `STATE_BUSY` (lock contention), `STATE_READ_FAILED`, `STATE_CORRUPT`, `STATE_WRITE_FAILED`,
  `TRANSACTION_UNAVAILABLE` (no real `transact`). Only `aborted:true` means "the domain said no".
- Mutator still runs **inside** the lock on a detached draft; abort happens before any temp file is
  created, so the lock is released by the existing `finally` with no residue.

## T05 — Members 试点（identity 权威收口）

**Gap**: the last-owner guard lived only in `MembersControlService` as a **lock-free** `ownerCount()`
pre-check. Two concurrent demotions both read "2 owners" and both pass → the sole owner could be
removed or downgraded to zero (K03 TOCTOU). `identity.removeBinding` / `identity.updateBinding` were
also lock-free read-modify-write.

**Fix** (`src/inbound/identity.mjs`):
- New private `mutateBinding(key, apply)` runs the *whole* change (guard + write) inside one fresh
  `transactOutcome`: the guard is evaluated against the **in-lock draft**, so a stale second caller is
  correctly rejected. Business rejections abort (zero write) instead of performing a no-op full write.
- `removeBinding` / `updateBinding` now enforce **owner-last in-lock**; label edits are unaffected;
  the legacy no-`transact` path keeps a read-then-decide fallback with the guard before mutation.
- `confirmPending`'s transaction path switched from `transactDurable` to `transactOutcome`, so a
  business rejection (`not-found` / `already-bound` / `invalid-account`) is no longer conflated with
  `storage-failed` (K04/K05) and no longer triggers a pointless write.

**Deliberate behaviour change (recorded)**: `identity.removeBinding`/`updateBinding` now refuse to
delete/demote the last owner. This is required by K03 ("check 与 write 同锁", authority owns the fact)
and matches what the service and the CLI `/unpair` path already enforced. Two pre-existing tests that
deleted a *sole* owner through `identity` directly were updated to first seed a second owner — their
real assertions (the one-shot `inbound:migrated` no-revival guard) are unchanged. This is an
expectation correction forced by the pack's invariant, not an adaptation to fit an implementation.

**Tests**: `test/v015-stage-s1-core.test.mjs` (7 cases) — abort zero-write/zero-publish, lock-busy
vs business-abort separability, `TRANSACTION_UNAVAILABLE`, cross-instance last-owner convergence,
same-key sibling preservation, `storage-failed` never rewritten, pending-reject zero-write.

**Count**: 2166 → **2173** (README.md / README.zh-CN.md / HANDOFF.md / docs/memory/project-state.md synced).

**Validation**: `node --test test/v015-stage-s1-core.test.mjs` → 7 pass / 0 fail; `npm test` → **2173 pass / 0 fail / 0 skip**.

## T06 — identity / pairing 剩余写入

**Done**: `identity.addPending` and `identity.dismissPending` moved from lock-free
read-bindings + read-pending + whole-table `setDurable` to an in-lock `transactOutcome`
read-modify-write (shared `planPendingAdd` planner so the real-store path and the legacy
no-`transact` fallback cannot drift). A business rejection (`already-bound`, `not-found`) now aborts
with zero write and is no longer conflated with `storage-failed`.

**Deferred (registered in T07)**: `pairing.mint` / `pairing.revoke` still read-modify-write through
`writeCodes`; `pairing.sweep` itself nests a `writeCodes`, so inlining them into one transaction
requires extracting a non-writing `sweepInTable` first. `pairing.redeemAndBind` (the security-critical
path) is already a single transaction, so the residual risk is a lost concurrent **admin** mint/revoke.

## T07 — 试点复核 + 全量 writer 登记

**Artifact**: `docs/state-writer-registry.md` — every store key mapped to its authority, production
writers, and a convergence verdict; hidden/secondary writers (bootstrap seeding, startup cleanup,
read-path sweep, CLI, admin adapter, dispose) registered explicitly; deferrals listed with risk and
next action.

**Verdict**: identity keys (`inbound:bindings`, `inbound:pending`, `inbound:migrated`) are now single
in-lock authorities. Three multi-owner keys remain and are assigned to later tasks: `route:sessions`
(T14), outbound and inbound `channel:*` config (T08).

## T08 — desired / resolved / resources 分离

**Result**: the outbound config model's three layers are now explicit and enforced, and the
runtime-truth owner gained a monotonic revision fence.

- **Layers** (documented in `docs/state-writer-registry.md` §Outbound config layers):
  `desired` (persisted `channel:<type>:outbound` overlay + YAML base, returned by `raw()` as a
  deep clone) → `resolved` (`adapter.resolve()` output, the live entry — not frozen, adapter owns
  it and may lazily cache) → `resources` (adapter-private `_`/`__` fields, mutable, stripped from
  every projection) → `projection` (`snapshot()`/`get()`, deep-frozen, no reference sharing).
  Stage A already split resolved/resources (live vs frozen); T08 records the full contract and
  proves it **through the real assembly**.
- **C02 apply semantics** (`src/control-surface/outbound-config.mjs`): `applyRuntime` now takes
  `wasLive`. A failed hot swap where an old runtime is still serving marks the channel
  **online + restartPending** (new desired + old active = `diverged`) instead of `failed`; only a
  channel with no prior runtime is marked `failed`. This matches acceptance "apply失败显示新desired
  和旧active" and no longer slanders a still-working channel.
- **C03 revision fence** (`src/runtime/channel-manager.mjs`): the runtime-truth owner keeps a
  per-type monotonic `appliedRevision`. A lifecycle update carrying an older `source.version` is
  dropped, so a late (superseded) apply result can never roll a newer runtime state back. The
  revision is consumed for the fence only and never enters the `runtimeState` shape (existing
  `deepEqual` contracts unchanged). `save`/`remove` stamp `revision: source.version`.
- **C01 real assembly** (`test/v015-stage-s2-config-layers.test.mjs`): `composeOutboundChannels`
  → `createOutboundSource` → `createRuntimeChannelManager` → `createNotifier` sends qq-bot and
  wecom-app with the assembly-produced resolved config; the live object is mutable (lazy caches
  survive), the projection is frozen, and the public payload matches a direct `resolve()`.
- **C02 commit-failure** (same suite): a `transact` that returns `committed:false` throws
  `storage-failed` with **zero** `replace`/`remove` calls and zero desired written.

**Writer convergence**: `channel:<type>:outbound` is now **single** — `outbound-config` is the
only in-transaction authority; `channel-config-migration` is a one-shot, marker-guarded projection.
The inbound `<type>:account` scan writers (`_feishu-register` / `_qq-scan`) remain a registered
multi-writer deferred to **T11** (they write the same two credential fields today; low blast radius).

**Tests**: `test/v015-stage-s2-config-layers.test.mjs` (8 cases). Related suites re-run green
(v014-stage-c-runtime-truth, runtime-mutability-v014, assembly-runtime, config-runtime-truth-v013,
channel-control-service-v014, v014-stage-b-persistence-tx, outbound-transaction-rollback-v013,
channel-config-migration-v013, durability-contract-v0121, outbound-source-v012) → 74 pass / 0 fail.

**Count**: 2175 → **2183** (README.md / README.zh-CN.md / HANDOFF.md / docs/memory/project-state.md synced).

## T09 — 简单 HTTP sender 试点

**Result**: the provider path gains an explicit **stateless sender contract** and a pilot registry; the
simple HTTP channels (Bark, Webhook) are switched onto it without touching a byte of protocol code.

- **Contract** (`src/adapters/sender.mjs`): a stateless sender exposes exactly
  `validate(cfg) -> resolved` and `send(resolved, msg) -> { accepted, confirmed }` and **declares
  `lifecycle:'stateless'`**. It deliberately exports **no** `createRuntime` / `start` / `stop` /
  `candidate` / `dispose` — a channel that owns no resident resource must not fabricate resource
  verbs (02 §生命周期与资源; T09 边界「没有常驻资源就不实现 start/stop/candidate lifecycle」).
  `bridgeStatelessAdapter(adapter)` wraps a legacy `{type, resolve, send}` adapter and converges its
  success into the two-level evidence vocabulary (`accepted` = provider took the request;
  `confirmed` = explicit receipt, per `delivery-evidence.mjs`). Failure semantics are unchanged: the
  original `NotifyError` propagates, so `publicMessage`/`detail` layering still holds.
- **Pilot registry** (`src/adapters/senders.mjs`): `bark` and `webhook` only. `senderOf(type)` returns
  `null` for every other channel — unregistered channels keep the legacy `adapter.send` path
  (回退要求「只切该渠道 wrapper；其他渠道原状」). T10/T11 plug stateful senders into the same table.
- **Dispatch** (`src/notify.mjs`): `sendOne` uses `senderOf(type)` when present, else the legacy
  adapter. Both are shape-compatible `(resolved,msg) -> value`, so segmentation / retry / evidence
  inference are unchanged. No double-send: exactly one of the two paths runs per attempt.
- **Boundaries honored**: endpoint / payload / validation / timeout range / SSRF are owned by the
  adapters and untouched; no new runtime connection resource; custom endpoints are **not** relaxed
  (webhook private targets still fail closed without `allowPrivateNetwork: true`).

**Tests**: `test/v015-stage-s3-http-sender.test.mjs` (14 cases) — contract shape (no lifecycle verbs),
evidence mapping (accepted vs confirmed), Bark/Webhook payload goldens identical to the adapter,
2xx/4xx (`API_ERROR`/`HTTP_ERROR`), timeout→`TIMEOUT`+`noRetry`, Webhook SSRF block + explicit
allow, frozen-resolved send, real-assembly notifier dispatch, and unregistered-channel fallback.

**Count**: 2183 → **2197** (README.md / README.zh-CN.md / HANDOFF.md / package.json
`dshQuality.testCount` / docs/memory/project-state.md synced).

## T10 — 复杂 runtime 试点

**Result**: the provider path gains a **stateful (resource) sender contract**, and the two resource-holding
outbound channels — QQ 官方机器人 and 企业微信应用 — are migrated onto it with an explicit runtime
lifecycle. Resources stay on the live `resolved` object (T08 layering); the contract adds **who owns the
lifecycle**, not a second copy of the config.

- **Contract** (`src/adapters/sender.mjs`): `defineStatefulSender({ type, validate, createRuntime })` declares
  `lifecycle:'stateful'` and exposes exactly `validate` / `createRuntime` / `send` / `retire`. The runtime host
  is **single-owner per resolved** (WeakMap: concurrent `send` / `createRuntime` reuse one runtime, `start`
  once) and **epoch-guarded**: `send` that is still in flight when `retire()` runs rejects with
  `CHANNEL_RETIRED` + `noRetry` — a stopped runtime's late result can never masquerade as a delivered message
  ("停用后旧 callback 不落地"). `retire()` is idempotent and bounded: `stop()` + `dispose()` each once, then
  the reference is dropped (GC / no timer leak). `bridgeStatefulAdapter(adapter)` wraps a legacy
  `{ type, resolve, send, disposeRuntime? }` adapter with zero protocol changes.
- **Pilot registry** (`src/adapters/senders.mjs`): `qq-bot` / `wecom-app` registered as stateful senders
  (Bark/Webhook remain stateless per T09). `retireSenderRuntime(type, config)` is the shared release entry.
- **Bounded dispose** (`src/adapters/qq-bot.mjs`, `wecom-app.mjs`): new `disposeRuntime(resolved)` invalidates
  the token manager (so a late refresh cannot resurrect a dead credential) and drops `_tokenManager` /
  `_rateGate` references. No payload / validation / timeout / seq semantics touched → P01 (single-flight) and
  P02 (segmentation + `msg_seq` idempotency) goldens are byte-identical.
- **Lifecycle owner** (`src/runtime/outbound-source.mjs`): `createOutboundSource(initial, { onRetire })` now
  reports every discarded config (replace / remove / replace-all) to the single authority; `src/index.mjs`
  wires it to `retireSenderRuntime`, so a removed or hot-replaced channel releases its runtime instead of
  leaking a usable token cache.
- **QQ 入站实例** (existing `src/inbound/qq-gw.mjs`): token single-flight (`createTokenManager`), connection
  epoch (`ws !== conn` drops late frames/ACKs from a retired socket), bounded `stop()` (clears every timer)
  and idempotent `start()` were already in place; T10 re-verifies them as the same per-instance contract.

**Tests**: `test/v015-stage-s4-stateful-sender.test.mjs` (14 cases) — contract shape (stateful verbs vs
stateless no-lifecycle), single-owner + shared token fetch under concurrency, retire→fresh epoch + refetch,
in-flight retire → `CHANNEL_RETIRED`, idempotent/bounded retire, lifecycle-verb throw containment, evidence
without secrets, timeout (`TIMEOUT`+`noRetry`), real-assembly stateful send (frozen projection / mutable live),
outbound-source retire on replace/remove, unregistered-channel fallback, wecom-app token single-fetch +
dispose, and the QQ inbound instance (idempotent start = single owner; post-stop late frame never lands).
T09's registry assertion was updated to include the two new stateful entries.

**Count**: 2197 → **2211** (README.md / README.zh-CN.md / HANDOFF.md / package.json `dshQuality.testCount` /
docs/memory/project-state.md synced; `verify-release` green).

## T11 — 全部 provider 保留迁移

**Result**: every outbound provider is now classified and registered under the sender contract, and the
last multi-writer credential key converges — all without touching a byte of protocol code.

- **Contract matrix** (`src/adapters/provider-registry.mjs`, new): the single source of truth for all
  **28** outbound providers — `lifecycle` (stateless/stateful), `owned resources`, and whether the
  channel is wired for button/card interaction. It is **descriptive only** (never on a payload / validate
  / timeout path), unknown types return `null` (fail-closed), and `providerRegistryDrift()` proves the
  matrix and the sender registry cannot disagree (lifecycle written in exactly one place).
- **Full registration** (`src/adapters/senders.mjs`): all 28 providers are bridged — handwritten HTTP /
  local channels and the spec-engine channels as `bridgeStatelessAdapter`, QQ 官方机器人 / 企业微信应用 as
  `bridgeStatefulAdapter`. `senderOf()` is the single lookup; the T09/T10 pilot-only assertions were
  updated to the full-census fact (the census itself moved to the s5 suite).
- **No protocol change**: `sender.send` and the legacy `adapter.send` are shape-compatible
  (`(resolved,msg) → value`), so segmentation / retry / evidence inference are reused verbatim. The s5
  suite proves the request fingerprint (url/body/headers) and the thrown `NotifyError.code` are identical
  on both sides for a representative set of channels.
- **Boundaries honored**: no dsh-im protocol copied, no platform parser/auth lifted into a "universal
  core", no media/voice/new platform added; inbound negatives (TG offset pause, Feishu ACK/card patch,
  DingTalk reconnect, WeChat login state) stay owned by their own suites — an import-direction fitness
  check proves the outbound seam cannot import inbound/transport modules.
- **Credential merge convergence** (T07 deferral, assigned here): the scan onboarding writers
  `_feishu-register` / `_qq-scan` no longer write the whole `<type>:account` object via `setDurable`;
  they commit through the new `mergeDurable(store, key, patch)` — a **single-key field merge inside one
  transaction** (same semantics as `channel-config.mergeAccount`). A concurrent manual `put` / second
  scan on the same key can no longer drop a sibling field. `docs/state-writer-registry.md` verdict for
  `<type>:account` moves **MULTI → single**.

**Tests**: `test/v015-stage-s5-provider-migration.test.mjs` (15 cases) — completeness (28 senders ==
`CHANNEL_TYPES`), matrix ↔ registry ↔ capability-matrix interaction axis, fail-closed unknown, contract
shape (stateless has no lifecycle verbs; stateful has exactly the four), protocol goldens, error-code
parity, import-direction fitness, inbound-negative suite presence, unknown-channel fallback, real-assembly
send evidence, and the credential field-merge (sibling preserved). T09/T10 registry assertions updated.

**Count**: 2211 → **2226** (README.md / README.zh-CN.md / HANDOFF.md / package.json `dshQuality.testCount` /
docs/memory/project-state.md synced; `docs/state-writer-registry.md` convergence updated; `verify-release` green).

## Task status

| Task | Status | Commit | Evidence |
|---|---|---|---|
| T01 | done | `027852d` | baseline table, drift table, writer inventory above |
| T02 | done | `21bdfca` | `docs/behavior-contract.md` + 2 sanitized legacy fixtures; oracle map above |
| T03 | done | `eef0d3d` | isolated `test/dom/` bed: real React DOM + fake-Cordis assembly smoke; `node test/dom/run.mjs` → 8 pass / 0 fail |
| T04 | done | `8f59965` | narrow `transactOutcome` abort + failure taxonomy |
| T05 | done | `8f59965` | in-lock last-owner in identity authority; K03/K04/K05 covered |
| T06 | partial | `ca5097a` | identity pending writes transactional; pairing mint/revoke deferred (registered) |
| T07 | done | `ca5097a` | `docs/state-writer-registry.md` |
| T08 | done | `93dfc50` | desired/resolved/resources layers + apply-failure divergence + runtime revision fence; `test/v015-stage-s2-config-layers.test.mjs` → 8 pass |
| T09 | done | `f6cc400` | stateless sender contract + Bark/Webhook pilot registry; `test/v015-stage-s3-http-sender.test.mjs` → 14 pass |
| T10 | done | `a0af7b1` | stateful sender runtime (single-owner + epoch + bounded dispose) + QQ/WeCom migration; `test/v015-stage-s4-stateful-sender.test.mjs` → 14 pass |
| T11 | done | (this commit) | all-28 provider contract matrix + full sender registration + credential field-merge convergence; `test/v015-stage-s5-provider-migration.test.mjs` → 15 pass |
| T12–T30 | not started | — | — |