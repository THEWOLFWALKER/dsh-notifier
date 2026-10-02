# 目标契约 → 现有 dev 符号映射（U01）

本表把交接包 `contracts/target-contracts.d.ts` 的**目标内部类型**映射到当前
`dev@c890d2c` 的实际符号。目标契约是设计目标，**不等于**仓库已存在这些接口。
本表只做接线判定，不改行为；每行的“差距/动作”就是对应工作包的实施起点。

判定口径：现有代码以 `createXxx()` 工厂 + 普通对象返回为主，目标契约多为 `interface` 类型
说明——接线时优先扩展现有工厂的返回形状，不新增第二套 authority。

## 1. Store 与状态

| 目标契约 | 现有符号 | 位置 | 差距 / 动作（工作包） |
|---|---|---|---|
| `StateStore`（`read`/`readMany`/`transact`(async)/`inspect`） | `createStore()` 返回同步面 `{ bootStatus, backup, get, transact, set, delete, deleteDurable, keys, size, sweepPrefix }` | `src/inbound/store.mjs:58` | 缺 `read`/`readMany`/`inspect`；`transact` 为同步；需新增并迁移调用链（WP01） |
| `StoreTrust`（`ready`/`missing`/`corrupt`/`busy`/`recovery-required`） | `bootStatus().status` ∈ {`ready`,`unavailable`,`corrupt`} | `src/inbound/store.mjs:366` | 需扩 `missing`/`busy`/`recovery-required`；`busy` 现为锁超时返回码（WP01） |
| `CommitReceipt`（`commitState`/`revision`/`durability`/`requestId`） | `transact()` 返回 `{ ok, committed, durable, code, value }` | `src/inbound/store.mjs:344` | 需新增 `commitState`（committed/unchanged/rejected/indeterminate）、`revision`、`durability` 枚举；`rejected` 与 `indeterminate` 现未区分（WP01） |
| `Snapshot`（value/exists/storeRevision/rowRevision） | 无 | — | 新增（WP01） |
| `Draft`（read/put/remove/appendAudit） | mutator 收到 detached 普通对象 `draft` | `src/inbound/store.mjs:329` | 需加 `read`/`put`/`remove`/`appendAudit` 形状与 `expectedRowRevision`（WP01/WP13） |
| 兼容 helper：`setDurable`/`mergeDurable`/`transactDurable`/`transactOutcome`/`deleteDurable` | 同名函数 | `src/inbound/store.mjs:468,492,509,546,590` | 保留旧语义；新 async 事务落地后统一 await 化，旧同步写入口显式报 unsupported（WP01） |
| secret field `generation` / tombstone | 无（Top） | `src/security/secret-patch.mjs:14`（`splitSecretPatch` 仅拆分） | 新增 generation/ABA 检测（WP13），并与 store row revision 打通 |

## 2. 身份、访问与目标

| 目标契约 | 现有符号 | 位置 | 差距 / 动作 |
|---|---|---|---|
| `Principal`/`ConversationRef`/`AccountRef`（含稳定 `accountId`） | 身份为 `(channel, userId)` 绑定 | `src/inbound/identity.mjs`（writers 见 core-distillation 清单） | 需贯穿稳定 `accountId`；禁止 account-blind 键（WP02） |
| `AccessContext`（`actorId`/`origin`/`scopes`/`principal?`/`verified:true`） | 控制契约 + 服务入口 | `src/control/contract.mjs:47`、`src/control/entry.mjs`、`src/control/session-arbiter.mjs`、`src/control-surface/service.mjs:112` | 服务端身份注入、payload 自报 role 一律不信任（WP03） |
| `TargetRef`（`targetId`/`kind`/`targetRevision`） | `guardTargets`/`resolveNotifyTargets`/`feishuP2pEquivalent` | `src/inbound/target-guard.mjs:85,128,65` | 需加 `kind` 与 `targetRevision`；私聊证明仅在有来源证据时成立（WP07/WP18） |
| `PrivateEnvelope`/`AdmissionResult`/`SourceProof` | inbound 归一与 bus | `src/inbound/message.mjs`、`src/inbound/bus.mjs`、`src/inbound/callback-refs.mjs` | 私聊准入 fail-closed；群/未知不触发业务（WP07） |

## 3. 交互、投递与运行时

| 目标契约 | 现有符号 | 位置 | 差距 / 动作 |
|---|---|---|---|
| `InteractionRecord`/`ClaimToken`/`InteractionService`（claim/settle/terminate/patchMetadata） | `createInteractionLedger()` | `src/interaction/ledger.mjs:42` | claim 的 `actor` 形状、终态不可倒退、崩溃后 uncertain 不重试（WP04） |
| `DeliveryAttempt`/`DeliveryResult`/`DeliveryService`（send/flush） | `createNotifier()` | `src/notify.mjs:23` | 需 `outcome` 枚举、`retryAdvice`、逐目标 evidence；`flush` 现无（WP06） |
| evidence 归一 | `isConfirmedReceipt`/`normalizeDeliveryEvidence` | `src/delivery-evidence.mjs:16,27` | accepted/confirmed/unknown/failed/skipped/partial 语义对齐（WP06） |
| `RuntimeView`/`RuntimeManager`/`RuntimePermit`/`RuntimeObservation` | `createRuntimeChannelManager()` | `src/runtime/channel-manager.mjs:10` | epoch 只在新实例递增；permit/准入/异步 dispose（WP05） |
| outbound runtime truth | `createOutboundSource()` | `src/runtime/outbound-source.mjs:113` | 撤证后关闭新准入、旧结果不刷绿新 epoch（WP05/WP06） |

## 4. 配置、导入导出与云

| 目标契约 | 现有符号 | 位置 | 差距 / 动作 |
|---|---|---|---|
| `ConfigView`/`ConfigChange`/`ConfigService` | `createControlSurfaceService()` | `src/control-surface/service.mjs:112` | secret generation、row revision、保存/应用分离（WP13） |
| `SecretOp`/`SecretState` | `splitSecretPatch` | `src/security/secret-patch.mjs:14` | keep/replace/clear 判别联合 + expected generations（WP13） |
| `ImportPreview`/`PortabilityService` | `createConfigPortabilityService()` | `src/control-plane/config-portability.mjs:169` | previewId/expiresAt 服务端保存、跨域全或无、ABA（WP13） |
| `CloudJob`/`CloudResource`/`CloudService` | `createCloudflareDeploymentService()` | `src/cloudflare/deployment.mjs:12` | 持久步骤日志、readback 恢复、`cancel-requested` 等 exit（WP14） |
| `BindingReceipt`/`UnbindReceipt`/`FieldUndo` | `createBindingsProjection()` + deployment 绑定 | `src/control-surface/bindings.mjs:102` | field revision 条件恢复、删除 D1 不是解绑副作用（WP15/WP16） |
| `SurfaceDomain`（freshness） | control-surface revision | `src/control-surface/revision.mjs` | 分域 freshness（WP19） |

## 5. 渠道元数据与能力证据

| 目标契约 | 现有符号 | 位置 | 差距 / 动作 |
|---|---|---|---|
| `ChannelMeta`/`CapabilityProof` | `capabilitiesOf`/`displayNameOf`/`OUTBOUND_CHANNELS`/`CHANNEL_CAPABILITIES` | `src/inbound/capability-matrix.mjs:200,97,234,135` | 需 `proofs` 四态（implemented/contractTested/providerAccepted/deviceRendered）；Logo/排序/中文标签（WP19） |
| 入站渠道全集 | `INBOUND_CHANNELS`/`INBOUND_CHANNEL_SET` | `src/inbound/channels-registry.mjs:12,22` | 群退出后能力目录由实际清理结果生成，不固守“28”（WP07/WP19） |

## 未决与风险（U01 遗留）

- 目标契约的 `Problem`/`Result<T>` 错误模型与现有 `makeReceipt(status,…)` 形状是否统一，未在源码逐调用点核对。
- `RuntimePermit` 与现有 session-arbiter / launch-ticket 的关系需在 WP03/WP05 落点确认，避免两套准入。
- `CommitReceipt.indeterminate` 的 requestId 读回裁决需要 store 持久化事务标记，现无对应记录——属 WP01 新增能力。

以上三项在对应工作包开工时以源码复核为准；本表不假设任何一项已经存在。