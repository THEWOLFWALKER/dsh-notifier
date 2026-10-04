# 高风险实现定稿

本文件给 Luna 直接执行的接口和故障裁决。与旧源码/测试冲突时，`DECISIONS.md` 优先。唯一允许改变的原因是固定上游契约或真实运行证据推翻规则；先记证据与新裁决，再继续开发，不中途请用户设计。

## 1. 权限、账号与目标证明（S1）

**Owner：Control Core 拥有准入；Identity 拥有 Principal；Provider 只产出不可自行授权的来源证据；Native 只发意图。**

```ts
type Principal = { channel: Channel; accountId: StableAccountId; userId: string };
type PrivateProof = { provider: Channel; accountId: StableAccountId; chatId: string; chatType: 'private'; observedAt: number; sourceEventId: string };
type Admission = { principal: Principal; chatId: string; generation: number; permissionRevision: number };
admitPrivate(envelope, capturedGeneration): Admission | Denial;
assertCurrent(admission): void; // 每个外部 effect/claim 前再执行
resolvePrivateTarget(target, proof): VerifiedPrivateTarget | Denial;
```

- 凭证存在、Admin enabled、YAML 出现 inbound 均不是私聊授权。Native 写入的 canonical enabled 是唯一授权意图；YAML 必须显式 `enabled:true`。Provider 的 group、topic、缺 chatType、缺 accountId、来源与目标不匹配全部 Denial。Telegram 负 chat ID 永不成为私聊目标。dsh-im 渠道 kind 只提供目标类别，不自动证明 Telegram `chat` 是私聊。
- `disablePrivate(channel,account)`：先同步提升 generation 并让 admission deny；随后持久化 `enabled:false` 和 generation；再 abort poll/socket/callback 并 await 安全点。持久化失败时仍维持当前进程 deny，返回 `close-incomplete`，启动读到不完整权限也 deny。已经发出的外部请求只能标 unknown，不能说“已撤回”。单渠道关闭不能 stop 其他账号。
- owner 判断比较完整 `(channel, accountId, userId)`。`approval/router`、`questions/router` 里的 fallback 不调用仅按 `channel+userId` 的 owner 判定。所有 state key（pending、dedup、throttle、selection、callback、event evidence）均带结构化 Principal；旧无账号键不读进新模型。
- 旧状态：S0 只读清单，备份至唯一文件并 fsync/限制权限；新 schema 以空状态启动，私聊默认关闭。Native 提示“需要重新连接通知渠道和私聊”，列出步骤；旧文件留离线恢复。不能做旧字段转换和运行时 fallback。

**必须验证的交错**：关闭与 poll 返回、关闭与 claimed effect、存盘失败与重启；账号 A/B 同 userId 与同 eventId；未知 chatType 的 Feishu `oc_*`、Telegram supergroup、QQ group；目标 resolver 的 `extraTargets` 中夹私聊和群。对每例断言业务消费者、host effect 和 provider send 次数。

## 2. Interaction 与 Import（S1）

**Owner：Ledger 独占生命周期 transition；router 只传判定与执行 ID；Import service 独占 preview/commit；Store 提供 fresh transaction。**

```ts
transition(id, expectedVersion, allowedFrom, nextState, patch, executionId?)
  -> {kind:'won',version} | {kind:'already-terminal',state} | {kind:'conflict'} | {kind:'storage-unknown'};
```

- `terminate` 与 `markUncertain` 只调用 `transition`；在 transaction 内读最新 row、校验 version、状态、executionId，再写一次。禁止 transaction 外 `get` 后整行 `set`。`resolved/declined/terminated` 不回 pending；`uncertain` 只在外部效果可能发生且无法证明结果时使用，不能当普通失败终态。不同执行不能借 `allowClaimed` 布尔开关结算他人 claim。
- Defer 只为 pending 写 `remindAt`，保持原 expiresAt，重复点击幂等；到时重新展示。若一种交互无法重新展示，移除“稍后处理”按钮，明确写“拒绝”。
- `ImportPlan` 包含 baseRevision、每个 patch/clear key 的 expectedDigest、过期时间。commit 在一个 Store transaction 中对所有预期当前摘要做 CAS，全部匹配才写；clear 同样比较。已提交但 runtime apply 失败为 `committed-but-not-applied`，不可诱导重新提交。备份重设不是旧版本 import。

**必须验证的交错**：terminate 与 resolve、markUncertain 与 resolve 两种先后；Store stale get 与 fresh transact；claim 后 effect timeout 与 restart；Import preview 后另一个 writer 修改待 clear 凭证；commit 成功后 apply/Activity 失败。每例记录持久 row 和外部 effect 次数。

## 3. Public、Runtime、Store（S1/S2）

**Owner：Public facade 定义唯一对外契约；Runtime 拥有 generation 和证据；Store 拥有提交/持久保证；Fake 共享公共契约测试。**

- D05 的五个 PushResult bucket 互斥，定向也是同形数组；`source` 是选路来源。provider 收到请求后超时归 unknown，禁止自动重试。策略跳过归 skipped；确定拒绝归 failed。`flush()->{drained:boolean}` 只陈述队列排空。生产/fake/types/event 同一 schema；`PUBLIC_API_VERSION=0.8`。sent event 只有脱敏证据和关联 ID，不含原消息/密钥。
- Runtime 的 desiredRevision 只属于配置，liveGeneration 只属于运行实例；状态观察必须带采样时的 generation，旧代、无代、未来代均不更新现健康。accepted 不等于 confirmed 或 connected。权限/secret 撤销先 fence 再 apply；普通热替换失败可以保留旧 runtime，但须显示 diverged。
- Store `get` 返回隔离副本；无法复制即报 corrupt。关键多键写只用 fresh `transact`。成功 `durable:true` 需文件及目录 sync；rename 后 sync 失败返回 `commit-unknown`，调用方 readback/reconcile 后才决定下一步，不无条件重放 effect。读失败不能伪装首次空库。

**必须验证的交错**：发送 timeout 后 provider 晚回、旧实例晚报 healthy、撤销 secret 时热替换失败、目录 fsync 失败、磁盘运行中被删、fake 与 runtime 同输入表、真实 TS consumer compile。

## 4. Cloud Job（S2）

**Owner：Cloud job ledger 拥有状态；credential resolver 拥有来源；Wrangler adapter 只执行确定输入的外部操作；Runtime apply 决定可见 bound 状态。**

```ts
type CredentialSource = {kind:'state-secret'|'yaml-outbound'; ref:string; digest:string};
type Phase = 'planned'|'external-started'|'external-observed'|'local-apply'|'done';
type State = 'queued'|'running'|'recovery-required'|'cancel-requested'|'done'|'failed'|'cancelled';
```

- claim 时固定 credentialSource；YAML-only 不制造 state-secret ref，也不因为新 metadata 存在而失去 YAML fallback。digest/来源变化 → 确定失败，不偷换凭证。外部调用**开始前**的校验失败为 failed；调用开始后失去确定回执为 recovery-required。重启只做只读 reconcile，不自动 create/deploy。若返回明确资源 ID，先持久化 receipt 再 local apply；保存 receipt 失败则 recovery-required，绝不盲重建。
- cancel 无需内存 job row 也可请求，尽快 abort；持久化 cancel 失败仍尝试 abort，并报告 unknown。unbind 只撤回此 job 拥有的 token 副本与 endpoint，更改过的用户值不覆盖；YAML 用户值不删除。只有本地 runtime apply 成功才显示“已连接/已解绑”。Worker healthz 仅代表 Worker 可达。

**必须验证的交错**：YAML-only × 首次 deploy/restart/lost response/每个 durable checkpoint；token rotate 于 claim 后；receipt save failure；cancel row save failure；unbind 与用户修改并发。真实 Wrangler readback 未有证据时保留 unknown。

## 5. Native、Recovery 和阶段阻断（S3/S4）

**Owner：Native canonical projection 直接读 channel/account/interaction 服务；Recovery 只读诊断；CI/Release 拥有证据账。**

- Native 必须呈现首次重设、独立通知与私聊开关、多 owner 选择、待办/成员管理、撤销配对、Cloud 恢复、错误/空态/未知的真实状态。分页有 total 与继续入口。RPC 失败显示原因类别和下一步，不能显示“暂无数据”。`admin.enabled` 不得影响这些状态。
- 删除旧 Admin API/UI client/event hub/scan 的生产调用与 npm 包体资源；保留 Recovery 时重新做最小 loopback 只读入口。旧路径应 404；Native 行为测试证明没有通过 Admin API 偷读配置。
- `npm test` 和 `npm run test:dom` 分别执行并纳入同一 CI 阻断；源码 grep 只辅助。Host 各声明版本实际 boot、provider/设备/Cloud 实测没有证据时为 unknown，不扩大支持声明。S4 只产出候选发布审查；不 tag、Release、npm publish。

每个阶段把本文件对应的交错测试、跨层 gate、issue-crosswalk ID 和残余 unknown 写入 `PROGRESS.md`；一项高风险能力无法证明安全时局部禁用、继续其他阶段，不等待用户回合。
