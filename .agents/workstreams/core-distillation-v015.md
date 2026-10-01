# workstream: core-distillation-v015

- **identity**: agent `flash`, task pack `dsh-notifier-flash-complete-taskpack` (T01–T30)
- **branch**: `codex/core-distillation-v015` (off `dev`)
- **status**: in progress — T01–T23 done (T06 partial)
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

## T12 — 投递证据与 health 收口

**Result**: the health surface now speaks the same three-bucket evidence vocabulary as delivery, is
bounded in both size and time, and is scoped to a runtime generation.

- **Three evidence buckets** (`src/control-surface/health.mjs`): `accepted` (provider took the request),
  `delivered` (explicit receipt == `confirmed`), `unknown` (result indeterminate — timeouts etc.). A
  legacy `delivered` record (old "send resolved" meaning) is normalized to `accepted`, **never** to
  confirmed. `unknown` never counts as success or as a definitive failure.
- **`unknown` not double-counted as `failed`** (`recordSend`): a failure row carrying `uncertain: true`
  is recorded **only** in the `unknown` bucket — otherwise one indeterminate send would be both a
  certain failure and "unknown", and the channel would be mislabeled `degraded`.
- **Bounded, time-aware history**: a `window` cap (5–100) plus a `ttlMs` TTL (default 24h) prune stale
  observations on snapshot, so a long-running process no longer accumulates unbounded history.
- **Runtime epoch**: `markEpoch(type)` advances a monotonic per-type generation and discards the old
  generation's observations. `src/index.mjs` wires it to the outbound-source lifecycle event, so a
  replaced/removed/replaced-all runtime's late observations can never pollute the new instance
  ("断线旧 epoch 观察不污染新实例").
- **State semantics** (`healthState` / `healthView`): configured + active but **no evidence** → `ready`
  (never `online`/`healthy`); latest result indeterminate → `unavailable`; `restartPending` outranks
  evidence health; `supported:false` → `unsupported` explicitly. `healthView` carries `epoch` and the
  observation timestamps (`observedAt` / `last*At`), never fabricating a time when there is no evidence.
- **Observer failures never change delivery**: malformed records are ignored, never thrown.
- **End-to-end** (`src/notify.mjs`): a timeout (or `uncertain`) failure now audits `unknown:[type]` with
  `failed[0].uncertain === true` (instead of a plain certain failure), so the health surface reports
  `unavailable` rather than a fabricated failure/success, and the result is **never** replayed.

**Tests**: `test/v015-stage-s6-delivery-evidence-health.test.mjs` (11 cases) — three-bucket separation,
legacy-delivered→accepted, unknown vs failed separation, window cap, TTL eviction, epoch advance + drain,
healthView epoch/timestamps, `ready`/`unavailable`/`unsupported`/`restart-pending`, observer robustness,
and the end-to-end timeout → `unknown` bucket + `unavailable`.

**Count**: 2226 → **2237** (README.md / README.zh-CN.md / HANDOFF.md / package.json `dshQuality.testCount` /
docs/memory/project-state.md synced; `verify-release` green).

## T13 — 官方 Host seam

**Result**: all host-service reads/calls and Cordis optional-dependency lifecycle are centralized on
one seam, the declared capability matrix is explicit, and native-question handling is capability-aware.

- **Seam** (`src/host/seam.mjs`, new): `HOST_QUESTION_CAPABILITY` version table (0.1.7-alpha.1 →
  0.2.0-rc.2: `waterfall`/`provider`/`timed`/`continued`/`verified`), `readHostService(ctx,name)`
  (defensive; `get(name,false)` first, throwing proxies treated as "no service"), `hostQuestionFeatures`
  (runtime probe merged with the declared table), `createHostLifetime` (late `ctx.inject` / replacement
  replay / idempotent dispose that releases every registration), and the `createHostSeam` facade.
- **Native questions** (`src/host/native-questions.mjs`): late-reply handling is now driven by the
  host's real `timed`/`continued` capability — an unanswered winner is only handed back to the host
  answerer when the host supports it, and the host caller signal is **never** aborted by us.
- **Assembly** (`src/index.mjs`): optional host injection (`userQuestions`, `connection`+`webServer`)
  routes through `createHostLifetime().inject(...)`; the lifetime disposer is registered once.
- **Bounds honored**: no support-matrix / peer-range widening (audit only), no dsh-im contract inferred
  as a host contract, unsupported capabilities degrade locally.

**Tests**: `test/v015-stage-s7-host-seam.test.mjs` (14 cases) — H01 missing/late/revoked service,
H02 timed/continued late-reply semantics, H03 defensive reads + capability table.

**Count**: 2237 → **2251**. Contract: `docs/behavior-contract.md` HST-05 / HST-06.

## T14 — Session/Routing 收敛

**Result**: `route:sessions` is now a **single transactional writer**. The session registry's lifecycle
write reads the fresh whole-table base **inside the same `store.transact()` mutator** as the router's
outbound/control override writer, so both serialize on the store key lock and preserve each other's
sibling fields (route lifecycle ↔ outbound/control siblings).

- **Fix** (`src/routing/session-registry.mjs`): `persist()` split into a pure `buildNextSessions(base)`
  (tombstone delete → per-dirty-field record merge → control-overlay sanitize) plus `commitSucceeded()`;
  the real path runs `transactDurable(store, draft => { draft[SESSIONS_KEY] = buildNextSessions(draft[SESSIONS_KEY]); return true })`,
  eliminating the previous "read latest outside the transaction, commit the stale snapshot" TOCTOU.
  A store without `transact` keeps the single-key read-modify-write best-effort fallback (no fabricated
  atomicity); `committed:false` leaves the in-memory value rolled back (no ghost state).
- **Already-satisfied (verified, not rebuilt)**: `agent-router.commitSessions` already commits inside a
  transaction; `SessionArbiter` is constructed per-event from the durable overlay (`src/control/entry.mjs`
  L271) and holds no long-lived second route cache; identity bindings are already cross-key atomic (T05/T06).
- **Bounds honored**: no precedence/default/ambiguity change, no user-workspace or Host-log migration.

**Tests**: `test/v015-stage-s8-routing-convergence.test.mjs` (6 cases) — in-transaction base (sibling
outbound preserved under a simulated stale read view), registry↔router sibling coexistence, cross-session
preservation, `committed:false` zero-write, no-transact legacy fallback, business-abort isolation.
Cases 1 & 3 fail on the pre-fix code (verified via `git stash`), so the suite discriminates the fix.

**Count**: 2251 → **2257**. Contract: `docs/behavior-contract.md` RT-05; `docs/state-writer-registry.md`
`route:sessions` MULTI → single.

## T15 — Questions/Approval/Actions claim 收敛

**Result**: the three interaction entry points (actions / approval / questions) now share one
`authorization → durable claim → first-settlement → host effect` boundary while keeping their own
business differences. No new state machine was introduced — the existing `interaction/ledger.mjs`
atomic operations are the single claim authority for all three.

- **Shared boundary (verified, not rebuilt)**: `actions.mjs` claims via `ledger.claim` before running an
  irreversible handler; `approval/router.mjs` settles through `settleThroughLedger` (`finalizeApproval`
  → `ledger.settle` → `bus.settle`) and `questions/router.mjs` through the Control Core — all three
  order the durable claim **before** any host/provider effect, so a failed durable write cannot deliver
  a host decision (I02: claim-failure ⇒ zero effect, caller gets non-`accepted`).
- **Kill / terminal-write failure (I03)**: an unpersisted terminal write marks the row `uncertain`
  (`isPending` false) — the claim is never released back to `pending`, so restart / numbered reply /
  auto-retry never replay the effect.
- **Multi-entry contention (I04)**: first durable settlement wins; a late settle from another entry
  (web / mobile button / numbered reply / action click) is rejected with `already_handled` /
  `already-resolved` and never flips the terminal state — at most one host effect.
- **Source mismatch (I01)**: cross-chat / cross-channel / cross-account replies neither settle nor
  consume the correct source's pending row (ownership gate stays fail-closed).
- **Live waiter ↔ ledger (H02)**: `bus.wait` (in-memory) and the durable ledger each keep their own
  fact; terminating one never resurrects the other, and a late settlement never revives a closed waiter
  — a remotely-approved wait returns the same decision to the desktop (`allowed-once`), not `desktop`.

**Tests**: `test/v015-stage-s9-claim-convergence.test.mjs` (12 cases) — I02 claim-failure zero-effect
(question + control receipt), I04 question/approval/action first-wins, I01 source mismatch (cross-chat
+ cross-channel), I03 uncertain-after-claim, and H02 terminal-set late settle. Assertions driven only
through production entries (`bus.accept` / `bridge.adminSettle` / `control.handle` / `dispatcher.dispatch`).

**Count**: 2257 → **2269**. Contract: `docs/behavior-contract.md` INT-06.

## T16 — 应用入口与 Recovery/CLI 同权威

**Result**: every application entry (Native RPC, Advanced Console / Recovery HTTP, CLI) now reaches the
**same authority** per operation. The entries only authenticate, map input shape, and map presentation —
they no longer hold a second writer or a duplicate business rule. Failure semantics stay separated:
a durable IO failure is `storage-failed` (never rewritten as `not-found`), and a query fails **closed**
when its service is missing instead of returning a plausible empty result.

- **Members authority convergence** (`src/control-plane/members.mjs`): the last-owner guard no longer
  keeps a lock-outside `ownerCount()` pre-check in the service — that was a **duplicate rule** that
  raced the identity write (TOCTOU, K03) and could zero out the owners. The guard now lives only inside
  `identity.mutateBinding`'s fresh transaction; the service just resolves the key and maps the input,
  passing identity's `owner-last` straight through. `storage-failed`/`owner-last`/`not-found` are
  preserved verbatim.
- **IO failure ≠ not-found** (`src/admin/api.mjs`): `putMember`/`deleteMember`/`confirmPendingMember`/
  `dismissPendingMember`/`revokePairingCode` now map `storage-failed` to **500** ("未落盘，已保留当前
  状态") instead of falling through to 404 — a failed durable write had been reported as "member does
  not exist", so the caller would misread it and stop retrying (I2/I16).
- **Native projection messages** (`src/control-surface/members.mjs`): a shared `reasonMessage` maps the
  service reason to a user-facing string so `storage-failed` never masquerades as "不存在"; the RPC
  error code is still `dsh-notifier/storage-failed`.
- **Query fail-closed** (`src/control-surface/service.mjs`): a new `requireRead` guard makes
  `members.list`/`members.pending`/`pairing.list`/`sessions.list`/`bindings.get` return
  `not-supported` when the backing service is absent — a missing service must not be indistinguishable
  from "no data yet" (U04「错/缺service不当空」).
- **Kept, not rebuilt**: the `saveInbound`/`removeInbound`/`mergeAccount` constructor fallbacks stay as
  documented pre-v0.13 compatibility shims (production always injects the canonical port, so they add
  no second writer); the Admin `getMembers` graceful-empty legacy contract is preserved for low-version
  public-API compatibility; `channels.mjs`/`sessions.mjs` shared services were audited and already
  surface `storage-failed` correctly through every entry.

**Tests**: `test/v015-stage-s10-entry-parity.test.mjs` (9 cases) — member/session/binding mutations
produce the same durable diff through the Native RPC and the Advanced Console over one shared store
(sibling fields preserved); IO failure on member update/remove, pending approve/dismiss, pairing revoke
and session overlay is `storage-failed` on the Native entry and HTTP 500 on the Admin entry (never
not-found); the five list/get queries fail closed with `not-supported` when the service is missing; and
the last-owner guard is single-sourced (Native `conflict` / Admin 422, no owner zeroing). The mock store
in the S1 suite was corrected to actually run the transaction mutator so an in-lock business abort is
honored even when the commit always fails.

**Count**: 2269 → **2278**. Contract: `docs/behavior-contract.md` ENT-01.

## T17 — legacy 退场与依赖检查

**Result**: the writer inventory (`docs/state-writer-registry.md`) is now a machine-checked fitness
function instead of a prose table, and the one remaining caller-less legacy write seam is gone. No
LOC/file-size KPI is chased, no reader that still serves an old format is deleted, and a `compat`-named
file is not treated as debt by name alone.

- **Caller-less write seam removed** (`src/control-plane/channels.mjs`): the `removeInboundFn` /
  `mergeAccountFn` constructor parameters had no production assembly and no test injection — the only
  real entry is the canonical inbound port. They are deleted; a missing capability now fails closed as
  `not-supported` instead of silently taking a second write path.
- **Doc/JSDoc parity**: `src/assembly/admin-token.mjs` and `src/assembly/inbound-signals.mjs` comments
  now name `setDurable` (the actual durable single-key write) instead of the raw `store.set` they had
  stopped using.
- **Fitness guard** (`test/v015-stage-s11-writer-fitness.test.mjs` + a new `<!-- writer-fitness:allowlist -->`
  block in the registry doc): the generic `store.set`/`store.delete` surface is confined to
  `src/inbound/store.mjs`; every durable-store writer must appear in the allowlist and no row may go
  stale; layer dependencies point one way (adapters/control-plane/control-surface never reach up into
  `admin/` or across into each other); and `src/index.mjs` is reachable only through the plugin entry.

**Tests**: `test/v015-stage-s11-writer-fitness.test.mjs` (5 cases).

**Count**: 2278 → **2283**.

## T18 — Native 保存/测试/加载状态

**Result**: the Native control surface now tells the truth about *which step* the user is at. Saving
and testing are separate operations with separate receipts, list reads distinguish "still loading" from
"failed" from "genuinely empty", and delivery evidence is graded so an accepted request is never shown
as delivery and an unconfirmable result is never shown as a hard failure.

- **Receipt vs refresh** (`client.js` controller `saveChannel`): the durable receipt is the commit
  result itself; the follow-up `channels.get` is a *separate* read whose failure is returned as
  `refreshed:false` and rendered as "saved, details refresh failed" — never rewritten as a save
  failure. `saveChannel`/`testChannel` are non-reentrant while busy (U02).
- **Save/test decoupling** (`SetupFlow`, `ChannelDetailView`): the form action is a plain **save**; the
  wizard can be completed with no test sent (U12). Testing is opt-in, targets only the *committed*
  config, and is disabled with an explicit reason while the form is dirty — no silent save+send (U03).
- **List tri-state** (`listBody`): `loading` (no response yet) / `error` (service or network failure) /
  `empty` (answered, nothing there); stale data is kept but timestamped. Applied to channels, tasks,
  questions, members, pending, pairing, sessions, bindings and activity (U04).
- **Evidence grading** (`testOutcome`): `confirmed` → delivered; `accepted` → "accepted, not confirmed";
  anything else → "could not confirm" with a concrete reason and an explicit no-auto-retry note
  (U08/U09). Dead `saveAndTest`/`testFailed`/`testAcceptedHint`/`testLater` strings removed.

**Tests**: `node test/dom/run.mjs` → **14 pass / 0 fail** (6 new T18 acceptance cases in
`test/dom/ui-dom-t18.test.mjs` + the two setup-flow cases updated for the save/test split). The DOM bed
stays out of the shipped `npm test` glob; `npm test` is unchanged at **2283**.
Contract: `docs/behavior-contract.md` UX-01…UX-04.

**Count**: unchanged at **2283** (DOM suite is a separate workspace, by design).

## T19 — Native 布局、表单与可访问性

**Result**: the Native surface is now usable with a keyboard, a screen reader and a phone. Form controls
are chosen from the field's *declared* schema instead of always being text boxes, an accidental exit can
be cancelled, and destructive actions state their impact before they run. Nothing here adds a second
authority or a UI framework — it is all presentation over the same shared services.

- **Stable direction sections** (`ChannelDirectionSection`, module-level): the outbound/inbound form used
  to be defined *inside* `ChannelDetailView`, so every parent poll produced a new component type and
  remounted the subtree — dropping focus and caret mid-typing. It is now a module-level component; the
  input DOM node survives state updates and poll re-renders (U05).
- **Schema-driven controls** (`SchemaField`): a field's declared `type` picks the control —
  `boolean`→checkbox, `enum`→select (with declared options), `number`→number input, `list`→textarea,
  else text. `src/config.mjs` now declares those types for the adapters that have them and
  `src/control-surface/channels.mjs` `fieldViews` passes type/options through as *presentation metadata*
  (never a business rule; undeclared types fall back to text). A configured secret is never echoed: it
  offers keep / replace / clear and shows no saved value (U06).
- **Leave-draft confirmation** (`SetupFlow`, `ChannelDetailView`): a dirty form arms a cancelable dialog
  before leaving; cancelling keeps the draft, only an explicit discard navigates away. Non-secret drafts
  live in `sessionStorage` (cleared on tab close); secret plaintext never touches any web storage (U07).
- **Pairing-code copy + manual fallback** (`copyText`, `PairingCodesView`): a copy action reports success
  only when it really copied; without clipboard capability it selects the one-time code and tells the user
  to copy manually — never a false "copied" (U10).
- **Nav layering** (`HomeView`, `NAV_DAILY`/`NAV_MANAGE`): daily work (questions/tasks/channels/activity)
  is one step away; the management surface (members/pending/pairing/sessions/diagnostics) is its own
  labelled, screen-reader-navigable group and stays fully reachable in Native — nothing is hidden in
  Recovery (U11).
- **Destructive-impact confirmation** (`ConfirmButton` `impact`, `MemberRow`): demote/remove arm first and
  name the subject and the consequence; only a second, explicit confirm writes; 4s idle or cancel falls
  back. Keyboard focus is visible via a scoped `:focus-visible` outline; theme tokens stay the Host's
  `.dsw-alias-*`/`.dsw-radius-*` variables (no hard-coded concept-art colors), with 320/390/768/1280px
  layouts covered by the responsive rules (U13).

**Tests**: `node test/dom/run.mjs` → **21 pass / 0 fail** (7 new T19 acceptance cases in
`test/dom/ui-dom-t19.test.mjs`). `test/client-module.test.mjs` static invariant updated to the refactored
secret-eviction shape (same property). DOM bed stays out of the shipped `npm test` glob.
Contract: `docs/behavior-contract.md` UX-05…UX-10.

**Count**: unchanged at **2283** (DOM suite is a separate workspace, by design).

## T20 — Recovery 纯恢复与诊断

**Result**: the Advanced Console is now a *recovery* surface with a first-class, read-only diagnostics view
that works **even when Native is not loaded**. It renders the same canonical snapshot Native uses — no second
collection path, no second authority, no repair-on-read — and every failure mode is stated honestly
(`501` when diagnostics is not assembled, `503` when the snapshot cannot be read; never an empty snapshot
posing as "all clear").

- **Shared diagnostics instance** (`src/index.mjs`): the Admin API is constructed with
  `diagnostics: surfaceDiagnostics` — the **very same** `createDiagnosticsService` instance the Native
  surface exposes. Recovery and Native therefore read one canonical snapshot (same redaction, same
  `unknown != failed` semantics); there is no duplicate collector and no duplicate fixer.
- **Read-only API** (`src/admin/api.mjs` `getDiagnostics`): returns `diagnostics.snapshot()` verbatim. It
  touches **no** store, opens **no** transaction, changes **no** runtime and replays **no** interaction. A
  missing capability throws `ApiError(501)` (fail-closed); a throwing snapshot throws `ApiError(503)`
  (never a false "healthy").
- **Route** (`src/admin/server.mjs`): `GET /api/diagnostics` behind the existing localhost Bearer gate —
  the Recovery console can read diagnostics with no Native in the process.
- **Recovery UI** (`src/admin/ui/markup.mjs` + `client.mjs` + `strings.mjs`): a "诊断" tab fetches the
  snapshot on open and renders attention/storage/host/channels/capabilities/recent-failures as read-only
  presentation. Client strings are `tr()`-sourced (zh/en same shape); no Chinese literal in `client.mjs`.
- **Report ≠ backup**: the Native support-report panel now says so explicitly
  (`reportNotBackup`) and points at configuration export/import for restoring an environment — a redacted
  read-only report must never be mistaken for a restorable backup.

**Boundaries held**: no `0.0.0.0` bind, no ticket in long-lived URLs, no direct remote exposure of the
Recovery console, no second authorization implementation, and no interaction replay during recovery.

**Tests**: `node --test test/v015-stage-s12-recovery-diagnostics.test.mjs` → **6 pass / 0 fail** (shared
canonical snapshot + read-only, zero-secret, `501` fail-closed, `503` on read error, HTTP route + auth).
Contract: `docs/behavior-contract.md` RC-01…RC-04.

**Count**: **2283 → 2289** (`npm test`, full suite green).

## T21 — 本地配置导出与导入

**Result**: configuration export/import is a single orchestration authority (`src/control-plane/config-portability.mjs`)
that moves **committed** channel configuration between environments without ever touching a secret. Native consumes it
via `portability.*` RPC; when the service is unassembled the surface fails closed (`501`, never an empty document
posing as "no config").

- **Export is public-only** (`exportConfig`): the document is a whitelisted, versioned
  `dsh-notifier-config`/`v1` JSON. Secret fields are omitted, token-bearing URLs have userinfo and secret-shaped
  query params stripped, and inline `ENV` references are not inlined — they are reported as `externalReferences`
  (kind `env`) with a `credentialDescriptors` entry marked `reference` instead of `supply`. A masked string can never
  round-trip as a value.
- **Import is strict + dry-run + staged** (`previewImport`/`commitImport`): a wrong document type/version, a reserved
  key (`__proto__`/`constructor`/`prototype`), oversized payload, or non-JSON content is rejected at parse time
  (zero write, zero fetch). The dry-run emits an add/patch/conflict/skip/unsupported plan; only explicitly selected
  rows are applied. New channels are staged **disabled** under an inert key domain the assembly never reads —
  import never activates a channel or sends a test; existing channels keep their enable state, and existing secrets
  are kept by default (explicit clear/replace follows the old contract).
- **Commit is one transaction** (`transactDurable`): cancel writes nothing; a failed staging write is reported
  honestly and leaves the original config intact; previews are bounded (TTL + cap) and evicted.
- **Single-entry accounting**: `portability.commit` advances `revision` once and records one activity per import,
  never once per channel (single-owner rule from T16).

**Boundaries held**: no `state.json`/claims/cursors export; no auto-enable/auto-test; no plaintext secret; no remote
fetch (a rejected file fetches nothing); import only writes the public fields present in the document.

**Tests**: `node --test test/v015-stage-s13-config-portability.test.mjs` → **12 pass / 0 fail** (E01 export-no-secret
+ env-reference separation, E02 round-trip except secrets/refs/disable rule, E03 reject bad type/version/proto-pollution
/oversize, E04 cancel-zero-write + idempotent re-import, E05 staging-write-failure preserves original, T21 readBack).
Contract: `docs/behavior-contract.md` PT-01…PT-03.

**Count**: **2289 → 2301** (`npm test`, full suite green: 2301 pass / 0 fail).

## T22 — dsh-im 可选投递桥

**Result**: the optional dsh-im delivery is an isolated **delegating bridge** (`src/control-plane/dsh-im-bridge.mjs`) — the
only module that touches the host's optional `ctx.dshIm` service. It holds no platform credential, makes no HTTP call,
copies no session/permission, and never guesses a bot prefix; it only delegates a user-selected, opaque
`(botId, targetId)` reference. Native consumes it via `dshIm.*` RPC; an unassembled bridge fails closed.

- **Dynamic availability** (`observe`/`status`): every operation re-reads `ctx.dshIm` defensively (via the T13 seam)
  instead of caching one object. Missing → `status().available:false` with `reason:'no-dsh-im'` (never a throw);
  late appearance / withdrawal / recreation are all visible. A monotonic **epoch** guards in-flight sends: a late result
  from a service withdrawn/recreated while a send was airborne is discarded as `unknown` (`reason:'epoch'`), never accepted
  (D01/D02).
- **Honest evidence** (`send`): `sent===true` → `accepted` (accept ≠ delivery; `confirmed:false`); `false`/`rejected →
  `rejected`; timeout/cancel/ambiguous → `unknown` — the request may already have been sent, so it is **never** blindly
  re-sent or re-routed to another provider (D04). `botId/targetId/text/options` pass through unmodified; the stable opaque
  id is never prefix-guessed (D03).
- **Text-only + no auto-switch** (`send`/`botOf`/`targetOf`): empty ref/body → `bad-request`; `media`/`interactive`/`card`
  options → `not-supported`; a removed/changed target is never substituted; list projections expose only
  `botId/label/platform` (or `targetId/label/kind`) and never leak credentials (D05).
- **Wiring** (`src/index.mjs` + `src/control-surface/service.mjs`): the bridge is built once with the real `ctx`/`warn`
  and injected as `dshIm`; the surface adds `dshIm.status/listBots/listTargets/send`. `send` records one activity row
  (single-owner accounting), a truthful `accepted ≠ delivered` title, and no auto-retry.
- **No durable key**: the opaque reference is caller/client-held desired (the bridge owns no store key); disabling the
  bridge leaves dsh-im's own targets and the notifier's own channels untouched.

**Boundaries held**: no forced dsh-im install, no unauthenticated public-HTTP path, no bot-prefix guess, no session/permission
copy, no blind resend fallback.

**Tests**: `node --test test/v015-stage-s14-dsh-im-bridge.test.mjs` → **12 pass / 0 fail** (D01 no-service, D02 late/withdrawn
/recreated + in-flight epoch isolation, D03 args pass-through + safe projection, D04 sent/timeout/cancel/error evidence,
D05 no auto-switch + text-only, plus surface wiring + unassembled fail-closed). Contract: `docs/behavior-contract.md`
DI-01…DI-03.

**Count**: **2301 → 2313** (`npm test`, full suite green: 2313 pass / 0 fail).

## T23 — dsh-im 已知格式迁移

**Result**: dsh-im known-format migration is a **pure translator + planner** (`src/control-plane/dsh-im-import.mjs`)
that reads a user-provided dsh-im bot export in one of the five locked formats and maps it onto the notifier's
existing outbound channels. It owns **no store key** and performs **no durable write of its own** — `commit` / `cancel`
delegate verbatim to the T21 portability authority, so the single-writer and secret-keep rules stay single-sourced.

- **Locked formats** (`FORMATS`): `feishu-legacy`→`feishu`, `qq`→`qq-bot`, `dingtalk`→`dingtalk`, `telegram`→`telegram`
  (each with a fixed `version` and `description`); `feishu-v2` (app-credential bot) has **no outbound equivalent** and is
  reported as `skip` + `bridge` (never a bot-prefix guess). Unknown `sourceType`/`format`/`formatVersion`, non-JSON, and
  over-size inputs fail closed with `bad-request` and **zero write** (D06).
- **Secret-source masking, never a value** (`classifySecret`): a secret field is reported by its *source* — `inline` /
  `env` (→ external reference with `name`, `requirement:'reference'`, `writable:true`) / `opaque` (`hs:/credential:/…`) /
  `masked` (`••…`)/`missing` — and never by its value. The translated document and the preview projection each omit the
  secret value, so no env ref is inlined and no plaintext/masked/opaque credential is copied (D07).
- **Live-waiter / membership facts never migrate** (`DROPPED_ROOT` + per-bot drop): `owner`, `approvedSenders`, `session`,
  `offset`, `loginContext`, `pendingAction`, `tempWebhook`, `idempotencyKey`, `chatRef`, `sessionId`, `platformRoute` are
  dropped on sight — no privilege elevation, no live waiter, no consumption cursor moves (D08).
- **No multi-account invention** (`translate` `seen` set): at most one candidate per notifier channel; extra bots for the
  same slot become reviewable `alternatives` (`reason:'duplicate-slot'`). An existing slot with a differing public config is
  a `patch` at the importer layer and a `conflict` (deselected by default) at the portability layer (D09).
- **Source read-only**: `detect`/`plan` parse the source string and never mutate it (two previews return identical mapping).
- **Wiring** (`src/index.mjs` + `src/control-surface/service.mjs`): the importer is built once over the shared `portability`
  authority (`createDshImImportService({ portability: surfacePortability, outboundConfig })`) and injected as `dshImImport`;
  the surface adds `dshIm.import.preview/commit/cancel`. It deliberately **never exposes the raw `detect` result** (which
  would carry the source document's plaintext); `commit` records one activity row and advances one revision (single-owner).

**Boundaries held**: no full-credential scan, no stopped-bot takeover, no auto owner, no offset/login-context migration, no
equivalent-platform bot suddenly bridged as "migrated"; unknown future schemas fail closed.

**Tests**: `node --test test/v015-stage-s15-dsh-im-import.test.mjs` → **14 pass / 0 fail** (D06 per-format locked mapping +
feishu-v2 bridge + unknown/mutated-source fail-closed, D07 inline/env/opaque/masked source classification with zero value
leak, D08 root + bot-level live-waiter key drop, D09 duplicate-slot alternatives + existing-slot conflict + disabled staging,
plus surface wiring + unassembled fail-closed). Contract: `docs/behavior-contract.md` MI-01…MI-03.

**Count**: **2313 → 2327** (`npm test`, full suite green: 2327 pass / 0 fail).

## T24 — 远程 URL 与手机入口

**Result**: remote entry is a **pure local translator + validator** (`src/control-plane/remote-url.mjs`) with **zero store key
and zero effect** — it canonicalizes a *user-supplied* HTTPS URL into an entry projection and refuses everything else, and
it never performs any network request, reachability probe, or DNS/connection check (so there is no SSRF / background-fetch
surface). `buildRemoteEntry` derives the QR payload from the **same** canonical string as the plain link (`qrPayload === url`),
so a QR and its plain link can never diverge (R04).

- **Reject matrix** (`validateRemoteUrl`, `reason ∈ empty | too-long | unparseable | no-tls | unsafe-scheme |
  embedded-credentials | no-host | contains-secret`): only `https:` is accepted — plain `http:` is rejected as `no-tls`,
  every other scheme (`javascript`/`ftp`/`file`/`data`/…) as `unsafe-scheme`, `userinfo` (embedded username/password) as
  `embedded-credentials`, and any query key matching an obvious secret-parameter name (`ticket`/`token`/`password`/`secret`/
  `access_token`/`api_key`/`signature`/`session`/`jwt`/…) as `contains-secret` — case-insensitive, narrow so ordinary params
  (`?tab=settings&page=2`) are never over-rejected.
- **QR ⇔ plain-link equivalence**: `buildRemoteEntry` returns `qrSupported:false` (the core claims no browser-side QR
  renderer) and `qrPayload === url`; a secret-bearing URL never reaches the entry projection.
- **No guessing**: the module deliberately never constructs a session URL / dynamic deep link; it only echoes and
  canonicalizes the address the user typed. Connection and permission are reported as separately-checkable concerns
  (`remoteHint`).
- **Wiring** (`src/control-surface/service.mjs` + `client.js`): the surface adds `remote.validate` (pure local parse,
  zero write, zero `revision.touch`); the Native `RemoteView` holds only user input + the validation result. Open/copy are
  browser-side actions; the error map (`REMOTE_URL_REASONS`) supplies stable, user-facing messages without leaking any
  secret.

**Boundaries held**: no probe of arbitrary intranet URLs, no background fetch validation (no SSRF), no Tunnel enable, no
change to Host trust; clearing the URL only affects this plugin's entry, never the network service.

**Tests**: `node --test test/v015-stage-s16-remote-url.test.mjs` → **13 pass / 0 fail** (R04 reject matrix incl. scheme/TLS/
credentials/secret-params/empty/over-length, QR⇔plain-link byte-equivalence, no-network + purity checks, plus `remote.validate`
surface wiring and unassembled fail-closed).

**Count**: **2327 → 2340** (`npm test`, full suite green: 2340 pass / 0 fail).

## T25 — 可选 Cloudflare Tunnel 扩展

**Result**: an **independent, default-disabled** extension (`extensions/cloudflare-tunnel/`) that supervises a
**user-managed `cloudflared` binary** it spawns itself. It owns no core store key and never touches Host trust.

- **Config gate** (`src/config.mjs`): named tunnel required, Quick Tunnel rejected (`quick-tunnel-stable`), a
  host-trust violation matrix (`clearOrigin`/`rewriteLocalhost`/`disableHostCheck`/…) rejected, and an Access
  protection claim without a configured `applicationId` rejected (`access-as-cleartrust`) — a protected flag can
  never be asserted into existence.
- **Supervisor** (`src/supervisor.mjs`): single-flight `start()` (concurrent calls share one spawn), a start
  deadline that kills only *its own* process, epoch isolation so late exit/error callbacks never revive a stopped
  instance, at most one reconnect timer with capped backoff, and stop-during-start that explicitly settles the
  in-flight promise (no hang, no leak).
- **Asset/redaction**: pinned-version assets fail closed while the checksum is unpinned; stdout/stderr are masked
  (`TUNNEL_TOKEN`/JWT/hex/base64 shapes) and bounded before they reach `status().recentLog`.

**Stability fix (this commit)**: `start()` used `promise.finally(...)`, whose derived promise was never consumed —
a rejected start surfaced as `unhandledRejection`. Replaced with `promise.then(clear, clear)` so both outcomes
settle cleanly (18/18 green).

**Tests**: `node --test test/v015-stage-s17-tunnel.test.mjs` → **18 pass / 0 fail** (R01 single-flight + deadline,
R02 epoch/no-revival/bounded reconnect/stop-during-start, R03 reject matrix, R05 assets fail-closed + redaction +
controller not-configured/disabled; deterministic fake process + fake timers, no real subprocess, no network).

**Boundaries held**: never downloads/executes an unverified binary, never auto-publishes the Host, never manages
another plugin's process, never erases Origin to widen trust, never proxies Recovery.

## T26 — Workers/Pages 通知扩展包（DEFERRED，待议）

**Decision (user, 2026-10-01)**: **不做**。Cloudflare Workers/Pages 扩展包本轮不实现，保留任务书
（`03-TASKS.md` T26 + 04 的 W01–W06 + 06 §Workers/Pages）作为将来讨论的输入，不在本 workstream 内落地任何
Worker/Pages 源码、wrangler 配置或部署包。恢复讨论时按原依赖（T22/T24）重新评估。

**不影响**：本地 CORE 与本扩展包完全独立；`extensions/cloudflare-tunnel`（T25）是本地进程监督，与本项无关，
已交付。因此 T28–T30 的收尾不受此决定阻塞。

## T27 — 云端保存窄接口（预留契约）

**Result**: a **contract, not a feature**（`src/control-plane/cloud-store.mjs`）。只定义「存放已经生成好的
bytes」的窄接口：`put(bytes, metadata)` / `get(id)` / `delete(id)` / `capabilities()`，schema
`dsh-notifier-cloud-store/v1`，失败码稳定（`bad-bytes`/`too-large`/`bad-metadata`/`bad-id`/`not-found`/
`storage-failed`/`cancelled`/`not-configured`）。

- **不透明**：store 绝不 parse / decode / validate / interpret 业务含义（不知道什么是导出 v1）；
  未知格式既不 recognize 也不 reject，原样搬运。字符串 payload 刻意拒绝——编码是调用方的解释决定。
- **无业务权限**：cloud adapter 不读/不写插件 state、不持有 mutation 权限；它失败不影响本地导出与下载。
- **两种内置实现**：`createMemoryCloudStore()`（round-trip + 错误注入 fixture，可注入 `now`/`random`/
  `failPut`/`failGet`/`failDelete`）与 `createUnavailableCloudStore()`（未装配 provider 的诚实占位，
  一律 `not-configured`，`capabilities().available === false`）。
- **无生产实现**：不接 R2/D1/KV、不要求 CF 账户、**Native 无云按钮**、不新增业务 authority。
- **未来决策已写文档**：加密属导出层、密钥与云账户互相独立、真实 adapter 只是同一契约的可替换实现、
  加密全量备份是另一个独立格式（普通配置导出永久**不是**灾难恢复快照）。

**Tests**: `node --test test/v015-stage-s18-cloud-store.test.mjs` → **10 pass / 0 fail**（G01：byte round-trip +
导出 v1 round-trip 逐字节一致、未知 bytes 原样搬运且 store 无 interpret 面、copy-on-write、字符串/超限/
畸形 metadata 拒绝且零写、abort 零写、注入失败不影响本地导出、无 cloud binding 仍可运行）。

**Boundaries held**: 不解释业务数据、不获得 state 写权、不引入账户/同步/云按钮、不收紧旧 provider 的
原有合法 payload 范围。

## T28 — 全用户周期文档

**Result**: `docs/user-lifecycle.md` 串起九段真实旅程（安装 → 首次保存 → 复用/迁移 → 日常问题与审批 →
手机入口 → 断线/健康 → 升级 → 导出换机 → 停用/卸载），每段给出**实际存在的命令**与**可观察结果**，
并显式声明两件承重事实：**导出不含密钥**、**外部引用（ENV / 机器特定）不会被导入迁移、需重新绑定**。
教程与截图对应当前 Native「通知与控制」，不使用旧管理台截图冒充 Native。

**Tests**: `node --test test/v015-stage-s19-lifecycle-docs.test.mjs` → **5 pass / 0 fail**（L01：文档里每条
`node scripts/*.mjs` 都真实存在且通过 `--check`；每条 `npm run <script>` 都是真实 script；每个相对链接都
解析到真实文件；九段旅程与两条承重声明确实存在）。

**Boundaries held**: 真实手机 / 真实账号 / 真实 provider 回执证据**不**在默认 CI 范围（文档已声明，
继续 open），文档不承诺未发布能力（能力口径以兼容性矩阵为准）。

## T29 — 等价 / 回退 / 性能演练

**Result**: 把「迁移等价」与「回退安全」变成可执行证据，而不是口头保证。

- **等价矩阵（全 28 型）**：每个出站渠道类型的 legacy → canonical 迁移都被**分类**（`copied-from-admin`
  / `copied-from-account` / `dual-domain-kept` / `canonical-wins`），逐型比对声明规则，**零未解释差异**；
  旧 `admin:channel:<type>:outbound` 域一律退场；重复迁移是 byte-stable no-op。
- **回退演练**：在切换窗口内经新权威写入的配置与成员，经过一次迁移后仍然保留；canonical 键是共享读路径，
  重新装配的 reader 解析出同一份有效配置。
- **不重放**：`claimed` 与 `uncertain` 行在重启/回退后都不是 live pending，`claim`/`resolve`/`terminate`
  全部拒绝重放（零二次 effect）。
- **写放大**：一次用户动作 = 一次 durable 事务（1:1），1/10/100 阶梯每个 bucket 放大倍数恒为 1。

**Tests**: `node --test test/v015-stage-s20-equivalence-rollback.test.mjs` → **7 pass / 0 fail**。

**Runner**: `node scripts/perf-drill.mjs`（仓库内维护者命令，**不进 npm 包**，`--json` / `--ladder=1,10,100,500`）。
本机实测：`1/10/100` saves → transacts/commits = 1/10/100（amplification = 1.000），
100 saves 60.7ms（0.607 ms/save）；首轮冷 FS 观测到 ~97 ms/save，属环境抖动，绝对毫秒只用于趋势对比。

**Boundaries held**: 演练只跑本地 CPU/磁盘，零网络；差异分类全部来自声明规则，没有"看起来一样就算了"
的未解释差异；回退不重放 claim/uncertain。

## T30 — 最终全量 / 打包与交付

**Result**: 全量门 + 计数收口 + 打包。

- `npm test`：**2358 → 2380**（2380 pass / 0 fail / 0 skip）。
- `npm run verify:release`、`node scripts/gen-channel-matrix.mjs --check`、
  `node scripts/verify-host-compat.mjs`、`node --check src/index.mjs` 全绿。
- 计数同步：`package.json` `dshQuality.testCount`、`README.md`、`README.zh-CN.md`、`HANDOFF.md`、
  `docs/memory/project-state.md`。
- `CHANGELOG.md` 增补 v0.15（Unreleased）条目；T26 决定记录在案。
- 交付包：`npm pack` 产物 + 源码树（不含 secret / 账户 ID / 真实域名）。

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
| T11 | done | `c290f64` | all-28 provider contract matrix + full sender registration + credential field-merge convergence; `test/v015-stage-s5-provider-migration.test.mjs` → 15 pass |
| T12 | done | `7735d68` | accepted/delivered/unknown buckets + bounded (cap+TTL) + runtime-epoch health closure; `test/v015-stage-s6-delivery-evidence-health.test.mjs` → 11 pass |
| T13 | done | `3bcb6c2` | centralized host seam + Cordis lifetime + capability-aware native questions; `test/v015-stage-s7-host-seam.test.mjs` → 14 pass |
| T14 | done | `93c6e62` | `route:sessions` single transactional writer; `test/v015-stage-s8-routing-convergence.test.mjs` → 6 pass |
| T15 | done | `66d9b77` | shared claim boundary across actions/approval/questions; `test/v015-stage-s9-claim-convergence.test.mjs` → 12 pass |
| T16 | done | `97d5f7c` | every entry shares one authority; storage-failure never rewritten as not-found; query fails closed; `test/v015-stage-s10-entry-parity.test.mjs` → 9 pass |
| T17 | done | `dc9410a` | caller-less write seam removed; writer inventory is a machine-checked fitness guard; `test/v015-stage-s11-writer-fitness.test.mjs` → 5 pass |
| T18 | done | `4ea06ea` | save receipt ≠ refresh; save/test split (no implicit send); list tri-state; evidence grading; `node test/dom/run.mjs` → 14 pass |
| T19 | done | `843fd12` | module-level stable form sections (no focus loss); schema-driven controls + secret keep/replace/clear; leave-draft confirm; pairing copy w/ manual fallback; nav layering; destructive-impact confirm; `node test/dom/run.mjs` → 21 pass |
| T20 | done | `6d51a60` | Recovery reads the shared canonical diagnostics snapshot (no second collector); read-only; 501 unassembled / 503 read-error; `GET /api/diagnostics` behind localhost auth; report ≠ backup; `test/v015-stage-s12-recovery-diagnostics.test.mjs` → 6 pass |
| T21 | done | `39f042f` | config export/import single authority; public-only export (no secret / URL token / ENV ref inlined); strict parse + dry-run + staged-disabled import; one-transaction commit; cancel/fail zero-write; `test/v015-stage-s13-config-portability.test.mjs` → 12 pass |
| T22 | done | `2068af2` | optional dsh-im delegating bridge; dynamic availability + epoch isolation (D01/D02); honest accepted/unknown evidence (D03/D04); text-only + no auto-switch + no credential leak (D05); `test/v015-stage-s14-dsh-im-bridge.test.mjs` → 12 pass |
| T23 | done | `165efd1` | dsh-im known-format migration importer (pure translator over T21 portability); locked formats + feishu-v2 bridge + unknown fail-closed (D06); secret-source masking with zero value leak (D07); live-waiter/membership keys dropped (D08); duplicate-slot alternatives + conflict + disabled staging (D09); `test/v015-stage-s15-dsh-im-import.test.mjs` → 14 pass |
| T24 | done | `3e5a694` | remote URL / phone entry (pure local validator, zero store key / zero effect); https-only + reject matrix (R04); QR payload byte-identical to plain link; no SSRF / no deep-link guessing; `remote.validate` surface + `RemoteView` (open/copy browser-side); `test/v015-stage-s16-remote-url.test.mjs` → 13 pass |
| T25 | done | `acf821c` | optional pinned cloudflared supervisor (single-flight start + epoch isolation + bounded reconnect + redacted logs + fail-closed asset pin); default-off, user-managed binary only; `test/v015-stage-s17-tunnel.test.mjs` → pass |
| T26 | deferred | — | user decision 2026-10-01: Workers/Pages extension package **not built**; task book kept as future discussion input |
| T27 | done | (this commit) | cloud-store narrow contract (`put`/`get`/`delete`/`capabilities()`), schema `dsh-notifier-cloud-store/v1`; memory fake + unavailable placeholder; no prod impl / no cloud button; `test/v015-stage-s18-cloud-store.test.mjs` → 10 pass |
| T28 | done | (this commit) | nine-journey user lifecycle doc; commands/links machine-checked; `test/v015-stage-s19-lifecycle-docs.test.mjs` → pass |
| T29 | done | (this commit) | equivalence / rollback / no-replay drills + `scripts/perf-drill.mjs` (amplification = 1); `test/v015-stage-s20-equivalence-rollback.test.mjs` → pass |
| T30 | done | (this commit) | full `npm test` 2380/2380; verify:release + matrix + host-compat + perf all green; counts synced; `npm pack` deliverable |