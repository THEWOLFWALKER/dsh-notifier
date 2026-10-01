# 行为契约索引（v0.15 core distillation）

本文件是 **T02「行为契约与旧 oracle」** 的交付物：把**现有系统**已经成立的行为固化成可索引的
spec 条目，并为每条标注**旧代码 oracle**（现有 `test/` 或 `src/` 中可复现该行为的权威来源），
使后续重构任务（T04–T17）可以用「同一输入 → 同一 durable diff / effect trace」证明等价。

> 规则：运行时真相是 `src/` 与 `test/`。本文件不新增行为，只**索引已有行为**。文档与源码冲突时，
> 以源码和测试为准，并在同一变更里修文档。

## 字段说明

每条 spec 含以下字段：

| 字段 | 含义 |
|---|---|
| `ID` | 稳定标识，前缀按域：`CFG` 配置 / `MEM` 成员 / `RT` 路由 / `INT` 交互 / `PRV` provider / `HST` Host seam / `MIG` migration |
| `分类` | 五选一：`MUST_PRESERVE` / `BUG_FIX` / `SECURITY_FIX` / `UNKNOWN` / `OBSERVATION_ONLY` |
| `事实 owner` | 当前唯一（或登记已知多写者）的生产写入模块 |
| `适用版本` | 该行为已成立的版本区间 |
| `输入/前置状态` | 触发该行为的输入与磁盘前置状态 |
| `公开执行入口` | 用户/上层可触达的真实入口（API/服务/装配），不是内部函数 |
| `结果` | 公开返回值/状态语义 |
| `durable diff` | 对 `store` 键/行的预期变化（无变化即关键断言） |
| `effect trace` | 外部副作用（provider 调用 / Host effect / handler）计数 |
| `禁止动作` | 明确不得发生的行为（重构红线） |
| `证据链接` | 指向 `test/` 或 `src/` 的 oracle |
| `旧 test 映射` | 对应的旧测试文件（即「旧 oracle」） |

**分类约定**

- `MUST_PRESERVE`：重构必须逐字保持的行为。
- `BUG_FIX` / `SECURITY_FIX`：**必须**写「旧表现 + 新预期 + 理由」；旧 bug 不作为永久 golden。
- `UNKNOWN`：仓内**没有**可复现 oracle；**不得**上调为 `MUST_PRESERVE`，需外部证据。
- `OBSERVATION_ONLY`：只作观察/投影，不构成业务事实。

必测矩阵 ID（`K01–K06` / `C01–C05` / `I01–I04` / `H01–H03` / `M01–M03` / `P01–P04`）来自
`04-ACCEPTANCE-AND-REVIEW.md`；下图给出本文件到矩阵的映射。

---

## 一、配置 config

事实 owner：出站 `control-surface/outbound-config.mjs`（canonical 键 `channel:<type>:outbound`）；
入站 `inbound/channel-config.mjs`（`<type>:account` / `channel:<type>:…`）；迁移
`control-surface/channel-config-migration.mjs`。多写者键已在 T01 writer inventory 登记，属 T08 收敛目标。

### CFG-01 · 同 key 不同字段 patch 保留兄弟字段（inbound / outbound）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/inbound/channel-config.mjs`（put）、`src/control-surface/outbound-config.mjs`
- **适用版本**：v0.14 起（Stage B 事务内 draft 合并）
- **输入/前置状态**：同 key 已存在其它字段；两写者并发对一个 key 写不同字段
- **公开执行入口**：`createInboundChannelConfigPort().put()` / `createOutboundConfigService().put()`
- **结果**：`{ saved: true }`，两字段并存
- **durable diff**：该 key 行同时含本次 patch 与并发写者字段（不被整对象覆盖）
- **effect trace**：无外部 effect
- **禁止动作**：不得用事务外旧 snapshot 整对象回写；不得丢弃 sibling
- **证据链接**：`test/v014-stage-b-persistence-tx.test.mjs:187`（inbound）、`:233`（outbound）、
  `:205`（clear 与兄弟 patch 并存）；实现 `src/inbound/channel-config.mjs`
- **旧 test 映射**：`v014-stage-b-persistence-tx.test.mjs`（B5/B6）
- **矩阵**：**K02**

### CFG-02 · 写盘失败语义（storage failure）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/inbound/store.mjs`（`transact` / `setDurable`）
- **适用版本**：v0.12.1 起
- **输入/前置状态**：父路径被普通文件占用 / rename 失败 / mutator 抛错 / 持锁超时
- **公开执行入口**：`createStore().set()` / `.transact()`
- **结果**：失败返回 `false`（或 `{ ok:false, code }`），**不抛、不静默吞、不谎报成功**
- **durable diff**：memory 与 disk 均保持原样（零 publish）
- **effect trace**：零外部 effect
- **禁止动作**：失败不得变 `not-found`/`empty`；`false` 不得被当作 abort 误推成功
- **证据链接**：`test/store.test.mjs:24`（set 落盘失败）、`:34`（mutator 失败 draft 不发布）、
  `:51`（锁超时 `STATE_BUSY` 不 unlocked write）；实现 `src/inbound/store.mjs`
- **旧 test 映射**：`store.test.mjs`、`durable-primitives-v0121.test.mjs`
- **矩阵**：**K01 / K05**

### CFG-03 · 冻结的 resolved 配置经真实装配发送

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/runtime/outbound-source.mjs`（live 对象与冻结投影分层）
- **适用版本**：v0.14 起（Stage A，`2978f31`）
- **输入/前置状态**：resolved config 经 `OutboundSource` 装配后交给 adapter
- **公开执行入口**：`createOutboundSource([{ type, config: resolved }])` → `liveEntries()`/`notifier`
- **结果**：live runtime 对象**不冻结**且可扩展，adapter 可惰性写；`snapshot()/get()` 才是冻结投影
- **durable diff**：无（运行期对象）
- **effect trace**：真实装配下 provider 发送成功
- **禁止动作**：不得 JSON-clone + deep-freeze live 配置；投影不得泄漏 adapter 私有运行态字段
- **证据链接**：`test/runtime-mutability-v014.test.mjs:47`（qq-bot live）、`:90`（端到端发送）、
  `:145`（投影冻结）、`:164`（投影剔除私有字段）
- **旧 test 映射**：`runtime-mutability-v014.test.mjs`
- **矩阵**：**C01**

### CFG-04 · 深冻结出站配置导致发送失败（BUG_FIX）

- **分类**：BUG_FIX
- **事实 owner**：`src/runtime/outbound-source.mjs`
- **适用版本**：修复于 v0.14（Stage A `2978f31`），修复前 ≤ v0.13.1 为缺陷
- **输入/前置状态**：v0.12 出站源对 resolved config 做 JSON 克隆 + deep-freeze
- **公开执行入口**：qq-bot / wecom-app 出站发送
- **结果**：修复后 live 对象可写，发送成功
- **durable diff**：无
- **effect trace**：修复前 0 次成功投递（写入抛 `TypeError`）；修复后正常投递
- **禁止动作**：不得把冻结对象当 live 配置使用
- **旧表现**：`OutboundSource` 复制并深冻结 resolved adapter config（issue #45/#46），adapter 惰性
  写 `_tokenManager/_rateGate/_msgSeq` 抛错 → qq-bot/wecom-app 发送失败。
- **新预期**：live runtime 对象与冻结投影分离；`.snapshot()/.get()` 冻结，live 可扩展。
- **理由**：token/seq 缓存必须落在稳定 live 对象上，否则资源型 adapter 无法工作。
- **证据链接**：`test/runtime-mutability-v014.test.mjs:127`（负向对照：冻结即发送失败）、
  `:47`/`:90`；issue #45/#46
- **旧 test 映射**：`runtime-mutability-v014.test.mjs`
- **矩阵**：**C01**

### CFG-05 · secret patch 契约：空白保留 / 非空替换 / 显式清空删除

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/control-surface/outbound-config.mjs`、`src/inbound/channel-config.mjs`
- **适用版本**：v0.13 起
- **输入/前置状态**：已有 secret 字段；patch 传空白 / 新值 / 显式 clear
- **公开执行入口**：outbound/inbound config service 的 put
- **结果**：空白保留旧值；非空替换；显式清空删除
- **durable diff**：仅目标 secret 字段变化，兄弟字段保留
- **effect trace**：无
- **禁止动作**：不得把空白当删除；不得泄露 secret 到日志/错误/diagnostics
- **证据链接**：`test/channel-config-migration-v013.test.mjs:155`（outbound）、`:173`（inbound）、
  `:189`（诊断不含配置值）
- **旧 test 映射**：`channel-config-migration-v013.test.mjs`
- **矩阵**：**C02**

### CFG-06 · canonical 出站键唯一权威（Admin 关闭不得复活旧 overlay）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/control-surface/channel-config-migration.mjs`（迁移）、
  `src/runtime/outbound-source.mjs`（读取）
- **适用版本**：v0.13 起
- **输入/前置状态**：存在旧 `admin:channel:<type>:outbound` 与 `<type>:account`
- **公开执行入口**：启动迁移 + 运行期出站装配
- **结果**：legacy 出站一次性复制到 `channel:<type>:outbound` 后删除旧键；运行期不读 legacy
- **durable diff**：新增/更新 `channel:<type>:outbound`；`admin:channel:<type>:outbound` 被移除
- **effect trace**：无
- **禁止动作**：Admin 关闭不得从旧 overlay/ENV/YAML 复活；dual-domain 入站 `feishu:account` 不得被
  当作 outbound 迁移
- **证据链接**：`test/channel-config-migration-v013.test.mjs:22`
- **旧 test 映射**：`channel-config-migration-v013.test.mjs`、`config-runtime-truth-v013.test.mjs`
- **矩阵**：**C02**

---

## 二、成员 members

事实 owner：`src/control-surface/members.mjs`（服务层）→ `src/inbound/identity.mjs`（唯一持久 writer）。

### MEM-01 · 末位 owner 不变式（last-owner）

- **分类**：SECURITY_FIX
- **事实 owner**：`src/control-surface/members.mjs` + `src/inbound/identity.mjs`（同一锁内 check+write）
- **适用版本**：v0.14 服务归一后
- **输入/前置状态**：仅剩一名 owner；请求将其降权或移除
- **公开执行入口**：`createMembersControlService().updateMember()/removeMember()`
- **结果**：`{ ok:false, reason:'owner-last' }`；两入口（Native/Recovery/命令）结果一致
- **durable diff**：不变
- **effect trace**：无
- **禁止动作**：不得让 owner 数降到 0；不得锁外判断后锁内写
- **旧表现**：服务层可能先读快照判定 owner-last 再写，或直接 mutation 绕过守卫 → 最后 owner 可被
  降权/移除，造成组织锁定。
- **新预期**：last-owner 判定与 update/remove 在同一 fresh 事务内；底层直接 mutation 也守不变式。
- **理由**：防止不可逆的管理面自锁（安全不变式）。
- **证据链接**：`test/members-control-service-v014.test.mjs:156`；实现 `src/control-surface/members.mjs`
- **旧 test 映射**：`members-control-service-v014.test.mjs`
- **矩阵**：**K03**

### MEM-02 · storage-failed 不得被改写成 not-found

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/control-surface/members.mjs`（透传底层 reason）
- **适用版本**：v0.14 起
- **输入/前置状态**：成员更新/删除时落盘失败
- **公开执行入口**：members service 写操作
- **结果**：`storage-failed`（底层 reason 透传），不报 `not-found`
- **durable diff**：不变
- **effect trace**：无
- **禁止动作**：不得把 IO 失败伪装成「成员不存在」
- **证据链接**：`test/v014-stage-b-persistence-tx.test.mjs:75`（B1）、
  `test/members-control-service-v014.test.mjs:83`（pending→member 原子）、`:111`（真实落盘失败）
- **旧 test 映射**：`v014-stage-b-persistence-tx.test.mjs`、`members-control-service-v014.test.mjs`
- **矩阵**：**K01 / K05**

### MEM-03 · 绑定读盘防御（坏形状丢弃 / 坏字段回退默认）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/inbound/identity.mjs`
- **适用版本**：v0.10+ 起，v0.13 强化（G-44）
- **输入/前置状态**：`inbound:bindings` 含坏形状行 / 非法 channel / 非法 role
- **公开执行入口**：`createIdentity({ store })` 读盘
- **结果**：坏形状/非法 channel 整条丢弃；非法 role 回退 `member`；不复活已删成员
- **durable diff**：启动清洗时死键移除写回（warn 计数）
- **effect trace**：无
- **禁止动作**：不得由损坏 state 重新 bootstrap owner；不得半写 marker
- **证据链接**：`test/identity.test.mjs:166`（读盘防御）、`:87`（G-44 清洗）、
  `:112`（全坏键不复活）、`:45`（迁移一次性播撒）
- **旧 test 映射**：`identity.test.mjs`
- **矩阵**：**M01 / M02**

### MEM-04 · pending → binding 原子提升

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/inbound/identity.mjs`
- **适用版本**：v0.14 起
- **输入/前置状态**：`inbound:pending` 有可确认条目，提升为正式绑定
- **公开执行入口**：配对/确认流程（bus / pairing）
- **结果**：成功两键同事务提交；失败 pending 与 bindings 均原样
- **durable diff**：pending 删除 + bindings 新增，同一事务
- **effect trace**：无
- **禁止动作**：不得半提交（删了 pending 无 binding，或反之）
- **证据链接**：`test/identity.test.mjs:253`（confirmPending 事务失败保持原样）、
  `test/members-control-service-v014.test.mjs:83`
- **旧 test 映射**：`identity.test.mjs`
- **矩阵**：**K04**

### ENT-01 · 应用入口同权威（Native / Recovery / CLI 单一 writer）

- **分类**：MUST_PRESERVE
- **事实 owner**：identity（成员）/ agent-router + session-registry（路由）/ outbound-config +
  inbound channel-config（渠道）——由共享 control-plane service 编排，入口只鉴权/输入映射/表现映射
- **适用版本**：v0.15 起
- **输入/前置状态**：同一操作经 Native RPC / Advanced Console（Recovery HTTP）/ CLI 发起；
  落盘失败；查询时 backing service 缺失
- **公开执行入口**：`createControlSurfaceService().call()`、`createAdminApi()`、
  `createMembersControlService()` / `createRoutingControlService()`（共享单例）
- **结果**：同操作多入口落到**同一权威键**、durable diff 逐字一致（字段级合并、兄弟字段不丢）；
  IO 失败一律上报 `storage-failed`（Native RPC `storage-failed`、Admin HTTP 500），绝不伪装成
  `not-found`；查询在能力缺失时 fail-closed（`not-supported`），绝不返回 `ok:true` 的空表
- **durable diff**：与单入口一致；失败零写盘
- **effect trace**：每次用户动作最多推进一代 revision、最多记一条 activity（revision/activity
  唯一 owner）
- **禁止动作**：不得在入口自持第二 writer 或重复业务规则（如锁外 last-owner 预检）；不得把缺
  service 当空数据；不得把 storage 失败降级成 not-found
- **证据链接**：`test/v015-stage-s10-entry-parity.test.mjs`（多入口同权威 / 失败语义可分 / 查询
  fail-closed / 末位守卫单一权威，9 例）
- **旧 test 映射**：`members-control-service-v014.test.mjs`、`sessions-projection-v014.test.mjs`、
  `bindings-projection-v014.test.mjs`、`admin-members.test.mjs`
- **矩阵**：**I1 / I2 / I9 / I16 / U04**

---

## 三、路由 routing

事实 owner：`src/routing/agent-router.mjs`（commitSessions）+ `src/routing/session-registry.mjs`。
**`route:sessions` 已收敛为单一事务写者**（T01 inventory 曾记为 MULTI；T14 收敛，见 RT-05）。

### RT-01 · session 覆盖层字段级 diff 不 clobber 兄弟字段

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/routing/agent-router.mjs`（`setSessionOutbound` / `setSessionControl`）
- **适用版本**：v0.14 起
- **输入/前置状态**：同 session 已存在 `outbound`，另一写者更新 `control`（或反之）
- **公开执行入口**：router 的 setSessionOutbound/setSessionControl；routing control service
- **结果**：两字段并存，返回成功
- **durable diff**：目标子字段变化，兄弟子字段保留
- **effect trace**：无
- **禁止动作**：不得用旧快照整对象回写覆盖并发写入的兄弟子字段
- **证据链接**：`test/agent-router.test.mjs:549`（P1 回归）、`:571`、`:610`（墓碑保留）；
  `test/routing-control-service-v014.test.mjs:161`（字段级 diff 不 clobber）
- **旧 test 映射**：`agent-router.test.mjs`、`routing-control-service-v014.test.mjs`
- **矩阵**：**K02**

### RT-02 · 双表整表替换单事务提交

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/routing/agent-router.mjs`（`replaceAgentBindings` / `replaceChannelDefaults`）
- **适用版本**：v0.13 起
- **输入/前置状态**：整表替换 agents + channels
- **公开执行入口**：routing control service（Native/Admin 共用）
- **结果**：同一事务提交两键；失败两表都不落盘且如实报错
- **durable diff**：`route:agents` 与 `route:channels` 原子同变
- **effect trace**：无
- **禁止动作**：不得两次独立落盘（半提交）
- **证据链接**：`test/routing-control-service-v014.test.mjs:82`、`:113`（形状违规零写入）；
  `test/agent-router.test.mjs:359`/`:385`
- **旧 test 映射**：`routing-control-service-v014.test.mjs`、`agent-router.test.mjs`
- **矩阵**：**K02 / K04**

### RT-03 · 出站/入站解析优先级

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/routing/agent-router.mjs`（resolve 纯读）
- **适用版本**：v0.12+ 起
- **输入/前置状态**：session / agent / workspace / global 各层配置共存
- **公开执行入口**：`resolveOutbound` / `resolveInbound`
- **结果**：session > agent > workspace > global；显式空集合不回落；ambiguity 带 candidates
- **durable diff**：无（纯解析）
- **effect trace**：无
- **禁止动作**：不得改优先级/默认/ambiguity 规则
- **证据链接**：`test/agent-router.test.mjs:60`–`:161`（出站链）、`:177`–`:307`（入站链）
- **旧 test 映射**：`agent-router.test.mjs`
- **矩阵**：**C01（装配一致性）**

### RT-04 · 路由写盘失败如实报错

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/routing/agent-router.mjs`、`src/routing/session-registry.mjs`
- **适用版本**：v0.14 起
- **输入/前置状态**：绑定/会话写入落盘失败
- **公开执行入口**：routing control service
- **结果**：如实返回失败，绝不假成功；重启无幽灵行
- **durable diff**：不变
- **effect trace**：无
- **禁止动作**：不得把失败写成成功
- **证据链接**：`test/routing-control-service-v014.test.mjs:183`、
  `test/v014-stage-b-persistence-tx.test.mjs:135`（session-registry 失败内存/盘均不变）
- **旧 test 映射**：`routing-control-service-v014.test.mjs`
- **矩阵**：**K01**

### RT-05 · `route:sessions` 单一事务写者（生命周期 ↔ 出站/控制兄弟字段）

- **分类**：MUST_PRESERVE
- **事实 owner**：`store.transact()` 键级锁；写者 `src/routing/agent-router.mjs`（`commitSessions`，出站/控制覆盖）与 `src/routing/session-registry.mjs`（`persist`，生命周期）
- **适用版本**：v0.15 起（T14）
- **输入/前置状态**：同一 `route:sessions` 键上并发写——registry 生命周期写（ensureSession / touch / markDisposed / sweep）与 router 出站/控制覆盖写（setSessionOutbound / setSessionControl）
- **公开执行入口**：`registry.ensureSession` / `router.setSessionOutbound` / `router.setSessionControl`
- **结果**：两个写者都在**同一个 `store.transact()` mutator 内**读取最新整表 draft 再记录级/字段级合并，提交经 store 事务锁串行化；registry 不拥有 router 的兄弟字段（`outbound`/`control` 子树），提交后兄弟字段并存不丢
- **durable diff**：仅本写者拥有的字段（registry：inherit/workspace/createdAt/lastActiveAt/disposedAt；router：outbound/control）
- **effect trace**：无
- **禁止动作**：不得在事务外读 latest 再提交（TOCTOU）；不得整表覆写抹掉并发兄弟字段；`committed=false` 时不得 publish 未持久化值
- **证据链接**：`test/v015-stage-s8-routing-convergence.test.mjs`（6 例：事务内基底、同会话兄弟共存、跨会话保留、提交失败零写、无事务旧 store 回退、业务 abort 隔离）
- **旧 test 映射**：`agent-router.test.mjs:549`（RT-01 兄弟不 clobber）、`v014-stage-b-persistence-tx.test.mjs`
- **矩阵**：**K02**

---

## 四、交互 interaction / questions / approval / actions

事实 owner：问题 `src/questions/router.mjs` + `src/interaction/ledger.mjs`；审批 `src/approval/router.mjs`；
动作 `src/actions.mjs`。三入口共用授权/claim 边界（T15 收敛目标）。

### INT-01 · 迟到问题卡按终态话术编辑（late question / H02）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/questions/router.mjs`（runPush 收尾路径）
- **适用版本**：v0.13 起（web-first / Stage D `3c4ac28`）
- **输入/前置状态**：Stage-1 定时器已触发、卡发送挂起；wait 被行终止/作答结算后才迟到投递
- **公开执行入口**：`bridge.askQuestions()`（web-first 双目标）
- **结果**：wait 结算不误取消；迟到卡由收尾路径编辑为**终态话术**（terminated/answered/skip），非 timeout
- **durable diff**：按终态落盘（终态落盘失败 → uncertain，见 INT-03）
- **effect trace**：迟到卡编辑恰一次（无重复发送）
- **禁止动作**：不得把 timed-out 误判为 cancel；不得在迟到时改发 timeout 话术
- **证据链接**：`test/questions-web-first.test.mjs:227`（迟到 Stage-1 卡 terminated 话术）、
  `:277`/`:301`/`:321`（迟到卡按已作答/跳过/自定义话术）
- **旧 test 映射**：`questions-web-first.test.mjs`、`v014-stage-d-question-lifecycle.test.mjs`
- **矩阵**：**H02**

### INT-02 · claim 落盘失败则不执行特权 effect（I02）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/actions.mjs`（`mintAction`/`dispatch`）+ `src/interaction/ledger.mjs`
- **适用版本**：v0.8.7 起
- **输入/前置状态**：dispatch 时 claim 行落盘失败
- **公开执行入口**：`dispatcher.dispatch({ actionKey, token })`
- **结果**：`{ ok:false, reason:'storage-failed' }`；handler 调用 0 次；pending 保持可重试
- **durable diff**：claim 行保持 `pending`
- **effect trace**：**0** 次 handler / Host effect
- **禁止动作**：claim 提交前不得产生任何特权 effect
- **证据链接**：`test/actions.test.mjs:470`（C5 claim 失败零 handler）
- **旧 test 映射**：`actions.test.mjs`
- **矩阵**：**I02**

### INT-03 · claim 后 kill → uncertain，不自动重放（I03）

- **分类**：SECURITY_FIX
- **事实 owner**：`src/interaction/ledger.mjs`、`src/actions.mjs`、`src/approval/router.mjs`、`src/questions/router.mjs`
- **适用版本**：v0.13 起（terminal-cleanup）
- **输入/前置状态**：claim 已提交，effect 前后进程被杀；或终态落盘失败
- **公开执行入口**：重启扫描 / dispatch
- **结果**：恢复为 `uncertain`，不自动重跑 handler；终态落盘失败也不解除 claim
- **durable diff**：行标记 `uncertain`（不再是 pending）
- **effect trace**：不确定时不重复 effect
- **旧表现**：终态落盘失败可能释放 claim 或回退 pending → 重启后重复执行特权 effect。
- **新预期**：`uncertain` 保留；终态写失败不解除 claim；不自动重放。
- **理由**：避免重复执行不可逆的特权操作（安全不变式）。
- **证据链接**：`test/actions.test.mjs:496`（重启见 claimed 只报 uncertain）、
  `test/terminal-cleanup-v013.test.mjs:215`（动作终态落盘失败）、`:133`（问题超时终态落盘失败）
- **旧 test 映射**：`actions.test.mjs`、`terminal-cleanup-v013.test.mjs`
- **矩阵**：**I03**

### INT-04 · 来源会话校验（伪造/转发/跨通道拒绝）

- **分类**：SECURITY_FIX
- **事实 owner**：`src/actions.mjs`（markSource / srcChats）、`src/approval/router.mjs`、`src/questions/router.mjs`
- **适用版本**：v0.8.7 起（F-08），v0.14 强化（CRACK-001）
- **输入/前置状态**：卡片 token 被转发到其他 chat/channel 点击，或来源元数据缺失/异常
- **公开执行入口**：按钮回调 dispatch
- **结果**：转发/跨通道/异常形状一律 fail-closed 拒绝且不消费 token；原会话仍可裁决
- **durable diff**：拒绝时 token 不核销
- **effect trace**：拒绝时 **0** 次 handler
- **旧表现**：来源会话未校验或只做宽限 → 转发卡片可被他人点击触发特权动作。
- **新预期**：mint 记源 + 点击会话精确匹配；legacy 旧卡显式 warn 后按官方能力兼容，不产生永久免检卡。
- **理由**：防止跨会话/跨通道的授权提升（安全不变式）。
- **证据链接**：`test/actions.test.mjs:213`/`:229`/`:255`（F-08）、`:322`–`:392`（CRACK-001）、
  `:289`（legacy 兼容放行 + warn）；`test/inbound.telegram.test.mjs:412`–`:458`
- **旧 test 映射**：`actions.test.mjs`、`feishu-p2p-source.test.mjs`
- **矩阵**：**I01**

### INT-05 · 首达结算 / 多入口争答最多一次 effect（I04）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/actions.mjs`、`src/approval/router.mjs`、`src/questions/router.mjs`
- **适用版本**：v0.8.7 起
- **输入/前置状态**：同 token/claim 被多入口或重复点击
- **公开执行入口**：dispatch / decide
- **结果**：首达胜出；二次 `already-resolved`；stale claimId 拒绝，终态不反转
- **durable diff**：仅首次写入终态
- **effect trace**：**最多一次** effect
- **禁止动作**：迟到 settle 不得反转已落终态
- **证据链接**：`test/actions.test.mjs:72`（二次 already-resolved）、`:83`（过期核销）、
  `:121`（缺失行 unknown-action 不执行）
- **旧 test 映射**：`actions.test.mjs`、`approval.multi.test.mjs`
- **矩阵**：**I04**

### INT-06 · 三条交互入口共用 claim 边界（T15 收敛）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/interaction/ledger.mjs`（唯一 claim authority）；入口 `src/actions.mjs`、
  `src/approval/router.mjs`、`src/questions/router.mjs`
- **适用版本**：v0.15 起
- **输入/前置状态**：actions / approval / questions 任一入口的裁决；durable claim 落盘失败；
  claim 提交后进程 kill；多入口争答；来源不匹配
- **公开执行入口**：`dispatcher.dispatch` / `control.handle` / `bridge.adminSettle` / `bus.accept`
- **结果**：三条入口统一遵循「授权 → durable claim → 首达结算 → host effect」；claim 前零
  host/provider effect；首达胜出、迟到裁决被拒且不反转终态
- **durable diff**：claim 未提交 → 零写盘、行保持 pending；终态落盘失败 → 行标 `uncertain`
  （不退回 pending）
- **effect trace**：最多一次；claim 失败零 effect；claim 后 kill 不自动重放
- **禁止动作**：不得在 claim 提交前释放 live waiter / 执行特权 effect；不得让迟到 settle 翻转终态
- **证据链接**：`test/v015-stage-s9-claim-convergence.test.mjs`（I01–I04 / H02 收敛，12 例）
- **旧 test 映射**：`actions.test.mjs`、`questions-web-first.test.mjs`、`terminal-cleanup-v013.test.mjs`
- **矩阵**：**I01/I02/I03/I04/H02**

---

## 五、provider adapters / inbound

事实 owner：`src/adapters/**`、`src/inbound/**`、`src/channels/**`。

### PRV-01 · QQ 长文分段与 msg_seq 幂等基线（P02）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/adapters/qq-bot.mjs`
- **适用版本**：v0.12+ 起
- **输入/前置状态**：文本超 3000 码点；或分段中途失败
- **公开执行入口**：qq-bot 出站 `send`
- **结果**：按码点分段、每段 ≤3000、`msg_seq` 递增、无孤立代理项；中途失败不推进 `msg_seq`
- **durable diff**：无（seq 缓存在 live 对象）
- **effect trace**：失败段不重复整条发送
- **禁止动作**：不得为绿测试改协议 golden
- **证据链接**：`test/adapters.test.mjs:297`（分段）、`:317`（中途失败不推进）、`:337`
- **旧 test 映射**：`adapters.test.mjs`
- **矩阵**：**P02**

### PRV-02 · token 刷新 single-flight 与代际守卫（P01）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/adapters/_tokens.mjs`（`createTokenManager`）
- **适用版本**：v0.13 起（G-11）
- **输入/前置状态**：token 过期并发 `get()`；或 `invalidate()` 后旧 inflight 晚完成
- **公开执行入口**：adapter 内部 token manager（qq-bot / wecom-app）
- **结果**：并发 get 共享一次换取（single-flight）；`invalidate` 后旧 inflight 晚完成不复活失效 token
- **durable diff**：缓存不落入 config（只在 live 对象）
- **effect trace**：单次换取
- **禁止动作**：不得把 token 缓存写进持久 config；不得泄密
- **证据链接**：`test/tokens.test.mjs:27`（代际守卫）、`:52`、`:68`/`:80`（TTL 钳制）；
  `test/adapters.test.mjs:345`（expires_in=0 fail-closed）
- **旧 test 映射**：`tokens.test.mjs`
- **矩阵**：**P01**

### PRV-03 · Telegram offset 提交与 durable 游标（P03）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/inbound/telegram-bot.mjs`
- **适用版本**：v0.6.1 起（process-before-commit）
- **输入/前置状态**：控制回调处理失败；或 `tg:offset` 落盘失败
- **公开执行入口**：长轮询 `getUpdates`
- **结果**：处理失败时 offset 不前移、下轮原样重投；durable 失败时用旧 offset 重投并由 bus 去重
- **durable diff**：`tg:offset` 仅在成功提交后推进
- **effect trace**：不静默丢单
- **禁止动作**：不得错误前移 offset；不得把 409 当作无冲突
- **证据链接**：`test/inbound.telegram.test.mjs:1010`（process-before-commit）、
  `:1066`（C11 durable cursor 失败重投）、`:682`（offset 持久化）、`:718`（401/409 双写可见）
- **旧 test 映射**：`inbound.telegram.test.mjs`
- **矩阵**：**P03**

### PRV-04 · adapter 出站 payload golden

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/adapters/**`
- **适用版本**：v0.6+ 起
- **输入/前置状态**：各渠道已配置
- **公开执行入口**：`notify` → adapter `send`
- **结果**：endpoint/payload/签名/校验/timeout/SSRF 与官方契约一致
- **durable diff**：无
- **effect trace**：一次网络投递
- **禁止动作**：不得放宽自定义 endpoint/SSRF；不得改协议 golden 迎合重构
- **证据链接**：`test/adapters.test.mjs:34`（telegram）、`:79`（feishu 卡片）、`:105`（wxpusher）、
  `:188`（bark）；`test/fixtures/channels/*.json`
- **旧 test 映射**：`adapters.test.mjs`、`channel-fail-closed.test.mjs`
- **矩阵**：**C01（共同 payload 一致）**

### PRV-05 · QQ C2C 键盘真机渲染（UNKNOWN）

- **分类**：UNKNOWN
- **事实 owner**：`src/adapters/qq-bot.mjs`（发送侧已实现）
- **适用版本**：—
- **输入/前置状态**：C2C markdown + keyboard 发送到真机
- **公开执行入口**：qq-bot C2C 出站
- **结果**：**未知** —— 仓内没有可复现「真机渲染按钮」的 oracle
- **durable diff**：—
- **effect trace**：—
- **禁止动作**：**不得**在无外部证据下写成「真机支持」或上调为 MUST_PRESERVE
- **证据链接**：`docs/v0.14-evidence-matrix.md`（QQ keyboard 行 = `external-evidence-pending`）；
  issue #26
- **旧 test 映射**：无（仅有 contract 级 mock）
- **矩阵**：**—（外部证据缺口）**

---

## 六、Host seam

事实 owner：`src/host/**`（含 `src/host/seam.mjs` 集中接缝）、`src/host-events.mjs`、`src/control/entry.mjs`、`src/plugin-entry.mjs`。

### HST-01 · 服务缺失/晚注入/撤销 → 局部降级（H01）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/host/**`
- **适用版本**：v0.11+ 起
- **输入/前置状态**：Host 服务缺失、晚出现、撤销或重建
- **公开执行入口**：Host adapter 装配与生命周期
- **结果**：局部降级，其他渠道继续；旧 listener 退出；不 false-claim 可用
- **durable diff**：无
- **effect trace**：缺失服务的渠道无 effect，其余正常
- **禁止动作**：不得猜私有字段；缺能力必须 fail-closed
- **证据链接**：`test/host-seam-audit.test.mjs:106`（throwing rpc 回落 webServer）、
  `:175`（agents 降级不 false-claim）、`:195`（声明注入为 Host 提供，非 npm 依赖）
- **旧 test 映射**：`host-seam-audit.test.mjs`、`host-capability.test.mjs`
- **矩阵**：**H01**

### HST-02 · 声明 peer 范围与 fixture 指向真实文件（H03）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/host/**`、`docs/compatibility-matrix.md`
- **适用版本**：v0.13.1 起
- **输入/前置状态**：兼容矩阵与 `package.json` peer 声明
- **公开执行入口**：`scripts/verify-host-compat.mjs`
- **结果**：矩阵 8 个审计目标与声明 peer 范围一致；fixtureCovered 行指向真实 notifier/probe 文件
- **durable diff**：无
- **effect trace**：无
- **禁止动作**：不得自动放宽 peer 范围；`fetch.register` 单独不作为 carrier
- **证据链接**：`test/host-seam-audit.test.mjs:58`/`:78`/`:85`/`:94`；`docs/compatibility-matrix.md`
- **旧 test 映射**：`host-seam-audit.test.mjs`、`host-compat-matrix.test.mjs`
- **矩阵**：**H03**

### HST-03 · attachments 防御式读取与媒体白名单 fail-closed

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/host/**`
- **适用版本**：v0.12.1 起
- **输入/前置状态**：attachments 经 get / 直读 / 抛错 proxy 读取；或非白名单媒体类型
- **公开执行入口**：`admitInboundImage` / `admitInboundFile`
- **结果**：三种读取路径均防御；非白名单媒体类型拒绝；缺 `saveFile` 拒绝
- **durable diff**：无
- **effect trace**：拒绝时无写入
- **禁止动作**：不得在缺 Host 能力时静默放行
- **证据链接**：`test/host-seam-audit.test.mjs:128`/`:146`/`:163`
- **旧 test 映射**：`host-seam-audit.test.mjs`、`attachments-bounds-v0121.test.mjs`
- **矩阵**：**H03**

### HST-04 · 0.1.7-alpha.2 / rc.1 真机走查（UNKNOWN）

- **分类**：UNKNOWN
- **事实 owner**：—
- **适用版本**：—
- **输入/前置状态**：在 `0.1.7-alpha.2` / `0.1.7-rc.1` 真 Host 中的视觉/交互走查
- **公开执行入口**：—
- **结果**：**未知** —— 仅 source/artifact seam 已验证，未做真机走查
- **durable diff**：—
- **effect trace**：—
- **禁止动作**：不得把这些版本写成「host smoke verified」
- **证据链接**：`docs/compatibility-matrix.md`（alpha.2 / rc.1 = contract/source verified）
- **旧 test 映射**：无
- **矩阵**：**—（外部证据缺口）**

### HST-05 · Host seam 集中化与 Cordis 生命周期（H01/H03）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/host/seam.mjs`（唯一读取/调用宿主服务与 optional-dependency 生命周期的入口）
- **适用版本**：v0.15 起
- **输入/前置状态**：宿主服务缺失 / 晚注入（`ctx.inject` 依赖晚就绪）/ 撤销 / 重建（子插件重放）；或 cordis 代理对未 inject 服务抛错
- **公开执行入口**：`src/index.mjs` 装配经 `createHostLifetime().inject(...)`；诊断经 `createHostSeam` / `readHostService` / `hostQuestionFeatures`
- **结果**：读取绝不抛错、绝不 false-claim（`get(name,false)` 优先，抛错代理按无服务）；late inject 才 attach；replacement 重放时旧 listener 退出、只留一个；dispose 释放全部登记且幂等；无 `ctx.inject` 的宿主/测试桩以根 ctx 直连（局部降级，不阻断其他渠道）
- **durable diff**：无
- **effect trace**：缺能力时对应渠道零 effect；其余渠道与通知照常
- **禁止动作**：不猜私有字段；不 monkey patch 宿主；生产 `src/` 不得裸调 `ctx.inject`（仅 `host/seam.mjs`）
- **证据链接**：`test/v015-stage-s7-host-seam.test.mjs`（H01 六例 / H03 五例）
- **旧 test 映射**：`host-seam-audit.test.mjs`、`host-capability.test.mjs`、`native-questions.test.mjs`
- **矩阵**：**H01 / H03**

### HST-06 · 宿主提问生命周期 timed/continued（H02）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/host/seam.mjs`（版本能力声明）+ `src/host/native-questions.mjs`（按能力处理迟到答复）
- **适用版本**：v0.15 起（能力表覆盖 0.1.7 线与发布版 `0.2.0-rc.2`）
- **输入/前置状态**：宿主问题 `ask()` 有界等待结束而宿主仍 pending；caller abort；GUI 迟到答复
- **公开执行入口**：`user-questions/request` waterfall 拦截器
- **结果**：本侧有界等待结束（全未作答）**绝不误取消**宿主 caller signal；宿主声明 `timed`/`continued`（0.2 线）时，未作答且下游未结算则交回宿主自身 answerer，迟到答复仍可 win；0.1.7/未知版本保守（未作答即终态）；下游无 answerer 时有界收尾、不悬挂
- **durable diff**：无
- **effect trace**：无（提问自身的 claim/settle 由问题账本负责）
- **禁止动作**：不得把「未作答」误当取消；不得伪造宿主能力（版本表仅描述差异，探测结果优先）；未列版本一律保守
- **证据链接**：`test/v015-stage-s7-host-seam.test.mjs`（H02 四例）、`test/v014-stage-d-question-lifecycle.test.mjs`
- **旧 test 映射**：`native-questions.test.mjs`、`v014-stage-d-question-lifecycle.test.mjs`
- **矩阵**：**H02**

---

## 七、migration

事实 owner：`src/control-surface/channel-config-migration.mjs`、`src/inbound/identity.mjs`。

### MIG-01 · 迁移备份一次、幂等、损坏 boot state fail-closed（M01）

- **分类**：SECURITY_FIX
- **事实 owner**：`src/control-surface/channel-config-migration.mjs`、`src/inbound/identity.mjs`
- **适用版本**：v0.13 起
- **输入/前置状态**：legacy 出站 state 存在；或 boot state 损坏；或重复迁移
- **公开执行入口**：启动迁移 `migrateCanonicalChannelConfig`
- **结果**：仅备份一次；重跑幂等（`already`）；不重复播种；损坏 state 跳过迁移且 fail-closed
- **durable diff**：`state:schema-version` 仅在成功迁移后写入
- **effect trace**：无
- **旧表现**：损坏/不可信旧 state 被当作「空实例」迁移 → 可能重新 bootstrap owner。
- **新预期**：损坏 state 跳过迁移并 fail-closed，绝不写入 schema 版本、不覆盖证据。
- **理由**：防止由不可信 state 派生授权（安全不变式）。
- **证据链接**：`test/channel-config-migration-v013.test.mjs:22`（备份一次/幂等）、`:197`（损坏 fail-closed）、
  `:51`（忽略 malformed legacy）；`test/identity.test.mjs:45`/`:69`/`:77`（只增不减、不复活）
- **旧 test 映射**：`channel-config-migration-v013.test.mjs`、`identity.test.mjs`
- **矩阵**：**M01 / K06**

### MIG-02 · 新 metadata/claim 经旧 reader（M02）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/actions.mjs`（srcChats 元数据）、`src/inbound/identity.mjs`
- **适用版本**：v0.8.7 起，v0.14 强化
- **输入/前置状态**：升级在途的旧卡（缺来源元数据）；或旧 reader 读到新形状行
- **公开执行入口**：按钮回调 dispatch / identity 读盘
- **结果**：legacy 旧卡显式 warn 后按官方能力兼容，不产生永久免检；不安全自动回退明确拒绝
- **durable diff**：不误重放、不误写终态
- **effect trace**：宽松放行仅在受限窗口内，窗外拒绝
- **禁止动作**：不得让旧 reader 误 allow/重放；不安全回退必须显式拒绝
- **证据链接**：`test/actions.test.mjs:289`（legacy 老卡兼容放行）、`:322`/`:334`（在途旧卡窗口）；
  `test/identity.test.mjs:166`（读盘防御）
- **旧 test 映射**：`actions.test.mjs`、`identity.test.mjs`
- **矩阵**：**M02**

### MIG-03 · 切换后新增数据再回退读最新（M03）

- **分类**：MUST_PRESERVE
- **事实 owner**：`src/inbound/identity.mjs`、`src/control-surface/channel-config-migration.mjs`
- **适用版本**：v0.13 起
- **输入/前置状态**：迁移/切换后新增配置或成员，再回退读
- **公开执行入口**：迁移 + 运行期读取
- **结果**：读取最新数据，不用旧 backup 覆盖
- **durable diff**：回退读取不写盘
- **effect trace**：无
- **禁止动作**：不得用旧 backup 覆盖新数据；不重复播种
- **证据链接**：`test/identity.test.mjs:69`（迁移只增不减）、`:77`（不复活已删成员）；
  `test/channel-config-migration-v013.test.mjs:47`（重跑幂等不重铸备份）
- **旧 test 映射**：`identity.test.mjs`、`channel-config-migration-v013.test.mjs`
- **矩阵**：**M03**

---

## 必测矩阵 → spec / oracle 覆盖

| 矩阵 ID | spec 条目 | 旧 oracle（文件:行） |
|---|---|---|
| K01 | CFG-02, MEM-02, RT-04 | `store.test.mjs:24`; `v014-stage-b-persistence-tx.test.mjs:75,135` |
| K02 | CFG-01, RT-01, RT-02 | `v014-stage-b-persistence-tx.test.mjs:187,233`; `agent-router.test.mjs:549` |
| K03 | MEM-01 | `members-control-service-v014.test.mjs:156` |
| K04 | MEM-04, RT-02 | `identity.test.mjs:253`; `routing-control-service-v014.test.mjs:82` |
| K05 | CFG-02, MEM-02 | `store.test.mjs:34,51` |
| K06 | MIG-01 | `channel-config-migration-v013.test.mjs:197` |
| C01 | CFG-03, CFG-04, RT-03, PRV-04 | `runtime-mutability-v014.test.mjs:47,90,127` |
| C02 | CFG-05, CFG-06 | `channel-config-migration-v013.test.mjs:22,155,173` |
| I01 | INT-04 | `actions.test.mjs:213,255` |
| I02 | INT-02 | `actions.test.mjs:470` |
| I03 | INT-03 | `actions.test.mjs:496`; `terminal-cleanup-v013.test.mjs:133,215` |
| I04 | INT-05 | `actions.test.mjs:72,121` |
| H01 | HST-01 | `host-seam-audit.test.mjs:106,175` |
| H02 | INT-01 | `questions-web-first.test.mjs:227,277,301,321` |
| H03 | HST-02, HST-03 | `host-seam-audit.test.mjs:58,128,146,163` |
| M01 | MEM-03, MIG-01 | `identity.test.mjs:45,87,166`; `channel-config-migration-v013.test.mjs:197` |
| M02 | INT-04, MEM-03, MIG-02 | `actions.test.mjs:289,322,334`; `identity.test.mjs:166` |
| M03 | MIG-03 | `identity.test.mjs:69,77` |
| P01 | PRV-02 | `tokens.test.mjs:27,52` |
| P02 | PRV-01 | `adapters.test.mjs:297,317` |
| P03 | PRV-03 | `inbound.telegram.test.mjs:682,1010,1066` |

### 未覆盖 / UNKNOWN（不得上调）

- `PRV-05`（QQ C2C 键盘真机）、`HST-04`（alpha.2/rc.1 真机走查）**无仓内 oracle**，保持 `UNKNOWN`。
- 矩阵中 `C03/C04/C05`（epoch/状态机切换）、`P04`（飞书 ACK/钉钉重连）、`H01` 的
  「旧 listener 清理」等，现有 oracle 为 contract 级；真实 provider/真机证据见
  `docs/v0.14-evidence-matrix.md`，标 `external-evidence-pending`，本文件不下沉为等价结论。

---

## fixtures 说明（脱敏）

现有 `test/fixtures/` 主体是**渠道协议 fixture**（`channels/*.json`、`qq-c2c-image.json`），
覆盖 PRV-04 的 payload 契约。上面的**必测不变式**（K/C/I/H/M）其输入在前述测试里以**临时目录 +
内存 mock store 内联构造**，不需要共享 fixture 即可复现——因此未重复造轮子。

仅**旧 reader / 迁移**（M01/M02/M03）所需的**旧形状 state 快照**在仓内缺文件级 fixture，故新增两条
**脱敏**样本（全部为明显假占位符，不含真实 token/账号/手机号/chat id）：

| 新增 fixture | 用途 | 对应 oracle |
|---|---|---|
| `test/fixtures/legacy/inbound-bindings-mixed.json` | 混合有效性绑定行（坏形状/非法 channel/非法 role） | MEM-03 / MIG-02（`identity.test.mjs:166`） |
| `test/fixtures/legacy/channel-config-legacy.json` | pre-v0.13 legacy 出站键 + admin 键 + malformed 行 | CFG-06 / MIG-01（`channel-config-migration-v013.test.mjs:22`） |

两条均为**录制参考样本**，尚未被测试消费（等价状态由上述测试内联构造）；后续任务若需要可显式读取。
校验方式：JSON 解析 + 与测试内联构造的字段形状一致性核对。