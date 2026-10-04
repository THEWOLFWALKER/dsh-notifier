# dsh-notifier v0.15 下一阶段实施规划与 Review

基线：`dev@2542a3107e7d3795e6ba5b294a7a5b82052c3431`。本计划是设计依据；执行取舍以同目录 `DECISIONS.md` 为准。交接整理已修改仓库文档，尚未改业务源码。交接 ZIP 15 个文件均通过 SHA-256 清单校验。主清单 201 项（P1 69、P2 130、P3 2），上一轮复验 61、F01–F16 16、独立发现 MY-R01–R16 16。它们是 4 组来源记录，**不能相加为唯一缺陷数**。`issue-crosswalk.json` 为每条记录保留原始描述、状态、位置、证据和唯一主归属。历史已修/撤回项保留为回归约束，不重新算成缺陷。

## 1. 产品判断与竞品定位

目标是一个可理解、可撤销、可信赖的私聊通知与控制产品。对照 dsh-im 时按用户任务评价：连接渠道、确认身份、选择当前任务、处理问题/审批、理解发送结果、诊断和恢复、升级兼容。dsh-im 的 checked delivery v1 是真实上游契约，应精确兼容；其多机器人/群聊/额外通知方式不自动成为 dsh-notifier 范围。dsh-notifier 保持“一渠道默认一个账号”的用户路径，内部仍必须支持稳定 accountId 和多 owner。相比 dsh-im，当前主要差距不是代码量，而是“Native 能力可达性与真相表达”：后端有成员管理/撤销配对但 UI 无入口；已关闭的私聊仍可在当前进程继续；未知投递被显示为成功；错误被展示为空配置。先补完整用户任务，再谈更广功能。

竞品评估表（实现阶段需以当前 upstream 固定提交复核并存证）：

| 用户能力 | 当前差距 | 决策 |
|---|---|---|
| Bot/目标查询与 checked send | dsh-im v1 `account.fingerprint` 接错，mock 同错 | 修 bridge；来源于 upstream 源码/文档的 fixture；若 Native 没产品场景，移出 daily allowlist；保留受控兼容接口须有实际调用者 |
| 一键连接与可解释状态 | Telegram 通知配置会启动入站；关闭后仍 live；Cloud 状态误报 | 本轮核心产品闭环，UI 仅展示“通知/私聊/连接中/需要处理”等用户词 |
| 多 bot 与群聊 | dsh-im 可更广；本项目产品硬约束是一账号默认、只私聊 | 不追平，不当 bug；彻底移除正向群聊发送/控制宣传与入口 |
| 宿主 Settings 融合 | 现用 sidebar/plugin bundle，未有相同 IA | 做真实宿主 walkthrough 后决定是否重排 IA；先保证 Native 日常任务完整、Recovery 仅诊断 |
| 更新状态 | Native 暂无自更新可见性 | 产品待定：若宿主已有可信更新入口，提供清楚跳转；否则做轻量状态提醒，避免自造升级器 |
| 可信发送证据 | accepted/confirmed/unknown 各层不一致 | 公共 API、Activity、UI 统一语义，避免误重试 |

## 2. 综合问题模型与去重优先级

优先级按对真实用户/权限/数据的影响重新判定，不照搬原 P1。逐 ID 初判已写入 `issue-crosswalk.json`：B0 60 条、B1 116 条、B2 25 条。这是 201 条来源记录的任务优先级，不代表 201 个独立 bug。B0 是进入任何候选发布前必须闭环；B1 是本轮一起做；B2 是有证据后决定/可延后。部分 B2 在承诺或开启对应能力时升级为 B0。原始 ID 的完整逐条交叉索引在 JSON，下面编号为**根因簇**而非新增 issue 数。

| 根因簇 | 类型与当前 ID 主归属 | 结论与优先级 |
|---|---|---|
| R01 能力启停与准入不由同一权威控制 | 产品偏差/安全；#1,#22,#31–33,#40–41,#45–48；MY-R01/R05/R12，F13 | **B0**：通知和私聊分别配置、准入即时撤销、非私聊证明失败即拒绝、策略坏态 fail closed |
| R02 principal 未贯穿状态域 | 安全/一致性；#8–9,#16–19,#29,#34–36,#54–58；E06–E11,F06/F08/F09 | **B0**：跨账号借权/碰撞，迁移读写双轨危险；多 owner UI 冲突一起解决 |
| R03 interaction、导入与结算非原子/非单调 | 数据一致性/产品语义；#26,#37–39,#42–44,#49–51,#62–63,#65；A03/A04/A13,MY-R03/R04/R06/R07 | **B0**：迟到终态覆盖、旧预览清新 secret、“稍后处理”误终结；重放边界显式化 |
| R04 Native 投影把失败当空或把局部成功当整体成功 | 产品/UX/测试幻觉；#2–7,#10–15,#20–21,#23,#27–28,#30；F07/F12,MY-R14 | **B1**，其中误报成功/隐藏待办为 B0 验收项；要求可信聚合、可达操作、列表总数与分页 |
| R05 配置/路由宽容解析和非原子写 | bug/架构债；#52–53,#59–61,#64,#66–78；D01/D02,A05 | **B1**；静默广播、重复通知、覆盖消息、错误默认安全重试需本轮修 |
| R06 desired/live/evidence 与运行世代混合 | 一致性/误重试；#24–25,#79–92；A08,D11/D12 | **B0** 的 credential revoke、unknown 传播；其余健康/订阅/性能 B1 |
| R07 Store 引用、事务、恢复与 durability 声明不实 | 安全/数据一致性/性能债；#93–115；A02/A09/A10,C02 | **B0**：活引用、浅拷贝逃逸、误报 durable、权限失败、删盘复活、陈旧恢复覆盖；**不以全面 async 为目标**，同步 IO/写放大先度量再做定点优化 |
| R08 Cloud Job 把确定失败与不确定恢复合并 | bug/外部副作用；#116–134；F03–F05,MY-R15/R16 | **B0**：YAML token 自断、bind/unbind/apply 顺序、取消、永久失败循环；资源清理与部署供应链 B1/条件性 |
| R09 Tunnel 的进程态被当连通态 | 状态/生命周期；#135–139；A07/A12,C01 | **B1**：running、stopped、protected 均须真实证据；其中错误权限提示为 B0 UI 声明约束 |
| R10 Provider 协议链与设备证据 | bug+外部证据；#140–162；A16 | **B1** 修明确的 offset/ACK/重复副作用/生命周期；QQ/Feishu/DingTalk/WxPusher 真机项为 **B2 evidence-only**，未证实能力不得宣称通过 |
| R11 公共 notifier 与 dsh-im 外部契约 | 契约 bug/测试幻觉；#163–171；F01/F02/F11/F16,MY-R02/R09–R11,E01–E05 | **B0**：fingerprint、三态证据、外部效果后 activity 失败不可改主结果；容量/timeout B1 |
| R12 Surface/Recovery 能力清单与真实调用断裂 | 产品/架构债；#172–176；F10,MY-R13 | **B1**：彻底删除旧控制台 JS/API/SSE/server；Native 用户能力有入口；如仍需恢复诊断，另建最小只读入口 |
| R13 CI、宿主兼容、发布声明和文档治理 | 门禁/证据/漂移；#177–201；F14/F15等 | **B1** 完整门禁/文档修；Windows、Node 范围、真实宿主/设备等按声明定 B0 或 B2；签名/安全自动化属于治理决策，不伪称 runtime bug |

依赖关系：R07 的事务与 durability 语义支撑 R03/R02/R08；R02 的 canonical principal 支撑 R01、R03、Provider 去重；R06 的 generation/evidence 类型支撑 R01/R08/R11/Native；R11 的公开语义先稳定，R04 才能准确展示；R12 的 UI call graph 需在 R01–R04 能力确定后收口。R13 的门禁在每阶段落地，而非末尾补测。

详细的开发与用户双视角设计批判见 `DESIGN_REVIEW.md`；已拍板的实施规则见 `DECISIONS.md`。

## 3. 接口与状态机设计

### 3.1 Capability、private admission、identity

定义 `CapabilityDecision {direction, desired, effective, generation, reason, observedAt}`。`direction` 仅 `notification | privateChat`。Telegram 出站 token 可作为显式开启私聊时的受控凭证来源，但 token 存在**绝不代表私聊 enabled**。Native 的开启动作原子提交期望状态、凭证来源与身份前置条件；安装 transport 后才把 effective 置 on。关闭动作顺序：同步提高 admission generation 并拒绝新 envelope → 持久化关闭意图和 deny generation → abort poll/callback/WebSocket → 等在途处理达安全点/标 unknown → 更新可见状态。只有持久化成功才确认“已关闭”；若落盘失败，当前进程仍保持禁止准入并展示“关闭未完成”，启动时对不完整授权默认 deny，避免重启回开。所有 envelope 带 `(channel,accountId,userId,chatScope,admissionGeneration)`；在外部副作用前再次验证 current generation 与 private proof。未知/空 chatType 统一 `unknown` 并拒绝，不通过 `not known group` 推导 private。已发给 provider 的请求无法撤回，只记 unknown。

`Principal = (canonicalChannel, stableAccountId, providerUserId)`，组件使用结构化 tuple 或长度前缀编码，不允许分隔符拼接。accountId 缺失的事件或旧状态不进入新运行态，用户重设账号。owner 资格按**本次操作指定 principal** 检查，不能从 `identity.list(channel)` 借另一账号的 owner。多 owner Native：UI 显示明确可选择的当前身份/账号；动作携 revision 和 principal，服务端重新授权；默认只有唯一候选时自动预选，无“全局恰好一位 owner”条件。

状态域清单：identity、current task、task-selection pending、approval/question owner fallback、`/log`、handled/dedup、拒绝回执 throttle、callback refs、delivery evidence、route defaults、import/export。S0 只读盘点旧状态的数量、类型和敏感性。保留权限受控、唯一命名的备份，建立全新 schema 空状态。旧状态不自动转换或装配，也不长期双轨读写。重设向导引导重新输入凭证、建立身份和私聊授权；任何失败保持旧文件可恢复且新权限关闭。绝不把未知 account 落 `default`。用户 UI 不展示内部 accountId，以显示名/渠道选择。

### 3.2 Interaction、问题与导入

Ledger 行含 `id, principal, kind, state, version, createdAt, expiresAt, decision, effectEvidence`。`pending -> resolving -> resolved|declined|terminated|uncertain`；终态 `resolved/declined/terminated` 不可回退，`uncertain` 表示外部效果可能发生，只能由有证据的 reconciliation 转入对应终态。`resolve/terminate/markUncertain` 用**同一 fresh transaction 内校验 version 与状态并提交**；返回 `won | alreadyTerminal | conflict | storageUnknown`，禁止旧 snapshot whole-row set。`onSettle` 必须 await，外部副作用在 claim durable 后执行；若效果不确定，不回滚为 pending。缺时间/policy/source 的旧 pending 进入 quarantine/expired，不能合成新十分钟有效期。

“稍后处理”要么是可重新出现的 defer（保留 pending、记录 remindAt、原 expiry 不延长），要么 UI 明确改为“拒绝/跳过”；本计划选**真正 defer**，与产品文案一致。只有明确“拒绝”才走 terminal decline；对审批与提问分别核对语义，不能共用误导按钮。导入 preview 为不可变 `ImportPlan {scope, baseRevision, perKeyExpectedDigest, patch, clear, secretPresence, expiresAt}`；commit 在同一事务对 patch 和 clear 做 compare-current，冲突返回具体字段且零写入。任何外部 apply 在 commit 之后失败时报告 `committed-but-not-applied`，并提供恢复动作，不把真实已提交说成失败。Remote URL 拒绝 fragment，sessionId 规范化与允许集合一致。

### 3.3 Public notification、runtime、health

统一 `DeliveryEvidence = confirmed | accepted | unknown | failed | skipped`。`accepted` 仅 provider 接受，`confirmed` 必须有交付确认，`unknown` 是可能产生外部效果但无结果，`failed` 才能安全理解为未发生，`skipped` 是策略未尝试。公共 `PushResult` 在定向、多渠道发送、TypeScript、testing fake、`dsh-notifier/sent` 事件中共享 `DECISIONS.md` D05 的五个互斥 bucket，不保留顶层 `ok` 或 `delivered`。`flush()` 是单独的 `{drained:boolean}` 契约，不伪称某条消息已送达。unknown 的重试建议为人工核对；事件发一次、只带脱敏证据，不因脱敏丢语义。日志/Activity 失败不改变已有外部发送结果，只另记 observation gap。当前消费者收到一次明确的破坏性 API 说明，不为旧版维持错误投影。

Runtime 分 `desiredRevision`, `liveGeneration`, `providerEvidence`。配置每次实质变化才换 generation；`setState/recordTest/recordSend` **必须携** generation 与 revision，缺失/旧/未来 generation 均拒绝或 quarantine。`replaceAll` 只更换实质变化的实例；async start/stop/dispose await、AbortSignal、清理超时可见。retire 后晚到 send 统一 unknown（除非能证明 provider 前未调用）。健康显示“已配置/已连接/最近测试/待确认”分别，不把 accepted 或 24h 历史当当前 healthy。required secret 被清除或失效时，立即封锁旧 live sender 的 admission，再按 generation 关闭；不能靠解析新配置失败而维持旧凭证发送。

### 3.4 Cloud Job 与 token

`CloudJob` 有 durable `id, operation, configDigest, credentialSource(kind,ref,digest), phase, state, generation, lease, resources, lastEvidence, cancelRequested`。`credentialSource.kind` 明确 `state-secret | yaml-outbound`；claim 时 pin source/digest，禁止生成不存在的 state ref；引用失效/轮换报 `credential-changed`，不静默 fallback 到另一账号凭证。phase 先 `planned`→`external-started`→`external-observed`→`local-apply`→`done`，每一步有幂等键、外部资源 ID 与补偿日志。

状态：`queued/running/recovery-required/cancel-requested/done/failed/cancelled`。**外部请求开始前**的确定性校验/凭证 mismatch/权限/参数冲突→`failed` 终态；外部请求开始后结果不明、进程中断后无法证明是否创建→`recovery-required`，**只允许显式 resume/reconcile**，启动自动做只读检查和显示，不自动继续有副作用步骤；取消 durable row 不依赖内存 job，先请求 abort，持久化失败时仍尝试 abort 并报告状态 unknown；完成取消需确认外部效果停止或留 recovery-required。deploy 不自动捞任意非终态 job。link/unbind 采用 prepare→apply runtime→commit visible bound/unbound；失败保持 `transitioning/recovery-required`，不能先显示成功。backup 覆盖全部被写 token、chatId、apiBase、gatewayKey、inbound/outbound 来源；只恢复仍由本 job 拥有的值，避免覆盖用户后改。Worker `/healthz` 仅证明部署可达，另测 Telegram upstream 和真实发送须注明证据层级。云资源默认保留或清理由产品明确提示并可列出，避免费用无感累积。

### 3.5 Store、Routing、Provider、Surface

Store 保留同步接口边界；`get()` 返回深拷贝/冻结只读投影，clone 失败即报坏数据，绝不退回 live 引用。多键写走 fresh `transact`，原子操作仅接受具备 `transact` 能力的 Store；删除旧版无事务降级路径，不得假报 durable。`durable:true` 必须对应文件与目录 sync 成功；若性能代价不可接受，改名 `atomicReplace` 并把 durability 显式列为弱保证。锁错误分 `busy/permission/io`；运行期外部删盘/损坏要停止写并进入恢复，不用内存旧态复活。备份每次重设生成唯一 ID；权限 0600 失败阻断载密写。设业务 key schema 与 state 大小监测；同步性能用 p95/p99 event-loop delay、状态大小、事务延迟门槛决定是否局部拆分或 worker 化，不做无证据全面 async 重写。

Routing 解析采用完整验证：`[]` 明确为不发送；未知 channel/level/quiet/retry 参数报配置错；去重目标；override 只允许白名单字段； retry 只在 provider 明示安全且幂等时自动执行，unknown 不重试；jitter、上限、AbortSignal。重复 type 配置直接拒绝并指出来源，测试与 runtime 使用同一 resolved config。命令解析未知 `/command` 只回复一种明确结果，不能又进入模型；感叹文本不作为默认控制前缀；按 principal 排队保证同会话注入顺序。

Provider：Telegram offset 仅在业务处理确认或 durable quarantine 后推进，落盘失败退避且停止重复热拉；poison update 受控隔离后继续后续消息；stop abort poll。QQ keyboard `msg_id`、按钮能力和截断按真实客户端证据启用；旧 WebSocket close 不得影响新代。Feishu 旧卡片缺来源/时间时不放宽，走重新发卡；SDK 方法形状启动时验证。DingTalk ACK 先后与重送采用明确 at-least-once + durable dedup；sessionWebhook 响应不明不自动 fallback push。callback refs 跨重启必须 durable 或旧按钮明确失效可重新生成；资源 cap 超限显式报错/降级。WxPusher UID 认证强度在真机证据前标 unknown。

Recovery-only：删除旧版控制台的 UI/API/events/SSE、sessions/bindings/members/questions 管理实现与静态资源；只保留经重新审定的最小只读恢复诊断入口。若该独立 HTTP 服务也无必要，则一并删除，以 Native/离线恢复路径替代。Native 将用户仍需的 update/remove user、revoke pairing 做成可达且有安全确认的用户流程；没有用户任务支持的 dshIm.* daily 方法直接删除。建立真实 client call graph（静态调用+浏览器交互记录）与 method allowlist 差异门禁，不能用 allowlist 自证。旧 Recovery HTTP 的 restart-stop、票据、缓存问题通过删除旧服务消除；若重建最小只读诊断入口，需重新证明 loopback、no-store 与可停机。用户文档只讲“诊断/恢复”。

## 4. 阶段规划、进入/完成条件

采用 5 个连续大阶段；每阶段独立提交与 integration checkpoint。所有阶段从最新 `origin/dev` 复核差异，基线变化逐条回填交叉表。不急发布，不以 CI 绿代替产品验收。

| 阶段 | 进入条件与 ownership | 完成条件 / focused tests / integration gate |
|---|---|---|
| S0 冻结契约与事实 | 交叉表全 ID 对齐；owner: 产品架构+测试+Native UX；锁定 dsh-im/Host 上游 commit 和 fixture、当前 UI call graph、能力矩阵与六个核心用户旅程 | 文档化公共 API/状态机/新 schema 与备份重设、可见错误状态与用户词汇；源自 upstream 的 contract fixture；选择 QQ 按钮/Windows/Node 等声明范围；无代码兼容猜测。Gate：baseline Node+DOM、pack/exports、真实依赖装配 smoke 可复现；登记 unknown。 |
| S1 权限与数据原子性 | S0 接口稳定且备份重设流程已设计；owner: Control/Identity/Interaction/Store | R01/R02/R03/R07 的 B0 完成：通知仅出站、关闭即时拒绝、跨账号无借权、ledger 终态单调、defer 语义、import clear CAS、Store 真正隔离。Focused：竞态 barrier/fault、备份重设、私聊关闭在途与重启、storage fault。Gate：Native 关闭私聊的真实纵向切片→admission→ledger→Store 全链，备份重设与启动提示。 |
| S2 投递/运行与 Cloud | S1 principal/capability/evidence 可用；owner: Runtime/Public API/Cloud/Provider | R05/R06/R08/R09/R11 B0 与 Provider 明确 bug 完成：证据三态统一、YAML token 工作、永久失败终结、cancel 可用、link/unbind 不误报、Telegram cursor 不热循环。Focused：upstream fixture、timeout 后晚到、Cloud 故障注入、路由解析、runtime generation。Gate：Native 投递未知与 Cloud 恢复纵向切片可理解；外部效果发生而本地 bookkeeping 失败时不重复发送/部署；pack 中 runtime/types/fake/event 一致。 |
| S3 Native 产品闭环与清理 | S1/S2 已交付关键 Native 纵向切片；owner: Native/Surface/Docs | R04/R12 完成：多 owner 与成员/撤销配对可用，列表 total/分页/attention，错误不可伪装空，术语检查覆盖真实 DOM，旧控制台代码删除，dsh-im 能力取舍有明确产品入口。Focused：真实 React DOM 交互、异常状态、手机窄屏/明暗快照、真实 call graph。Gate：逐个用户任务从入口到结果/恢复路径可走通，无隐藏后端日常能力。 |
| S4 兼容与预发布证据 | S1–S3 integration 通过；owner: CI/Release/Docs/产品验收 | R13 门禁与文档完成；根据声明跑 Windows/Node/可用的真实 Host 版本。Focused：真实依赖 install、Host in/out range boot、无真实账号的恢复演练；真实 provider/设备/Cloud 账号缺口保持 unknown 并限制相应能力声明。Full gate：root+DOM+channel matrix+release guard+host compat+pack/exports+类型与 fixture+安全/性能预算+全 ID closure。不得自动发版。 |

每阶段一个主提交系列（契约/实现/迁移/验收文件可分别提交），提交消息带阶段编号与对应根因，checkpoint 记录测试命令、结果、环境和未证实项。跨阶段不能把半迁移状态推作“已完成”。

## 5. Test 与验收策略

测试优先级：真实外部契约 fixture（标来源 commit/版本/文件及断言）→ 行为集成→ fault injection / deterministic race→ DOM 用户流程→ 源码静态 invariant。grep 只可守“旧符号不存在/allowlist exact set”，不可作为发送、准入、迁移成功证据。dsh-im fixture 必须采自 `xmanrui/dsh-im@ecf6c85b` 的 `delivery-service.mjs` / `PROACTIVE_DELIVERY.md`：`describeBot().account.fingerprint`、`contractVersion=1`、`sendChecked` 的 `expectedFingerprint` 与 `account-changed`；新增真实 service integration/版本追踪，禁止 mock 手写本地实现 shape。Host fixture 取明确 upstream commit 与 operator `connection.admit` 契约，并记录与当前 peer range 的差异。Cloud/Telegram/QQ 等未有真机/真实 provider 时用 `unknown`，绝不将本地 mock 记 pass。

Full gate 不仅测试通过：清单每个原始 ID 状态为 fixed/deferred/evidence-only/historical，且有理由和回归 ID；权限关闭与 secret clear 在当前进程生效；跨账号隔离；外部效果 unknown 不自动重试；云状态可退出；用户任务从 Native 走通；用户文案可理解；发布支持矩阵与真实证据一致。CI 必须将 test 与 verify:release/verify-host-compat 串联，`--count` 失败即失败；DOM lockfile 可复现；构建/pack exports 与依赖安装由 CI 检验。覆盖率阈值基于高危分支而非单纯 2447 数量。分支保护 required checks、提交签名与 GitHub 设置需要有权限的操作者核验，不能由仓库测试伪装为完成。

## 6. KEEP / REPLACE / DELETE / RECOVERY_ONLY

| 决策 | 范围 |
|---|---|
| KEEP | loopback-only Recovery、Native `selectTask` exact registration、account-aware current-task 主路径、无隐式 latest task、runtime 不随普通 state 变更推进 generation、Cloud durable checkpoint/不重复明文 secret、dsh-im checked-only 与无猜测 importer、已修 pairing 事务、已识别 group 的拒绝、现有 QQ/Telegram/Feishu/DingTalk 实际协议资产、用户可用品牌信息 |
| REPLACE | Telegram 能力启停、principal 全域 key、ledger stale RMW、import CAS、public delivery schema/Activity、Cloud job/reconcile/token source、Native 多 owner/列表/错误状态、Store 复制与 durability 语义、routing validation/retry、Provider cursor/ACK/fallback、CI gate 组合 |
| DELETE | 正向群聊发送/控制入口及文档（含 QQ notifyGroups、`/v2/groups`；记录对当前外部消费者的破坏性变更）；无真实用户任务的 dshIm daily 方法；**整个旧版 Admin Console 及其 channels/members/sessions/bindings/questions/SSE client/API/events/静态资源和旧路由**；无效 legacy fallback、危险宽容默认、重复 package files 条目、过时自证 mock |
| RECOVERY_ONLY | 仅重新实现或保留最小只读诊断与恢复说明；旧控制台绝不保留。若必须有写恢复操作，单独定义离线、显式、可审计工具而非默认 HTTP 路由 |

`./internal`、`./testing`、legacy delivered/failed 必须逐项核对是否为当前真实外部契约；仅历史内用或旧版遗留的直接删除，不做旧版对齐。确有当前消费者的正式 API 可以破坏性修正并给出迁移说明。群聊正向支持必须退出。README/version/兼容矩阵/writer registry 同代码与证据更新，不能用文档维持错误支持承诺。

## 7. Deferred / evidence-only

1. **外部证据 unknown**：#146 QQ HELLO/mention/media/keyboard；#157 Feishu P2P；#159 DingTalk soak；#161 WxPusher UID；#162/#198 Cloud、Telegram/APNs、完整宿主；#171 dsh-im 真实 host；#199 Native 真宿主视觉；#200 scoped error；#201 peer range boot。设实验脚本、版本/账号/设备、结果记录与能力降级，不凭 mock 标 pass。若产品承诺该能力，缺证据即阻断该能力公开启用；可在不宣称的范围继续开发。
2. **需测量才决定的工程债**：#94–96 同步 IO/写放大、#107 大 state、#114 单文件故障域、#183 覆盖率百分比、#173 Recovery 独立服务必要性。收集规模/延迟与故障演练，再决定定点优化；不预设全面 async 或全面重写。
3. **产品取舍**：DSH-D03 单渠道多机器人（明确不做）、DSH-D15 Settings IA、DSH-E19 更新入口、#124 workers.dev 公网面与 #134 资源保留（须有用户清晰选择）、#177/#178 Windows/Node 声明范围、#188 版本号在发布前决定。dsh-im 的广度不自动改变私聊与单默认账号硬约束。
4. **治理/文档**：#186 required checks、#187 签名、DSH-E18 SECURITY/Dependabot/CODEOWNERS/CodeQL、F14 dev/main 分叉需单独权限和发布流程决策；#195–197、DSH-D19/F16 事实漂移本轮修文档。不得在本轮触碰 main。

## 8. 后续实施 Git 规则

仅从执行时最新 `origin/dev` 工作并只 push `dev`；禁止 force push、禁止操作 main；禁止 tag / GitHub Release / npm publish，除非最后单独授权。每个提交 `Author = THEWOLFWALKER`、`Committer = THEWOLFWALKER`，邮箱读取仓库现有 THEWOLFWALKER 提交沿用。远端变更先 fetch/rebase 或安全合并，冲突停下审视，不覆盖他人提交。阶段完成后记录 HEAD、测试证据和剩余 unknown。
