# 单元测试语义审查与 Luna 接手标记

基线 `dev@2542a3107e7d3795e6ba5b294a7a5b82052c3431`。已机械盘点 `test/` 下 **179 个 `.test.mjs/.spec.mjs` 文件、48,397 行、2,492 个具名 test/it/describe 声明**（动态生成与 Node 实际 2,447 leaf count 口径不同）；完整逐声明索引在 `test-catalog.json`。独立环境后续完成三路测试审查，原文在 `sources/independent-test-review-merged.md`，新增裁定见 `TEST_REVIEW_ADJUDICATION.md`。审查员估算深读约 780+ 个测试点、标题遍览约 1800+ 个；这不是逐断言全量认证。未列出的测试不等于已获真实契约背书。

判据：用户当次产品约束 > 当前公开上游契约与实际消费者 > 当前产品文档 > 实现。旧任务书、历史测试、当前代码本身不能反过来定义需求。行为测试可保留安全不变量；源码 grep/字符串/本地 mock 不能单独证明功能或外部契约。

## A. 已确认可疑：应删除或改写预期

| 测试（基线行） | 实际断言 | 依据及为什么可疑 | 给 Luna 的动作 |
|---|---|---|---|
| `test/v015-stage-s14-dsh-im-bridge.test.mjs:34,63,77,117,131,141`，共同 `makeService:12–20` | mock `describeBot()` 给顶层 `accountFingerprint`，据此认为 bot 支持 checked、发送可成功；后续竞态均复用此 mock | **当前实现反推**。真实 dsh-im v1 是 `account.fingerprint`；mock 与实现同错，全部绿灯不能证明真契约。且 mock 用 Telegram checked，而固定上游文档称首版 checked 只支持 Feishu/Lark | 用 `UPSTREAM_CONTRACT.md` 的固定源码派生 fixture；flat-only 应拒绝；先真实 nested shape 再跑竞态 |
| `test/assembly.inbound-signals.test.mjs:52` | 没配置 inbound 时出站 Telegram token 自动成为 `inboundBotToken` | **旧实现便利回退**，违背通知与私聊显式解耦；把 MY-R01 固化为测试 | 反转：仅出站配置不得启动任何入站 transport；独立 enable 才可复用 token |
| 同文件 `:75,:127` | Admin enabled + Feishu/QQ/DingTalk/Wechat/WxPusher store 账号即入站 wanted | **旧管理台配置即授权假设**。凭证存在不等于用户授权私聊；问题不限 Telegram | 对每个入站渠道加独立显式授权与关闭即时撤权测试 |
| `test/native-boundary-contracts.test.mjs:178` | 缺 accountId 显示 `default`，内部 `accountId` 原样作 displayName | **当前投影**，与 fail-closed account 归属和用户不见内部 ID 冲突 | 缺 ID 拒绝并提示重设；显示名用用户语义 |
| 同文件 `:279` | 服务端 snapshot 截到 `CHANNEL_CAP/RAIL_CAP` 且 `truncated=true` 即算通过 | **服务端实现自证**。客户端不消费 `truncated`，用户仍看不到第 13 个渠道 | 真 DOM 验证分页/搜索/总数与需处理渠道可发现 |
| `test/v015-stage4-postrc-hardening.test.mjs:64,:87` | method table 与声明表一致，且所有 SECONDARY_METHODS 在 daily allowlist | **两张服务端表互证**；`dshIm.*`、`native.updateUser/removeUser/revokePairing/wait` 可无客户端调用仍过关 | 以真实 UI call graph+用户任务验收；无用方法删除，必要方法做 Native 可达 |
| `test/public.test.mjs:104,:118,:139` | 定向 push 把结果适配到 delivered/failed；timeout 进入 failed 数组，虽错误文字说结果未知 | **旧二态 API 实现**，unknown 可能已发送，消费者可能按 failed 重试 | 定向/广播/event/fake/types 同一 evidence schema；timeout 为 unknown，不入确定失败 |
| `test/public-testing-fake.test.mjs:49,:63,:113` | malformed、rate-limited、disabled、budget、busy 仍 `ok:true`；flush 返回 `undefined` | **fake 自身实现**，与生产 `ok:false`、`flush(){return {ok:true}}` 冲突 | 与真实 public contract 共用 table-driven 测试；fake 与运行时同语义 |
| `test/public-types.test.mjs:72,:91` | 用 regex 断言 `flush(): Promise<void>` 和旧 SentEventRecord 字段存在 | **声明文本自证**；生产 flush 返回对象，事件缺 accepted/confirmed/unknown。regex 不能证明 TS 消费端可编译、行为相同 | 用实际 TS consumer compile + runtime/fake contract suite；事件保留隐私且带 evidence |
| `test/delivery-evidence-v013.test.mjs:59` | provider accepted 即 `healthState(...)=healthy` | **旧健康实现**。平台接受一次请求不证明当前连接/端到端送达，误导 Native | health 分配置、连接、最近发送证据；accepted 不自动整体 healthy |
| 同文件 `:92` 与 `test/notify.test.mjs:78,:119` | `delivered` 继续作为 accepted 的 legacy 别名，并用全对象 deepEqual 锁形状 | **旧版兼容形状**；与“旧版不对齐”及用户证据语义冲突 | 删除别名或给确有当前消费者的正式 API 一次破坏性迁移说明；不得借旧字段表达送达 |
| `test/v015-stage-s23-gate2-rmw.test.mjs:59` | 缺 epoch 的 legacy record 仍计入新代健康 | **历史兼容假设**；无世代证据可污染新 runtime，正是原 #25/#80 | 缺 generation 的运行证据标 unknown/quarantine，不作当前健康 |
| `test/routing.test.mjs:34,:43,:56,:62` | 未设置路由广播；其中 active level 未配也广播；未知渠道静默得到 0 目标；未知 level 默认 active | 部分是产品默认，部分仅是**宽容实现**。显式 `[]` 与未设置不可混；错字可能静默广播或静默不发送 | 分别测试 unset、explicit empty、invalid channel/level、重复项；非法配置报可操作错误 |
| `test/conversation.test.mjs:312,:324` | 未知 `/command` 先回复“未识别”，仍进模型一次 | **历史投递语义**；一次输入两种处理，用户不知哪种有效 | 一次输入只走一种明确路径；不要把“不吞消息”作为唯一要求 |
| `test/store-shape-corrupt-v0121.test.mjs:119,:149` | 启动空文件、读失败按空 state 静默继续 | **旧保留行为**。读失败不同于首次空态；凭证/身份可被伪装成未配置 | 读取失败显式 unavailable、封锁依赖能力；空文件策略明确且一致 |
| `test/v015-stage-s2-config-layers.test.mjs:181` | apply 失败时仍允许旧 runtime active，只显示 diverged | **一般配置更新**下可能合理；清 required secret/关闭私聊时却允许旧凭证继续服务 | 按操作类型区分；权限或凭证撤销必须即时 fence，普通热替换可维持旧 runtime 并标 diverged |
| `test/v015-stage-s17-tunnel.test.mjs:94` | `status:'running' + access.protected:true` 投影成 `available/protected:true` | **本地配置/进程状态自证**，没有实际 Tunnel 连通与 Access 网络验证 | 表达 configured/started/verified 三层；真实保护证据未有时 unknown |
| `test/inbound.qq.test.mjs:930,:1082,:1129` | `/v2/groups`、`notifyGroups` 正向发送；`buttons:true` 无条件 | **旧群聊产品**与**未真机验证的能力宣称**；违背私聊专用 | 删除群聊正向测试/代码；保留群聊拒绝测试；QQ 按钮证据前不宣称已验证 |
| `test/config-validation.test.mjs:180,:197` | Qmsg 群聊消息与旧群配置迁移成功 | **退出的产品能力和旧版兼容** | 删除正向群测试及群迁移；验证旧配置被安全拒绝/提示重设 |
| `test/inbound.feishu.test.mjs:625,:1153,:1173` | 群 chat_id 可发文本、动作群通知可发，敏感审批仅降级 | **旧群聊产品假设**；“不发敏感内容”不能替代私聊专用 | 删除群目标发送；保留群来源 fail-closed 回归 |
| `test/actions.test.mjs:289`、`test/inbound.telegram.test.mjs:458,:994`、`test/inbound.feishu.test.mjs:834,:887,:1014` | 旧卡缺来源元数据仍 warn 后放行/结算 | **旧版兼容优先于来源证明**；允许在无法验证原 chat 时执行控制 | 来源不明 fail closed，给用户重新发卡/重新操作路径 |
| `test/host-compat-matrix.test.mjs:19–64` | package peer、仓库矩阵、workshop 列表互相一致，固定 0.1.7 版本即通过 | **仓库内三份声明互证**，没有上游 freshness 或真实 boot；新 Host 可已前进 | 继续保留一致性检查，但单独跑固定 upstream+真实 Host boot；不把此测试标“兼容已验证” |
| `test/user-copy-lint.test.mjs:137,:207` | 抽字典、部分 `words()` 字面量查禁词 | **源码构造方式自证**；其他真实渲染字符串可漏过，已出现内部术语 | 真实 DOM 可见文本+所有 i18n 来源检查；人工任务走查 |

## B. 产品决策改变后应删除的测试族

- `test/admin-api.test.mjs`、`admin-events`、`admin-members`、`admin-questions`、`admin-scan`、`admin-ui-behavior`、`admin-ui-i18n`、`admin-wiring` 等旧 Console 正向测试：它们验证的旧产品已经退出；随对应代码删除。`admin-origin/server` 中 loopback、no-store、认证安全不变量若最小 Recovery 仍存在，应在新入口重建行为测试，不能保留旧服务只为让旧测试绿。
- `bindings-projection-v014`、`sessions-projection-v014`、`members-projection-v014`、`control-surface-service-v012` 中“旧 daily RPC 已删”类测试可改成真实 allowlist/前端调用闭环；不必保留一串旧方法名的历史墓碑。
- `channel-config-migration-v013`、`v014-persistence-concurrency-hardening` 中旧版本持久化迁移测试，按“备份旧状态并重设”策略重写；不为 v0.12/v0.13 留自动转换或长期读写兼容代码。

## C. 交 Luna 深审；本轮停止继续挖掘，不标通过

| 测试域 | 为什么要审 | 决定性验证 |
|---|---|---|
| `test/cloudflare-release.test.mjs`、Cloud recovery/supervisor | rig `yamlRows:new Map()`，未覆盖 YAML-only token；failed/recovery-required、cancel durable 与 apply 顺序不足 | 带 YAML 的真实配置 rig；逐 checkpoint crash/fault；远端 side effect spy |
| `test/interaction.ledger.test.mjs`、`terminal-cleanup`、`v015-stage-s22/s23` | metadata 事务用例较强，但 terminate/markUncertain 的 stale RMW 仍漏；旧无 epoch 测试相反 | 真实 store barrier 两种交错+重启 |
| `test/native-boundary-contracts.test.mjs`、`test/dom/*` | 服务端截断、单 owner fixture、错误变空、后台方法可达性均可能没走真实客户端 | 多 owner、数据源抛错、超上限列表、真实 DOM 点击到结果 |
| `test/inbound.telegram.test.mjs` | mock getUpdates 可能无法暴露 offset 落盘失败热循环和 poison update；stop 未中止在途 poll | 可控存储故障、连续 update、fake clock/abort、重启 |
| `test/inbound.qq.test.mjs` 与协议 fixture | 本地 mock JSON 不能证明客户端按钮显示；缺 msg_id/长文本截断 | 固定上游协议证据+真机 unknown 记录；能力开关 |
| `test/inbound.dingtalk.test.mjs` | ACK-first 与 sessionWebhook ambiguous fallback 可能重复/丢消息 | ACK/网络响应丢失故障注入；真实 soak 另记 unknown |
| `test/inbound.feishu.test.mjs` | 旧卡来源/TTL 放宽，SDK 形状由本地 fake 规定 | 当前 SDK 包形状/固定版本 fixture；旧卡拒绝行为 |
| `test/agent-router.test.mjs`、`task-routing`、`questions`、`approval`、`inbound-log-command` | accountId 缺省/default、owner fallback、pending/dedup/throttle 可能跨账号 | A/B 两账号同 userId、同 eventId 的真实跨组件测试 |
| `test/public.test.mjs`、`public-types`、`public-testing-fake`、`notify` | 四个面各自测试自己，没有共享契约 | 一个 table-driven contract 跑 runtime/types/fake/event |
| `test/v015-stage-s11-writer-fitness.test.mjs`、`security-structure`、`package-payload` | grep/allowlist 只辅助结构；删旧代码后会大量改动 | 先行为/打包实测，再保留少量静态 invariant |
| `test/host-compat-matrix.test.mjs`、`host-seam-audit`、`issue38-host-compat` | 内部快照自证，不能证明新版真实 Host | 固定上游源、支持范围内外真实 boot |

## D. 测试迁移规则

1. 先写每个测试的**外部依据**：用户任务/安全不变量/正式公开 API/固定上游源码（commit+路径+hash）。只有“旧测试期望如此”则不得作为依据。
2. 保留输入输出和故障结果测试；删除旧 Console/群聊正向/历史兼容测试；重写自证 mock、静态词法检查和只看服务端的 UX 测试。
3. 对公开 API 做破坏性修正时，以真正使用者和产品新语义为准；不要为了旧版绿色测试维持缺陷。
4. 每个改动先跑 focused，再跑全量；旧测试失败须记录是产品决策淘汰还是新 bug。禁止为了凑 `testCount` 增加镜像实现的测试。
5. 真实 provider、真实 Host 与设备缺证据均标 unknown。mock 可证明故障处理，不能证明平台契约或实机能力。
