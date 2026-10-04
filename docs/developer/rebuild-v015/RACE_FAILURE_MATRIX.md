# 五域 Race / Failure Matrix 与测试用例

每行的“可观察结果”同时是行为集成测试断言；注入点使用 barrier、可控 Promise、磁盘/网络故障。结果分类只有 `confirmed/accepted/unknown/failed`，不能用 Activity 标题或 `ok` 代替。外部系统无法证实时记录 unknown。

## Interaction（owner: `src/interaction/ledger.mjs`, `src/questions/router.mjs`, `src/approval/router.mjs`, `src/control/entry.mjs`）

| 竞态/故障 | 规定的原子边界与结果 | 测试 | 来源 |
|---|---|---|---|
| resolve 与 terminate 读同一 pending，resolve 先提交 | version CAS first-winner；terminate 返回 alreadyTerminal，不覆盖 resolved | 两 Promise barrier 控制交错，重启后终态仍 resolved | MY-R03,A03 |
| resolve 与 markUncertain 交错 | 已提交终态不回退；外部 effect 不明时只能从 resolving 到 uncertain | 插入 send timeout 与 late result，枚举顺序 | MY-R04,A03 |
| 两位 owner 同时处理同一问题 | 一人 won，另一人 alreadyHandled；Activity 不把后者写“本次处理成功” | 双身份真实 service 路径 | #26,#42 |
| 点击“稍后处理”/过期/随后重开 | defer 不 decline，不延长原 expiry；只有明确拒绝终结 | DOM→RPC→ledger→重启回归 | MY-R06,#37–39 |
| 持久化 claim 成功、settle 异步拒绝 | await settle；行留 uncertain/reconciliation，UI 给可恢复反馈 | Promise rejection fault | #42 |
| 重启/TTL/cap 后 provider 事件重放 | durable dedup 或受控幂等 key；未知不双做副作用 | kill/restart + duplicate event | #49–51 |

## Runtime / admission（owner: `src/assembly/inbound-*`, `src/runtime/channel-manager.mjs`, `src/adapters/sender.mjs`, `src/control-surface/health.mjs`）

| 竞态/故障 | 规定结果 | 测试 | 来源 |
|---|---|---|---|
| 只设 Telegram 通知 token | 无 inbound transport/pairing；notification 可用 | 真实 assembly fake transport spy，禁 `start()` | MY-R01 |
| 私聊关闭与在途 poll/message | 先增 admission generation；新/未执行外部副作用的旧 envelope 拒绝；已发效果记 unknown | barrier 分别置于 poll、route、send 前 | MY-R05,E12 |
| required secret 清空但新 config resolve 失败 | 旧 runtime 同步封锁，UI 不宣称关闭完成前已成功 | fail secret resolver / persisted clear | E12,#80 |
| replaceAll 无实质变化 | 不换 live generation、不清健康 | 实际对象/配置摘要 compare | #79 |
| 旧代测试或 provider 状态晚到 | `recordTest`, `setState`, `recordSend` 必须携 generation，旧/未来均拒绝 | 两实例交错、future epoch | #25,#80–81,#88 |
| send 已进入 provider，retire 先返回 | 返回 unknown，禁止自动重试；Activity 同语义 | provider deferred Promise + retire | #91,A08 |
| async stop/dispose reject、强制超时 | 状态 needs-attention，资源统计不称已释放 | 故障生命周期 fake | #89,#92 |
| provider accepted 但无 confirmed，24h 无探测 | health 只显示“平台已接收/最近状态”，不显示当前已送达 | clock fake + UI DOM | #83–87 |

## Cloud Job（owner: `src/cloudflare/deployment.mjs`, Wrangler runner, Tunnel supervisor）

| 竞态/故障 | 规定结果 | 测试 | 来源 |
|---|---|---|---|
| YAML-only token claim 后再次解析 | credentialSource 固定 yaml；fingerprint 不自断 | 有真实 YAML row、无 state secret row 的 rig | F03,MY-R15,#122 |
| token 轮换/本地参数错误 | `failed` 终态，无自动 resume；可新建 job | crash/restart 与再次 deploy | F04/F05,MY-R16 |
| 远端 create 已发生但响应丢失 | `recovery-required`，保存资源线索；仅显式 reconcile | 外部 effect spy + lost response | #128–129 |
| job 内存对象消失后 cancel | durable row 可取消；abort 尝试不被 save fault 跳过 | 重启、fault `saveJob` | #130,F05 |
| link record 保存成功、runtime apply 失败 | visible bound 不得 true；保留 transitioning/recovery | crash 在每 checkpoint | #116–119 |
| unbind 与用户并发改 token/chatId | 只恢复 job 仍拥有的字段；新用户值保留 | CAS 与多字段 backup | #116–117 |
| Worker /healthz 成功、Telegram 401 | 状态区分 Worker reachable 与 upstream unavailable | mock HTTP 两层，再做真实账号证据 | #120–121 |
| Tunnel spawn、未连通、stop kill 失败 | 不称 running/stopped/protected；保留诊断 | fake child events/kill fault | #135–139,C01 |

## Import（owner: `src/control-plane/config-portability.mjs`, `src/control-surface/secondary-service.mjs`, Store）

| 竞态/故障 | 规定结果 | 测试 | 来源 |
|---|---|---|---|
| 预览后另一个动作更新 secret，旧计划 clear | compare-current 冲突，零写入 | transaction interleave, assert secret intact | A04,MY-R07 |
| patch 与 clear 同时存在且其中一项 stale | 整体零写入，不部分提交 | 多键 fault / legacy store not-supported | #60,#110 |
| commit 落盘成功，revision/activity 失败 | 返回 committed-but-not-applied/observability-gap，不能劝用户再导入 | 逐点 fault；重启验证 | #163,#30 |
| 默认 scope 写错字段 | schema reject 或明确转换，导出/导入往返同义 | property round trip | A13 |
| 旧状态 schema 冲突、重设中断 | 唯一安全备份；新 schema 空启动；旧身份/凭证不装配；重试不覆盖备份 | backup/reset fixtures + crash every step | #106,#111 |
| remote URL fragment/session case drift | 拒绝 fragment，canonical session 对等 | parser property cases | A05 |

## Identity / Account（owner: identity、routing、approval、questions、conversation、dedup）

| 竞态/故障 | 规定结果 | 测试 | 来源 |
|---|---|---|---|
| 同 channel/userId 在 A owner、B member | B 的 `/log`、审批、提问都不可借 A owner | 两 account 真 service 集成 | F08/F09,E08/E09,#34 |
| A/B 同毫秒、相同 eventId/messageId | dedup、throttle、pending 互不碰撞 | 模拟同值事件 + 重启 | #35–36,E07/E10/E11 |
| 新 envelope 缺 accountId | fail closed，不能落 default | provider adapter→entry 真实路径 | #54 |
| 旧键看似只有唯一 account | 仍不自动转换；备份后由用户重新建立账号，重启私聊保持关闭 | backup/reset fixture + Native onboarding | E06 |
| 旧键可对应多 account | 隔离旧状态，不自动赋 default/第一个账号 | backup/reset fixture + Native onboarding | E06,#8 |
| 多 owner 且选择当前任务 | UI 要求选择 principal，动作按该 principal 授权与写 key | Native DOM→service，两个 owner | F06,MY-R08,#16/#29 |
| 严重损坏成员缺 key | 不合成同一个空 ID；错误显式、不可操作项不显示为可操作 | corrupt row integration | #17–19 |

## 外部契约与用户流程补充

- dsh-im 真实 upstream v1 fixture 验证 nested `account.fingerprint`、contractVersion、checked failure；现有 flat mock 必删（F01/F02/MY-R02）。真实 Host 尚无证据时标 unknown（#171）。
- public `push(channel)`、`notifyAll`、`flush`、types、fake、event、Activity 对四种 evidence 跑同一 table-driven contract suite；副作用后 activity 失败不改主结果（E01–E05,MY-R09–R11,#164）。
- QQ/Telegram/Feishu/DingTalk 协议错误测试只证明本地故障行为；真机/真实 provider 单独留 evidence log，不混进绿灯计数。
