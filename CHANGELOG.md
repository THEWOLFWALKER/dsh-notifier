# Changelog

## [0.10.0] - 2026-09-12（codex/mobile-task-loop-v010 收口）

「手机接管 DSH 任务」闭环特性线：宿主能力桥（能力快照 + 事件实证 + 生命周期诊断）、经 `ctx.userQuestions` 公开 seam 桥接原生提问、Web-first 远程延迟升级、移动任务路由（任务投影 / 任务选择 / 歧义前置）、图片进入 DSH 会话、管理台暴露 DSH 连接与任务状态。`npm test` 为 **1605**（1605 pass，较 0.9.7 基线 1548 净 +57）。全部为 mock/contract/fixture 证据；原生提问桥与 QQ 图片解析未经真机复验，缺口见 `docs/memory/risks.md`。

### 宿主能力桥（`src/host/capability.mjs`）

- 新增 `detectEventsMode` / `detectQuestionsMode` / `detectConversationMode` / `detectHostVersion`，把宿主能力归一为可观测的 `supported` / `unsupported` / `unknown` 三态，不读私有字段。
- 新增 `createHostCapabilitySnapshot`：派生式能力视图（事件 / 提问 / 会话 / 媒体四个维度），只暴露支持状态与模式，绝不泄漏 sessionId / 正文 / token / 凭证。
- 新增 `receivedEventsView`：对 `receivedEvents` 做脱敏摘要（事件 key + 计数上限 `MAX_RECEIVED_EVENT_KEYS`），供管理台诊断。

### 经公开 seam 桥接宿主原生提问（`src/host/native-questions.mjs`）

- `createNativeQuestionBridge` 只经宿主唯一公开 seam `registerProvider` 把 `ctx.userQuestions` 的 `ask_user_question` 桥进现有 `aq:` 账本与 Control Core，使原生提问、Web、手机共用同一首达结算闭环。
- `normalizeOptions` 将 `AskUserQuestionOption` 归一为 aq 桥选项标签，`description` 并入上下文避免丢信息；`attach` / `pending` / `settle` / `snapshot` / `dispose` 构成窄接口。
- 红线：不读私有字段、不覆盖未公开 singleton、不 monkey patch；seam 不可用或已被占用时安全降级 `unsupported`，保留插件自有 `ask_user` fallback，绝不伪造「已桥接」。宿主提问与 provider 异常只返回空答案，绝不让宿主被静默吞掉。

### Web-first 远程延迟升级（`src/questions/router.mjs`）

- 通知投递改为分级升级：Stage 0 Web 优先、Stage 1 延迟 IM、Stage 2 提醒（可选），各阶段延迟可配，并在用户作答后取消未触发定时器，跨端终态同步。
- 计时器取消与终态同步保障 Web 与 IM 双端首达采纳一致；延迟参数加入 `src/config.mjs` 默认值。

### 移动任务路由（`src/routing/task-projection.mjs` / `task-selection.mjs` + `src/inbound/conversation.mjs`）

- `projectTasks` / `tasksSnapshot` 提供只读任务视图（taskRef / workspace / status / attention / lastActiveAt / boundChannels），聚合会话注册表与 agent 状态，不暴露敏感数据。
- `createTaskSelection` 处理多任务歧义：选择卡（selection card）+ pending 状态（`state.json` + 内存优先），用户显式选定后才投递，杜绝错投。
- 会话路由接入 `/tasks`（列任务）与 `/use`（切换目标）命令，歧义前置与省事选择回执收进统一入站处理链。

### 图片进入 DSH 会话（`src/inbound/message.mjs`）

- 统一入站消息模型补 `image`/`file` 附件归一：结构化 `{ url, width?, height? }` 与 `{ name?, url?, size? }`；缺 url / 未知结构 fail-closed。
- `normalizeInboundMessage` 保留既有 text + 合法图片双载，不再因「有文字」丢图；`normalizeImageUrl` 做受控下载校验（永拒主机名/后缀、私有/回环/链路本地/ULA IPv6，含 IPv4-mapped IPv6 的 SSRF 绕过防护、尺寸与类型上限、超时）。
- 图片受控下载失败不阻塞文字投递，经 `onImageFailure` 给用户失败回执（见对抗性 review 修正）。

### 管理台暴露 DSH 连接与任务状态（`src/admin/api.mjs` / `server.mjs`）

- 新增 `GET /api/tasks`：返回当前任务投影快照（脱敏只读视图）；`GET /api/host`：返回宿主能力快照。
- 查询方法红线：绝不抛——宿主 `ctx` 是抛错代理 / getter 时降级为全 `unknown` 的安全最小快照，不让异常冒泡到 HTTP 层。

### 对抗性 review 修正（v0.10）

- 修图片 URL SSRF 绕过：IPv4-mapped IPv6（如 `::ffff:127.0.0.1`）此前只走 IPv6 前缀判断漏过，现提取内嵌 IPv4 后按私有/回环/链路本地区间拒绝。
- 管理台 `getHostCapabilities` 增防御 try/catch，宿主上下异常时返回安全默认快照。

## [0.9.7] - 2026-09-12（codex/pr22-issue23-fix 收口）

入站交互可靠性修复线：Telegram `ask_user` 单选卡片补「自定义回答 / 跳过」按钮并修 ref 泄漏与来源校验缺口（PR #22），QQ 网关心跳时序死循环修复（Issue #23）。`npm test` 为 **1548**（1548 pass，较 0.9.6 基线 1544 净 +4；Telegram/QQ 心跳与点击链 focused 回归 117 + 45 项全绿）。两项修复均为 mock/contract 证据；Issue #23 依据真机 A/B 证据（网关只对 READY/RESUMED 之后的心跳回 ACK）实现，但**未在本代码库重跑真机 soak**——真机验证缺口见 `docs/memory/risks.md`。

### 修复：Telegram ask_user 单选卡片「自定义回答 / 跳过」按钮 + ref 回收与来源校验（PR #22）

- `src/inbound/telegram-bot.mjs` `sendQuestionCard()` 在选项按钮之后追加 `✍️ 自定义回答`（`c`）与 `⏭ 跳过`（`s`）两个辅助按钮，继续沿用 `buildQuestionAction()` 与 `r:<ref>` 短引用链，不另造协议。
- **引用回收**：本次卡片为选项与两个辅助按钮铸造的全部 callback ref 记录进 `cardRefs`；容量中途耗尽时、辅助按钮铸造失败时、以及 `sendMessage` 抛错/返回失败时，均完整回收本次已铸全部 ref 后降级编号通知，仅真正发送成功才保留 ref 供点击链单次核销（不再泄漏到 TTL）。
- **来源/token 校验**：`src/questions/router.mjs` `handleCardAction()` 对 custom/skip 分支补 token 有效性（过期/畸形/错签名）、`token.key === qKey`、ledger 存在且 `status === 'pending'`、以及 `(channel, accountId, userId, chatId)` 精确来源匹配（`pushedTo` 中存在 `accountId` 时必须匹配）；来源字段缺失、旧卡、已答、已过期、错误账号/用户/聊天全部 fail-closed 并给出安全提示。custom 只回指引（`答：<内容>`），不直接结算；真正文本回答仍走 `settleText()` / Control Core / `bus.settle` 首达采纳。
- 修复来源 fail-closed 闸只查 `null`、漏掉 `Array.prototype.find` 返回 `undefined` 的越权放行。
- 新增 focused regression：错 key token / 过期 token / 已决问题 / 错误 chat / 错误 account 均 fail-closed，正确来源只发指引不结算，随后 `答：` 文本正常落账。

### 修复：QQ 网关心跳时序死循环（Issue #23）

- `src/inbound/qq-gw.mjs`：`OP_HELLO` 只记录本连接的 `heartbeat_interval` 并发送 IDENTIFY/RESUME，**不再立即启动并发送首拍心跳**（真机 A/B 证据：QQ 网关只对鉴权完成、收到 READY/RESUMED 之后发出的心跳回 `OP_HEARTBEAT_ACK`，提前起搏永远收不到 ACK 而死循环）。
- 心跳起搏拆为 `recordHeartbeatInterval()` + `armHeartbeat()`：收到 `READY` 或 `RESUMED` 后才幂等启动定时器并立即发送第一拍（携带当时最新 `lastSeq`）；重复 READY/RESUMED 不会创建多个定时器或重复首拍。
- `beat()` 语义修正：上一拍未 ACK 且未达到 `maxMissedAcks` 时记一次 miss、告警，但仍继续发送下一拍（保持恢复路径，不再提前 `return` 卡死）；只有达到阈值才 `cleanupSocket()` 并按既有语义走 RESUME 优先重连，该拍不再发送；收到任意有效 `OP_HEARTBEAT_ACK` 后清零等待与连续 miss 计数。
- **连接级状态隔离**：`heartbeatIntervalMs`/`heartbeatArmed`/`awaitingAck`/`missedAcks` 均为连接级，`cleanupSocket()` 复位；`connect()` 的 message 监听器按连接身份 `conn` 比对，旧连接迟到 ACK 不再取消已决策重连、也不污染新连接；`stop()` 增补清心跳状态，restart 后能重新正常握手与起搏。
- 保留现有关闭码分支、退避、token、sessionId、lastSeq 与 fail-safe 行为；未顺手重构其他 QQ 协议代码。
- 测试：删除「HELLO 后立即心跳」旧契约，新增 HELLO→IDENTIFY-only、READY/RESUMED 才首拍、RESUME→RESUMED 起拍、重复 READY/RESUMED 不双定时器、单拍丢失下一拍仍发、旧连接迟到 ACK 不污染新连接等回归。

### 真机验证缺口

- Issue #23 全部为 mock/contract 证据，未跑新的真机 soak；`docs/memory/risks.md` 登记「自动化验证不等于真机复验」及 4 项待观察点 + 1 项接受的残留（鉴权前 liveness watchdog 移除后，HELLO 后静默挂起依赖 TCP 层超时）。
- Telegram PR #22 点击链为 contract-tested；真机 Telegram 客户端按钮回调与 `答：` 文本续答未复测。

## [0.9.6] - 2026-09-12（codex/admin-zero-config-onboarding 收口）

「零配置首访」特性线：安装后不写 YAML——打开终端打印的启动链接，选通知渠道、填凭证、当场收到测试通知；远程控制以后再配。`npm test` 为 **1544**（1544 pass，较 0.9.5 基线 1531 净 +13；`admin-ui-behavior` 套件按新鉴权/向导契约整体重写为 46 项）。

### 后端（装配/API）

- **admin 默认启用**：`cordis.patch.yml` 补 `admin.enabled: true`，新安装零 YAML 即带管理台。
- **fragment 启动链接（launchToken）**：`src/assembly/admin-token.mjs` 首启生成路径额外产出本次进程内有效的明文 `launchToken`；`src/index.mjs` 在 server 取得真实端口后打印 `http://127.0.0.1:<port>/#token=...`——token 只在 fragment，不进 query / Referer / 访问日志；显式/复用 token 路径不打印（恒 null）。
- **端口冲突自动回退**：`src/admin/server.mjs` `start()` 遇 `EADDRINUSE` 在同一 server 生命周期内先 close 清理半启动状态，再以 `port: 0` 内核分配重试；仍只绑 127.0.0.1，Origin/Host 白名单按实际端口构建，就绪行打印真实地址。
- **出站 state 键域分域**：新键 `admin:channel:<type>:outbound`（`src/assembly/outbound.mjs`），与非双域旧键 `<type>:account` 及 YAML bootstrap 按优先级合并（admin 出站键 → 非双域 account → YAML）；双域通道（feishu/dingtalk）出站/入站键域彻底分离，网页编辑出站不再触碰入站扫码凭证。
- **方向明确 API**：新增 `PUT/DELETE /api/channels/outbound/:type`、`POST /api/channels/outbound/:type/test`、`PUT/DELETE /api/channels/inbound/:type`；旧 `/api/channels/:type` 路由原样保留兼容（双域 webhook 422 限制只约束旧路由）。
- **即时真实测试**：`testOutboundChannel` 现场合并「当前 YAML 原文 + 当前 state 出站键」后调 `channelTest(type, rawConfig)`——保存后无需重启即可真实测试投递；投递层并入运行时仍维持「重启后生效」（G-14 语义不变）。

### 前端（管理台 UI 重构，src/admin/ui/ 三件套）

- **源码拆分**：`ui.mjs` 只做组合，`ui/theme.mjs`（「信号中枢台」视觉：深空底色 + 信号青主色 + 广播塔脉冲标识）、`ui/markup.mjs`（页面骨架）、`ui/client.mjs`（浏览器端逻辑）；仍为零构建、无 CDN、自包含单文件 HTML。
- **解锁门取代 window.prompt**：无 token / token 失效一律站内解锁门（`#gate`），认证 token 验证成功后只写 sessionStorage（绝不写 localStorage），受限环境退化页面内存；401 清 token 回解锁门，单飞共享、至多自动恢复一次。
- **首访三步向导**：选渠道（推荐瓷砖优先、入站渠道不进向导）→ 填凭证（必填标星、`***` 视为未修改不提交）→ 保存并当场真实测试，送达才视为初始化完成；明确「保存成功 ≠ 通知可达」。
- **信息架构重排**：首页（链路状态 / 下一步行动 / 健康矩阵 / 提问 / 审计流）→ 通知渠道（出站主、入站次）→ 成员 → 通知；绑定矩阵与会话收进「打开高级设置」（默认隐藏）。移动端自适应与焦点/ARIA 语义保留。

### 测试

- `test/admin-ui-behavior.test.mjs` 整体重写（46 项）：fragment 凭证静默验证、先清地址栏再写 sessionStorage、解锁门路径、401 单飞恢复、首访向导全链路（选渠道/必填校验/保存并测试/失败保留输入重试）、个人模式默认值与高级设置显式入口。
- `test/admin-api.test.mjs` / `test/admin-wiring.test.mjs`：新方向路由、出站键域优先级、双域 editable 语义、即时测试合并配置。
- `test/personal-ux-api.test.mjs`：泄密判定改为「口令框不得预填值」（解锁门 `type="password"` 是掩码输入正当用途）。

### 已知残留

- `docs/screenshots/admin-*.png` 旧版实拍已随新 UI 上线删除（README 双语引用同步移除）；新 UI 真机截图待拍后回补。
- 版本号与 `dshQuality.testCount` 已在 v0.9.6 收口为 `1544`（1544 pass，发布门通过）。

## [0.9.5] - 2026-08-28

R5「测试保真与文档」修复列车（80 项清单 W13：G-57/G-58/G-59/G-60/S-11/S-13 + mock 分层原则）。全部为 mock/contract 证据，协议类修复未经真机验证（真机缺口登记 `docs/memory/risks.md`）；`npm test` 为 1531（1531 pass，同 0.9.4——本批为测试与文档面）。

### W13 测试保真与文档

- **G-57 脚本重命名**：`scripts/test-channel.mjs` → `scripts/channel-selfcheck.mjs`——`test-*` 前缀会被 Node 22 裸 `node --test` 默认 glob 误吞；README/AGENTS/ADAPTER/OPERATIONS/CI 引用全同步。
- **G-58 mock 保真**：qq FakeWebSocket 补 error 事件/半帧垃圾帧支路（error 不直接调度重连、非法帧不崩握手）；public fetch mock 补超时支路（AbortError 与 G-50 TIMEOUT+noRetry 分类同构）；mock 分层维护规则（协议合约 fixtures / 传输 fake / 业务断言三层分离）写入 `docs/TECHNICAL_DEBT.md`。
- **G-59 三新测试套件**：`test/health.test.mjs`（渠道自检错误形态/SSRF 拦截/凭证缺失指引/`${ENV:}` 解析）、`test/escalation.test.mjs`（升级链阶段推进/mock timers/多 key 独立/重启清计时器）、`test/pairing.test.mjs`（配对码锁出新语义：过期码不翻锁、无效码 5 次锁出、TTL/审计/隔离）。
- **G-60 文档缺口**：README 两语言补全会话命令 11 条带边界说明；guide.md 排障新增 accountId 来源规则（绝不 channel 兜底、多账号显式配置）。
- **S-11 hook-server 排除出包**：package.json `files` 从含整个 `scripts` 目录改为显式列举 6 个发布脚本，`hook-server.mjs`（127.0.0.1 + 512KB cap 开发用）不随包分发；verify-release 增加发布脚本显式列举校验。
- **S-13 optional 依赖锁定**：`@larksuiteoapi/node-sdk` `^1.61.1` → `1.73.0`（已审查版本）、`qrcode-terminal` → `0.12.0` 精确锁定；移除 UNLICENSED 的 `@tencent-connect/qqbot-connector`（维持「仅参考不引入」决策）。

### 已知残留（登记 `docs/memory/risks.md`）

- 沿用 R4 的 SSRF DNS rebinding 竞态、单 token 模型固有边界、G-19 scoped 事件契约未定、G-47 首见基准内存态四条残留。

## [0.9.4] - 2026-08-28

R4「配置收敛与入站生命周期」修复列车（80 项清单 W10/W11/W12 共 25 项）。全部为 mock/contract 证据，协议类修复未经真机验证（真机缺口登记 `docs/memory/risks.md`）；`npm test` 为 1531（1531 pass）。

### ⚠️ 破坏性语义变化（迁移说明）

- **出站配置「视图热、投递冷」（G-14）**：管理台保存出站渠道凭证后 UI 即时回显并标「重启后生效」——投递层只在插件下次启动时并入运行时（YAML ⊕ store 合并）。**此前「保存即生效」的认知作废；重启前保存不影响已运行的出站链路。**
- **配对码过期不再计入 5 次失败锁出（G-30/31）**：过期码单独分支回执「码已过期」，不翻锁——能提交过期码说明曾真实持有在铸码，不是爆破信号；防泵码由引导码重铸 10min 节流单层兜住。**依赖「过期码 5 次锁出」的用户不再生效（无效码仍计失败锁出）。**
- **合成消息 id 语义（G-46/G-27）**：无消息 id 回调（wxpusher 等）的合成幂等键从 24h 长窗改 60s 短窗；wxpusher 键追加进程内单调 seq——同一秒内同文本的两条真实消息不再互吞（传输层重投去重让位，幂等由业务层兜底）。

### W10 配置校验与渠道枚举收敛（G-13/S-12/G-61~64/G-32/G-38/G-39/G-45/G-28）

- **G-13 渠道枚举唯一来源**：新增 `src/inbound/channels-registry.mjs` 冻结数组，identity/target-guard/assembly/admin 四处硬编码改引——新渠道单点注册。
- **S-12 target-guard 未知渠道 fail-closed**：未知出站渠道从放行改为拒绝 + warn（对齐入站默认拒绝红线）。
- **G-61~64/G-32/G-38/G-39/G-45/G-28 配置形态收敛**：数值字段 `type:'number'` 声明；pushplus template/channel 白名单；webhook headers 值字符串化；desktop sound 布尔形态全表解析；`_bounded` max 非数字回落调用方默认；slack 仅 Incoming Webhook 显式报错；discord >2000 码点 fail-fast；postText 补 `content-type`；iLink contextToken 缺省 warn。

### W11 入站生命周期与交互健壮性（G-15/G-46/G-16/G-17/G-18/G-26/G-27/G-30/31/G-34；G-19 取证登记）

- **G-15 bus 消费优先级显式化**：`MESSAGE_PRIORITY` 冻结常量（cardAction=10/numberedReply=20/default=50/conversation=100），五处注册点显式传参 + 同 priority 注册序稳定排序——暗契约转明契约。
- **G-16 重启残留审批失效告知（D4）**：启动扫描 `ap:` pending 行 → 标记 expired + 向 pushedTo 目标补发「该审批因宿主重启已失效，请回桌面处理」；补发失败仅 warn 不阻塞启动。
- **G-17 飞书卡片 TTL 兜底**：卡片 value 增带签发时间 `iat`，回调超 15min（对齐 TG refs）拒绝 + toast 指引；升级前在途缺 iat 卡片 warn 后兼容放行。
- **G-18 event-listener 去重键按 intent 分离**：approval/asked 键追加负载摘要（同 seq 不同负载不再互吞）；turn 类维持现状。
- **G-26 非文本消息静默忽略 + 回执**：飞书非文本消息不再注入占位符文本进 agent 语境（注入面关闭），回执「暂不支持该消息类型」尽力而为。
- **G-27 wxpusher 合成键单调 seq**：同秒同内容两条真实消息不再互吞（60s 窗语义内放行双消息）。
- **G-30/31 过期码单独分支**：见上文破坏性变化。
- **G-34 双路径通知双响封口（D5）**：卡片/编号裁决成功后同 key 文本线（广播 + 升级链）5min 抑制窗口——点过卡片不再收到「仍在等待批准」。
- **G-19 scoped 事件契约（取证登记，不改码）**：C 轮 cordis 源码证据（`events.ts:165-175` context filter、`agent/disposed` Scoped）与现有 root 订阅策略存在张力，但源码不在仓库、真机未验证——按计划登记 `docs/memory/risks.md`，行为保持 scope 诊断 + root 回落，留真机回归项。

### W12 存储与状态（G-20/G-47/G-44/G-14/S-14/S-04）

- **G-20 配对码铸造单次原子写**：mint 的 minted→active 双写崩溃窗口（孤儿码可被核销）合并为单态 `minted-active` 一次落盘；审计行独立写不影响状态一致性。
- **G-47 route:sessions 出站覆盖行 30d TTL**：无 disposedAt 的覆盖行（/quiet、管理台覆盖）30d 不活跃即清（宿主活跃会话护栏不误删）；disposed 行到期摘除时保留出站覆盖字段——静默配置不随会话回收丢失。
- **G-44 坏绑定键启动清洗**：启动一次性清洗坏形状/幽灵键 + 写回 + warn 计数；只动 `inbound:bindings`，绝不动 `inbound:migrated`——「启动损坏白纸重置」下已删成员不复活（放大面测试钉死）。
- **G-14 出站配置视图热/投递冷**：见上文破坏性变化。
- **S-14 ledger.resolve 前态不设防**：已终态行二次 resolve 返回 `already-resolved` 不再翻转；actions 多步落地走 `claimedSettle` 显式逃生门。
- **S-04 凭证明文落盘缓解加固**：store 加载前 mode 自检——非 0600 warn + chmod 收紧尝试（失败仅 warn 不阻塞启动）。

### 已知残留（登记 `docs/memory/risks.md`）

- 沿用 0.9.3 的 SSRF DNS rebinding 竞态、单 token 模型固有边界两条残留。
- **G-19 scoped 事件契约未定**：见上文——需真机/宿主源码复验后才决定 root 订阅、双订阅或 payload 兜底策略。
- **W12 G-47 纯覆盖行首见基准内存态**：重启后重新起算 30d，最坏多留一个运行周期（30d 量级可接受）。

## [0.9.3] - 2026-08-28

R3「安全中危加固」列车（80 项清单 W9：S-02/S-05/S-06/S-07 四项）。全部为 mock/contract 证据，协议行为未经真机验证（真机缺口登记 `docs/memory/risks.md`）；`npm test` 为 1478（1478 pass）。

### 🔒 Security

- **S-02（CWE-918）SSRF 防护**：新增 `src/adapters/_urlguard.mjs`——用户可配 URL 的渠道（webhook / slack / discord / wecom / mattermost / gchat / teams / ntfy / gotify / chanify / pushdeer）发送前三道闸：scheme 白名单（http/https）、私网/保留段拦截（IPv4 十五段直查 + IPv6 窗口比较 + `::ffff:` v4-mapped 与 NAT64 内嵌递归）、域名 `dns.lookup({all:true})` 全地址校验（60s 短 TTL 缓存）。`0x7f000001` 这类非常规四进制写法经 DNS 路径同样拦截。**逃生口**：`allowPrivateNetwork: true` 显式放行内网自托管接收端；onebot（`ssrfGuard: 'private-ok'`）因渠道本质是本机服务（文档默认 `http://127.0.0.1:3000`）默认放行。重定向绕过面同步关闭：`_shared.mjs` 全部出站 fetch 改 `redirect:'manual'`，3xx 显式报错拒绝跟随。
- **S-05（CWE-200）出站片段脱敏**：新增 `src/redact.mjs`——自动状态推送（不是用户显式 notify）默认 `redaction: 'minimal'`：宿主会话摘录 200→80 字符（尾沿截断，结论通常在最后）+ 密钥形态打码（JWT/sk-/ghp_/xox/AKIA/Bearer/32+ hex/40+ base64 → `***`）；审批推送 reason 同打码。`redaction: 'extended'` 显式维持原文（README 已声明数据流向）。拼错值一律回落 minimal——安全配置的非法值不配得到宽松解释。
- **S-06（CWE-352/942）admin Origin/Host 闸**：Bearer 模型下补第二道纵深——浏览器跨站请求必带的 Origin 头不在白名单 → 403（先于鉴权与路由，不泄露路由存在性）；Host 头校验挡 DNS rebinding（受害者浏览器被解析到 127.0.0.1 时 Host 是攻击者域名）。回环绑定自动放行 127.0.0.1/localhost/[::1] 三形态（实际端口、http/https 双 scheme、无端口形态）；公网反代场景用 `allowedOrigins`/`allowedHosts` 显式注入。非浏览器客户端（curl 无 Origin）放行，由 Bearer 鉴权兜底。
- **S-07（CWE-74）回答内容边界**：ask_user 自定义回答（`答：...`）入口补与身份链正交的内容闸——2000 Unicode 码点上限（码点计数，非 UTF-16 单元；emoji/中文按人类感知计），超长 fail-closed 拒绝（绝不静默截断——半句话的回答比没有回答更危险）+ 回执指引；控制/零宽/bidi 不可见字符剥离（对人类不可见，却是注入载体；`\n\t\r` 保留）。前置检查在 Control Core 之前回执（不白跑一轮裁决），`settleText` 内同闸兜底。

### 已知残留（登记 `docs/memory/risks.md`）

- **SSRF DNS rebinding 竞态**：urlguard 校验与 fetch 建连之间存在理论竞态窗口（校验后 DNS 记录被换到内网地址）。完全闭合需自定义 dispatcher 钉死 IP，超出零依赖约束；60s 短 TTL 缓存压观测窗口，中危定级下属可接受残留。
- **单 token 模型固有边界**：持有 admin token 的攻击者可同时改 URL 与 `allowPrivateNetwork` 开关——urlguard 挡的是默认路径与配置被钓后的低成本内网跳板，不防已持 token 者（S-09 范畴）。

## [0.9.2] - 2026-08-28

R2「投递与凭证可靠性」修复列车（80 项清单第二批 13 项：W6/W7/W8）。全部为 mock/contract 证据，协议类修复未经真机验证（真机缺口已登记 `docs/memory/risks.md`）；`npm test` 为 1447（1447 pass）。

### ⚠️ 破坏性语义变化（迁移说明）

- **投递超时不再重试（G-50）**：超时 = 请求可能已到达，重试即 at-least-once 重复通知。现在超时统一标记 noRetry（错误码仍 TIMEOUT，文案「结果未知，不再重试」）；确定性失败（连接拒绝/明确 4xx/5xx）维持重试。**依赖「超时后自动重试」的用户需自行评估是否补发**。
- **token TTL 非法值 fail-closed（G-55）**：上游返回 `expires_in` 为 0/负/非数值时，qq-bot/wecom-app/钉钉入站/qq 网关四处不再各自 `|| 7200` 静默吞掉——统一抛错让投递失败并告警。上游损坏必须可见，不得拿默认值掩盖。
- **QQ 网关 INVALID_SESSION 可恢复会话不再弃（G-21）**：op9 带 `d:true` 时保留 session 走 RESUME；`d:false` 才重新 IDENTIFY（对齐官方 SDK）。

### W6 出站投递语义（G-50/08/09/56）

- **G-50 超时不再盲目重试**：`postJson`/`postForm` 超时统一 `timeoutNoRetryError`（noRetry=true）——重试会把「可能已送达」变成「必然重复送达」。
- **G-08 平台限流退避**：HTTP 错误体解析 `parameters.retry_after` 附着 `retryAfterMs`，重试退避取 max(指数退避, retryAfterMs)；Telegram 入站 `api()` 同附着。
- **G-09 Server酱 SC3**：`sctp` 前缀 SENDKEY 走 `sctp.ftqq.com` 域名；`sct`/`sendKey`/`sctKey` 三别名同时配置按 sct > sendKey > sctKey 取值并 stderr 出声一次。
- **G-56 qq-bot 2xx 非 JSON**：解析失败抛 `BAD_UPSTREAM_RESPONSE` + stderr，不再乐观当成功；msg_seq 冻结语义维持（失败不推进，重试幂等）。

### W7 错误可见性分层（G-53/54）

- **G-53 publicMessage/detail 分层**：错误对象区分对外话术（通知/回执用，不含上游原文与凭证碎片）与对内明细（日志用）；`health` 与 `notify` 各取所需。
- **G-54 渠道名映射**：对外话术用中文渠道名（「钉钉」「企业微信」而非 `dingtalk`/`wecom-app`）；`verdict-text` 统一生成，`bus.mjs` 枚举零改动。

### W8 token 与网关生命周期（G-11/55/29/07/21/12）

- **G-11 代际守卫**：`invalidate()` 递增 generation 并清 inflight；在飞任务写回前比对代际——旧任务晚完成不再把被吊销 token 连同 7200s TTL 写回缓存。
- **G-55 TTL 归一单一实现 `normalizeTtlMs`**：非有限/≤0 抛错，正数钳制 [1s, 7d]。同值不同命终结：0 曾在 qq 层活 7200s、wecom 层活 1s、feishu-register 变立即超时（本地配置不炸 CLI：回退默认 480s 并出声）。
- **G-29 动态刷新余量**：余量 = min(配置值, 剩余寿命 20%)——TTL < 60s 的渠道不再「永判不新鲜」每发必取 gettoken。
- **G-07 QQ 关闭码分支表**：4004 作废 token + 弃会话（全文件首处 `tokens.invalidate()`，不再带死凭证无限重连）；4008 固定 60s 等待窗（限流码走短退避反而雪崩）；4006/4007/4009 弃会话重 IDENTIFY；其余现行为。
- **G-21 INVALID_SESSION 看 d 标志**：见上文破坏性变化。
- **G-12 iLink 轮询假死看门狗**：在飞 getupdates 超 longPollTimeoutMs + 宽限仍未返回即 abort 强制断开重试（连续 kick 计数可观测）——TCP 活着但服务端不推消息的假死从「完全静默」变「可检测」。

## [0.9.1] - 2026-08-28

R1「正确性第一线」修复列车（20 轮审查 80 项清单的第一批 18 项）。全部为 mock/contract 证据，协议类修复未经真机验证（真机缺口已登记 `docs/memory/risks.md`）；`npm test` 为 1414（1414 pass）。

### ⚠️ 破坏性语义变化（迁移说明）

- **`/stop` 收紧为无参命令（G-04）**：此前 `/stop 任意文字` 会误触发任务取消——用户一句「/stop 一下别急」就把长任务杀了。现仅裸 `/stop` 命中取消；`/stop 附言` 回执「未识别的命令」且附言按普通文本投递。**依赖「/stop + 文字」取消的用户须改发裸 `/stop`**。
- **未知 `/` 命令现在有回执**（G-04 副作用）：此前静默按普通文本投递；现在先回执「未识别的命令」（文本仍会送达 agent）。
- **裸编号多选消费面扩大（G-52）**：`1 3`、`1、3`、`1;3`、`1, 3`（分隔符混用）现在按多选裁决；此前被当普通文本喂给 agent。授权闸不变（fail-closed 语义不变）。`1, 1` 在单选题直接按 1 作答（去重）。
- **`/agent use` 支持含空格名（G-33）**：`/agent use my space` 整体作为目标名；此前只用首词。

### W1 钉钉 Stream 协议修正（G-01/02/10/23/24/42，P1×2）

- **G-01 ack 回执三重偏差**：messageId 改读 `frame.headers.messageId`（顶层无该字段，旧实现读顶层恒为空）；回执头字段名 `requestId`→`messageId`；`data:'ack'`→`JSON.stringify('OK')`。仲裁源：dingtalk-stream 2.1.4/2.1.6-beta.1/2.1.7-beta.1 三版 SDK 源码核对，证据沉淀 `docs/protocol-preflight/dingtalk.md`。旧测试 mock 把错误契约钉死成基线，已重写（headers.messageId 形态钉契约）。
- **G-02 SYSTEM/ping 零应答**：新增 SYSTEM 帧分支——ping 原样回显 headers+data（含必须回显的 opaque），disconnect/KEEPALIVE/REGISTERED 记 debug 后不进业务。应用层 SYSTEM ping 与传输层 WS 心跳是两码事，注释写明不得合并。
- **G-10 建连字段名**：`uesrAgent`→`ua`，删除「官方 SDK 拼写错误照抄勿改」的错误注释（三版源码核对查无实据，全系 `ua: this.config.ua`）。
- **G-42 data 二次 parse 失败静默**：warn（含 messageId/type/前 64 字符）后仍丢弃——ack 已发则服务端不重推，丢消息至少可观测。
- **G-23 richText 归一**：richText 消息遍历内容模块，text 段拼接、图片段走既有管线；downloadCode-only 图片段 fail-closed 丢弃（换 URL 需另调文件下载接口，超出本批次）。纯文本/纯图行为不变。
- **G-24 被动回复 messageId 碰撞**：hash6(content) 合成改 `dt:reply-<ts36>-<seq36>` 模块级单调序，同会话同内容两次回复不再同 ID。

### W2 码点安全分段统一（G-03/22/40）

- **G-03+G-22 同根**：新增 `splitByCodePoints` helper（`Array.from` 码点语义），微信 iLink 发送、QQ 文本分段（2000 码点）、QQ Markdown 截断（3000 码点）三处 UTF-16 码元切片全部改用——星体平面字符（emoji/生僻字）跨块不再产生孤立代理项。ZWJ 序列拆为多个完整码点属可接受降级（注释说明）。
- **G-40 stripMention 白名单化**：仅剥已证实形态（`<@!数字>`/`<@数字>`/行首 `@名字+空格`），未命中但形似提及保留原文并 debug 出声——@ 残片污染 agent 语境从「静默漏剥」变「日志可见」。
- **G-22 被动回复配额 warn**：QQ c2c 4 条/群 5 条配额常量 + 超限 warn（平台静默丢弃，先让丢弃可见），不硬阻塞。

### W3 命令解析矩阵修正（G-04/06/25/33/43/52/65）

- **G-06 `/cmd@botname` 支持**：命令词 @ 后缀贪心剥除（涵盖含点号 botname）；TG 群聊/钉钉入站 @ 剥离同修。`/pair@bot code` 剥离后 args 干净。
- **G-65 全角斜杠**：`／pair` 规范化为 `/pair`（仅首字符）；命令附言保留在 args。
- **G-43 缺 chatId 裸编号黑洞**：fail-closed 消费后补指路回执（「请回到原卡片回复或使用管理台裁决」），裁决结果不受影响。
- **G-25 飞书 @提及还原**：依据事件 mentions 映射把 `@_user_N` 占位符还原为 `@名字`（非删空），双空格消失；事件无 mentions 时退回旧行为。三渠道 @ 策略差异（TG/钉钉剥离、飞书还原、QQ 白名单）注释写明。

### W4 管理台裁决审计隔离（G-05/41）

- **G-05 审计失败不再翻转为 500**：本文件全部 9 处 `appendAudit` 调用点经统一 `auditGuard` 兜底——审计写失败只 warn（host logger + stderr），已生效的裁决结果照常返回。取舍：审计是可观测性副作用，裁决已生效的事实不能被磁盘满推翻；降级经 warn 可观测。
- **G-41 裁决接收人校验去门控**：删除 `targets.length > 0 &&` 前置——pushedTo 空表同样执行 userId 比对并 fail-closed 回拒（「未找到该审批的投递记录，无法核验回复来源，请回桌面处理」）。空表意味着无法证明投递对象；临时空表退化为「拒绝直到账本一致」，方向与 fail-closed 一致，只收紧不放宽。

### W5 合并窗与身份路由键（G-51/48/49）

- **G-51 合并窗跨 chat 串台**：pending/flush 键从 `(channel,userId)` 加宽为 `(channel,userId,chatId)`——同一用户私聊+群不再并线成一条混合投递。chatId 缺失仍聚合（现状语义）。内存上界分析：键基数=窗口内活跃 chat 元组数，每条配对冲刷 timer，无无界增长路径。
- **G-48 覆盖绑定摘旧挂钩**：`/bind`、`/agent use` 覆盖绑定前先经 registry 既有 `detachInbound` 摘旧会话入站挂钩（幂等），`/route` 不再一 user 双挂。
- **G-49 身份键归一**：新增单一 `bindingKey(channel, userId)`（trim + channel 小写收敛，userId 保持大小写敏感——wxpusher/飞书 ID 大小写语义真实），conversation/agent-router/identity/registry 四处键构造改引。现网行为零变化（休眠边界封口），回归测试保护。

## [0.9.0] - 2026-08-27

- 2026-08-27 v0.9.0 release candidate：汇总维护、Control Core 安全收口、六条入站通道契约、个人模式管理台和文档整理；`npm test` 为 1352（1351 pass + 1 skip），版本/测试计数已统一到本候选发布线。

- 2026-08-27 收尾修复：管理台远程提问结算改为传递对象给统一 `api()` 序列化（修复预序列化导致 POST 双重 JSON 编码、服务端丢失 action/options 的真实缺陷），并改用属性匹配查找按钮，恶意/畸形 ref 不再触发 CSS selector 异常。WxPusher 管理台出入站字段新增可选非敏感 `accountId`，支持多应用来源绑定且明确不得填写 APP_TOKEN；YAML/store 显式值覆盖关系保持不变。补充 focused 回归测试；无版本、协议或真机验证声明变更。

- 2026-08-27 final maintenance rerun: admin pairing-code revocation now requires explicit confirmation before issuing the destructive DELETE. Focused admin UI coverage is 33/33 after the settlement/accountId compatibility checks; full `npm test` is 1352 total (1351 pass + 1 skip). No version or provider-support claims changed.

- 2026-08-27 compatibility closure: retained YAML `inbound.allowUsers` as a documented one-shot `inbound:migrated` migration (no silent re-seeding after runtime deletions), added an optional Feishu/QQ SDK seam and lifecycle matrix, and documented the WxPusher multi-account residual when multiple apps omit explicit local `accountId`. Evidence is contract/seam tests only; no provider, tenant, or real-device support claim is added.

- 2026-08-27 public facade A3/A4 hardening: `sourceName` is trimmed, length-limited, and control-character safe; each notifier instance now enforces finite call/UTF-8-byte/concurrency/queue budgets shared across facade wrappers, with busy/budget denials isolated to the current call. The consumer facade is deeply contract-stable and frozen (`version`, `enabled`, `push`, `flush` only); teardown is private and registered through the host lifecycle. Focused coverage exercises label rotation, Unicode byte limits, queue saturation, disposal races, and strict mutation failure. No package version change; provider/device validation remains out of scope.
- 2026-08-27 inbound callback capacity now fails closed when the bounded reference table is full instead of evicting live buttons; Telegram card builders degrade to text/fallback when references cannot be minted. The package root export is narrowed to `{ name, inject, apply }`; constructors remain available only through the explicit `dsh-notifier/internal` path for local tooling/tests. No OS isolation is implied; same-process hostile plugins remain a host trust-boundary risk.
- 2026-08-27 协议预审落地之后的渠道适配安全收尾（`docs/protocol-preflight/` 为事实边界，不改协议猜测；全部 mock/contract 证据，无真机验证）。聚焦 + 全量测试通过：**npm test = 1346（1345 pass + 1 skip）**，`verify-release`（909）/`gen-channel-matrix --check`（27 渠道）/`node --check src/index.mjs`/`git diff --check` 全绿。修掉的 7 个失败为 HEAD 预存（phase-1 源码硬化后的测试断线），本次一并修复：
  - **wxpusher 入站注入本地 accountId（`src/inbound/wxpusher-callback.mjs`）**：六个交互通道里唯一 format envelope 不带本地 accountId 的通道——修复前 WxPusher 的审批/提问编号回复自来源绑定硬化（`79ebf70`）后全部 fail-closed（消费但永不裁决，远程审批/提问形同虚设），且会话路由把 channel 名当账号。修复：`resolveWxpusherInboundConfig` 接受可选 `accountId`，`createWxpusherInbound` 缺省字面量 `'default'`（与 telegram 回退语义一致），envelope 与通道实例都携带该本地标识；绝不从回调自报的 `data.appId` 取号。
  - **移除全部「把 channel 当 accountId」兜底（`src/inbound/conversation.mjs`、`src/control/entry.mjs`、`src/actions.mjs`）**：会话路由 `route()` 的 `accountId: String(envelope.accountId ?? envelope.channel ?? '')` 与 `pendingMeta` 的 `accountId ?? channel` 都改为缺省即缺失，由 `normalizeControlEvent` 以 `missing_accountId` fail-closed 拒绝；`actions.dispatch` 此前把传输层传入的本地 accountId 丢掉（telegram/feishu ac: 回调入 Control Core 的载荷没账号），现原样转发（缺失传空串 fail-closed）。
  - **telegram/飞书直接按钮回调把提供方真实 eventId 传入 Control Core（`src/inbound/telegram-bot.mjs`、`src/inbound/feishu-bot.mjs`）**：修复前 `ap:`/`aq:` 直接回调的 `control.handle` 不带 `eventId`，而 approval/question spec 的 `buildEvent` 直取 `input.eventId` → `normalizeControlEvent` 以 `missing_eventId` 拒绝——仅当你以 mock 断言「不进入裁决」时光绿，真机/接线后按钮全部失效。telegram 用官方 `callback_query.id`；飞书用 `context.open_message_id + operator.open_id + act` 合成稳定 eventId（同卡片重复投递去重、不同动作/操作者互不抢占）。
  - **questions 编号回复真实缺陷（`src/questions/router.mjs`）**：① 缺 chatId 的 fail-closed 分支此前丢失 `envelope.accountId`，pushedTo/hintTargets 带账号时 `accountMatches` 恒 false → 已绑定用户的裸编号不被消费（泄露进对话路由）；现在把 accountId 一并传给 `latestPendingFor`。② 编号作答成功回执原读不存在的 `verdict.answers`（Control Core 回执是通用形状）→ 出现「✅ 已作答：」空标签；改为从已结算账本行回读 `answers`。
  - **测试契约对齐（生产恒接线 Control Core）**：`test/approval.test.mjs`、`test/approval-phase2-hardening.test.mjs` 的 rig 缺省接线 `createControlEntry()`；`test/questions.test.mjs` 两处独立 bridge 补 control、hintTargets 断言补本地 accountId；`test/questions-admin-settlement.test.mjs` 手机晚到回执放宽为 accepted/desktop_fallback（首达采纳由账本保证，状态不再被误记）；`test/contract.spec.mjs` 只跑「契约测试形状」的 fixture——`docs/protocol-preflight/` 的纯协议证据片段（`feishu.json`/`telegram.json`/`wechat-ilink.json`/`qq-bot-protocol.json`，无 `type`）与契约 fixture 同目录，须跳过。
  - 能力边界不变：微信 iLink 图片/文件 `declared`、飞书签名/加密/文件/CardKit `declared`、Telegram 文件 `declared`、QQ 群按钮保持文本 fallback；真实设备/宿主协议验证仍待做，不标注 `real-device-verified`。
- 2026-08-27 phases 1-6 hardening tests: added 60 comprehensive integration tests across 6 phases covering overlay→Control Core wiring, PR #12 remaining hardening, cross-process session writes, channel fail-closed behaviors, personal UX admin API, and security/structural bounds. npm test = 1329 (1328 pass + 1 skip). All verification scripts green.
- 2026-08-26 question P1 安全收口：admin settle 路径 `accountId` 不再用 `channel` 兜底（`src/questions/router.mjs` L611 `String(target.accountId ?? target.channel ?? '')` → `String(target.accountId ?? '')`）。修复前，若 `pushedTo` 目标无 `accountId`（测试 rig 缺失），admin settle 会用 `channel` 名冒充 `accountId` 传入 Control Core，违反硬性要求"不得把 channel 当作 accountId 的兜底值"。虽非安全漏洞（`buildEvent` 用真实 `pushedTo` accountId），但违反最小权限原则。同步修复 `test/questions-admin-settlement.test.mjs` 和 `test/admin-questions.test.mjs` 的测试 rig——入站适配器必须携带 `accountId` 以匹配生产行为。聚焦 + 全量测试通过。
- 2026-08-26 session 并发写入修复（阶段 5 P2）：`setSessionOutbound` 和 `setSessionControl`（`src/routing/agent-router.mjs`）现在在写回前 re-read 最新整表，将本次 diff 合并到最新记录上写回，防止多个 session 并发更新时最后写入者覆盖 sibling 字段。新增 3 个并发回归测试验证：session A 更新后 session B 不覆盖 A 的 outbound/control，outbound 与 control 分别更新不互相覆盖。聚焦 + 全量测试通过。
- 2026-08-26 team policy persistence adversarial review (Stage 4, round): fixed three defects in the session control overlay persisted at `route:sessions[<sessionId>].control`.
  - **Split-writer repair (P1-1)**: the registry's whole-cache `persist()` used to write its in-memory `route:sessions` table verbatim, while `agent-router.setSessionControl` reads/rewrites the whole persisted table. A lifecycle write (ensure/touch/markDisposed/reactive) could therefore erase a freshly admin-set control — and could drop unrelated/cross-session records the registry's stale cache never contained. `persist()` now does a record-level re-read/merge: re-read the store's current table fresh as the base, delete sweep tombstones from base, then merge each in-memory record onto its disk record (`{ ...base[id], ...record }`) so disk-only subkeys (like the router-owned `control`) survive and router-created sessions the registry never cached are preserved; malformed `control` is canonicalized/removed on the way out. Swept deletions ride a `removedIds` tombstone set cleared only on a successful persist. Cross-component regression tests added (real router + real registry on one store): lifecycle `touch`/`ensureSession` after `setSessionControl` no longer erase the control, a router-created session survives a registry persist, a fresh-registry restart reads the persisted control, and a swept expired-disposed session is actually removed from the persisted store (tombstone beats the fresh base).
  - **Durable write propagation (P1-2)**: `store.save()`/`set()` silently swallowed disk failures and signaled nothing; `router.safeSet` treated non-throw as success, so `PATCH /api/sessions/:id/control` returned 200 while the write was lost on restart. `store.save()` now returns a `durable` boolean (true only after the durable rename completes; false on disk-failure and on corrupt-rename abort), and `store.set()` returns it. `router.safeSet` treats an explicit `false` as failure while still treating legacy `undefined` as success (backward compatible); the admin already maps a non-true setter to `ApiError(500)`. New `test/store.test.mjs` exercises the real `createStore` save-failure path (parent path is a regular file) asserting `set` returns `false` (and `true` on a writable path); a new admin-api test wires a real failing `createStore` + real router and asserts `patchSessionControl` throws `ApiError(500)`.
  - **Copy-on-read (P2)**: registry public record returns were shallow copies, letting a caller mutate the nested `control.approvalMembers` array in registry internal state; a `recordCopy` helper deep-copies `control`/`outbound`/`inbound` subkeys for all public returns, and two existing tests were corrected off the mock-store's reference aliasing onto the durable value-semantics the real `createStore` always had.
  - Validation is `1230` tests (`1229` pass + `1` skip); package/version unchanged at `0.8.6`. Known residual (documented, not expanded): the router read-modify-write path still reads-fresh-then-writes whole, and outbound dual-path clobber remains pre-existing/out-of-scope.
- 2026-08-26 team policy control overlay persistence (Stage 4): the reviewed session control policy (`owner` / `approvalOwnerOnly` / `approvalMembers`) is now persisted as a durable, session-addressable bounded overlay at `route:sessions[<sessionId>].control` through the existing session registry and loopback admin API. A single pure `normalizeControlOverlay` in `src/control/session-arbiter.mjs` is the sole definition of a valid overlay (only the four approved fields; source fields `channel/accountId/userId/chatId/sessionId/policyVersion/expiresAt/revoked` are dropped on read and rejected on write so an admin/store edit can never manufacture the source an authorization compares against — fail-closed). `src/routing/session-registry.mjs` gains defensive `getControl`/`setControl`/`clearControl` (copy-on-read, normalize-before-write, corrupted overlay treated as absent, unrelated keys preserved, persist failure degrades to memory). `src/routing/agent-router.mjs` gains `setSessionControl(sessionId, patch)` mirroring `setSessionOutbound` (field-level diff with null = delete key, canonicalized via `normalizeControlOverlay`, returns a boolean for a clean storage-failure 500). The Bearer-gated loopback admin surface adds `PATCH /api/sessions/:id/control` and a safe redacted `control` summary on `GET /api/sessions` (mode / approvalOwnerOnly / ownerConfigured / approvalMembersCount — never raw identifiers). Strict validation (unknown/source/reserved fields 422, shape/bounds/global 422, null-clear, missing session 404, storage failure 500); personal defaults stay safe because the overlay never carries `converse`/`groupChatControl`. Constraint-mandated persistence/API-only slice — the overlay is NOT yet wired into `createControlEntry` authorization; the exact next hook is documented in the workstream. Focused tests added across the arbiter/registry/router/admin-api/server suites. Validation `1223` tests (`1222` pass + `1` skip); package/version unchanged at `0.8.6`.
- 2026-08-26 team policy source-binding conflict-consistency + legacy-envelope repair (adversarial review, round 4): the prior entry's `sourceOf` preferred `rowMeta`, so a stale or tampered `pending.control`/`pending.controlMeta` could override a conflicting canonical base-policy channel/account, and authorizing commands still risked the event manufacturing the policy source. `createControlEntry` now treats every present source authority — `basePolicy`, each of `pending.control`/`pending.controlMeta`, and the pending top-level — as a consistency constraint: for `approval`/`question-answer` any disagreement among them (or with the event) fails closed (`source_mismatch_*`), and the merged-policy source binding uses the true original source, never event-supplied values, unless an adapter `spec.authorize` proves the target (a `pushedTo` exact match). Non-authorizing `stop`/`steer`/`ordinary-message` keep an explicit legacy envelope binding (deterministic `pendingMeta` sessionId/key, event channel/account/user/chat) so legacy action/conversation rows with no source metadata still settle; `approval`/`question-answer` never use event fallback. Focused regression tests added (`test/session-arbiter.test.mjs`, `test/control-entry.integration.test.mjs`): a nested controlMeta spoof over a bound base policy is rejected, aligned sources still accept, and action callbacks from Telegram/Feishu still settle through the shared entry. Validation is `1205` tests (`1204` pass + `1` skip); package/version unchanged at `0.8.6`.
- 2026-08-26 team policy owner source-binding repair (adversarial review, round 2): `createControlEntry`'s merged policy (re)assigned `channel`/`accountId`/`userId`/`sessionId`/`chatId` from the incoming event, so when a pending row omits `accountId` (or `channel`) — or the policy carries an owner without a bound conversation — an `approvalOwnerOnly=true` / team owner event from the wrong account or channel could be accepted because the event manufactured the very policy source the arbiter authorizes against. The entry now binds the event to the true original source (`rowMeta` → pending top-level → base policy) for `channel`/`accountId`/`chatId`/`sessionId`/`userId`, rejecting any mismatch; `owner` is never event-supplied (it comes only from the original policy/pending), and when owner/team-member settlement is in play but no genuine conversation source exists at all, it fails closed (`source_mismatch_channel`) instead of trusting event values. Legacy non-authorizing paths (action `stop`, conversation steering) that genuinely carry no source metadata keep their adapter-envelope binding; `sessionId`/`chatId` stay exact; ownership/membership never grants `steer`/`ordinary-message`. Focused regression tests added (`test/session-arbiter.test.mjs`, `test/control-entry.integration.test.mjs`). Validation remains `1204` tests (`1203` pass + `1` skip); package/version unchanged at `0.8.6`.
- 2026-08-26 team policy contract repair (exact-source binding, adversarial review): `canSettleApproval` previously let `approvalOwnerOnly=true` and the team owner-exemption accept an event carrying the owner `userId` from the wrong channel or account. Both paths now also require the event's `(channel, accountId)` to match the normalized policy channel/accountId in addition to the owner `userId`; listed non-owner members are still authorized only by their exact normalized `(channel,accountId,userId)` triple; `sessionId`/`chatId` remain exact. The same rule applies through the exported `canSettleApproval` and `canAcceptCommand`/Control Core path, and ownership/membership never grants `steer`/`ordinary-message`. Focused adversarial tests added (`test/session-arbiter.test.mjs`, `test/control-entry.integration.test.mjs`). Validation remains `1200` tests (`1199` pass + `1` skip); package/version unchanged at `0.8.6`.
- 2026-08-26 maintenance sync: development line is at `887b71f` (stage 2A Web/admin `ask_user` settlement plus reconciled handoff facts; runtime implementation is `ce46edc`). Validation is `1194` tests (`1193` pass + `1` skip); package/version remains the published `0.8.6` (`909` release contract), with no new release or real-device/host-protocol verification. QQ C2C buttons, GROUP text fallback, and the admin choose/reject path are contract-tested; missing `chatType` or unknown source metadata fail closed. Desktop still has no settlement entry, so dual-end sharing is not claimed.
- 2026-08-26 team policy contract: provider-neutral team-mode approval scope is now explicit and bounded. `src/control/session-arbiter.mjs` normalizes an optional `approvalMembers` list (trim, drop malformed/wildcard/global/empty entries, dedup exact triples, cap 64, never wildcard/unbounded/nested) and exposes a pure `canSettleApproval(policy,event)` decision helper wired into `canAcceptCommand`/Control Core only — applying to both `approval` and `question-answer`, never granting `steer`/`ordinary-message`. `approvalOwnerOnly=true` still allows only `policy.owner`; `mode='team'` with a non-empty list requires the exact `(channel,accountId,userId)` triple unless the event is the owner; personal / team-without-list keep the existing exact source binding. `src/control/entry.mjs` now forwards the normalized policy snapshot to the settle callback (`onSettle(event, policy)`), so callbacks never reason over unnormalized policy data and stales/mismatches are rejected before settling. No IM transport, UI, admin, approval/question core, or release version changed; personal defaults and `conversation` remain separate opt-ins. Contract-tested only (`test/session-arbiter.test.mjs`, `test/control-entry.integration.test.mjs`); no real-device/provider assertion. Validation `1200` tests (`1199` pass + `1` skip); package/version unchanged at `0.8.6`.
- PR #12 modular rework: QQ interaction callbacks now use the shared approval/question Control Core with explicit source binding and text fallback. QQ group targets remain non-actionable to avoid cross-member disclosure. `approval.parallel` remains disabled by default and is explicit opt-in only; wait rejection is fail-closed. Real QQ protocol/device verification is still pending.

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。
DSH 处于 developer preview，0.x 阶段的次版本号提升允许小幅破坏性变更（会在条目中标注）。

后续已随 [0.9.7] 发布。

### 修复：Telegram ask_user 单选卡片增加「自定义回答 / 跳过」按钮 + ref 回收与来源校验（PR #22，2026-09-12）

- `src/inbound/telegram-bot.mjs` `sendQuestionCard()` 在选项按钮之后追加 `✍️ 自定义回答`（`c`）与 `⏭ 跳过`（`s`）两个辅助按钮，继续沿用 `buildQuestionAction()` 与 `r:<ref>` 短引用链，不另造协议。
- **引用回收**：本次卡片为选项与两个辅助按钮铸造的全部 callback ref 记录进 `cardRefs`；容量中途耗尽时、辅助按钮铸造失败时、以及 `sendMessage` 抛错/返回失败时，均完整回收本次已铸全部 ref 后降级编号通知，仅真正发送成功才保留 ref 供点击链单次核销（不再泄漏到 TTL）。
- **来源/token 校验**：`src/questions/router.mjs` `handleCardAction()` 对 custom/skip 分支补 token 有效性（过期/畸形/错签名）、`token.key === qKey`、ledger 存在且 `status === 'pending'`、以及 `(channel, accountId, userId, chatId)` 精确来源匹配（`pushedTo` 中存在 `accountId` 时必须匹配）；来源字段缺失、旧卡、已答、已过期、错误账号/用户/聊天全部 fail-closed 并给出安全提示。custom 只回指引（`答：<内容>`），不直接结算；真正文本回答仍走 `settleText()` / Control Core / `bus.settle` 首达采纳。
- 修复来源 fail-closed 闸只查 `null`、漏掉 `Array.prototype.find` 返回 `undefined` 的越权放行。
- 新增 focused regression：错 key token / 过期 token / 已决问题 / 错误 chat / 错误 account 均 fail-closed，正确来源只发指引不结算，随后 `答：` 文本正常落账。

### 修复：QQ 网关心跳时序死循环（Issue #23，2026-09-12）

- `src/inbound/qq-gw.mjs`：`OP_HELLO` 只记录本连接的 `heartbeat_interval` 并发送 IDENTIFY/RESUME，**不再立即启动并发送首拍心跳**（真机 A/B 证据：QQ 网关只对鉴权完成、收到 READY/RESUMED 之后发出的心跳回 `OP_HEARTBEAT_ACK`，提前起搏永远收不到 ACK 而死循环）。
- 心跳起搏拆为 `recordHeartbeatInterval()` + `armHeartbeat()`：收到 `READY` 或 `RESUMED` 后才幂等启动定时器并立即发送第一拍（携带当时最新 `lastSeq`）；重复 READY/RESUMED 不会创建多个定时器或重复首拍。
- `beat()` 语义修正：上一拍未 ACK 且未达到 `maxMissedAcks` 时记一次 miss、告警，但仍继续发送下一拍（保持恢复路径，不再提前 `return` 卡死）；只有达到阈值才 `cleanupSocket()` 并按既有语义走 RESUME 优先重连，该拍不再发送；收到任意有效 `OP_HEARTBEAT_ACK` 后清零等待与连续 miss 计数。
- **连接级状态隔离**：`heartbeatIntervalMs`/`heartbeatArmed`/`awaitingAck`/`missedAcks` 均为连接级，`cleanupSocket()` 复位；`connect()` 的 message 监听器按连接身份 `conn` 比对，旧连接迟到 ACK 不再取消已决策重连、也不污染新连接；`stop()` 增补清心跳状态，restart 后能重新正常握手与起搏。
- 保留现有关闭码分支、退避、token、sessionId、lastSeq 与 fail-safe 行为；未顺手重构其他 QQ 协议代码。
- 测试：删除「HELLO 后立即心跳」旧契约，新增 HELLO→IDENTIFY-only、READY/RESUMED 才首拍、RESUME→RESUMED 起拍、重复 READY/RESUMED 不双定时器、单拍丢失下一拍仍发、旧连接迟到 ACK 不污染新连接等回归。

### 新增：宿主事件根上下文订阅与可观测性（Issue #16，2026-08-26）

- 新增 `src/host-events.mjs`：DSH/Cordis 宿主事件订阅的兼容边界。宿主按注册上下文限定事件监听作用域，插件挂在 scoped 子上下文时，宿主事件订阅会经功能探测回落到文档化的 Cordis 根上下文（`ctx.root`，自引用校验；非 Cordis 的 root 服务一律拒绝）。
- 回落是订阅局部的，不使用 `global: true`，不改变宿主过滤语义；会话/agent 生命周期、错误与 dispose 订阅已切换到该边界。
- 载荷归一仅接受文档化元组 `(session, event)` 与显式 envelope 兜底，agent 生命周期载荷按 `{ agent }` 归一、legacy 直传作为兼容；畸形载荷 fail-closed 拒绝。
- 注册与处理均逐订阅 try/catch 闭环，诊断为有界快照（仅事件计数与 context/scope 状态，不含会话内容、标识符或凭证）；`ask_user` 仍由 `questions.enabled` 独立注册，本批不改变 interaction/desktop/provider 行为。
- 新增 focused host/event/index 测试。DSH 0.1.1-rc.2 运行态仍须真实宿主/协议验证，Issue #16 只能标记 code/contract hardened，不关闭、不提 real-device 证据。

### 新增：本地管理台远程提问裁决入口（路线图阶段 2A，2026-08-26）

- 管理台新增「待处理远程提问」面板：`GET /api/questions` 返回脱敏只读快照（不可逆 12 位 sha256 ref、掩码 agent/chat/user 短段、选项文本、创建/过期时间、状态），绝不返回 token/凭证/完整聊天/agent 标识/答案隐私。
- 受保护结算 `POST /api/questions/:ref/settle`：`choose`（采用具体选项）与 `reject`（驳回复用既有 `aq-skip` 语义交还桌面、绝不编造答案），一律经 Control Core 的 `question-answer` 注册 spec 走既有授权（配对/source/policy/首达采纳）与单次结算语义——本端点不复制 ledger 结算、不写状态、不留直通后门；个人模式默认仅本地 owner/admin。
- 竞态/单次结算：admin 先答 → 手机晚到 already-handled；手机先答 → admin 返回 handled；答辩失败/重复提交/非法选项不产生二次结算。
- fail-closed：缺 owner 证明 / 过期 / 未知 ref / 非法 action/option / Control Core 未接线 → 安全错误（501/403/410/404/409/422/not_available），绝不直通结算、绝不落账本。
- 前端 `src/admin/ui.mjs` 面板为纯字符串渲染、逐字段 `esc()` 转义，token/完整标识绝不进 DOM；无新增前端依赖、无第二控制台。
- 新增 focused API / 结算竞态 / UI 行为测试。真实宿主/设备验证不做，标志为 code/contract-tested（代码 + 契约测试），Issue #16 不关闭。

### 新增：入站图片信封归一与有界下载（Issue #14，2026-08-26）

- `src/inbound/message.mjs` 定义 text/image/file 统一入站模型；未知结构 fail-closed 返回 `null`，绝不把「非文本」伪装成 text 漏进会话路由。
- `normalizeImageUrl` 仅接受显式 HTTP(S)、剔除凭证段、URL 长度有界；`normalizeImageAttachment` 只保留 url/width/height 已知字段，超限或畸形返回 `null`。
- `downloadInboundImage` 为可选图片下载原语：AbortSignal 超时、`redirect: 'error'`、content-length 与实读字节上界 5 MiB、content-type 限 `image/*`，从不落盘二进制，失败 fail-closed 返回 `null`；结果不持久化。
- QQ C2C `extra`（字符串化/已解析媒体段）、iLink item_list、钉钉 picture/image URL 已接线到归一模型并契约测试；图片下载失败不阻断文字/控制路径。
- QQ C2C 图片解析 `parseQQImageMessage` 按 fixture 契约接线，真实字段形状仍无真机样本核验，能力状态 contract-tested/declared，不标记 `real-device-verified` 或正式支持。

### 新增：飞书与 Telegram provider facades（批次 5，2026-08-26）

- 新增 `src/channels/feishu/` 与 `src/channels/telegram/` 独立 provider 入口；旧 inbound 模块继续作为兼容实现，控制语义仍统一复用 Control Core / session arbiter。
- 两个 provider 暴露来源绑定的回调归一化、生命周期入口和能力证据；未知/缺失 `chatId` 或 `userId` 的回调不会进入控制路径。
- 飞书富文本卡片、更新、按钮回调、群聊来源校验与 WebSocket 生命周期标记为 `contract-tested`；Telegram 命令、inline buttons、消息编辑、4096 UTF-16 文本护栏、重连和文本兜底沿用既有契约。
- 文件发送仅保留显式 `fileAdapter` 接口，能力状态为 `declared`；没有真实平台/设备验证，不标记 `real-device-verified`，不宣称正式支持。

### 新增：微信 iLink 单账号 QR-first provider slice（批次 4，2026-08-26）

- 新增 `src/channels/wechat-ilink/` provider 边界；旧 `src/inbound/wechat-ilink.mjs` 保留兼容入口，应用装配已切换到新边界。
- 轮询游标、context_token 和连接状态按 `accountId` 命名空间隔离；游标有界，并在整批消息交给 Control Core 后才推进，断线可重连且由现有 bus 去重避免重复控制命令。
- QR 过期返回明确重新扫码状态；未知协议字段不进入控制信封；图片消息保留结构化 envelope，图片下载失败不阻断文字/控制路径。
- 图片收发仅提供可选 media bridge，证据状态为 `declared`；没有真实设备/协议验证，不宣称正式支持或 `real-device-verified`。

### 改进：管理台首次配置路径（Task 04，2026-08-26）

- 首屏新增「未配置 → 已配对 → 测试通知 → 正常运行」进度状态，并明确本地管理台入口由启动日志提供实际 URL/端口。
- 默认进入个人模式；绑定矩阵和会话等高级控制需显式打开，降低首次配置认知负担。
- 通道空状态改为字段配置指引；测试成功/失败均显示下一步或重试原因，YAML 保留为高级入口。
- 不改变 loopback 绑定、Bearer 鉴权、渠道传输或凭证脱敏；真实设备布局与浏览器兼容性仍需后续手工复验。

### 新增：Session 控制策略与命令仲裁契约（规划批次 3，2026-08-25）

- 新增 `src/control/session-arbiter.mjs`：个人模式安全默认值、精确来源绑定、策略版本/撤销/过期、固定命令优先级与一次性事件收敛。
- 该层不接入具体 IM，不包含 QQ 按钮、提问卡片或 `approval.parallel`；真实平台验证仍未宣称完成。

### Control Core Step 1：提问编号回复按 chat 隔离（CC-1，2026-08-25）

- 提问编号兜底证据改为逐目标 `hintTargets`（`channel + userId + chatId`）；精确 chat 才能裁决。
- 同渠道同用户的错误 chat 会消费消息并提示回原会话，不改变提问状态；缺少 `chatId`、跨渠道、旧 `hintChannels` 行、部分/失败送达均 fail-closed。
- `notifyAll().delivered` 只有渠道级证据，不再被推导为具体 chat 的送达，也不再将新行写入 `hintChannels` 作为授权凭据。
- 事实校准：旧版本条目中的 `hintChannels` 仅描述历史实现；当前实现只接受 `hintTargets` 的逐目标 `(channel,userId,chatId)` 送达证据，旧行按 fail-closed 处理。
- 新增正确/错误 chat、缺 chatId、用户隔离、部分送达、旧行、重复与僵尸 pending 回归测试。真实渠道仍需协议级验证具体 chat 送达形状。

### 维护批 6-C：提问升级提醒渠道分流（MNT-6-C，2026-08-25）

- 修复 `questions/router.mjs` 的升级提醒遗漏渠道过滤：提醒现在复用本题首次推送实际覆盖的出站渠道，不再无条件广播到全局渠道池。
- 入站渠道（例如 `qq`）通过能力矩阵映射到出站别名（`qq-bot`）后再过滤；未知或未配置的目标从提醒集合剔除，保持 fail-closed。
- 新增回归测试，验证提醒显式携带覆盖渠道并保留 `qq`/`qq-bot` 别名契约。
- 终态卡片编辑继续由 `normalizeInbound.editTarget()` 逐目标吞错，单目标失败不会中断其他目标；本批不重复实现第二层保护。
- 返工：升级提醒不再使用按渠道的 `notifyAll`，改为按本题实际 `pushedTo`/兜底目标逐 chat 发送；两个并发提问实例即使使用同一 IM 渠道也不会互相收到升级提醒。
- 纯入站编号兜底现在只在至少一个目标 `sendText` 成功后登记该渠道的 `hintChannels`；发送失败不再留下可被裸编号命中的虚假证据。
- 出站编号兜底现在检查 `notifyAll()` 的 `delivered` 结果；空目标、静音、失败或异常都不登记 `hintChannels`，并新增回归测试。
- 残余风险：编号证据仍是渠道级，尚未绑定原始 `chatId`；当前提问桥未注入 session 路由器，无法在本维护批安全推导更窄的出站范围。该 P1 已登记到维护 workstream 与 `docs/memory/risks.md`，后续统一 Control Core/session scope 时处理。

### 维护批 6-A：Issue #10 Dashboard 首屏引导 UX 返工（MNT-6，2026-08-25）

Issue #10 的「首次使用三步引导卡」草案经过主管审查，按以下审查项返工：**完成条件收紧、localStorage 全 try/catch、删除未经证明的承诺、补齐 overview.members 契约 + 引导行为测试 + 移动端静态断言**。不改安全边界、不新增配置写接口、不碰 QQ interaction transport。

- **步骤 1 完成条件 = configured && enabled**（审查项 1）：原实现把「仅配置未启用」也判为完成，但通道未连起来时通知根本发不出去，等于假绿灯。改为 `anyOutEnabled`（出站通道里 configured 且 enabled 的至少一个）才算步骤 1 完成、才算引导卡自动隐藏的条件之一。
- **localStorage 全部 try/catch**（审查项 2）：`onboard_dismissed` 的 `getItem` 与 `setItem` 均用 `try { window.localStorage.xxx } catch (e) {}` 包裹，与既有 `getToken`/`setToken`/通知页偏好同口径。隐私/受限环境（Safari 无痕模式 / Firefox 隐私模式 / iframe 沙箱）下 localStorage 抛 SecurityError/QuotaExceededError 不再击穿 UI——读失败按「未隐藏」降级，写失败不影响本次页面内隐藏。
- **删除未经证明的承诺**（审查项 3）：去掉「2 分钟」「1 分钟」「终身有效」「扫码必然自动配对」「审批一定发卡片」等无法在维护批内验证的断言；文案改为描述真实可用路径（「挑一个…填凭证点测试发送，手机收到就通了」「扫码授权通道通常会自动登记」「按提示回复编号或点按钮」）。guide.md 同步修订。
- **`overview().members` 补契约 + 聚焦测试**（审查项 4）：`overview()` 返回 `members: { total, owners, guided }`，与 `getMembers()`/成员页引导态同口径。identity 未装配 / `identity.list()` 抛异常时按 `{ total:0, owners:0, guided:true }` 降级，绝不击穿总览。新增 4 例聚焦测试：正常装配 / identity 未注入 / identity.list 抛异常 / 空成员表 guided。旧 overview 无 members 字段时 UI 侧按 0 / 占位符 `–` 降级，不崩。
- **引导卡行为契约测试**（审查项 5）：`test/admin-ui-behavior.test.mjs` 新增 8 例——无通道无成员显示 / 仅配置未启用不算完成 / 配置且启用才完成并隐藏 / localStorage 读异常不崩 / localStorage 写静态契约（每处访问都在 try/catch 内）/ 步骤按钮 data-tab 指向真实存在的标签页 / 移动端窄屏静态断言（viewport meta + ≤768px 媒体查询 + flex-wrap + 44px 触控目标）/ 旧 overview 无 members 字段不崩。
- **安全的通道配置写入闭环已存在**（审查项 6）：盘点结论：admin API/UI 已有完整的通道凭证写入闭环——`putChannel` 键白名单 + 值形态上限 + 字段级合并（保留未知键不抹）+ `maskSecrets` 敏感值深脱敏不回显 + `testChannel` 连通性自检 + 审计 append-only。引导卡只是 UX 入口，不新增任何配置写能力，因此无需临时造危险接口，也无需本批做 schema 向导。
- **文档同步**（审查项 7）：启动日志已明确 `http://127.0.0.1:<port>` 与 token 来源三态（explicit/reused/generated，明文绝不重打）；README 功能表与配置表已覆盖 admin.enabled/port；guide.md 已含完整的「打开控制台 → token 来源 → admin 未启用怎么办」三步说明；本批只同步引导卡相关文案，不另开新文档。
- 验证：全量 `node --test test/*.test.mjs test/*.spec.mjs` = **1104** 契约（1103 通过 + 1 win32 skip，基线 1060 + 4 成员 overview + 8 引导 UX + 其他装配/批间增量）；`verify-release.mjs` / `gen-channel-matrix --check` / 全量 `node --check` 通过。

### 维护批 6-B：Issue #15 QQ RESUME/ACK 回归测试（MNT-6-B，2026-08-25）

QQ 网关心跳 ACK 丢失与 RESUME 恢复路径是批 2 引入的关键韧性机制（连续丢 2 拍才判死重连），但此前只有 2 个聚焦测试（单拍丢失 + maxMissedAcks 阈值可配），缺 RESUME 行为契约、迟到 ACK 边界、stop 清理完整性的回归钉。本批只加测试、不改生产代码。

- **ACK 连丢 → RESUME 携带原 session_id 与 seq**：连续 ACK 丢失触发判死重连后，新连接必须发 op6 RESUME 而非 op2 IDENTIFY，并携带上一会话的 `session_id` 和最后事件序号——确保事件不丢。
- **迟到 ACK 不取消重连、不污染新会话**：阈值触发后才到达的 op11 ACK 不能回滚已决策的重连；新连接起搏前心跳计数从零复位（`awaitingAck=false` / `missedAcks=0`），不得继承旧会话的未确认状态。
- **stop() 清理完整性**：断线后重连定时器已调度时 stop，`reconnectTimer` 必须被清除（stop 后推进时间不产生新连接）；stop 幂等；restart 能完成完整握手（IDENTIFY 或 RESUME）并输出就绪日志。
- **stop 期间 dispose 顺序**：心跳等待 ACK 途中 stop 不得抛异常；stop 后推进时间无心跳/重连副作用（`heartbeatTimer` + `reconnectTimer` 都清理干净）。
- 新增 4 例，全部 mock fetch/WebSocket，零生产代码改动。
- 真机/协议缺口：QQ 网关是否每拍必回 op11 ACK、RESUME 失败是否正确返回 op9 INVALID_SESSION、静默断连（无 close 帧）下 2 拍阈值是否可靠触发——均需真机或协议级验证，已记入 `docs/memory/risks.md`。
- 验证：全量 `node --test test/*.test.mjs test/*.spec.mjs` = **1108** 契约（1107 通过 + 1 win32 skip，基线 1104 + 4 新增）；`verify-release.mjs` / `gen-channel-matrix --check` / 全量 `node --check` 通过。

### 维护批 5：入站 text/image/file 统一消息结构（MNT-5，2026-08-24）

六通道适配器当前只产文字信封（`{ channel, userId, chatId, messageId, text }`），非文本消息要么静默丢弃（telegram），要么拼成 `[不支持的消息类型：x]` 占位文本（feishu）。本批补上内容模型的正规层：一座归一结构与一条 QQ 单聊图片解析**接口**，**全网不接线**（无协议证据不启用解析——QQ 官方机器人 C2C 媒体事件真实字段形状无真机样本）。

- **`src/inbound/message.mjs` 统一消息结构**：`INBOUND_KINDS`（text/image/file）+ `normalizeInboundMessage`。文字兼容——既有 `{ text }` 信封（含 channel/userId 等透传字段）原样归一为 `{ kind:'text', text, … }`，bus.accept / conversation router 消费面零改动；结构化 image/file 要求附件对象含有效 url，缺失一律 null（fail-closed）。text 与附件同载时按 text 归一（附件路径待证据，绝不旁路）。
- **QQ 单聊图片解析接口 `parseQQImageMessage`**：按「文档描述的常见实现」（`d.extra` 为 JSON 字符串/预解析数组，段 `type === 'image' | 1` 且 `image.url` 非空）解析 C2C 事件负载，返回 `{ kind:'image', image:{ url, width?, height? } }`；无 extra / 无图片段 / 段缺 url / extra 畸形一律 null。**不接线**——qq-gw.mjs 及其余适配器均不 import；附带 `parseExtraSegments` 供未来网关预解析复用。
- **fixture**：`test/fixtures/qq-c2c-image.json`（C2C 图片事件样本，文档假设形状），作真机校验时的对照样本；测试同时覆盖拒绝矩阵（空段/非图片段/缺 url/畸形 extra/非对象）与预解析数组直通。新增 8 例。
- 验证：全量 `node --test test/*.test.mjs test/*.spec.mjs` = **1060** 契约（1059 通过 + 1 win32 skip，基线 1052 + 8 新增）；`verify-release.mjs` / `gen-channel-matrix --check` / 全量 `node --check` 通过。

### 维护批 4：Interaction Core 统一交互状态账本（MNT-4，2026-08-24）

三条交互链（动作 actions / 审批 approval / 提问 questions）各自内联实现了一遍几乎相同的账本状态机（`add` 覆写式 pending+createdAt、`resolve` 有行即翻终态、`terminate` 仅 pending→terminated 的 C2/P1-5 僵尸守卫）。本次把状态机收敛为一份共享核心 `src/interaction/ledger.mjs` 的 `createInteractionLedger`，迁移顺序按维护计划定的 actions → approval → questions，每阶段全量契约零降、独立提交。

- **核心语义对齐（迁移时逐条核对，行为零变）**：`add` 总是覆写 pending+createdAt（旧行/僵尸行按「非 pending」判非待决，fail-closed）；`resolve` 无前态检查（approval/questions 既有语义；actions 的「首达采纳 → 执行 → 终局」多步落地也靠它）；`terminate` 仅待决可翻、已决/缺失返回 false（防 onAbandon 已决行二次改写）；过期不设独立 status（token TTL + decision `'timeout'` 表达，与三条链现状一致）；`resolve`/`terminate` 的 extra 只并入旁注字段，不能覆盖 status/decision/resolvedAt。
- **state key 格式保留**：键空间 `act:`/`ap:`/`aq:` 不动；决策字段名由各链声明——actions 传 `decisionField: 'outcome'`（保住 `act:` 行历史形状），approval/questions 用默认 `'decision'`。对外接口（`createActionDispatcher` / `registerApprovalHandler` / `createQuestionBridge`）签名未改。
- **各链 `latestPendingFor` 归属启发式有意留链内**：approval（exact/onChannel/intended + liveWaiters 僵尸过滤）与 questions（exact/onChannel/hint + hintChannels 广播凭据）的匹配语义差异过大，强行抽进核心会引入行为漂移。核心只暴露 `statuses/add/get/isPending/resolve/terminate/scanKeys` 六个原子操作，各链用 `{ ...core, latestPendingFor }` 合成同一 ledger 面，其余调用点零改动。未加 approval.parallel（计划明确非目标）。
- 提交拆分：阶段 1（核心模块 + 6 例单测 + actions 迁移）、阶段 2（approval 迁移）、阶段 3（questions 迁移 + 本文档）。actions 的 `markSource`/`unmarkSource`（srcChats 旁注字段原地微调）与两条链的 pushedTo 增量落账不是账本生命周期操作，保留直接 store 访问。
- 验证：全量 `node --test test/*.test.mjs test/*.spec.mjs` = **1052** 契约（1051 通过 + 1 win32 skip，基线 1046 + 6 新增）；`verify-release.mjs` / `gen-channel-matrix --check` / 全量 `node --check` 通过。

### 维护批 3：降低 index.mjs 装配复杂度（MNT-3，2026-08-24）

`src/index.mjs` 的 `apply()` 从 885 行散装收束到分段装配，按「先移动代码不改变行为、每阶段补装配测试」分三阶段，每阶段独立提交、四扇门全过（行为零变的契约锚 = 既有 apply() 级测试 + 各阶段新增模块边界测试）。块的具体职责与内联注释随原样搬入各模块，`apply()` 只留组装调用与晚绑定。

- **阶段 1（`f307950`）**：出站凭证 state overlay + 连通性测试 `testRawConfigOf` 抽为 `src/assembly/outbound.mjs` 的 `composeOutboundChannels`/`accountOf`。admin 关闭时 `channels` **数组引用同一性**逐字节保持（原 apply 语义）；`accountOf` 改 (store, key) 双参，7 处调用点同步。新增模块测试 7 例（防御读取/透传引用/合并优先级/双域永不过 overlay/按类型去重）。
- **阶段 2（`9fd6341`）**：admin token 三路决策（显式/复用/首启生成）+ `verifyToken` 抽为 `src/assembly/admin-token.mjs` 的 `resolveAdminToken`。state 只存 SHA-256 哈希、明文不落盘的既有红线原样随模块走；`verifyToken` 先比长度再 `timingSafeEqual`。新增模块测试 4 例（三路/损坏哈希/恒时安全面/store.get 抛错容忍）；`node:crypto` 移入模块，index.mjs 不再直接依赖。
- **阶段 3（`deda003`）**：六通道入站 resolve/启用信号（allowUsers / tg 便捷回退链 / approvalWanted / feishu-qq-dingtalk-wxpusher-wechat 的 wanted+resolved）抽为 `src/assembly/inbound-signals.mjs` 的 `resolveInboundSignals`。tg 回退次序（显式 > 出站渠道 > store 账号）、admin 关闭零执行语义逐字节保持；wxpusher 密径首铸落盘是这处唯一受控副作用；wechat 仅出 wanted/raw 信号，resolve 仍在 apply 的 guided 装配块晚绑定。新增模块测试 8 例；不再被引用的 4 个 `resolveXxxInboundConfig` 与 `resolveEnvRefs` 导入清理。
- 后续候选（身份/配对/迁移/引导、「已启通道」装配段）耦合面过宽（约 10 个出入值 + 审计 late-bound 回闭），继续抽的漂移风险高于精简收益，按「不要一次性重写」留待维护计划更深的批次或发版轮单独处理。
- 验证：apply() 体 885 → **737 行**（-17%）；全量 `node --test test/*.test.mjs test/*.spec.mjs` = **1046** 契约（1045 通过 + 1 win32 skip，基线 1027 + 7 + 4 + 8）；`verify-release.mjs` / `gen-channel-matrix --check` / 全量 `node --check` 通过。

### 维护批 2：QQ 心跳 ACK 连续丢失计数重连（MNT-2，2026-08-24）

`src/inbound/qq-gw.mjs` 心跳判死逻辑：原「任一拍未 ACK，下一拍即主动断开重连」对单次网络抖动/网关瞬时滞留过激——QQ 心跳间隔按 30s 级计，一拍没回应就断开重连等于让一次抖动杀掉会话。改为**连续丢失计数**：连续 `maxMissedAcks` 拍未确认才判死重连。

- 默认阈值 **2**（可经构造器选项 `maxMissedAcks` 覆盖，1..10 语义，合法值 `>=1` 取整后钳上限 10，**0/NaN/负数回落默认 2**——顺带修掉 `Number(0)||2` 把显式 0 变相改成 1 的坑）。单拍丢失只 warn 出「已连续丢失 1/2（下一拍仍无 ACK 才断线重连）」；ACK 到达即清零计数（抖动恢复不算数）；连丢满阈值才 cleanupSocket + 退避重连。
- `stop()` 定时器回收已就位，新增用例钉死「断线已调度重连但未执行时 stop → `clearTimeout(reconnectTimer)` 撤销，绝不新建连接」（`stopRequested` 布尔 + clearTimeout 双保险）。
- 测试用 node:test `t.mock.timers` 确定性推进心跳节奏（不再靠真实 50ms 间隔数拍），新增 4 例、替换 1 例：连丢 2 拍判死重连 / 单拍丢失 ACK 恢复不清零不重连 / 阈值 1 保留旧语义 + 0 回落默认 2 / stop 清理未决重连定时器。
- 未真机验证 QQ（按计划不声称「真实 QQ 已验证」）；协议行为（op10/op11、RESUME）保持原样。
- 验证：全量 `node --test test/*.test.mjs test/*.spec.mjs` = **1027** 契约（1026 通过 + 1 win32 skip）；`verify-release.mjs` / `gen-channel-matrix --check` / 全量 `node --check` 通过。

### 维护批 1：管理台初始化与 token 流程（MNT-1，2026-08-24）

修理管理台前端鉴权三处缺陷（对应 `test/admin-ui-behavior.test.mjs` 9 例 + `test/admin-wiring.test.mjs` 就绪日志 3 例）。**不改变任何安全边界**：token 仍只存 SHA-256 哈希、明文不落盘不重发、管理台仍只绑 127.0.0.1。

- **单飞询问门（① 叠窗）**：原 `api()` 缺 token 时各自 `window.prompt()`——首访 `loadAll` 并行 5 个 api 一次弹 5 个叠加窗。改为 `acquireToken()` 单飞门（`authGate`）：并发调用共享同一次询问，一次 resolve 的结果各自复用。
- **成功后才持久化（② 刷新必重输）**：原 prompt 输入的 token 从不 `setToken()`，刷新必重输；且 `clickToken` 手动输入与 api 自动询问两条路行为分裂。新增 `adoptToken(t)`——只在**成功响应（非 401）**后才落 localStorage；SSE 连接成功同样落库。错 token/code 永不在本地残留。
- **401 单次重登录（③ 风暴刷窗）**：原并发 401 各自沿调用链递归重询，N 个 401 弹 N 次窗，错 token 可死循环。改为 `reloginGate()` 单飞重登录门：一次询问 + 新 token 恰好重试一次；`autoReloginUsed` 门在每个成功响应后由 `markAuthOk()` 重新武装，失败后解除武装不再自动弹窗；`authGen` 世代计数使「用旧 token 发出的迟到 401」判为过期请求直接拒绝，绝不触发第二轮弹窗。SSE 的 401 与 api 共用同一把门（`handleStream401`）。
- **启动日志明确 token 获取方式（唯一新增 info 文案）**：`Web 管理台已就绪: http://127.0.0.1:<端口>` 就绪行按三态补充 token 来源——`explicit`（YAML admin.token）、`reused`（沿用首启打印旧值）、`generated`（已打印到上方日志，仅此一次）——重启后不再迷茫「token 从哪来」，也绝不重发明文。
- 验证：全量 `node --test test/*.test.mjs test/*.spec.mjs` = **1024** 契约（1023 通过 + 1 win32 跳过，基线 1012 + 12 新增）；`verify-release.mjs` / `gen-channel-matrix --check` / 全量 `node --check` 通过。UI 行为测试用 node:vm 真执行内联 `<script>`（剥离末尾 `init()` 自启），非复制粘贴断言。

### 维护：测试平台自适应（Windows 主机基线稳定，2026-08-24 mnt）

维护计划 batch-0：修 Windows 主机 8 个平台性测试失败。**纯测试维护，未改任何生产代码、未动安全边界**；POSIX/Linux 断言全部保留原强度。

- **desktop send 协议测试钉死平台（4 例）**：`send*` 家族是 send 协议语义测试，原跑宿主原生平台——win32 下 `send()` 会先起一个 BurntToast 能力探测子进程，破坏「单 spawn + 一次 close」假设导致挂死 10s。文件内本有 `withPlatform` helper（注明「三平台 CI runner 行为必须一致」），现把 4 个协议例包进 `withPlatform('linux')`；win32 探测行为由既有专属测试覆盖，语义不减。
- **store 锁新鲜锁定死 age<宽限（2 例）**：`P1-3 探测宽限期内` 与 `跨进程写锁双轮等待` 原依赖「自旋总耗时 < 500ms 宽限」——Windows `Atomics.wait` 粒度粗，两轮自旋跨过 500ms 后在死 pid 上触发死亡探测误删测试锚锁。改为把锁 mtime 拨到未来 60s（ageMs 恒负），结构性锁定「新鲜锁不做死亡推断」分支，平台无关；`属主已死的新鲜锁当场回收`（L123）与 `属主存活不误抢`（L140）仍用真实年龄交叉覆盖探测边界。
- **B1-1 码文件 0600 位只在 POSIX 断言**：win32 的 Node stat 不反映 Unix 权限位（写后仍报 666，实际边界是用户目录 ACL），仅把「精确 0600」断言收窄到非 win32；存在性/单行内容/warn 含路径/码面无泄漏断言全平台保留。
- **B1-1c symlink 攻击面按能力跳过**：win32 非管理员/非开发者模式主机 `symlinkSync` EPERM，测试无法铺前置；加能力探测，不具备即 `skip`（node:test 计 skipped，不占失败）。支持 symlink 的平台依旧全量断言写穿防护。
- **B1-1 warn 路径匹配归一化分隔符**：Windows 上生产 warn 的路径是「目录反斜杠 + 文件名斜杠」混合分隔符，逐字节 `w.includes(codePath)` 误判；归一化 `\`→`/` 后语义比对。
- 验证：本机（win32, Node v22）全量 = 1012 契约、1011 通过 + 1 跳过（B1-1c 能力缺失）、0 失败；Linux 主机预期 1012/1012（B1-1c 运行且过）。

### 审查修复：批次 A+B+C 独立 review 修掉 6 个缺陷（REVIEW-ABC，2026-08-24）

由非实现者身份的独立审查员按 `.agents/workstreams/crack-fix-plan/task-review-abc.md` 复审已落地的批次 A（`013ec48`）、B-1（`8e6739c`）、B-键族4（`f3fce85`）与工作区的 C1/C2/C3，报告见同目录 `REVIEW-ABC.md`。**发现 6 个缺陷、全部修完、0 遗留**；其中 3 个是「注释宣称了但测试不咬人」的恒绿摆设，1 个是致命语法错，1 个是过度收紧引入的新缺陷，1 个是装配缝。

- **致命：`src/inbound/identity.mjs` 多一个右花括号（BUG-1）**。C3 改动在 `readPending()` 的 for 循环后遗留一层 `}`，`return` 落在函数体外 → `node --check` 直接报 `SyntaxError: Illegal return statement`。该文件是 `src/index.mjs` 的静态 import，语法错等于**整个插件 import 即崩**（身份层、审批归属闸、管理台成员页全线不可用）。交接摘要 `SHORT-C3.md` 却声称 `node --check` OK / 1004 全绿 —— 说明该摘要写于错误引入之前、工作区实际状态从未复验，是宪法 #8 的典型漏网形态。已删除多余括号，并对全部改动文件 + `src/index.mjs` 重跑 `node --check`。
- **过度收紧反锁死清理入口（BUG-3，行为回退）**：C3 曾在 `src/admin/api.mjs` 的 `parseMemberKey` 增加「userId 含 `:` 即拒收」。但该函数只服务四条**读改删**路由（`PUT` 改角色 / `DELETE` 删成员 / `confirm` / `dismiss`），而 C3 之前落盘的存量冒号绑定行（旧 wxpusher `UID_PATTERN` 放行冒号 → `wxpusher:UID:EVIL` 直落，实测 `ok:true` 且升级后 `identity.allows()` 仍为 `true`）**仍照常准入**，却再也无法经管理台降级或删除 —— 等于把一条可能越权的 owner 身份永久钉死在白名单里，是宪法 #7「fail-open 要有度」的反面。已撤回该行拒收、恢复「只按第一个冒号切」的容忍语义，并在函数注释写明**为何故意不在此拒**：C3 的纵深防御设在**写入面**（`addBinding` / `addPending` + wxpusher `UID_PATTERN` 均已 fail-closed，新的冒号身份进不来），读改删面必须保留补救能力；`confirm` 不构成提权面（`confirmPending` 末端仍走 `addBinding`，冒号 userId 在那里被拒，实测 `ok:false`）。
- **三处恒绿摆设补上守卫（源码判据正确，只补测试）**：① CRACK-001 的注释宣称「异常形状 `srcChats`（数组等）一律 fail-closed」，把 `graceSourceAllowed` 的形状判据整条短路成 `if (false)` 后 `test/actions.test.mjs` 25 例**全绿**（BUG-4）—— 风险实体是数组形状 `srcChats` 过不了严校验分支的 plain-object 判定、若又能吃宽限窗则窗内任意会话可点；② `readPending` 的冒号过滤删掉后 `identity` + `admin-members` 54 例全绿（BUG-5）—— 旧版 `app_subscribe` 可把 `wxpusher:UID:EVIL` 写进待确认表，读盘仍认这类键则管理台会展示歧义身份、点「确认」即触碰越权路径；③ 顺手把 `src/actions.mjs` 该分支的判据与注释对齐（异常形状不再借道 `undefined/null` 分支的宽限窗）。
- **装配缝：删掉 `src/index.mjs` 两处 `identity` 传参，1011 例仍全绿（BUG-6）**。CRACK-003（审批编号回复归属闸）与 CRACK-004（提问 hint 兜底归属闸）的生效完全依赖 `index.mjs` 把 `identity` 传进 `registerApprovalHandler` 与 `createQuestionBridge`，而两处 `isAuthorizedDecider*` 都是 `if (!identity) return false` —— identity 缺失时**静默 fail-closed**：owner 代决能力整条消失、零告警、零测试可见，真机表现为「owner 回复 1 被拒『此审批不是发给你的』」而 mock 全绿。根因是所有函数级用例都自己显式传 `identity`，天然测不到装配缝。已补装配级用例走真实 `apply()` 并对两个装配点做源码级钉死（行为级要跑通 owner 代决需真卡片往返，属真机门；而这条缝的失效模式恰恰是「静默不报错」）。该用例自审时还发现初版断言失败会跳过 `cleanup()`、`apply()` 起的 wxpusher HTTP 句柄悬空把测试文件从 0.35s 吊到 120s（node:test 超时），已改 `try/finally`，变异下现在 391ms 快速见红。
- **测试自身的墙钟竞态（BUG-2）**：`test/identity.test.mjs` 三例过期码用例用 `pairing.mint({ ttlMs: 1 })` 后立刻走 `bus.accept`（该路径不注入 `now`，用真实钟），`expiresAt = mintedAt + 1` 在同毫秒内完成时码**尚未过期** → 断言前提被静默破坏，全量偶发红（`B1-6b` 实际收到「配对成功」而非「已重铸一枚引导码」）。3000 次采样实测：`ttlMs:1` 有 2867/3000（~95%）概率码仍有效，`ttlMs:0` 为 0/3000（确定性过期）。三处改 `ttlMs: 0` 并就地写明「为何是 0 不是 1」防改回；其余 `ttlMs:1` 用例都显式注入 `now: Date.now() + 5000`，不受墙钟影响，故意不动。`test/identity.test.mjs` 连跑 40 轮全绿。
- 测试：+5（`actions` 异常形状 `srcChats` 四态在宽限窗内一律 fail-closed；`admin-members` 存量冒号行仍可降级/删除 + confirm 冒号键不得落成绑定；`identity` `readPending` 冒号键清扫且不复活为绑定；`wiring.route` 装配完整性）+ 3 处去竞态。测试契约 1007 → **1012**。
- 计数订正：`REVIEW-ABC.md` 把本轮记作「1006 → 1012（+6）」，但其自身改动清单只列出 5 条新用例；2026-08-24 在 `f3fce85` worktree 与当前工作区上逐文件实测复核为 **994（B-k4 基线）+ C1 7 + C2 3 + C3 3 = 1007 → 1012（+5）**，以本行为准。
- 验证：`node --test test/*.test.mjs test/*.spec.mjs` = 1012/1012，连跑 3 轮一致；`verify-release.mjs`（v0.8.6，documented tests=909）/ `gen-channel-matrix --check`（27 渠道）/ 全量 `node --check` 通过；9 次变异验证中 7 次立即见红、2 次存活即上述 BUG-4/BUG-5，补测后复验全部见红。
- **未闭环（登记不遮掩）**：真机门仍未过（C1/C2/B1 的真实回调形状与飞书 `open_chat_id` 字段位置只有 mock 覆盖，按 `06-retest-checklist.md` 过真机后再发版）；四处版本串与测试计数仍停在 v0.8.6 / 909（发版轮动作，本分支未发版）；`src/inbound/_shared` 侧 `createDedupLedger` 的 `!== undefined` 判空转与 `_bounded` 已修正的写法不一致但当前不可达，按宪法 #1 不把重构混进修复轮，已登记技术债。

### 安全修复：复合键 `<channel>:<userId>` 冒号截断（批次 C3 / INJ-1 延伸，2026-08-24）

依据 `.agents/workstreams/crack-fix-plan/PLAN.md §批次C C3`。身份复合键是 `<channel>:<userId>` 的字符串拼接，而三处解析各写各的：wxpusher UID 形态校验**放行冒号**、`identity` 读盘用 `split(':')` 取前两段、管理台 `parseMemberKey` 用 `indexOf(':')` 只切第一个冒号。攻击者构造 `UID:EVIL` 一类 uid 即可让身份层把冒号后内容**截断丢弃**，落成 `wxpusher:UID` 覆盖他人绑定或降级 owner —— 同一份数据在两个模块里是两个身份，正是复合键设计的固有裂缝。

- **写入面 fail-closed（`src/inbound/identity.mjs`）**：`addBinding` 与 `addPending` 对含 `:` 的 userId 一律拒绝并 warn（warn 只截前 32 字符，不整串回显）。这是本条的主防线 —— 新的冒号身份再也进不来。
- **解析对齐（`src/inbound/identity.mjs`）**：`normalizeBinding` 与 `readPending` 改用 `indexOf(':')` 切分（`colon > 0` 才认，与管理台 `parseMemberKey` 同语义），含冒号的 userId 不再被截断成另一个人；`readPending` 另把存量含冒号的坏键**读盘即剔除**（旧版 `app_subscribe` 可能写入），并随统一写回一并清扫落盘，清扫必 warn（宪法 #3）。
- **wxpusher 形态收紧（`src/inbound/wxpusher-callback.mjs`）**：`UID_PATTERN` 去掉 `:` → `/^[A-Za-z0-9_.\-]+$/`，冒号 uid 在入站最外层即被拒并 warn。
- **读改删面故意保持容忍**：管理台 `parseMemberKey` 不拒冒号 —— 理由与实证见上方 REVIEW-ABC BUG-3 条目（否则存量越权行无法清理）。
- 测试：+3（`identity`：`addBinding` 拒绝冒号 userId 并 warn、`normalizeBinding` 用 `indexOf` 切分不截断；`wxpusher`：`INJ-1` 含冒号 uid 被形态校验拒绝并 warn）。测试契约 1004 → 1007。
- 变异验证：`addBinding` 冒号拒收、`normalizeBinding` 的 `split`、wxpusher `UID_PATTERN` 三处还原均立即见红。
- 注：`SHORT-C3.md` 记载的「1004/1004 pass、`node --check` OK」写于 BUG-1 语法错引入之前，与当时工作区实际状态不符；该摘要已就地标注更正。

### 修复：审批桥僵尸 `pending` 账本行吞掉编号回复（批次 C2 / P1-5，2026-08-24）

依据 `.agents/workstreams/crack-fix-plan/PLAN.md §批次C C2`。审批的「单次核销」此前只靠进程内 `entry.settled`；进程崩溃、重启或 `ledger.resolve` 写盘失败会在账本里留下 `status='pending'` 但**已无对应 waiter** 的僵尸行。`latestPendingFor` 迭代 `ap:` 前缀时会命中这些行 → 后续编号回复被僵尸行吸走、真实待决审批反而无人裁决，用户还收到「该审批已被处理」的误导回执（宪法 #5「账本先落终态」在崩溃缝隙下的残留形态）。

- `src/approval/router.mjs`：新增进程内 `liveWaiters` Set，仅在 `bus.wait(key)` 真的创建/复用 waiter 时登记（`mode === 'observe'` 不注册 waiter，天然不参与编号回复匹配 —— 与 observe「只旁观」语义一致）。`latestPendingFor` 的筛选条件从 `row?.status !== 'pending'` 加严为 `|| !liveWaiters.has(key)`，无存活 waiter 的僵尸行不参与匹配，消息落回对话路由而非被吞。
- **清扫归宿（宪法 #4）**：`decisionPromise.then(ok, err)` 双回调删 key —— `bus.wait` 的 promise 在四条路径（超时 null / settle 裁决 / abandon / dispose）全部会 settle，故每个 key 都有归宿；`dispose` 时清空整个 Set。审查复核确认无泄漏、无 settle 竞态。
- **E-2 已决竞态语义保持不变**：`settle` 后微任务尚未执行的窗口内，waiter 仍被视为存活 → `decideTrusted` 返回 `already-resolved` 后照旧走「该审批已被处理」消费路径（v0.8.3 E-2 的 4 例既有用例全绿）。
- 未动 `store.mjs` / `bus.mjs`；不新增 store 键族（`liveWaiters` 是纯内存集合，随实例生命周期消亡）。
- 测试：+3（僵尸 pending 行不参与编号回复匹配、消息落回对话路由；编号回复优先命中存活 waiter 并忽略更晚的僵尸行；崩溃恢复后持久化僵尸行不吞编号回复）。测试契约 1001 → 1004。
- 变异验证：还原 `liveWaiters` 闸门即见红。
- **真机验收未过（宪法 #8）**：证据来自 mock 与临时 `state.json`；真机需观测一次真实 kill -9 后重启、旧卡编号回复与新审批并存时的裁决走向。

### 安全修复：TG/飞书按钮来源比对「缺点击会话即放行」改为 fail-closed（批次 C1 / P1-4，2026-08-24）

依据 `.agents/workstreams/crack-fix-plan/PLAN.md §批次C C1`（宪法 #7「fail-open 要有度——守卫不能对缺关键信息时静默放行」）。SEC-1/F-08 建立的「点击会话 vs 卡片原始会话」比对，两个通道都在**点击侧元数据缺失**时放行 —— 攻击面等价于「把缺数据的回调形状造出来即绕过来源校验」，而这条正是既有测试全没覆盖的缝（转发拒绝用例一律用正常形状构造，mock 假定形状 ≠ 真实异常负载，宪法 #8）。

- **Telegram（`src/inbound/telegram-bot.mjs`）**：旧判据 `clickedChat !== undefined && originChat 非空 && 不相等` 是三项合取，`query.message?.chat?.id` 读不到（消息被删、事件形状异常、非 message 承载的回调）会把整式短路成 `false` → 直接放行裁决。现在拆成三级：`origin.chatId` 缺失（升级前在途卡片，本仓库所有 mint 点都带 chatId）→ warn 后兼容放行，窗口由 ref TTL 15min 天然封顶；`origin` 在场而点击会话读不到 → **拒绝**且不 `take()` 引用（原卡在 TTL 内仍可正常点，宪法 #6 不锁死）；两者在场且不相等 → 拒绝。判据用显式 `undefined`/`null` 比较而非真值 —— `chatId === 0` 是合法会话，`!clickedChat` 会把真实点击误判成缺数据（正控测试钉死）。**行为变化**：缺点击会话的回调由「静默放行裁决」变为回执「请到原会话操作」。
- **飞书（`src/inbound/feishu-bot.mjs` `sourceChatAllowed`）**：`clicked === ''`（负载缺 `context.open_chat_id` 且顶层兜底也缺，或值为空串）由 warn + `return true` 改为 `return false`。三个调用点（`ac:`/`aq:`/`ap:`）本就把 `false` 转成 toast「请到原会话操作」，不裁决、不 patch 终态、不核销 `wait`，所以收紧无需改调用点 —— 但此前只有审批分支有覆盖，本轮补上 `ac`/`aq` 平行面测试，防装配回归悄悄绕过。`srcChat === ''` 的旧卡兼容半边按 PLAN §C1(b) 显式保留不动。
- **拒绝路径全部 warn 出声（宪法 #3）**：两个通道的「缺数据拒绝」与「会话不一致拒绝」都补日志（TG mismatch 此前静默）；warn 只带 chatId/srcChat（非凭证，既有 warn 已带 userId）。
- 测试：+7（TG 4 例：缺 `message` 整块 → 拒绝且原会话仍可裁决、缺 `chat.id` → 拒绝、`chatId === 0` 正控放行、`origin` 缺 chatId 的旧卡兼容放行且 warn；飞书 3 例：缺 `context` → 拒绝且不 patch 不核销 wait + `open_chat_id` 空串 → 拒绝 + 原会话仍可裁决、`ac`/`aq` 平行面缺点击会话不执行不作答、`srcChat` 缺失旧卡维持兼容）。测试契约 994 → 1001。
- 变异验证（证明测试真的咬人）：TG 缺数据分支还原放行 → 2 红；TG 判据改 `!clickedChat` → 1 红（`chatId === 0` 正控咬住）；飞书 `clicked === ''` 还原 `return true` → 2 红。每次变异后以 `git diff --stat` 确认逐字节还原。
- **真机验收未过（宪法 #8）**：证据全来自 mock fetch 与 fake SDK。真机需观测：TG 卡片消息被删除后回调的真实形状（`message` 是否真会缺）、飞书长连接负载是否恒带 `context.open_chat_id`（若某些卡片类型不带，收紧会误拒真实点击 —— 这是本条最主要的回滚触发条件）。已记入 `docs/memory/risks.md`。

### 修复：入站内存学习表与 `wechat:ctx:` 键族全部收上界（批次 B-键族4 / P1-7，2026-08-24）

依据 `.agents/workstreams/crack-fix-plan/PLAN.md §批次B B4` 与 `PLAN-B-k4-fin.md`（宪法 #4「状态必须有界」）。这些表以 chatId/uid 为键**只增不减**——键的数量由外部（群数量、陌生人来消息）决定，长跑进程或被灌水时内存/`state.json` 单调膨胀，是 F-8 写放大与内存 DoS 的底座。

- **新增 `src/inbound/_bounded.mjs`（零依赖工具）**：`setBounded(map, key, value, max, onEvict)` 写超上限即从最旧一端淘汰（`Map` 迭代序 = 插入序），写已存在的键先 `delete` 再 `set` = **LRU 触摸**，活跃会话不会因「首次学习早」被误淘汰；`while` 而非 `if` 让上限调小/历史遗留的超量也能一次收敛。`createThrottledWarn(warn, { intervalMs, now })` 把淘汰这类高频降级的告警按 60s 窗节流，窗内累计次数随下次告警一并报出——既不静默（宪法 #3）也不刷屏。既有先例（`bus.mjs` 的 fifo/replyThrottle、`callback-refs.mjs` 的 `DEFAULT_MAX`、`turn-tracker` 的 `MAX_TRACKED`）收成一处，避免各通道抄歪。
- **钉钉（`src/inbound/dingtalk-stream.mjs`）**：`sessionWebhooks` / `chatSenders` 加 1024 上限（真实企业几十个会话，三个数量级余量）。淘汰安全 —— 前者缺失回落 `batchSend` 主动推送，后者缺失回落「chatId 当 staffId」，两条都是既有路径。`seenMsgIds` 的惰性窗口清扫此前**只在 `size > 1024` 时触发**，60s 内涌入上万条新 msgId（群灌水）时无一条过窗、表继续无界涨；现在补硬上限淘汰最旧（最旧条目离过窗最近，窗口内去重语义不变）。
- **QQ（`src/inbound/qq-gw.mjs`）**：`targetKinds` / `msgSeqs` 同加 1024 上限。淘汰安全 —— 前者缺失回落 `notifyGroups` 配置判定单聊/群（配置里声明过的群即使学习记录被淘汰仍按群投递），后者缺失从 1 重新递增（`msg_seq` 只需在同一 `msg_id` 下不重复）。
- **微信 iLink（`src/inbound/wechat-ilink.mjs`）**：`wechat:ctx:<uid>` 此前每个发过消息的 uid 永久占一条 `state` 键、唯一归宿是 `sessionExpired` 全清；现在键族收 256 个 uid 上限，超限按**首见顺序**淘汰最旧（`Object` 键序 = 插入序，跨重启保序），存量超量在下一次写入时一并收敛。淘汰安全：ctx 只是「发送时回显最新 `context_token`」的缓存，缺失走既有「不带 token 发 → -14/伪装 -2 → 剥 token 重试」路径。`store` 无 `keys()` 的精简实现走**显式 fail-open**（跳过淘汰但照常写入，宁可无界也不丢功能），该降级路径由测试钉死不静默。
- **D-7 廉价半边（`context_token` 形状校验）**：`context_token` 由对端消息携带，陌生人可塞任意长/带控制字符的串进 `state`（膨胀 + 污染日志与后续 JSON 载荷）。现在 >512 字符或含空白/控制字符一律拒收并 warn，**本条消息其余处理照常入站**（宪法 #6 不因一个字段失误吞掉消息）。
- **防抖表与宽限窗（`src/event-listener.mjs` / `src/rules.mjs`）——行为变化**：`createTrailingDebounce` 与 `createGraceQueue` 的在途表以 sessionId 为键、靠各自定时器到点自清，但 `debounceMs`/`graceSeconds` 可配且**无上限**（`config.mjs` 只钳下限 0），配成分钟/小时级 + 会话高频轮换时两表可无界堆积（每条还挂一个活定时器）。现在各加 256 个 key 上限，**溢出时立即触发最旧一条**并 warn。行为变化仅限「本该再等窗口末尾/宽限期的那一条被提前推送」——绝不静默丢弃通知（宪法 #3）；装配处两个 `onOverflow` 都接 `warn`。
- **同轮自审修掉三个自引入/既存缺陷**：① `_bounded.mjs` 的空转护栏原写作「最旧键 `=== undefined` 即 break」，键本身为 `undefined` 时会被当成空表、淘汰停摆而表越过上限——改判迭代器的 `done`；② 钉钉去重表的清扫阈值 `>` 在有了硬上限后**永不成立**（`setBounded` 保证写后 `size <= max`），惰性清扫成死代码、稳态高流量主机每条新消息都走「淘汰 + 告警」白丢去重记录还刷日志——改为 `>=`，表满先清过窗条目、清不出空位才淘汰；③ `createTrailingDebounce.flush()` 只 `timers.clear()` 却不 `clearTimeout`，卸载后最多 256 个已挂起定时器留在事件循环里，`debounceMs` 配长时进程要等整个窗口才退出（本仓库测试套件因此被吊住约 60s，修复后全量耗时 121s → 68s）——与 `grace.flush()` 对齐逐个清除。
- 测试：+54（`test/bounded.test.mjs` 新建 22 例：LRU 触摸/淘汰回调/回调抛错不致命/cap 正常与上下边界与越界五态/`Infinity` 与 `0` 的宽容语义/存量收敛/3000 条压测/`undefined` 键；钉钉 +5、QQ +4、微信 +7、`grace` +8、`debounce` +8 含两条装配级 300 会话零丢失与定时器泄漏钉死）。测试契约 940 → 994（本条原记作「956 → 1010」，绝对数偏高 16；2026-08-24 在 `f3fce85^` 与 `f3fce85` 上实测复核为 940 → 994，+54 增量不变，以本行为准）。
- 变异验证（证明测试真的咬人）：短路 `setBounded` 淘汰 → 19 例红；短路 `grace` 腾位 → 6 例红；短路 `debounce` 腾位 → 4 例红；`wechat:ctx` 淘汰置空 → 4 例红；去重阈值改回 `>` → 1 例红；`flush` 去掉 `clearTimeout` → 1 例红。每次变异后均以 `git diff` 确认逐字节还原。
- **真机验收未过（宪法 #8）**：全部结论来自 mock fetch/WebSocket 与临时 `state.json`。真机需观测：钉钉 60s 内 >1024 条消息的去重与告警节流、QQ >1024 个目标的接口选择回落、微信真实 `context_token` 的长度与字符集分布（512 上限是否误伤）、防抖/宽限窗溢出提前推送的用户体感。已记入 `docs/memory/risks.md`。

### 安全修复：引导码文件交付 + 过期码泵码堵死 + 文案不再指引 stderr（批次 B-1，2026-08-23）

依据 `.agents/workstreams/crack-fix-plan/PLAN-B1.md`（solution2.md 推荐方案 A + B2 + B4）。三条缺陷同属一条泄露链：引导码明文进持久化日志 + 过期码可无限重铸 + 文案把用户往日志里引。

- **LEAK-2 引导码明文进日志（高危）**：`showBootstrap`（`src/index.mjs`）原先经 `warn()` 双写（宿主 logger + stderr）把 owner 级配对码码面打进持久化日志（journald/Loki/ELK），任何能读日志的账号即可拿到首绑凭证。现在码面写 `<stateDir>/bootstrap-paircode.txt`（`mode 0600`，写前先 `unlinkSync` 防 symlink 写穿），stderr/logger **只印路径与有效时长，绝无码面**；写失败不回退印码面，只 warn 指引管理台铸码（宪法 #3 不静默、不泄漏二者兼顾）。
- **码面不留残渣**：新增 `clearBootstrapCodeFile()`，挂 `pairing.onAudit` —— bootstrap 码进 `redeem`/`expire`/`revoke` 任一终态即删码文件（含 re-mint 先 revoke 后 mint 的替换时序）；非引导态启动（`allowUsers` 已配或绑定表非空）顺手清掉上一轮残留文件，码面不过夜。同时移除 `bootstrapCode` 变量，码面不再驻留内存。
- **BYPASS-BOOT 过期码泵码（行为变化）**：`src/inbound/pairing.mjs` 的 `redeem` 对 expired 码原先直接 return、**不记失败计数**，过期码可无限次触发 `ensureBootstrap` 重铸（24h 内约 144 枚，旧实现每枚都进 stderr）。现在过期码提交同样计入 `recordFailure`，滑窗 5 次后锁出 10 分钟并返回 `locked-out`；`commands.mjs` 的 expired 重铸分支因 reason 已变而不再命中，锁出态不重铸。**行为变化**：连续第 5 次提交过期码的回执由「配对码已过期」变为「尝试次数过多，已临时锁定 10 分钟」；单次过期提交的语义不变（宪法 #6 用户失误不锁死）。
- **重铸节流 + 回调不静默**：`ensureBootstrap`（`src/inbound/commands.mjs`）新增同进程 10 分钟节流窗与 `minted.ok` 校验，不再对失败的 mint 假断言「已重铸」；`onBootstrapRemint` 回调异常原为空 catch 吞掉，现在 warn 出声（码已铸但文件可能未写入，指引查管理台）。节流/失败时 `/pair` 回执明确告知「重铸失败或节流中」，不静默吞掉（宪法 #6 停留在「等待再试」）。
- **文案（B4）**：5 处不再指引用户去翻 stderr/宿主启动日志，改指「本机引导码文件」与管理台 —— `whoamiText` 未绑定提示、`guidedHelp` 配对码位置、`/pair` 无参用法、expired 重铸成功回执、expired 节流回执。同步改口径的用户文档：`docs/guide.md` 引导码段落、README/README.zh-CN 身份体系条目（双语并行）。
- **自审补漏（本轮 review 发现，PLAN 未列）**：`ensureBootstrap` 在「已有在铸引导码」时也返回 `null`，若与节流共用同一句回执会谎报「重铸失败或节流中」——正是 B4 要治的 MISLEAD 类。现在该分支单独回执「当前已有在铸引导码，请取现码」；另修 `writeBootstrapCodeFile` 的 `error.message` 对非 Error 抛出物会得到 `undefined`（统一走 `instanceof Error` 三元，与文件内既有惯例一致），并去掉未使用的 `expiresAt` 形参。
- 保留 `【引导配对码】` 前缀（既有 `test/admin-wiring.test.mjs` 断言不破）；不新增 store 键族，无新增运行时依赖（`node:fs` 内置）。
- 测试：+13（引导码文件 mode 0600/单行码面、码面零泄漏正负控双钉、写失败不回退印码面、symlink 不被写穿、非引导态启动清陈旧文件、管理台撤销经真 HTTP 面触发删文件且 API 响应无码面、过期码 5 次锁出、锁出上下边界第 4/第 5 次、复合键隔离不牵连他人、重铸节流、回调异常 warn 出声、有在铸码时不谎报重铸失败、单次过期回执语义不变）；测试契约 927 → 940。
- 未收口的残差已登记技术债：admin UI 与 `bus.mjs` whoami 文案仍引 stderr、README/`docs/guide.md` 仍写「终端日志里打引导码」、跨进程节流不共享。

### 安全修复：越权裁决族四条 P0 全部改 fail-closed（批次 A / CRACK-001~004，2026-08-23）

依据 `~/dsh-notifier-handoff/27-crack.md` 破解轮与 `.agents/workstreams/crack-fix-plan/PLAN.md §批次A`（commit `013ec48`，契约 909 → 927；本条目于 2026-08-24 neat 轮回补 —— 提交时遗漏 CHANGELOG，违反军规 2.2#5「每个审查发现的修复都要写进 CHANGELOG 并注明审查编号」，登记为文档同步缺陷）。四条同属一族：**来源/归属证据不足时旧实现选择放行**，攻击者只要把证据缺掉就能越权裁决他人的审批、动作与提问。

- **CRACK-001 动作卡缺来源元数据即兼容放行（`src/actions.mjs`）**：F-08 建立的 `ac:` 来源校验对 `srcChats === undefined` 的历史卡 warn 后放行 —— 该放行**无时限**，等于永久免检卡，转发 ⏹ 卡即可取消他人任务。现在收成 `LEGACY_SOURCE_GRACE_MS = 10min` 的升级迁移宽限窗（上界对齐 `tokens.mjs` 的 token TTL：升级瞬间在途的旧卡本就只剩 ≤10min 生命期），窗外一律拒绝；放行与拒绝**两条路径都 warn**（宪法 #3）。
- **CRACK-002 `bus.decide` 的 `allowChats=null` 时来源校验整段跳过（`src/inbound/bus.mjs`）**：旧判据是「注册了范围**且**带了 chatId 才校验」的合取，缺任一侧整段短路 → SEC-1 的按钮来源校验被绕过。现在改为「有源证据才算有效按钮路径」：缺点击会话或缺来源范围一律拒绝并 warn，**不核销 wait**（合法原会话仍可裁决，宪法 #6）；无 waiter 的重放/已决路径不进本分支，保留 `settle` 的 `already-resolved` 语义。
- **CRACK-003 编号回复无归属校验（`src/approval/router.mjs`）**：`decideTrusted` 路径不过 token，任何白名单 member 回复 `1` 即可裁决同渠道任意待决审批。`latestPendingFor` 现在给命中结果带 `evidence`（`exact` | `onChannel` | `intended`）：`exact`（卡片发本人）直接放行，`onChannel`/`intended`（他人卡片或广播兜底）**仅该渠道绑定的 owner 可代决**，拒绝时回执「此审批不是发给你的(无权裁决)」并 warn。`identity` 缺失或 `list()` 抛异常一律 `return false`（fail-closed）。
- **CRACK-004 提问 hint 兜底跨渠道越权作答（`src/questions/router.mjs`）**：同构改造 —— `evidence` 为 `exact`/`onChannel`（questions 侧两者都已是同 user 命中，见 SEC-5/6）放行，`hint`（广播编号话术兜底）仅 owner 可代答，拒绝时消费裸编号 + 回执「此提问不是你作答的（无权回答）」，**问题保持待决**、原提问者仍可作答（宪法 #6 不锁死）。
- **装配**：`src/index.mjs` 把 `identity` 传进 `registerApprovalHandler` 与 `createQuestionBridge` —— 两处归属闸的生效完全依赖这两行，缺失即静默 fail-closed（该装配缝后由 REVIEW-ABC BUG-6 补上装配级守卫）。
- 测试：+18（`actions` / `approval` / `approval.multi` / `inbound` / `questions` / `inbound.feishu` 六个文件）。测试契约 909 → 927。
- 残差已登记 `~/dsh-notifier-handoff/20-techdebt.md`：CRACK-001-R1（畸形 `srcChats` 形态，后由 REVIEW-ABC BUG-4 补测试钉死）、CRACK-001-R2（`createdAt` 在未来时宽限窗无上界，同进程可信写入方不可达）。

## [0.8.6] - 2026-08-23

> 覆盖公共镜像 `THEWOLFWALKER/dsh-notifier` 已发布的 `v0.8.5`，并额外包含 PR #9 飞书扫码 SDK 适配与 P1-1/P1-2/P1-3 技术债修复。

### 修复：P1-3 跨进程状态压力——崩溃残留锁的 10 秒降级写窗口（2026-08-23）

- P1-3 状态压力审查（一次性多进程 harness，证据见 `.agents/workstreams/p1-3-state-stress.md`）：6 写者不相交键并发（360 键零丢失）、4 写者高碰撞（1800 次抢锁零丢失）、mtime 读收敛（CLI 写入 ~3ms 内对宿主可见）、损坏自愈（同实例中途外部写坏 → 双取证 + 内存全量重建，凭证键存活）、SIGKILL 风暴后文件始终可解析——键级合并、锁属主校验、自愈路径全部按设计工作。
- **确认缺陷**：陈锁判据只有「锁 mtime >10s」一条。持锁进程 kill -9/断电/OOM 崩溃后，残留的新鲜锁最长 **10s 内不被判回收**——窗口内每个进程的每次 `save()` 都白等两轮 ~480ms 再**降级无锁写入**（丢写保护失效，正是 v0.6.3 键级合并要防的整文件丢写形态；实测两进程在幽灵锁下双双降级）。
- `src/inbound/store.mjs`：新增死亡探测——利用 v0.6.5 属主落章 `pid:random` 格式，锁龄超 500ms 宽限期（防「刚创建即读」与 pid 复用竞态）后 `process.kill(pid, 0)` 探测，ESRCH=确死当场回收；存活/EPERM/畸形内容一律维持旧行为。三个回收点（进入前/自旋内每 8 拍/双轮间隙）统一走 `recoverableLock()`。
- 方向保守：pid 被无关新进程复用只会让恢复退回原 10s mtime 判据，绝不提前抢活锁；外来格式锁内容永不触碰。
- 测试：+4（死属主新鲜锁当场回收不降级、活属主照常双轮降级且不误删、宽限期内不推断、畸形内容维持 mtime 判据）；测试契约 902 → 906，四处计数引用同步。

### 修复：ask_user 编号回复在出站/入站异名与纯入站通道失效（issue #11，2026-08-23 自公共镜像接力合入）

- `src/questions/router.mjs`：`pushQuestion` 计算 `hintChannels` 时，把「该问题目标用户已绑定、卡片未送达」的交互入站通道一并计入（如 `qq`/`wechat`），编号话术经入站 `sendText` 送达纯入站通道（wechat iLink 无出站文本可走）；已由出站文本送达的通道（同名 type 或别名对 `qq-bot↔qq`）只补通道名不重发，避免同号双发。修复 QQ 官方机器人（`qq-bot` 出站 ↔ `qq` 入站异名）与微信 iLink（inbound-only）场景下 `ask_user` 编号回复完全失效、并落入 conversation 路由污染对话的问题。
- 安全约束不变：只加目标用户已绑定（`notifyTargets()` 三级解析非空）的通道，话术确实送达才入 `hintChannels`，维持 SEC-2 fail-closed——没收到话术的渠道/用户裸编号仍拒绝并 warn。
- 测试：`test/questions.test.mjs` 新增 3 用例（QQ 异名命中且不双发、iLink 纯入站 sendText 送达后命中、未绑定目标通道不补入 hintChannels）。镜像侧 885→888；本仓库契约以收口计数为准。

### 修复：飞书扫码一键建应用适配新版 SDK 协议（PR #9，2026-08-23 自公共镜像接力合入）

- `src/inbound/_feishu-register.mjs`：@larksuiteoapi/node-sdk ≥1.73 的 `registerApp` 回调名从 `onQrCode` 变更为 `onQRCodeReady`（接收 `{ url, expireIn }`），旧名会让 SDK 抛 "onQRCodeReady is not a function"；`addons` 从已弃用的 `resources` 名值映射改为 `normalizeAddons` 白名单协议（`preset/scopes/events/callbacks`），旧结构会抛 "addons.resources is not allowed" 导致扫码建应用失败。
- `scopes.tenant` 扩展为与 feishu-bot 长连接收发能力一一对应的权限集（p2p/群 @/群消息只读 + `im:message:send_as_bot` 出站）；`events` 订阅 `im.message.receive_v1`，`callbacks` 订阅 `card.action.trigger`（审批/停止按钮回调）。
- `test/channel-login.test.mjs`：fake SDK 与断言同步新协议（onQRCodeReady `{url}` → onQr 透传、scopes/events/callbacks 结构）。

### 修复：P1-2 错误可见性——三处静默故障路径补告警（2026-08-20）

- 审计范围：全量扫描 src/ 的 356 个 catch 块（141 有日志可见 / 139 有注释的刻意静默 / 7 前端 UI / 61 无注释静默逐个核实）。`_shared.mjs` 5 处为误报（catch 后分类重抛）；`ledger.mjs` 静默是文档化设计军规（账本失败绝不影响推送）；tokens/verifyToken 等 fail-closed 静默为安全正确行为——均不动。
- `src/approval/router.mjs`：审批分流的路由引擎异常原先静默回落全局广播（同函数的空集回落自 v0.6.5 起就有 warn，异常路径却零日志）。现在异常同样 warn（含引擎报错原因）；fail-safe 广播投递语义不变。
- `src/inbound/store.mjs`：启动时 state 文件损坏原先静默清零——绑定表/待审批/扫码凭证全部丢失且零日志。现在对齐 v0.6.5 save 路径的取证惯例：现场以 **copy**（非 rename——boot 时他进程可能持有该文件）转存 `.corrupt.<ts>` + 告警；空文件视作空态静默起步（无记忆可丢失，不算损坏）；读失败（权限/占用）与解析失败区分，前者维持静默；取证 copy 有 8MB 体积护栏（异常巨物只告警不复制，避免占满磁盘）。fail-open 语义不变。
- `src/rules.mjs` + `src/event-listener.mjs`：`keywords.regex` 非法正则原先静默降级字面量子串匹配——语义从「正则命中」变「子串包含」，include 规则可能永不命中（通知静默停止）。降级行为保留（宁可漏拦不炸启动），但 `createKeywordFilter` 新增 `regexFallbacks` 纯数据上报（模块保持零 IO），event-listener 装配时非空即 warn 列出降级条目。
- 测试：+5（审批异常分流告警、boot 取证不破坏并发写者、读失败不取证、空文件不告警、regexFallbacks 条件暴露）+3 处既有断言语义更新（boot 取证副本 1→2 等）；测试契约 897 → 902。
- review 过程：三轮对抗性 review（攻击者/资源耗尽、跨切面回归、全量 diff 重读），修正 2 个自引入缺陷：取证 copy 无体积护栏（巨物翻倍占盘）、空文件误判损坏（噪音告警）。

### 修复：Telegram 卡片文本超长护栏（P1-1 协议盲区，2026-08-20）

- 背景：TG `sendMessage` 的 text 硬限 4096 字符，超限必 400 `message is too long`。审批 `reason` / 提问 `context` / 动作卡 `content` 上游均无长度上限（public 层各 20000 码点），长文案会让按钮卡在所有会话全军覆没——卡片 catch 后只 warn 一行并返回 null，静默退化为纯编号回复。这是与 v0.6.2 `BUTTON_DATA_INVALID`、v0.6.3 legacy markdown 同类的 mock 盲区（mock fetch 不校验协议形状，单测测不出）。
- `src/inbound/telegram-bot.mjs`：新增 `clampTelegramText()` 护栏，`sendApprovalCard` / `sendActionCard` / `sendQuestionCard` 三个卡片路径的 text 统一钳制。计数按 **UTF-16 码元**执行（对抗性 review 修正：TG 底层 UTF-16 存储，astral 字符 1 码点 = 2 码元——只按码点数截到 4096 的全 emoji 文本实际 8192 码元，真机仍会 400）；切口回退到码点边界，绝不劈开 surrogate pair；截断处追加可见标记 `…（内容过长，已截断）`。限内文本零改动直通。
- `test/inbound.telegram.test.mjs`：+6 项协议形状契约——审批/提问/动作卡超长截断仍送达（不因 400 退化）、码点合规但码元超限的全 emoji 文本必须截断（码点计数会漏的对抗用例）、surrogate pair 完整性、限内文本不加标记不误伤、按钮 ref 形态不受截断影响、三种卡 sendMessage 一律不带 `parse_mode`（v0.6.3 legacy markdown 400 事故防回归护栏）。
- 测试契约 891 → 897；`package.json` `dshQuality.testCount`、README 双语徽章/正文、HANDOFF 测试行同步。
- 真机验证缺口：截断后的合规长度在真机的实际表现（含代理转义差异）仍待真机复验，已记录 `docs/memory/risks.md`。

## [0.8.5] - 2026-08-19

### Security

- `dsh-notifier/sent` 公共事件契约升级至 `0.7`：事件现在只包含送达状态、渠道、来源与标题/正文长度及 UTF-8 字节数等元数据，不再暴露 `message.title`、`message.content`、审批/用户文本或适配器错误正文；事件 payload 仍深冻结。
- 定向 `ctx.notifier.push(..., { channel })` 现在与广播共享同一内部审计回调，在成功、失败、未配置和限流结果完成后各记录一次；直接调用方的返回值形状保持兼容。

### Changed

- 消费方读取 `record.message` 的 sent 事件逻辑需迁移到 `titleLength`、`contentLength`、`titleBytes`、`contentBytes`、`hasContent` 与投递状态字段。

> 交接打包批：npm 发布包文档完整性修复 + guide.md 补齐 v0.8 远程提问章节 + 仓库文件地图。
> 本版同时包含插件事件脱敏与定向发送审计统一；当前 Windows 主机 887/891 通过，4 个桌面测试需 BurntToast/PowerShell 能力。

### 修复：npm 发布包文档完整性（README 引用死链）

- `package.json`：`files` 数组补入 README 链接到但不在包内的用户文档——`PLUGINS.md`（插件互操作契约，README 双语均引用）、`THIRD_PARTY_NOTICES.md`（第三方声明，README 底部链接）、`docs/guide.md`（完整使用指南，README 双语均引用）、`docs/upgrade-guide.md` / `docs/upgrade-guide.en.md`（升级/回滚指南）。装包用户从此不再遇到 README 死链（`npm pack --dry-run` 验证：138 → 143 个文件）。
- `README.zh-CN.md` / `README.md` 无需进 files 数组——npm 的 `README*` 自动包含规则已覆盖。
- 边界规则落 HANDOFF §1.5「仓库文件地图」：**README 链接到的文件必须在发布包里**；给装包用户的文档进 files 数组，贡献者文档（HANDOFF / ADAPTER / 设计存档 / 真机测试记录 / 截图）留仓库即可。

### 文档：guide.md 补齐 v0.8 远程提问章节

- `docs/guide.md`：「日常使用」新增「远程提问」小节——选项卡点答（飞书/TG）/ 编号回复（QQ/微信/钉钉/WxPusher，多选逗号分隔）/ 答错重答不作废 / 超时永不代答。v0.8.0 落地的 `ask_user` 此前在全部用户文档缺位（README 双语与 HANDOFF 已由 2026-08-19 早前提交 `f559658` 同步），本版补全最后一块。

### 交接

- HANDOFF.md：交接快照刷新至 0.8.5；新增 §1.5 仓库文件地图（发布包内容 vs 工程仓库文件，逐目录归属）；待办清单勾销 guide.md 缺口项。
- 仓库卫生：`node_modules`（947 文件）与 `package-lock.json` 系 v0.7.1（`59e954e`）整目录误提交（`.gitignore` 写了但先于 ignore 落库的文件不受约束），本版 `git rm --cached` 出库——实证零依赖成立（移走两者后完整测试仍全绿），`@deepseek-ai/cordis` 4.0.1 也在公共 npm，新克隆无需特殊处理。仓库体积 42MB → 2.4MB（zip 5.3MB → 1.2MB）。

### 测试

- `npm test`：891 项契约；当前 Windows 主机 887 通过，4 个桌面能力测试因环境缺失失败。

## [0.8.4] - 2026-08-18

> 安全收敛批：动作卡转发拒绝（F-08）、提问按钮会话收敛 + 编号回复 onChannel 收紧（AUTH-1/S-1）、
> WxPusher 回调面加固（INJ-1/OTH-1）、账本孤儿 pending 清扫、CI 移除 windows matrix。
> （本条目由接手 agent 于 2026-08-19 按 `38e08e5` 提交内容回补——发版时遗漏了 CHANGELOG 条目，
> 违反军规「每项修复必须进 CHANGELOG」，回补留档、引以为戒。）

### 安全：动作卡（ac:）来源会话校验——转发到别的会话点击不再生效（F-08）

- `src/actions.mjs`：`mintAction` 增第 3 参 `meta { channel, chatId }`，账本行落 `srcChats`（channel → chatId[]）；新增 `markSource` / `unmarkSource`（多目标广播发送前登记、失败/降级撤销）；`dispatch` 增 `chatId` 参数——新卡（有 srcChats）点击会话必须在来源集合内，否则 `source-chat-mismatch` 拒绝；缺点击会话 `source-chat-required` 从严拒绝（含跨通道转发）；无 srcChats 的历史卡显式 warn + 兼容放行（不打在途旧卡，但绝不静默）。
- `src/event-listener.mjs`：动作卡发送前先 `markSource`（登记先行堵「已发卡但账本无来源」的竞态窗口），发送失败/降级 null 时 `unmarkSource` 回滚。
- `src/inbound/telegram-bot.mjs`：dispatch 透传 `query.message?.chat?.id`；动作卡短引用 mint 携带 `{ chatId }`（v0.6.2 `r:<ref>` 机制扩展）。
- `src/inbound/feishu-bot.mjs`：动作卡按钮 value 嵌入 `srcChat`；callback 侧 `sourceChatAllowed` 前置校验 + dispatch 透传点击会话。

### 安全：提问（aq:）按钮会话收敛 + 编号回复 onChannel 收紧（AUTH-1 / S-1）

- `src/questions/router.mjs`：`askQuestions` 的 `bus.wait` 登记 `allowChats`（复用 v0.8.3 SEC-1 审批同款机制），`pushQuestion` 每送达一张卡片把对应 chatId 并入集合——转发到未送达会话的按钮点击被 bus.decide 拒绝；空目标 = 空 Map，不放行任意会话。
- `src/questions/router.mjs`：编号回复降级链的 `onChannel` 档从「该渠道推送过（他人代答）」收紧为「该渠道推送过且 userId 一致」——同渠道他人代答面关闭，exact/hint 两档语义不变（与 0.8.3 SEC-2 同向收紧）。

### 安全：WxPusher 回调面加固（INJ-1 / OTH-1）

- `src/inbound/wxpusher-callback.mjs`：uid 形态白名单 `^[A-Za-z0-9_.:\-]+$` 且长度 ≤128（与身份层一致）——`send_up_cmd` / `app_subscribe` 双入口校验先行，拒绝空白/控制字符/路径穿插/超长，杜绝伪造 uid 投毒待确认绑定表或膨胀 store 键。
- 回调绑定非回环 host 且未配置 `allowedIps` 时**拒绝全部回调来源**（fail-closed：WxPusher 上行回调无签名，公网面即冒用面）+ 显式告警指引（配 allowedIps 或回环 + 反代）；本地回环默认不受影响。

### 修复：账本孤儿 pending 清扫 + 审批行落 mode

- `src/index.mjs`：`ap:` / `act:` / `aq:` 的 pending 行超过孤儿线 `max(2h, approvalTimeout×2, questionTimeout×2)` 判孤儿清扫（observe 审批与无法分类的旧行保留）；`aq:` 前缀首次纳入清扫——提问账本不再无限增长。
- `src/approval/router.mjs`：审批账本行落 `mode` 字段（`answer` 模式标记，配合孤儿线区分可清扫/需保留）。

### CI

- `.github/workflows/ci.yml`：移除 windows matrix——headless 环境跑不了 PowerShell desktop toast，长期红不如不跑（linux/macos 保留）。

### 测试

- 新增用例覆盖：动作卡来源校验三态（命中/越界/历史卡兼容放行）、TG/飞书点击会话透传、提问 allowChats 与 onChannel 收紧、WxPusher uid 形态与公网 fail-closed、孤儿清扫联动（`test/actions.test.mjs`、`test/inbound.telegram.test.mjs`、`test/inbound.feishu.test.mjs`、`test/inbound.wxpusher.test.mjs`、`test/questions.test.mjs`、`test/wiring.route.test.mjs`、`test/approval.test.mjs`、`test/inbound.test.mjs`）。
- `npm test`：历史版本记录为 885/885 通过（862 基线 + 23 新增）。


## [0.8.3] - 2026-08-18

### 修复：提问编号回复竞态收紧（SEC-2，questions 侧 any→hint）

- `src/questions/router.mjs`：`latestPendingFor` 的编号回复兜底从「无条件取最近一条 pending（`any`）」收紧为「该渠道确实收到过本问题的编号话术（`hint`，=aq 行 `hintChannels`）」，匹配优先级 `exact → onChannel → hint`。关死「既没送卡、又没广播编号话术的渠道裸数字越权仲裁」的面（架构审查 SEC-2 / C-2 / BUG-11）。
- `src/questions/router.mjs`：`pushQuestion` 把广播编号话术的渠道集合 `hintChannels` 一并返回，`askQuestions` 落账到 aq 行；`isHintedChannel` 对无该字段的旧行恒 false（fail-closed 从严，升级瞬间在途最多超时回退，绝不越权）。
- 降级链三支不断：卡片送达（exact）/ 同渠道他人代答（onChannel）/ 无卡渠道收到编号话术（hint）全部保留；`P4 全渠道无卡片`、`P4 投递失败` 用例保持绿。
- **approval 侧零改动**（approval 已无 `any`，本版只收紧 questions）。

### 修复：审批编号二次决策消费一致性（E-2，approval 侧对齐 questions）

- `src/approval/router.mjs`：`handleNumberedReply` 在 `verdict.ok===false`（已决竞态：首达采纳/超时已 settle、账本暂未翻终态）时，从「不消费 + 无回执」改为「消费（`return true`，阻断裸 `'1'/'2'` 落回对话路由）+ 回执「该审批已被处理（首达采纳，此次回复无效）」」，对齐 `questions/router.mjs:316-318` 既有姿态（架构审查 E-2）。
- `pending === null`（无匹配待决审批）路径**不变**：裸 `'1'/'2'` 是正常会话消息，仍不消费、落回对话路由——两簇方向相反的行为用测试钉死，防过度收紧/过度放宽。
- `bus`/`settle`/`decideTrusted`/`latestPendingFor`/questions 侧零改动；首达采纳、token 单次核销、降级链语义不变。

### 测试

- `test/questions.test.mjs` 新增 5 用例：跨渠道抢答拒绝、hint 正控、多 pending 定向隔离、旧行 fail-closed、exact/hint 优先级稳定。
- `test/approval.test.mjs` 新增 4 用例：已决竞态消费+回执、回执失败仍消费（B8）、无匹配裸编号不消费（B3/B9）、未 settle 正常 pending 仍走裁决（B1）。
- `npm test`：862/862 通过（858 基线 + 4 新增；approval 相关既有用例零改动仍全绿）。

## [0.8.2] - 2026-08-18

### 修复：ask_user 装配回归 + 入站 ENV 解析回退

- `src/index.mjs`：恢复 `questions/router.mjs` 装配（`createQuestionBridge` / `registerAskUserTool` / `questionsForChannels` / `attach()`），让 `ask_user` 工具重新注册、Telegram/Feishu 的 `aq:` 提问按钮重新接上，并保留当前版本已有的 `busRef` / dispose 级联改动。
- `src/index.mjs`：入站 `feishu` / `qq` / `dingtalk` / `wxpusher` 的 resolve 流统一先过 `resolveEnvRefs`，避免 `${ENV:NAME}` 在入站配置里原样透传。
- `test/index.test.mjs`、`test/wiring.route.test.mjs`：补回归断言，覆盖 `ask_user` 工具注册、`createQuestionBridge/registerAskUserTool` 导出，以及整体装配不回退。

### 测试

- `npm test`：846/846 通过。

## [0.8.0-tg.0] - 2026-08-17（Telegram 真机测试包）

> v0.8 远程提问（issue #3/#5，规划书《选项卡通知》M1）首个可测版本。
> 测试步骤曾随测试包提供；当前验证边界以 `docs/memory/risks.md` 为准。

### 新增：ask_user 远程提问工具（`src/questions/router.mjs`）

- agent 可向手机推送 1-4 个选择题（每问 2-5 选项，支持多选），用户作答后答案回传 agent。
- **选项卡为主、编号兜底**（P4）：飞书/Telegram 单选推选项卡片（一选项一钮）；编号文案只发卡片未送达的渠道（无按钮通道 / 卡片投递失败 / 多选）。
- **发错可再答**：越界编号 / 单选回多项 → 回执提示 + 选项重发，问题保持待决，不作废。
- **超时永不代答**（P2）：超时 answered=false 交还桌面，绝不编造默认答案。
- 回调载荷短引用压缩（复用 v0.6.2 `r:<ref>` 机制，P7 不携带选项文本）；token 单次核销 + 首达采纳；30s/60s 催办升级链（复用审批 escalation）。
- 配置：`questions.enabled`（默认 true）/ `timeoutMs`（默认 300000，30s-30min 钳制）/ `rateLimitPerMinute`（默认 6）。

### 修复：Telegram `editResolved` 契约签名错位（真机 mock 盲区）

- `src/inbound/telegram-bot.mjs`：契约 `editTarget` 非 legacy 路径传 `(target, text)` 两参，TG 实现按 `(chatId, messageId, text)` 三参收 → 真机 `chat_id` 收到 target 对象，TG 400 被吞，**超时/编号回复路径的卡片终态编辑静默失败**。双形状防御解析兼容两种调用。
- 同类模式回顾：v0.6.2 `callback_data` 64 字节事故同源——mock fetch 不校验参数形状，835 用例全绿也测不出，真机才暴露。

### 测试

- 新增 `test/questions.test.mjs`（19 用例）：卡片分流、发错重发、多选中英文逗号、超时不代答、伪造 token、首达采纳、参数校验、限流、dispose。
- 测试抓出 1 个真 bug 并修复：`askQuestions` 从裁决信封取答案读错层级（`outcome.idxs` → `outcome.decision.idxs`），作答路径答案恒空。

## [0.7.3] - 2026-08-17

> GitHub issue 修复批：6 个 open issue 中的 5 个 bug 全部修复（#1/#2/#4/#6），
> #3/#5（ask_user_question 桥接）依赖宿主侧事件发射，列入规划。

### 修复：飞书 WSClient `logger: null` 静默崩溃（#1/#4-Bug2/#6-Bug1，三人三报）

- `src/inbound/feishu-bot.mjs`：SDK 1.46+ 的 `WSClient.start() → reConnect()/pullConnectConfig()` 内部调 `this.logger.info/debug/error`，`logger: null` 直接抛 `Cannot read properties of null`，rejection 被吞后**长连接静默永远连不上**。改传 noop 实现，`error` 级转发到插件 warn（SDK 内部错误不再不可见），`info/debug` 静默不刷屏。

### 修复：卡片终态 patch 读错 messageId 字段（#6-Bug2）

- 长连接投递的 `card.action.trigger` 负载顶层没有 `message_id`，实际位于 `data.context.open_message_id`；旧取法恒空串 → 裁决后卡片永远 patch 不成终态（按钮可重复点）。取值顺序改为 `context.open_message_id` 优先，顶层字段兜底保留。

### 修复：`agent/created` 载荷未解包，文本消息全部拒投（#4-Bug1）

- `src/inbound/conversation.mjs`：DSH 事件签名是 `(payload: { agent })`，旧代码 `agent?.id` 恒 `undefined` → `latestSessionId` 永不赋值，未 `/bind` 用户的文本全部走到「没有活跃会话」（现象：**命令能回、文本全丢**）。解包 `payload.agent`（兼容直传 agent 的旧宿主）+ `agent/disposed` 同修。
- 只追踪根 agent：后台 subagent 同样触发 `agent/created`，宿主暴露 `ctx.agents.roots()` 时过滤；老宿主无此 API 退化全量追踪。

### 修复：`stop()` 关不掉 WSClient，重激活泄漏僵尸连接（#4-Bug3）

- SDK（1.46/1.61/1.73）的 `WSClient` **没有 `close()/stop()`**，旧代码探测落空后旧实例 WS 永不断开：每次宿主重激活泄漏一条僵尸连接（事件被随机分发到旧连接）+ 僵尸实例用旧内存覆盖 `state.json`（`/bind` 绑定神秘丢失）。补 `wsConfig.getWSInstance().terminate()` 兜底。

### 修复：入站配置不解析 `${ENV:NAME}` 引用（#2）

- `src/index.mjs`：全部入站通道（feishu/qq/dingtalk/wxpusher/wechat）的 resolve 调用统一先过 `resolveEnvRefs`（与出站 `adapter.resolve(resolveEnvRefs(row))` 同构）。旧代码 README 示例 `${ENV:FEISHU_SECRET}` 原样透传 SDK → `invalid appId` 且无提示。

### 测试

- 新增 8 个回归用例（807 → 815）：WSClient logger 形态与 error 转发、`context.open_message_id` patch、bare WSClient（无 close/stop 形态）terminate、`{ agent }` 载荷解包（created/disposed）、subagent 过滤与无 roots 降级、入站 `${ENV:}` 展开。

### 规划（未实施）

- **#3/#5 `ask_user_question` 选项式提问桥接（计划 0.8.0）**：该提问通道（`@deepseek-ai/dsh-user-questions` 的 `UserQuestionService.ask()`）单 provider 且不发射任何 session 事件，插件层无法独立感知提问，本版本不硬上。0.8.0 分两步：
  1. **插件侧先行**：新增远程提问工具 `ask_user`（模型调用即推选项卡片/编号回复，复用审批桥接栈：HMAC 一次性 token + 白名单 + 首达采纳 + 超时静默交还桌面），同时把审批卡片设施泛化出 `aq:` 选项动作格式；
  2. **根治推上游**：推动 DSH 宿主为提问服务补会话事件（或 provider 优先级链，UI 优先、远程兜底）——事件到位后接线只是几行，两步设计互不阻塞。

## [0.7.2-wechat.0] - 2026-08-17

> 微信扫码即配对测试包（ prerelease ）：iLink 机器人是扫码微信的**专属好友**（1:1），
> 扫码确认那一刻配对自动完成——网页扫码 GUI 补齐 + 三链路配对闭环 + 测试说明随包分发。

### 新增：微信网页扫码授权（GUI）

- **`wechat` 入站卡片「扫码授权」**（src/admin/scan.mjs `makeWechatHandler`）：iLink 步进式流机对齐 CLI 状态机（wait/scaned 步进、scaned_but_redirect 跨机房切 host、expired 自动刷新 ≤3 次、总超时兜底、未知状态 fail-fast），轮询契约与 qq/dingtalk/feishu 一致——微信从此全网页可配，不再必须开终端。
- 卡片内置说明文案：扫码即配对、专属好友只和你聊。

### 新增：扫码即配对（三链路闭环）

- **网页扫码确认时**：凭证落 `wechat:account` + 立即 `addBinding(channel=wechat, userId=扫码者, origin=paired)`，首条绑定即 owner；userId 缺失只落凭证（回退 /pair 链路）；已绑定幂等跳过。
- **CLI `wechat-login.mjs` 确认时**：同上，终端明示「扫码即配对完成，无需再发 /pair」。
- **启动兜底（src/index.mjs）**：wechat 通道拉起前按凭证 userId 幂等补绑定，覆盖「绑定被误删」与「旧版 CLI 落盘缺 userId」两种现场。

### 测试

- `test/admin-scan.test.mjs` +10 用例（微信流机：基本流/重定向/过期刷新上限/超时/凭证缺失/缺 userId/瞬态重试/已绑定与 identity 异常降级/取码与落盘异常/未知状态），全量 797 → 807。
- 新增微信测试笔记随包分发（离线用例 + 网页/CLI 真机步骤 + 验收清单；后续文档整理已归档）。

## [0.7.1] - 2026-08-17

> 真机环境适配修复 + 文档对账（docs 审查线 5 项 + 测试隔离 P1）。
> 「797 全绿」自此在真机（存在 `~/.dsh` 残留 state 的机器）同样成立。

### 修复：测试隔离（真机 796/1 事故，P1）

- **index.test.mjs 未隔离默认 state 目录**：`defaultStateDir()` 读 `$DSH_HOME` → 在宿主真机跑过 dsh 的机器上，`~/.dsh/dsh-notifier/state.json` 携带扫码凭证/绑定表，未显式传 `stateDir` 的 `apply()` 经凭证回退读到真机残留——「无凭证不注册审批」断言当场翻车（沙箱无残留恒绿，mock 盲区又一例）。文件级修复：加载即设 `DSH_HOME` 指向一次性空目录（`node --test` 每文件独立进程，不泄漏其他测试文件）。修复前残留条件复现 10/1，修复后 11/11。
- **route-cli.test.mjs 同源**：无 `--state` 的 `buildContext()` 会在真机 home 建 `~/.dsh/dsh-notifier/`（污染用户目录），同样整文件隔离。

### 修复：文档对账（docs 审查线确认项，权威仓库同步落地）

- **README 安装命令缺 `--profile`（P1）**：裸 `dsh plugin add dsh-notifier` 真机必报错；双语补 `--profile <profile-name>` 及一句说明。
- **渠道计数 25+ → 27（P2）**：实际 12 专属 adapter + 15 spec 渠道 = 27；双语徽章/正文/架构图/目录树五处同步，枚举补 WeCom App（wecom-app）与 desktop。
- **HANDOFF 计数（P2）**：「spec-channels 吃 16 个」实为 15；「16+ 渠道」实为 27。
- **打包裂图根因**：v0.7.0 zip 排除了 `docs/screenshots/`，README 五处截图引用在包内裂图——截图随包分发（仓库内文件本就齐全，非仓库缺陷）。

## [0.7.0] - 2026-08-16

> 身份体系（v0.7 计划书全量落地）：把「谁是家里人」从 YAML 不透明字符串提升为运行时
> 对象——配对码准入、复合键绑定、管理台成员页、目标解析三级优先、跨渠道串门双防线。
> 11 项 UX 审查问题全部闭环；测试 733 → 797（+64），两处实现级 P1 在测试矩阵中当场抓获；
> R5 三路审查（P1×6 P2×9 P3×21）修复后复审 R5b 零 P1/P2；真机测试通过（2026-08-17）。

### 新增：身份绑定层（src/inbound/identity.mjs）

- **复合键绑定表**（`inbound:bindings`，键 `<channel>:<userId>`）：修复跨渠道串扰的入站半边——TG 绑定的 id 不再放行飞书消息（UX 审查 #5）。读失败回退空对象（fail-open 读军规），坏形状整条丢弃、坏字段回退默认。
- **角色系统**：首条绑定为 owner（含 bootstrap 单胜），其后为 member；owner 独占铸码/撤码/删成员/改角色；末位 owner 不可删不可降（管理台/API/命令三层同守卫）。
- **YAML 迁移**：`allowUsers` 启动播撒为绑定记录（origin=migrated，幂等、只增不减），对每个已启用通道各播一条；此后增删以管理台为准（YAML deprecated，v0.8 评估移除）。
- **待确认绑定**（`inbound:pending`）：订阅/扫码学到的身份（origin=learned）先进待确认区，管理台「确认」转正（origin=confirmed）或「忽略」丢弃。

### 新增：配对码状态机（src/inbound/pairing.mjs）

- **六态生命周期**：minted → active → redeemed / expired / revoked / locked；SHA-256 落盘（盘上只有哈希，码面仅在铸造响应/引导日志出现一次）；8 位 31 字符易读字母表（剔除 I/L/O/0/1）≈ 39.6 bit 熵；TTL 默认 10 分钟。
- **用户级暴力防护**：滑动窗内同一 `channel:userId` 连续 5 次核销失败锁出 10 分钟（「连续错 5 次锁码」无法按码计数——错误尝试的哈希命不中任何条目，暴力防护的正确单位是用户）。
- **注册命令**（/help /whoami /pair /unpair）：/pair 群聊拒答（码不消费，引导私聊）；/unpair 末位 owner 拒绝；命令回执尽力而为（失败只 warn）。
- **引导态**：绑定表为空 + 凭证就绪时自动铸造 bootstrap 码（stderr 双写展示，10 分钟有效，首位 /pair 成功者成为 owner，码随核销作废；重铸替换旧码）。原「空 allowUsers 不启动」死路（UX 审查 #1）改为引导态启动：注册面开放（/pair），业务面全拒。
- **拒绝回执**（UX 审查 #2/#3）：未绑定者的业务消息不再已读不回——回执含发送者自身身份 + 渠道维度 + 配对指引，60 秒节流；引导态裸消息回引导文案。伪造「1」不裁决任何等待中的审批（静默永不批准红线）。

### 新增：管理台成员页（admin API 五方法 + UI Tab）

- **API**：`GET /api/members`（三表聚合 + 引导态标记，读失败降级空表）、`PUT /api/members/:key`（改 label/role）、`DELETE /api/members/:key`、`POST /api/members/:key/confirm|dismiss`（待确认收口）、`POST /api/pairing`（铸码，码面只出现一次）、`DELETE /api/pairing/:id`（撤码）。守卫全表：501 未装配 / 422 键形状与字段校验（含 ttlMin 1-1440 整数、未知字段拒绝）/ 404 / 409（已是成员）。
- **UI**：成员表（角色/备注/配对时间/最近活跃）、配对码区（铸码/撤码/在铸列表，码面只在铸造弹层出现）、待确认绑定区；与宿主共用同一 store 实例，增删半秒内热生效（无需重启）。

### 新增：目标解析三级优先 + 形状守卫（src/inbound/target-guard.mjs）

- **三级优先**（出站卡片目标，六通道 adapter 全接）：该通道绑定成员 → 通道配置清单（notifyUsers/allowUsers/notifyChatIds/notifyUids）→ 全局回落（仅当绑定表整体为空，纯兼容模式用户行为零变化）。绑定表非空但该通道零绑定零配置时宁可不发也不回落全局（跨渠道错发是 P1）。qq 群目标（notifyGroups）是渠道属性，绑定接管用户目标后群通知不消失。
- **形状守卫**（发送前最后一道防线，两消费点：审批 router + 动作卡 event-listener）：按渠道校验 id 形态——TG 纯数字、飞书 ou_/oc_/on_ 前缀、wxpusher 数字 uid 为强形态；qq/wechat/dingtalk 宽松（宁可放过不可错杀——错杀真成员是 P1）；未知渠道 fail-open。
- **学习键汇流**：wxpusher app_subscribe 订阅事件学到的 uid 进待确认绑定（identity 未装配保持旧行为）。
- **密径持久化**：wxpusher webhookPath 未显式配置时首铸随机密径落 store（`wxpusher:webhookPath`），重启复用——原缺省每次启动随机换路径，用户已填进 WxPusher 控制台的回调 URL 立即失效；显式配置仍是用户意志。

### 修复（本轮开发中由测试矩阵抓获）

- **resolveNotifyTargets 字符串清单全过滤（P1）**：配置清单（feishu allowUsers / qq notifyUsers / wxpusher notifyUids）是原始 id 字符串数组，首版只按对象形态读——字符串元素全被 `chatId=''` 过滤清空，静默回落全局白名单（错发目标）。
- **清单并集不去重（P3）**：users 与 groups 出现同一 id 时二级分支直拼数组会同卡双发；并入时按 chatId 去重。
- **mintPairingCode ttlMin 布尔漏洞（P3）**：`Number(true)===1` 会把布尔值溜成合法分钟数；改为 typeof 守卫在前。
- **测试 flaky 根治**：升级链测试的 50/80ms 双阶段夹 70ms 检查点在 CI 负载下越窗误报；窗口拉宽至 50/400ms 夹 150ms（语义不变）。

### 修复：R5 三路审查（身份线/管理台线/六通道线，P1×6 P2×9 P3×21）

- **形态表想象编码三处全错（P1，R5-3）**：TG 群/频道 id 恒为负数（-100…），原 `^\d+$` 把合法配置的群目标整体错杀；wxpusher 真实 UID 是 `UID_` 前缀，纯数字形态错杀全部订阅用户；feishu `un_` 不是发送侧 receiveIdType（必炸），从形态表剔除。教训固化：形态表必须与真实平台 id 对账，测试不得按同一想象书写（否则把错误锁成"绿测"）。
- **migrate 无一次性标记（P1，R5-1）**：每次启动重播撒 YAML，「只增不减」退化为「管理台删除的成员重启后被复活」——删减权收归管理台单一入口的契约被推翻。落 `inbound:migrated` 标记后永不再播撒。
- **迁移实例 ownerCount 恒 0（P2，R5-1）**：播撒记录全 member，违反「首位成员即 owner」契约且 bootstrap 永不铸造；空表首条播撒置 owner。播撒同时按渠道 id 形态过滤（TG 数字 id 不播给飞书）。
- **管理台成员页整页死键（P1，R5-2）**：ui.mjs 首版漏挂事件委托——铸码/删成员/撤码/转正/忽略/改角色全部点不动；admin warn 未双写 stderr（dsh web profile 下 logger 不落 stdout，降级路径零可见）——与 v0.6.1 inbound 双写军规对齐。
- **锁出窗口滑脱（P2，R5-1）**：只按滑窗计数判锁，「锁 10 分钟」承诺在最早一次失败滑出窗口的瞬间失效；lockedUntil 时间戳持久化，锁定时刻落盘后只看此刻。
- **已绑定成员可被恶意烧码（P2，R5-1）**：/pair 先核销后判绑定会把单次码白白烧掉（任意已绑定成员可恶意提交有效码阻止新成员入伙）；改为先查身份短路，不触碰配对码。
- **QQ C2C 回执不带 msg_id（P2，R5-3）**：走主动消息配额，真机大概率被平台 4xx 拒掉（mock fetch 不校验被动回复权限，单测测不出）；回执带 msg_id 走被动回复。
- **引导态口径分裂（P2，R5-2）**：管理台只判 identity.isEmpty()，allowUsers 非空但整栈未启动的实例也亮「stderr 有引导码」——用户按提示翻日志永远翻不到；guidedProbe 探针注入，与 bus.isGuided 同口径。
- **动作卡目标全拦截零告警（P2，R5-3）**：guardTargets 静默过滤后 event-listener 不知情；kept 为 0 且 targets 非空时 warn「请核对通知目标 id 形态」。
- **契约 notifyTargets 未包裹（P2，R5-3）**：adapter 抛异常会击穿 _contract 归一层；try/catch 按空目标降级。
- **撤销/锁定前缀撞车（P3，R5-1）**：8 位 id 前缀与终态条目撞车时 find 可能先命中终态条目，真正要处置的在铸码无法撤销；只在在铸（minted/active）条目中找。
- **拒绝消息不进去重表（P3，R5-3）**：平台对未回执消息会重投，同一 messageId 每次重投都重走判定链（60s 节流只兜回执不兜 warn 刷屏）；拒绝路径同样 remember。
- **状态文件有界化（P3）**：锁出表完全过期的旧条目写路径顺手清除（锁出中的条目绝不清除，安全语义优先）；待确认绑定 7 天 TTL 读路径清扫（陌生人扫码写入后无人确认，只增不减）。
- **UI 铸码提示硬编码 10 分钟（P3）**：TTL 可选 10/30/60/1440 分钟，提示按实际选择展示；测试恒真断言改真断言。

### 行为契约变更（0.x 允许，标注）

- **YAML allowUsers 降级为首次导入**：迁移后删 YAML 用户不再生效（管理台是唯一删减入口）；不迁移的老实例行为不变（绑定表空 → 全局回落原样）。
- **空 allowUsers + 凭证就绪 = 引导态启动**（原为不启动）：引导配对码在 stderr，首位绑定者成为 owner。
- **wxpusher 随机密径跨重启稳定**（原每次重启换路径，需重填控制台回调地址）。

### 测试

- 全量 **797 pass / 0 fail**（node --test，约 110s；733 → 797，+64）。新增覆盖：identity 迁移/复合键/角色/待确认生命周期（含 7 天 TTL 清扫）、pairing 六态全表（哈希落盘/审计回调/锁出滑窗与有界化/bootstrap 重铸/终态清扫/大小写归一）、bus 引导态矩阵与红线（伪造审批不裁决/拒绝路径去重）、注册命令四条（群聊拒答/末位 owner/异常不上抛）、target-guard 三级矩阵（含字符串清单回归）+ 六渠道真实形态表、admin 五方法守卫全表 + 配对码脱敏 + 审计落盘 + guidedProbe 口径、HTTP 七路由鉴权与参数透传、学习键汇流（幂等/已是成员/未装配旧行为）、密径持久化（首铸/复用/显式优先）。

## [0.6.5] - 2026-08-16

> 第三轮三路并行代码审查（R4-1 store/bus/审批 / R4-2 admin / R4-3 出站渠道）修复轮：
> 20+ 项，含 2 个「真机 100% 必炸」P1（ntfy 中文标题、chanify 路径）——均为 mock
> fetch 构造盲区（mock 不构造真实 Headers/不做真实路由），契约测试假绿掩盖运行时
> 必然故障。核心安全红线零松动，一条未松。

### 修复（出站渠道，审查 R4-3）

- **ntfy 中文标题 100% 失败（P1）**：原「POST /<topic> + X-Title/X-Priority 头」协议里，x-title 经 undici fetch 的 ByteString 校验——非 ASCII 标题（中文！）直接抛 TypeError，而本项目主场景全是中文标题。改为 ntfy 官方 JSON 发布协议（POST 服务根，topic/title/message/priority 全进 body），中文标题/正文随通知体自由编码。
- **chanify 端点多拼 /send（P1）**：官方端点是 `POST /v1/sender/<token>`（dev.chanify.net 与移植来源一致均无 /send），原拼法真机必 404。
- **mattermost 删除官网缺省域（P2）**：Mattermost 无公共推送云，缺省 `https://mattermost.com` 会把 hookId（凭证）误发到官网域名（进第三方日志）且必 404。用 hookId 时必须显式填自托管 server，未配置时给出可行动的中文指引。
- **onebot CQ 码注入（P2）**：message 从字符串直传改为 OneBot 11 标准消息数组格式（`[{type:'text',data:{text}}]`）——正文里的 `[CQ:at,qq=all]`/`[CQ:image,...]` 是协议元语法，notify 的 message 参数 agent/LLM 可控，prompt injection 可借通知渠道向 QQ 群注入 @全体成员或诱导受害者客户端向任意 URL 发 GET。数组格式的 text 段无解析歧义，纯文本永远纯文本。
- **spec.fail 死代码复活（P2）**：原实现 post* 对非 2xx 直接抛 HTTP_ERROR，slack 403「去哪换 webhook」/discord 404「重建 webhook」等精心编写的中文排障指引在真实失败路径上永不可达。HTTP_ERROR 现在携带 status/json/text 现场，engine 捕获后交 spec.fail 合成指引再抛。
- **URL 路径段编码 + 枚举白名单（P3）**：企业微信 key/chanify token/xizhi key/qmsg key/hellyw key/mattermost hookId 全部 encodeURIComponent（含特殊字符的凭证不再拼出歧义 URL）；qmsg type 只允许 send/group、onebot messageType 只允许 private/group（拼错路径/语义漂移的请求在 validate 阶段给出中文指引而非静默 404）。
- **失败原因统一截断（P3）**：describeFailure 单字符串路径补 200 字符截断；spec.fail 返回值与 HTTP 指引同样截断——服务端超长 errmsg 不再整段进日志/notifyAll failed/工具渲染（agent 上下文膨胀）。
- **带上限读响应体（P3）**：新增 `readTextCapped`（流式读、64KB 上限、越限主动 cancel）——自托管端点（gotify/ntfy/onebot/mattermost 的 baseUrl 任意可配）故障或恶意回包时可返回超大 body，原 `response.text()` 全量读入后才截断，内存与日志被放大。
- **QQ 官方 bot msg_seq 重试不自增（P3）**：msg_seq 是服务端去重键，原实现每次尝试自增——重试时服务端视为新消息，同一条通知可能双份投递。改为整条消息固定一个 seq。

### 修复（store/bus/审批，审查 R4-1）

- **锁 owner 校验（P2）**：v0.6.4 的陈锁回收只看 mtime>10s——慢写者（大 state + 慢盘）超过 10s 后锁会被误抢，旧写者 rename 仍会覆盖新写者的结果（丢写保护失效）。锁文件现在写入 `pid:随机段` owner 章，释放时核对 owner 再 unlink（非本人锁不删）；被回收方写盘前复查锁 owner（已易主则放弃本次 rename，防陈锁窗口内的交错覆写）。
- **state 损坏自愈（P2，替代 v0.6.4 的「损坏中止」）**：中止会让 dirty 无限积压、CLI↔宿主共享永久断裂（外部不修复就永远写不进）。自愈 = 现场转存为 `.corrupt.<ts>`（取证保留，保护不降级），再以内存全量快照重建写路径——半截 JSON 本就解析不出任何键，重建丢失的只有「损坏文件里已不可读的内容」且已留副本；绝不能从 `{}` 起步（那会抹掉 boot 载入的凭证/路由）。转存失败（备份目录不可写等）退回中止语义保留现场。
- **tmp 文件创建即 0600（P3）**：原 chmod 后置——umask 窗口里含凭证的完整 state 对其他账号可读。`writeFileSync(..., {mode:0o600})` 原子收紧。
- **读收敛基线（P3）**：mtime 基线直接取启动时刻 stat——原 -1 哨兵会让启动后第一次 get 误判「文件变化过」而触发一次多余重载。
- **bus disposed 终态（P3）**：dispose 后 `wait()` 一律立即按无人应答（null）收场——不再新增长命定时器挂住已卸载的插件；消息处理器全摘，防止迟到 inbound 触发已死逻辑。
- **空分流回落全局广播（P3）**：agent 显式绑定空集或绑定渠道全被禁用时，原实现拿到空 channelTypes 后既不推任何渠道也不广播文案——审批静默消失且广播里教的回复方式全部落空。空集回落全局广播（与出站「空目标可见化」对齐：宁可广播也不静默）。

### 修复（admin API/Server，审查 R4-2）

- **putChannel 键白名单（P2）**：原实现只校验「非空普通对象」，持 token 客户端可写任意键 + 近 1MB 垃圾值污染 `<type>:account` schema 并使 state.json 膨胀；`__proto__`/`constructor`/`prototype` 等保留键虽是数据属性（spread/JSON.parse 不触发原型污染）但会永久残留。改为按渠道 spec 生成键白名单 + 键数上限 64 + 值 8KB 上限 + 保留键显式拒绝。
- **putBindings 单次落盘（P2）**：原「clear + set 逐键」对 N 键表做 N 次全量落盘——20 键表 = 20 次锁竞争 + 20 次整文件重写。新增 `replaceAgentBindings`/`replaceChannelDefaults` 整表替换（语义与逐键重建链等价：未出现字段删除、空条目整键回收），一次锁周期 + 一次整文件写。
- **scanHandlers 原型链防护（P2）**：按 type 查 scan 处理器时走 `Object.prototype.hasOwnProperty` 核验——`__proto__` 等键名不再可能沿原型链摸到 Object 内建属性。
- **SSE 并发上限（P3）**：持 token 客户端可开任意多条长连接耗尽宿主句柄/内存。超限（32 条）新连接 503，检查在连接权移交之前（移交后 503 写不进）。
- **审计有界轮转（P3）**：append-only 无上限会让长期运行把 state 目录撑爆。超 1MB 转存 `.1`（只保一代，总占用 ~2MB 封顶），getAudit 并读两代保持时间线连续。
- **HTTP 显式超时（P3）**：server 显式固化 headersTimeout/requestTimeout，不再吃 Node 版本默认值（默认值随版本漂移且 requestTimeout 新版默认 300s，慢速攻击连接可长期占位）。

### 测试

- 全量回归绿（node --test，见提交记录）。新增覆盖：store 锁 owner 校验/被回收方放弃/损坏自愈转存与回退、bus disposed 后 wait 立即 null、空分流回落广播、putChannel 白名单与保留键拒绝、putBindings 单次落盘（writeMap 调用计数）、SSE 上限 503、审计轮转后 getAudit 时间线连续、ntfy JSON 协议契约（中文标题进 body 而非头）、chanify 无 /send 路径、onebot 消息数组格式（CQ 码按字面文本处理）、HTTP_ERROR 现场 → spec.fail 指引链、readTextCapped 上限。
- 契约测试盲区自省：mock fetch 不构造真实 Headers（ByteString 校验盲区）、不做真实路由（路径拼错盲区）——本轮 2 个 P1 均属此类。测试 rig 已在可构造处对齐真实实现行为（如 readTextCapped 流式语义）。

## [0.6.4] - 2026-08-16

> 第二轮审查（修复质量复核 + 并发/边界专项）修复轮：6 项，集中在多进程并发与
> 「推送失败后用户被教错」死路。核心安全红线继续零松动。

### 修复

- **state 跨进程写锁（审查 R2-P1-2）**：v0.6.3 的键级合并解决了「互相抹键」，但没解决两进程 load→rename 区间交错的 last-writer-wins 整文件丢写。`save()` 全程持同目录锁文件（`openSync 'wx'` 抢占 + mtime>10s 陈锁回收 + 有界自旋 ≈240ms + 超时强写降级并 warn），锁内完成 load→merge→write→rename。
- **state 损坏不再放大（审查 R2-P2-2）**：save 时刻重读撞上解析失败（半截 JSON/坏块）时中止本次写、保留 dirty 下次再试——原 fail-open 到空会把全量凭证抹成只剩脏键的残本。只有启动 load 保留 fail-open（无记忆好过误清空）。
- **state 读收敛（审查 R2-P2-3）**：运行中宿主的内存快照感知不到 CLI 写入（`route:*` 改完要重启宿主才生效）。`get()/keys()` 节流 stat（≥500ms 一次），mtime 变化即重载合并（dirty 键内存优先）。
- **编号回复 intended 兜底（审查 R1-P2-1）**：卡片发送失败（或全部目标投递失败）时广播文案仍在教「回复 1 批准」，但 `pushedTo` 为空 → 收紧后的编号回复拒绝兜底 → 死路。审批入账新增 `intendedChannels`（null=全局广播=全部交互渠道；数组=分流结果），匹配优先级：送达精确 > 送达同渠道 > 意图渠道；非意图渠道的日常裸 1/2 仍拒绝（收紧价值保留）。
- **pushedTo 增量落账（审查 R1-P1-1）**：原实现等整轮推送完成才写 `pushedTo`（多通道限速门下数秒窗口），窗口内早到的编号回复读不到送达渠道而落空。现在每张卡送达立刻落账。
- **审批 key 随机起点 + 总线停机（R2-P2-4/R2-P2-5）**：counter 随机起点（重启后同 callId 不再撞 key 复现旧 token 核销路径，配合持久化 tokenSecret 时尤为必要）；`bus.dispose()` 整体收场（在途 waiter 以 null 结束=超时回退桌面语义、消息处理器全摘、定时器清理），插件卸载不再拖住进程；waiter 定时器 unref；dedup 清扫线联动窗口配置。

### 测试

- 718 全绿。开发中途的装配断线已修（`pushApproval` 增加 `channelTypes` 参数但调用点未传——`undefined.includes` 抛错被 handler 吞掉，整轮推卡夭折）；`intendedChannels` 随入账落盘，intended 兜底链真实生效。
- 行为变更同步固化：损坏文件测试从「fail-open 覆写」改为「写入中止保护现场 + 外部修复后 dirty 键补落」；approval 测试 rig 固定 `counterStart: 0` 保住确定性 key 断言（生产随机化）。
- 回退 waiter 定时器 unref：unref 会让「仅剩超时定时器存活」的事件循环直接退出（await 超时的测试全炸；生产中在途审批也不该因恰好空闲而蒸发）。停机清理由 `dispose()` 承担，职责单一。

## [0.6.3] - 2026-08-16

> 首轮三路并行代码审查（R1 出站核心 / R2 inbound+审批 / R3 装配+admin+v0.6）修复轮：
> 11 项 P1/P2 级问题，全部是「真机才暴露」或「长跑才显现」类缺陷——竞态窗口、
> 多进程并发写、状态单调膨胀、静默失败路径。核心安全红线（静默永不批准、token
> 单次核销、never-reject、A listener never throws）零松动，一条未松。

### 修复（出站核心，审查 R1）

- **分段部分送达不再整条重试**：`notify.mjs` 分段发送中断（前 N 段已出、后段失败）时错误标记 `noRetry:true`，`routing.sendWithRetry` 见标短路——原实现按「整条消息」重试，timeSensitive 3 次尝试 = 已送达的前半段被重发，同一通知收到多份半截轰炸。
- **空目标可见化**：路由矩阵/分流过滤后目标为空时，原实现 delivered/failed/skipped 三空 + ok:true + 零日志——agent 绑定的渠道后来被禁用 / routing 渠道名拼错时，通知（含 timeSensitive 审批提醒）静默消失且账本记成功，排障完全误导。现在 warn + `skipped:['(no-targets)']` + onSend 照发（ok 语义不变：无失败即 true）。
- **账本文件权限 0600**：账本行含通知标题/错误摘要（可能带任务路径与审批上下文），共享主机上不应其他账号可读；prune 重写路径同样收紧（对齐 store 的既有军规）。

### 修复（inbound + 审批，审查 R2）

- **审批 waiter 预注册（竞态）**：原实现先 `await pushApproval`（逐通道逐目标发卡 + 广播，限速门下数秒级）再 `bus.wait`——窗口内用户点按钮/回复 1/2 命中 already-resolved 被静默丢弃，此后永远无人能裁决 → 超时回落桌面。现在先注册 waiter 再推卡，早到裁决由 waiter 承接。
- **TG 审批卡片去 parse_mode**：approvalKey（`ap:<callId>:<n>`，callId 常含 `_`）与 reason（路径/反引号）未转义，legacy markdown 未配对 `_*` 必 400 "can't parse entities"，卡片静默降级纯文本。与 v0.6.2 BUTTON_DATA_INVALID 同类 mock 盲区（mock fetch 不解析 markdown，单测测不出）。
- **编号回复收紧（行为变更）**：`latestPendingFor` 只认卡片实际送达过的渠道（channel+user 精确匹配优先，同渠道兜底次之），移除跨渠道全局回退——审批是全局广播的，用户在没收到卡片的渠道日常对话里发裸 1/2 不得误裁决别处的审批。真实装配里能回话到 bus 的通道必然在 interactive 列表、推送时已进 pushedTo，收紧不误伤正常路径。
- **消息消费语义**：bus 处理器返回 true = 消息已被消费，停止扇出——审批编号回复吃掉「1」后不再同时被当作用户消息 inject 进 agent 会话（同一消息双重消费）。
- **wait 同 key 复用**：原实现同 key 二次 wait 无条件覆盖注册位，旧 entry 的超时回调会误删新注册（跨重启 counter 归零 + 同 callId 可复现 key）。未决时复用既有 waiter 的 promise。
- **state 定期瘦身**：`dedup:*`/`ap:*`/`act:*` 历史上只增不删（bus 每条入站消息落一个 dedup 键、审批/动作核销后账本行永留），长跑进程 state.json 单调膨胀且全量重写随之变慢。dedup 留 25h（窗口 24h + 1h 时钟回拨余量），已决审批/动作保留 24h 供审计，首启 + 每 6h 清扫（走脏键合并写，与 CLI 并发写互不覆盖）。

### 修复（装配/状态/admin，审查 R3）

- **state 并发写互抹（CLI vs 宿主）**：route/channel-login/wechat-login 等 CLI 与运行中宿主各持一份内存快照同写 state.json，原「整快照覆写」互相抹掉对方的键（admin:token-hash 被抹 = 已知 admin token 失效）。改为写时重读文件、只落本实例动过的键（键级合并），写回后内存收敛到合并结果；tmp 文件带 pid+随机段（多进程共用固定 `.tmp` 路径时 write/rename 交错会 ENOENT 丢写）。
- **心跳会话快照过期**：回调闭包冻结 turn/start 时刻的 session 引用，宿主逐事件传新快照时「最近输出」摘录恒为上一轮。改为 `entry.session` 随事件刷新，心跳/卡住回调统一取最新引用。
- **审计文件权限 0600**：审计行含 session id 与绑定键，对齐 store 军规。

### 测试

- 717 → 718：编号回复语义重写——送达渠道白名单用户精确命中、同渠道其他用户兜底、未送达渠道裸 1/2 拒绝兜底的负控（超时静默回落桌面 + 账本落 timeout）；`numberedReply: false` 改用「送达渠道+本人」回复，确保被测的是开关本身而非收紧副作用；无交互渠道时裸数字不裁决的回归固化。审批/多通道 32 项全绿。

## [0.6.2] - 2026-08-16

> 真机事故修复（v0.6.1 复验发现）：inbound 修复生效后，审批卡片发送报
> **HTTP 400 BUTTON_DATA_INVALID**——TG `callback_data` 硬限 64 字节，而
> `ap:<decision>:<approvalKey>:<token>` 实测 ≈ 131~165 字节（token 自身 ~109：
> b64url(payload) ~44 + `.` + HMAC hex 64）。mock fetch 不校验长度，单测测不出，
> 真机才暴露。v0.5 的 `ac:` 动作按钮（「停止任务」）同超限，只是尚未触发到场景。

### 修复

- **新增 `src/inbound/callback-refs.mjs`（短引用注册表）+ TG 适配层接入**：按钮 `callback_data` 只带 `r:<8 字符随机引用>`（恒定 10 字节），完整 `ap:/ac:` 负载存进程内注册表，点击时单次核销展开走既有解析。**token 密码学（vault）与审批账本（首达采纳状态机）零改动**；旧格式完整 data 双轨兼容（升级前在途卡片仍可点）。
- 注册表三重防泄：take 即删（单次核销）+ TTL 15min（略长于 token 10min，让「过期」语义由 token 判定）+ 容量 256 FIFO；重启即清与「token secret 默认进程随机」的既有语义一致，不新增窗口。
- `sendApprovalCard` / `sendActionCard` 全部按钮统一经 ref 压缩；`handleCallbackData` 独立分发函数（`r:` 展开 → `ap:/ac:` 既有分支原样保留）。

### 测试

- +3（714 → 717）：卡片形状（`r:` 短引用 ≤64 字节、不外泄完整 token、批准/拒绝独立 ref）；审批卡点击链端到端（ref 展开 → bus.decide 收到完整 decision/key/token；同 ref 二次点击核销拒绝 + 过期回执）；动作卡 `ac:` 点击链（超限长负载经 ref 展开 → actions.dispatch 收到原始 key/token）；注册表单元（单次核销/TTL/FIFO，时钟注入）。既有「raw ap: data 直落解析」测试保留 = 双轨兼容的回归证据。

## [0.6.1] - 2026-08-16

> 真机事故修复轮（TG Inbound 装配问题报告）：v0.6 真机部署中远程审批按钮未生效——
> 出站正常、inbound 全死、错误零可见，排查数轮才定位。根因不是单点 bug，而是
> 「可诊断性缺失」：告警只走宿主 logger（web profile 不落 stdout）+ 装配段无隔离 +
> inbound 块不做 `${ENV:}` 解析三件事叠加。

### 修复

- **告警双写 stderr**：`index.mjs` 与全部 inbound 模块（telegram/feishu/qq/wxpusher/wechat/dingtalk/bus/conversation/http-callback 共 9 处）的 `warn` 在宿主 logger 之外补写 `console.error`——对齐探针「console 与 logger 双写」做法。此前 `info` 有回落而 `warn` 没有（不对称），dsh web profile 下 cordis logger 不落 stdout，装配/轮询告警（401/409/webhook 冲突）全部成为黑盒。
- **inbound 逐通道装配隔离**：六条 inbound 通道 + approval 路由 + 会话路由各自 try-catch 守护——某条通道装配同步抛错只点名 warn（`inbound:<通道> 装配失败，已跳过`）并跳过，其余通道与出站照常。此前同步抛错直接冒出 `apply` 被 cordis 吃掉，导致「出站正常（notifier 先建好）+ inbound 全死 + 无任何线索」。
- **inbound 块 `${ENV:NAME}` 密钥引用**：`resolveConfig` 对 `inbound` 递归应用 `resolveEnvRefs`，与出站 channels 对齐。此前 `inbound.telegram.botToken: '${ENV:...}'` 是字面量（出站解析、入站不解析的双路径不一致），TG API 401 退避且不可见。

### 测试

- +4（710 → 714）：inbound env 引用替换/缺失/原样保留；warn 双写 stderr（宿主 logger 不可见路径）；逐通道装配隔离（通道炸了不崩 apply、其余照常）；telegram 轮询异常双写 stderr。

### 真机部署诊断指引（v0.6.1 起）

- 起来了：stderr 出现 `inbound 已启动：telegram 长轮询（白名单 N 人…）`。
- 没起来：stderr 出现 `inbound:<通道> 装配失败，已跳过（…）: <原因>`——原因直接可读。
- 起来但不工作：stderr 出现 `轮询异常，Ns 后重试: …`（401 = token/env 解析问题；409 = webhook 未删或他人在轮询）。

## [0.6.0] - 2026-08-16

Open event source: plugin notification bus（设计稿 `docs/v0.6-design.md` 两特性全量落地，经两轮独立审查修订）——**dsh-notifier 从「DSH 的通知插件」升级为「DSH 生态的通知基础设施」**：其他插件一行注入即可推送（共享配置、路由、分段、限流、账本、flush 全部基础设施），一行监听即可订阅每次广播结果。核心管线零改动，673 存量断言一条不改。测试 673 → 710（+37）。宿主语义依据 2026-08-16 真机 spike（DSH 0.1.0-rc.6 / cordis）：服务注册必须 `ctx.provide()`（直接赋值被宿主拦截）；消费方 `inject: ['notifier']` 声明在服务缺失时会阻塞宿主启动 → 任何形态下都提供服务（禁用时为 no-op stub）。

### Added（特性 A：出向服务注入 `ctx.notifier`）

- `src/public.mjs`（新模块，~200 行）：公共面 facade。四方法收敛——`version`（`'0.6'`，仅公共面 breaking 时 bump，不与包版本联动）/ `enabled()` / `push(msg, options)` / `flush()`。军规：**never-reject**（push 内部任何异常吞掉返回 `failed:[{reason:'internal'}]`，消费方不写 try-catch 也不崩）；**no-op stub**（禁用/未配置渠道时仍注入服务，push 返回 `skipped:['(disabled)']`——消费插件永不因我们不可用而崩）；title/content 各 20000 码点钳制（码点安全截断，防消费方 bug 引发分段风暴）；双空消息返回 `(malformed)` 不推不 emit 不占限流名额；sourceName 归一（非字符串/空 → `anonymous`，64 字符上限）。
- 按源限流：复用既有 `createRateLimiter` 滑动窗，每源独立（默认 `limitPerMinutePerSource: 10`，0 = 不限）；表容量 32 超限 LRU 淘汰最旧源并 warn（淘汰即限流窗归零——轮换 sourceName 绕限流的成本显性化）；`anonymous` 表外常驻单窗不参与淘汰。**限流拦截照落账照 emit**（静音不等于没发生，消费方能感知自己被限）。
- 定向推送 `push(msg, { channel: 'telegram' })`：走单渠道路径，返回值适配为 outcome 形状；诚实声明——该路径不进账本不发 sent 事件（既有行为，v0.6 不改）。
- `src/index.mjs` 装配：`ctx.provide('notifier', facade)`（cordis 强制契约，返回注销器进 disposers）；无 `provide` 的宿主/测试桩回退直接赋值 + 引用比对清除（不误伤他人后注册的同名服务）。插件顶层禁用时注入 no-op stub 服务。
- 广播返回值与 onSend record 同构外加 `source: { kind:'plugin', name }` 字段（facade 拼合，`notifyAll` 返回值形状不变——存量全形状 deepEqual 断言守着）。

### Added（特性 B：入向事件 `dsh-notifier/sent`）

- 每次广播完成即 `ctx.emit('dsh-notifier/sent', record)`：payload 与账本记录同构（`{ time, message, ok, delivered, skipped, failed, source? }`），**深冻结**（`deepFreeze`——防消费方篡改共享 payload 污染其他订阅者；环引用/非普通对象防御，冻结失败原值返回）。限流拦截的记录也发射。
- `composeOnSend` 组合器：账本 / admin hub / emit 三个挂载点逐个 try-catch——任一失败不拖累其余；全空返回 `undefined`，保持 v0.5「digest 关 + admin 关 → onSend=undefined」边界语义。宿主不支持 `ctx.emit` 时 warn 一次后续静默。
- `public.emit: false` 可关闭事件发射（保留「关闭零开销」家训）。

### Added（来源标注落账）

- `src/notify.mjs`：`notifyAll(msg, { source })` 并入 onSend record（返回值不动）。
- `src/ledger.mjs`：落盘白名单补 `source`（截 64 字符）；无 source 的旧行与本插件自身推送落盘形状逐字节不变——`v0.6` 起账本可审计「这条通知是谁推的」，为将来的按源静默铺路。

### Added（配置与文档）

- `src/config.mjs` 新增 `public` 三键：`enabled`（默认开——服务注入是消费插件硬依赖，关闭时仍注入 stub）/ `limitPerMinutePerSource`（默认 10，0 = 不限）/ `emit`（默认开）。
- `PLUGINS.md`（新文件）：消费方契约全量文档——防御式配方（回调式注入 `ctx.inject?.(['notifier'], …)` 为主、能力探测为辅，明确 version 相等比较是陷阱）、返回值契约、限流/钳制/事件 payload 形状、flush 与 dispose 配方、循环推送军规（监听器内禁止 push）。
- README 双语：特性表补「开放事件源（v0.6.0）」行，指向 PLUGINS.md。

### Added（测试）

- `test/public.test.mjs`（37）：facade 广播/定向/限流（含 LRU 淘汰与 anonymous 常驻）/双空 malformed/never-reject 注入异常/长度钳制/no-op stub/emit 开关与深冻结/`composeOnSend` 边界/装配级（provide 注入与注销、禁用 stub、宿主无 emit 降级）/ledger source 落盘/PLUGINS.md 文档同步（代码块语法与 API 签名防漂移）。fetch 全 mock，零真实网络请求。

### 真机验证（2026-08-16 · DSH 0.1.0-rc.6 / Node 24）

- 特性 A/B 双确认：静态 `inject: ['notifier']` 消费方解析到 `version=0.6` 真服务（非 stub）；`dsh-notifier/sent` 事件跨插件可见（15/15，payload 形状完整）；零渠道语义符合设计（`ok:false` 三空数组，不崩不阻塞）。
- **配方裁定**：rc.6 宿主只认静态 inject 声明——回调式 `ctx.inject(['notifier'], cb)` 不触发、未声明访问服务属性（`ctx.notifier`/`ctx.tools`）直接抛 `cannot get property … without inject`。PLUGINS.md 全部配方据此定稿为静态声明（v0.6 任何形态 `ctx.provide` + stub 兜底使静态声明安全）。
- 安装注意：pnpm 管理的宿主手动覆盖 `node_modules/dsh-notifier` 会被回滚，升级须 `dsh plugin add file:<路径>`。真渠道送达复验随验证包二轮进行（验收插件 v2 同步改静态声明）。

## [0.5.0] - 2026-08-16

Mobile command center + notification action loop（设计稿 docs/v0.5-design.md 四特性全量落地）：长任务自动心跳与疑似卡住提醒，通知卡片自带「停止任务」按钮（Telegram inline keyboard / 飞书卡片），手机从「收据面」升级为「指挥面」；`/quiet`·`/unquiet` 命令补全与管理台移动端适配收尾。测试 625 → 673（+48）。

### Added（特性 A：状态上报线——长任务不再黑盒）

- `src/status/turn-tracker.mjs`：纯逻辑 turn 跟踪器。`turn/start` 建档并起表、`turn/end`·`agent/disposed` 清档清表；会话事件 touch 续表；每 turn 只发一次 firstAfterMs 心跳、此后 everyMs 周期心跳、afterMs 无事件输出卡住信号；数值下限钳制 60s（v0.3.2 mergeWindowMs 教训的统一军规），0 非法值一律回落默认；`dispose()` 清全部定时器；所有回调 try-catch 绝不外抛（listener never throws）。
- `src/event-listener.mjs` 接线：tracker 挂进既有事件流（observe/session 创建与销毁），心跳 → `passive` 级「⏱ 任务进行中」、卡住 → `timeSensitive` 级「⚠️ 疑似卡住」，复用既有 push 链（防抖、分级路由、账本照常）；卡住信号带动作卡片（特性 B）。
- `src/config.mjs` events 三键：`turnStart`（默认关——桌面每 turn 一条是噪音，移动场景显式开）、`longRunning`（默认开：`firstAfterMs` 900s、`everyMs` 默认=firstAfterMs）、`stall`（默认开：`afterMs` 600s）。零配置用户的长任务从此有信号——版本主题，非行为回归。

### Added（特性 B：通知动作闭环——按钮即处置）

- `src/actions.mjs`：动作分发器。信任链与审批线完全同构（bot 私聊回调保真 + HMAC 一次性 token TTL 10min + 账本单次核销首达采纳）；内置白名单仅 `turn/cancel`——权限面与 `/stop` 命令完全等价，永无任意代码执行；`dispatch` 全 catch 绝不外抛；账本/铸造失败只降级为「不发卡片」，绝不影响通知文本主链路（文本 hint「回复 /stop 取消」全通道兜底）；账本持久化跨重启（与审批共用 store，键命名空间 `act:` 隔离）。
- `src/inbound/_contract.mjs`：`buildActionPayload` / `parseActionPayload`（`ac:<actionKey>:<token>`，与审批 `ap:` 负载同构）。
- `src/inbound/telegram-bot.mjs`：`sendActionCard`（inline keyboard callback_data 装载动作负载）+ 回调 `ac:` 分流进分发器、answerCallbackQuery 即时回执。
- `src/inbound/feishu-bot.mjs`：`sendActionCard`（交互卡片 action 元素）+ 卡片回调 `ac:` 分流。
- 推送路径（event-listener wiring）：心跳/卡住通知在 telegram/feishu 通道附「⏹ 停止任务」按钮；qq/wxpusher/wechat/dingtalk 纯文本通道零改动（hint 兜底）。装配时序采用惰性求值（`actions: () => actionsRef`）解决 event-listener 先于 inbound 创建的依赖环。
- `src/index.mjs`：注册 `turn/cancel` 处置动作（`agent.cancel('remote-action')`；会话不存在/已空闲给出结构性中文终态文案）。

### Added（特性 C：命令中心补全，P2）

- `/quiet <workspace|sid>` / `/unquiet <workspace|sid>`：调 `router.setSessionOutbound(sid, { quiet })` 静默/恢复会话出站推送（远程审批与对话不受影响）；`/unquiet` 写显式 `false` 压过上游 agent 级静默（不回落）；目标解析复用 `/agent use` 智能匹配并抽取为共用函数 `matchSessionByNeedle`（workspace 精确 > sid 精确 > ≥4 位前缀，多命中列候选）；router 缺省降级提示（同 `/route` 惯例）。
- `/help` 文案补三行（/quiet、/unquiet、状态上报说明）。

### Added（特性 D：管理台移动端适配，P2）

- `src/admin/ui.mjs`：`@media (max-width: 768px)` 纯 CSS 增量——表单字段单列（标签上移）、导航标签横滚（隐藏滚动条 + 惯性滚动）、宽表横向滚动、触控目标 ≥44px、input 16px 防 iOS 聚焦自动缩放。零逻辑变更零构建，桌面端逐字节不变。

### Fixed（管理台 UI 三处，真浏览器首次实跑暴露）

- `src/admin/ui.mjs` 头部版本号 v0.3.3 → v0.4.0（发布时漏更）；v0.5.0 发布同步更新为 v0.5.0（同类错误不二犯）。
- SSE 事件流解析器：内联脚本里的 `'\n\n'` 被外层模板字面量吃掉转义，服务出去的 HTML 字符串字面量跨行——**真浏览器整个内联脚本 SyntaxError，管理台全功能瘫痪**（测试只断言 HTML 字符串未执行 JS，故 625 测试全绿仍漏网）。修复为 `\\n` 转义。
- Dashboard「agent 路由键」统计：API 契约返回 `keys: number`，UI 按 `Array.isArray` 当数组渲染，恒显「–」（v0.3.3 起从未显示过）。UI 侧对齐契约。

### Added（文档与元数据）

- `docs/screenshots/`：管理台五页真实截图（Dashboard / 通知 / 绑定矩阵 / 会话 / 通道），README 双语「界面预览」章节引用。生成方式：真插件 admin server + 预置运行时数据（state.json 路由三表 + 审计流 + 本地回环 webhook/bell 触发真实广播），仓库代码零 mock。
- `docs/v0.5-design.md`：v0.5 设计稿（目标/现状盘点/四特性/装配时序/兼容性/测试计划/风险清单/三轮架构审查记录）。
- README 双语重写为新版精简结构（tagline · badges · ASCII 架构图 · 特性表格 · 配置块速查 · 渠道矩阵自动生成标记），`README.zh.md` 更名 `README.zh-CN.md`（同步 GitHub）。
- `package.json`：合并 GitHub 版 `dshWorkshop` 元数据块（omdsh-workshop-package/v1：permissions / capability / compatibility 清单）；`.gitignore` 新增（同步 GitHub）。

### Added（测试）

- `test/turn-tracker.test.mjs`（14）/ `test/actions.test.mjs`（12）；`test/event-listener.test.mjs` +7（turnStart 门控、心跳/卡住 intent、动作卡片铸造失败降级）；`test/inbound.telegram.test.mjs` +4 / `test/inbound.feishu.test.mjs` +5（动作卡片发送与 `ac:` 回调核销链）；`test/conversation.route.test.mjs` +5（特性 C：quiet 写入/显式 false 覆盖/目标解析三分支/降级/help 文案）；`test/admin-server.test.mjs` +1（特性 D 移动端 CSS 关键字）。

## [0.4.0] - 2026-08-16

System desktop notifications via two complementary paths: a new `desktop` channel calling native OS commands directly (zero npm deps), and an admin-console "Notifications" page (SSE event stream → browser system notifications + sound). Users without the console open get native popups through the channel; console users get them through the browser. Tests 588 → 625 (+37).

### Added（desktop 渠道）

- `src/adapters/desktop.mjs`：系统桌面通知渠道，直调平台原生命令——macOS `osascript`（`display notification`）、Linux `notify-send`（`-a` 应用名 / `-u` 紧迫度映射 level / `--` 防标题注入选项解析）、Windows `powershell.exe`（BurntToast 模块，探测结果缓存）。**零 npm 依赖**（仅 `node:child_process` spawn，argv 数组直传不经 shell，注入面收敛到各 shell 字面量转义：AppleScript/PowerShell 单引号法）。标题 64 / 正文 200 字符钳制；`silent: true` 走渠道静默语义；Windows 未装 BurntToast 返回结构性 unsupported + 安装指引（不误报成功）。

### Added（管理台通知页）

- `src/admin/events.mjs`：通知事件 hub——环形缓冲（容量 50，钳制 1-500）+ 订阅广播；publish/交付双层深拷贝（订阅者 mutate 不污染缓冲）；任何异常吞掉绝不影响推送主链路。
- `src/admin/server.mjs`：`GET /api/events` SSE 端点（鉴权同既有 API）：连接即重放缓冲（标记 `replay: true`）+ 订阅实时流；15s 心跳注释行保活 + `x-accel-buffering: no` 禁本机反代缓冲；断连（close/error 任一）即退订清定时器 end，绝不外泄资源。
- `src/admin/ui.mjs`：管理台新增「通知」标签页——开着的浏览器收系统桌面通知（Web Notification API，macOS 通知中心 / Windows Toast / Linux 通知服务）：权限授权与检测、测试发送、偏好四开关（总开关 / 普通级也弹 / 紧急级提示音 / 仅页面不可见时弹，localStorage 持久化）、Web Audio 提示音（首次交互解锁）、事件日志表（缓冲重放 + 实时，50 条）。页面可见时只进日志不打扰，不可见/最小化才弹系统通知。

### Changed

- `src/index.mjs`：admin 开启时 notifier `onSend` 旁路进事件 hub（账本照旧 append）；admin 关闭零开销——hub 不创建、onSend 维持 v0.3.3 账本单挂语义，存量行为逐字节不变。
- `package.json`：版本 0.4.0。
- README 双语：desktop 渠道 + 管理台通知页章节；TODO 记入 DSH web 客户端 bundle 路线（调研确认 `client.platform: web` 技术可行，暂缓——需 TS+esbuild 构建链，与零构建哲学冲突）。

### Added（测试）

- `test/desktop.test.mjs`（18）/ `test/admin-events.test.mjs`（9）/ `test/admin-server-sse.test.mjs`（7）+ 既有 wiring/server/config 增量（+3）。

## [0.3.3] - 2026-08-15

Web 管理台：本机 HTTP 服务 + REST API + 单文件 UI + 网页扫码授权，凭证与路由全程网页可管。YAML 只做首次 bootstrap，运行时态落 `state.json`（0600）；admin 关闭（缺省）时存量行为逐字节不变。测试 493 → 588（+95：admin 四测试文件 30/26/20/19，基线含其中 51）。

### Added（HTTP 服务与鉴权）

- `src/admin/server.mjs`：Web 管理台 HTTP 服务，**只绑 127.0.0.1**（host 不可配置——公网暴露 = 暴露全部凭证写权限，需要公网由用户自行反代）。Bearer token 鉴权（timingSafeEqual 恒时比对 SHA-256 哈希；401 不区分缺/错 token，防探测）；JSON body 1MB 上限；未鉴权请求绝不触达 api；ApiError 按 status 透传中文 error，未知异常一律 500「内部错误」（堆栈不外泄）。
- token 三条路：YAML 显式 `admin.token`（哈希同步 state）> 既有 `admin:token-hash` 沿用 > 首启 `randomBytes(24)` 生成并**打印一次**；明文绝不落盘，state 只存 64 位 hex 哈希。

### Added（API 面）

- `src/admin/api.mjs`：`GET /api/overview`（会话统计 + 出/入站渠道三态矩阵 + 最近审计）；`GET|PUT /api/bindings`（route:agents + route:channels 整表替换）；`GET /api/sessions` 与 `PATCH /api/sessions/:id`（出站覆盖 diff，显式 null 删键回落上游）；`GET /api/channels`（config 全脱敏 `***` + `fields` 凭证字段声明表）；`PUT /api/channels/:type`（凭证写 `<type>:account`）；`POST /api/channels/:type/test`（单渠道连通性自检）；`POST /api/scan/:channel`（扫码轮询步进）；`GET /api/audit`。写操作 append-only 审计——只记动作与通道名，凭证内容绝不进日志与返回值。
- 双域裁定（feishu/dingtalk）：`<type>:account` 键域归入站机器人凭证（v0.3.1 扫码落盘语义），两类**出站 webhook 只走 YAML bootstrap**——出站行 `editable: false`、UI 只读，`putChannel` 携带 `webhook` 键一律 422（防网页一键抹掉扫码凭证）。telegram/wxpusher 虽双向但凭证形状同域，不算双域、正常回退。

### Added（单文件 UI 与网页扫码）

- `src/admin/ui.mjs`：零构建单文件内嵌 HTML（vanilla JS + fetch，无 CDN 无外链资源，离线可用）。四标签页：Dashboard（健康矩阵/会话统计/审计流，detail 对象 JSON 展示）、绑定矩阵（勾选网格 + 通道默认 agent）、会话（出站覆盖 diff 编辑）、通道（凭证表单/测试发送/扫码授权轮询）。
- 建单表单：`fields` 声明表驱动（required 标 \*、desc 作 placeholder 与悬停提示），`configured=false` 的通道也能从零新建凭证——不再必须手改 YAML；值为 `***` 的字段视为未修改自动剔除，必填空值不提交；保存后提示运行时生效时机（出站 store 凭证下次启动并入，可先点测试发送验证）。
- `src/admin/scan.mjs`：网页扫码流状态机。qq/feishu 阻塞式（背景 Promise + 首调二维码宽限 ≤1.5s + 终态取走即复位可重开）与钉钉步进式（EXPIRED 自动刷新 ≤3 次、missing-field/incomplete-registration/api-error 结构性错误 fail-fast、瞬态错误下轮重试、SUCCESS 写 `dingtalk:account`）统一适配成轮询契约 `{ qrContent, done, saved?, error? }`——**绝不 throw**：begin 同步异常归一终态中文 error，迟到 onQr 回调按流代次（generation）丢弃不污染新流。

### Added（凭证模型与入站启用信号）

- `src/index.mjs`：admin 开启时出站凭证 store 回退——YAML 行 ⊕ `<type>:account` 字段级合并（store 覆盖同名键，数组整体替换）后重过 `adapter.resolve` 替换/追加 `resolved.channels`；resolve 失败沿用 YAML 条目只 warn，store-only 类型即「暂不启用」。显式 `enabled: false` 是用户意图，不回退。
- 入站五通道（feishu/qq/dingtalk/wxpusher/wechat）admin 启用信号：admin 开启时 store 存在 `<channel>:account` 本身即启用（`inbound.<channel>: {}` 零配置语义的自然延伸——含空对象），凭证链尾兜底 store（wxpusher 的 resolve 不收 credentials，在装配层做字段级合并，YAML 显式键优先）；admin 关闭时信号无效，YAML 显式对象仍是唯一阈值。
- telegram 入站回退链尾补 `telegram:account` 兜底（`inbound.telegram` > 出站 telegram 渠道 > store 账号）。

### Added（测试）

- `test/admin-api.test.mjs`（30）/ `test/admin-server.test.mjs`（26）/ `test/admin-scan.test.mjs`（20，注入点 mock 零网络）/ `test/admin-wiring.test.mjs`（19，含 §5.5 信号生效 + admin 关闭对照）。

### Changed

- `package.json`：版本 0.3.3。
- `src/config.mjs`：新增 `admin` schema——`enabled`（默认 false，opt-in）/ `port`（默认 8104，1-65535 截断）/ `token`（可选，缺省自动生成）；host 不开放配置。
- README 双语：新增「Web 管理台（v0.3.3）」章节（配置示例 / token 首启打印 / 安全模型 / 网页扫码与 CLI 关系 / YAML ⊕ store 凭证模型）。

## [0.3.2] - 2026-08-15

多 agent × 多通道路由引擎：workspace/agentId 双键路由矩阵（双向）、会话台账生命周期、`/agent` 命令族与 `/route` 排障、审批/工具/事件三线分流、`scripts/route.mjs` CLI。未配置任何 `route:*` 的存量用户行为逐字节不变。测试 391 → 493（+102）。

### Added（路由引擎）

- `src/routing/agent-router.mjs`：双向解析链。出站「会话 diff > 精确 agentId 条目 > workspace 条目 > 全局渠道池」字段级链（channels 与 quiet 各自独立走链、绑定引用未启用渠道自动剔除）；入站「显式 bind > 通道默认 agent（精确 agentId 直接用；workspace 名下多活跃会话投最近活跃并标 ambiguous）> 唯一 agent > 最近活跃」。`route:agents` / `route:channels` / `route:sessions` 读写 API（字段级 patch、显式 null 删键回落上游、空条目整键回收）+ `describe` 逐层排障文本。store/agentsList 全防御：任何故障按「无此数据」处理。
- `src/routing/session-registry.mjs`：会话台账（会话生命周期唯一写入口）。`agent/created` 自动建档（inherit = workspace 名）；`agent/disposed` 只标 disposedAt，保留 `route.sessionTtlHours`（默认 24h）供同 id resume 重连；回收惰性化（常规调用内联摊销 60s + dispose 后 ttl 到期点定时兜底 ≤5min）；touch 活跃信号 5s 摊销写盘防写放大；入站对话挂钩 attach/detach；旧 `bind:*` 迁移补档。事件注册失败降级惰性建档、存储失败退化内存态，绝不弄崩宿主。

### Added（命令族与 CLI）

- `/agent`：活跃会话分组视图（workspace | sid 8 位前缀 | 状态 | 出站通道集合 | quiet）；`/agent use <workspace|sid 前缀>`：智能绑定（workspace 精确 > sessionId 精确 > ≥4 位前缀唯一命中；歧义列候选）；`/agent back`：回通道默认；`/route`：双向解析排障（出站逐层 describe + 入站来源层/歧义标记/通道默认 agent）。入站多活跃会话消歧回执（「已投 <sid>…用 /agent use 或 /bind 精确指定」）。`/bind` `/unbind` 同步维护台账挂钩，`/help` 全量更新。
- `scripts/route.mjs`：路由 CLI（`show [key]` / `set <key> --channels/--quiet/--no-quiet/--reset` / `default <channel> <agentKey>|--clear` / `test <sid> --workspace/--global`）。宿主外查看与修改三张表；set 渠道类型白名单校验、`--channels ''` 显式空集（该键出站全静默）、`--reset` 整条删除；test 打印出站解析链并注明宿主运行时按已启用渠道过滤。

### Added（三线分流接线）

- `src/event-listener.mjs`：出站事件按解析链分流（`channelTypes` 过滤 + `quiet` 静音——不推仍写账本）+ 会话活跃信号 touch；router 缺失/无 session/解析异常回落全局广播（向后兼容）。
- `src/approval/router.mjs`：审批卡片与通知只发该 agent 绑定通道（升级链同轮次同一集合）；`quiet` 对审批不生效——沉默审批 = 审批永远超时回落桌面。
- `src/tool-register.mjs`：notify 工具广播按执行上下文 agentId 分流（agent / agent.session / session 三级防御取 id；单渠道点名不分流；quiet 永不作用于工具——agent 显式要求推送）；无上下文/解析异常回落全局池，旧调用形状逐字节不变。
- `src/index.mjs`：router/registry 装配（store 进一步前移至事件监听之前，v0.3.1 TDZ 修复语义保留）+ 四线注入（事件/工具/审批/会话）+ 旧 `bind:*` 迁移；导出 `createAgentRouter` / `createSessionRegistry` / `workspaceOf`。

### Added（测试）

- `test/agent-router.test.mjs`（32）/ `test/session-registry.test.mjs`（25）/ `test/conversation.route.test.mjs`（16）/ `test/route-cli.test.mjs`（14）/ `test/wiring.route.test.mjs`（15）。

### Fixed

- `src/inbound/conversation.mjs`：`mergeWindowMs: 0` 被 `Number(0) || 默认` 吞成 1500——README 承诺的「0 = 关闭合并（每条原样投递）」从未生效，立即投递分支不可达。修复归一逻辑（undefined/null/NaN → 默认，0 合法）并补回归；`/unbind` `/status` `/help` 文案对齐 v0.3.2 语义（解绑后走通道默认路由，而非「最近活跃会话」）。

### Changed

- `package.json`：版本 0.3.2。
- README 双语：新增「多 agent 路由（v0.3.2）」章节（路由矩阵 / 命令族 / 路由 CLI / 数据与配置 / 兼容性 / 审批分流），命令表补入 `/agent` `/route` 族。

## [0.3.1] - 2026-08-15

官方扫码授权 + 钉钉 Stream 入站：qq / dingtalk / feishu 支持官方扫码创建/绑定（凭证 0600 落盘，`inbound.<channel>: {}` 零配置启用）；新增钉钉 Stream 入站通道，双向回传升至六通道。测试 329 → 391（+62）。

### Added（官方扫码授权）

- `src/inbound/_dingtalk-auth.mjs`：钉钉设备授权流（RFC 8628 形态，零依赖移植 dsh-im device-auth.mjs MIT）——init/begin/poll 三端点、七类错误码归一、baseUrl 白名单校验（https + dingtalk.com 域）、错误摘录递归脱敏（嵌套凭证字段不泄露）。
- `src/inbound/_qq-scan.mjs`：QQ 官方扫码封装（`@tencent-connect/qqbot-connector` optionalDep）——动态 import 缺包降级 missing-sdk、导出形态防御性兼容（具名/default 两级）、批量授权数组语义取首个有效凭证。
- `src/inbound/_feishu-register.mjs`：飞书扫码建应用（`@larksuiteoapi/node-sdk` ≥1.61.1 optionalDep）——registerApp 最小权限集（im 只读三权限，不装官方预设全家桶）、user_denied/expired 状态归一、open_id 带回供白名单提示。
- `scripts/channel-login.mjs`：统一扫码 CLI（qq/dingtalk/feishu/wechat 四通道）——终端二维码渲染（qrcode-terminal 可选）、钉钉会话过期自动刷新 ≤3 次、瞬态错误重试/结构性错误 fail-fast、wechat 复用既有 wechat-login.mjs 子进程透传。

### Added（钉钉 Stream 入站）

- `src/inbound/dingtalk-stream.mjs`：Stream 长连接裸协议（逐字段对照官方 SDK 验证，零 SDK）——gettoken + 网关协商、WebSocket 注册订阅、帧 ack（code 200 + messageId）、sessionWebhook 被动回复（过期即弃）、batchSend 主动推送（token 管理器 60s 边际刷新）、robotCode 首条消息学习跨重启、msgId 60s 重推吸收窗、重连指数退避 + 抖动、主动推送复用熔断器。

### Added（测试）

- `test/dingtalk-auth.test.mjs`（19）/ `test/inbound.dingtalk.test.mjs`（25）/ `test/channel-login.test.mjs`（16）/ index 装配回归（2）。

### Changed

- `src/index.mjs`：state store 提前创建供扫码凭证回退；新增钉钉入站装配块。
- `src/inbound/qq-gw.mjs` / `feishu-bot.mjs`：config 解析支持扫码凭证回退（显式配置优先）。
- `package.json`：optionalDependencies 新增 qq/feishu SDK（^1.2.0 / ^1.61.1）；版本 0.3.1；keywords 新增 dingtalk/qr-login。
- README 双语：入站通道表更新为六通道；新增扫码 CLI 说明。

### Fixed

- `src/index.mjs` TDZ 崩启动：state store 曾在 feishu/qq/dingtalk resolve 之后才创建，配置任一通道即 `ReferenceError: Cannot access 'store' before initialization`。修复：store 创建前移（index.test.mjs 新增回归）。
- `src/index.mjs` 扫码「空对象即启用」承诺未实现：`inbound.feishu: {}` 等空对象被「对象非空」门槛当未配置跳过，扫码落盘凭证后无法零配置启用。修复：门槛改为「显式提供了对象」，新增扫码凭证回退启用回归。
- `scripts/channel-login.mjs`：钉钉 poll 结构性错误（missing-field/incomplete-registration/api-error）fail-fast 不重试。
- `src/inbound/dingtalk-stream.mjs`：resolve 提示词错别字「开放者」→「开发者」。

## [0.3.0] - 2026-08-15

多通道双向回传：远程审批 / 远程会话从 telegram 单通道扩展到 5 通道（telegram / feishu / qq / wxpusher / wechat）。全部零运行时依赖（fetch + node:crypto + 原生 WebSocket）；飞书 SDK 与 qrcode-terminal 进 optionalDependencies，缺省优雅降级。测试 228 → 329（+101）。

### Added（阶段 0：入站通道契约泛化）

- `src/inbound/_contract.mjs`：统一入站契约 `normalizeInbound()`——新形状（channel/start/stop/notifyTargets/sendApprovalCard/editResolved/sendText/capabilities.buttons）与 telegram 旧形状（notifyChatIds/editResolved 三参）归一；异常全部吸收（卡片失败 → null 降级纯通知）。
- `src/approval/router.mjs` 多通道化：审批卡片并发分发到全部交互通道、单通道失败只降级不中断、`capabilities.buttons=false` 的通道自动走「回复 1 批准 / 2 拒绝」文案、回执按消息来源通道路由（editTarget）。
- 编号回复跨通道裁决：任一通道的 `1`/`2` 都能裁决最近待决审批，首达采纳不变。

### Added（阶段 1：飞书 inbound）

- `src/inbound/feishu-bot.mjs`：官方 SDK 懒加载 + WebSocket 长连接（免公网）；事件归一 im.message.receive_v1 → bus envelope；交互卡片审批（按钮回调 → buildApprovalAction 同构 token 核销）；主动消息走 im/v1/messages（receive_id 修正）；SDK 未安装时中文指引后静默不可用。

### Added（阶段 2：QQ 官方机器人 inbound）

- `src/inbound/qq-gw.mjs`：WS 网关裸协议（op10 HELLO → IDENTIFY/RESUME → op0/op11 心跳；op7/op9 重连矩阵），零 SDK 依赖——官方 Node SDK 改名两次后事实弃维，直接实现协议本身。
- C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE 事件；被动回复带 msg_seq（独立配额），主动消息限速门；getAppAccessToken 换取复用出站 token 管理器。

### Added（阶段 3：WxPusher inbound）

- `src/inbound/http-callback.mjs`：最小 HTTP 回调服务器（POST + 精确密径匹配 + 64KB 上限 + 查询串容忍 + 单次响应防重入）。
- `src/inbound/wxpusher-callback.mjs`：`send_up_cmd` 上行（`#{appId}` 前缀词边界剥离）→ bus；`app_subscribe` 绑定学习落盘；密径（随机 32B hex）+ uid 白名单 + 可选 allowedIps 三重自防（官方无签名）；定向推送限速门 500ms（对齐官方 ~2QPS）。

### Added（阶段 4：微信 iLink inbound + 登录 CLI）

- `src/inbound/_ilink-api.mjs`：iLink 协议层（Hermes weixin.py MIT 移植 + openclaw-weixin 交叉验证）——请求头（X-WECHAT-UIN 逐请求重生成防重放）、base_info channel_version 2.2.0、getupdates/sendmessage/二维码登录端点、错误语义归类。
- `src/inbound/wechat-ilink.mjs`：长轮询（35s 挂起，游标持久化重启续传）；context_token 入站即学习、发送回显；`ret=-2 + unknown error` 伪装限流 → 剥 token 重试一次再定性（不计熔断）；`ret=-14` 会话过期 → 清 ctx/游标/凭证停用通道并中文告警；长文分块（块间 2s）。
- `src/inbound/_breaker.mjs`：通用熔断器（阈值 3/窗口 60s/开路 15s，时钟可注入）；任一入站消息复位——「用户再发一条消息即解锁」实证行为。
- `scripts/wechat-login.mjs`：扫码登录 CLI（qrcode-terminal 可选渲染；scaned_but_redirect 跨机房切 host；expired 自动刷新 ≤3；凭证原子落盘 0600）。
- `src/inbound/store.mjs`：state.json 权限收紧至 0600（v0.3.0 起存放 iLink bot_token）。

### Compatibility

- telegram 入站路径零改动（旧形状经 `_contract` 适配）；`deps.telegram` 旧入口保留。
- 既有配置无新增必填项；四个新通道均为 opt-in（显式配置 `inbound.feishu/qq/wxpusher/wechat` 才启用）。
- 出站适配器零改动；`npm test` 基线 228 例全绿零修改。

## [0.2.0] - 2026-08-15

### Added（阶段 0：仓库基建）

- GitHub Actions CI：`node --test` + 零运行时依赖断言 + 渠道矩阵漂移检查（`.github/workflows/ci.yml`）。
- `README.zh.md` 中文文档（修复「README 英文 / package.json 中文」的 i18n 倒挂）。
- `THIRD_PARTY_NOTICES.md`：移植代码来源声明（push-all-in-one / all-pusher-api）。
- `ADAPTER.md`：适配器接口契约、spec 声明表编写守则、契约测试模板、good first issue 指引。

### Added（阶段 1：渠道扩展）

- spec 引擎 `src/adapters/_engine.mjs`：吃声明表产出 `resolve`/`send`，新渠道 8-15 行纯数据接入。
- 声明表 `src/adapters/spec-channels.mjs`，新增 15 个声明式渠道：
  slack / discord / wecom（企微机器人）/ ntfy / onebot（QQ OneBot 11）/ pushdeer / pushover / chanify / xizhi（息知）/ qmsg / igot / gotify / teams / mattermost / gchat（Google Chat）。
- token 管理器 `src/adapters/_tokens.mjs`（换 token → 缓存 → 过期刷新，QQ 官方与企微应用共用）。
- 代码适配器 `src/adapters/qq-bot.mjs`（QQ 官方机器人，appid+secret 换 access_token）、`src/adapters/wecom-app.mjs`（企微应用消息）。
- 参数化契约测试：`test/fixtures/channels/*.json` + `test/contract.spec.mjs`（resolve 校验 / mock fetch 断言 URL·method·body / 成功失败路径 / secret 脱敏）。
- 密钥环境变量引用：`${ENV:NAME}` 全值替换（先于校验解析），密钥可不落 profile 明文。
- `scripts/gen-channel-matrix.mjs`：从声明表生成 README 渠道矩阵，防文档漂移。

### Added（阶段 3：分级路由矩阵）

- `src/routing.mjs`：`routing: { timeSensitive | active | passive → [{ channel, ...语义覆盖 }] }`。
- 分档重试：timeSensitive 指数退避重试 2 次，active 重试 1 次，passive 不重试。
- 渠道语义对接：telegram `disable_notification`（静默）、ntfy `X-Priority`/静默、bark 原生 `level`（已有）、钉钉/飞书 `atAll`（配置开启）。

### Added（阶段 4：远程审批 inbound 模块，整体可选）

- `src/inbound/tokens.mjs`：HMAC 一次性 token（恒时比较、TTL、伪造/篡改/过期全拒；secret 缺省进程内随机，重启即全部失效）。
- `src/inbound/store.mjs`：JSON 文件持久化（pending 审批账本 / 去重表 / 轮询 cursor，原子写 + 损坏回退空状态，重启可恢复）。
- `src/inbound/bus.mjs`：入站总线（白名单默认全拒、持久去重 + 内存 FIFO 双层、`wait`/`decide`/`decideTrusted`/`abandon`、首达采纳——二次裁决一律 `already-resolved`）。
- `src/inbound/telegram-bot.mjs`：getUpdates 长轮询 + inline keyboard 按钮审批（无公网要求）；`callback_data` 解析容忍审批 key 内含冒号；offset cursor 持久化重启不重复消费；轮询异常只退避重试。
- `src/approval/router.mjs`：`approval/request` 瀑布流处理器（observe / answer 两模式，超时静默交还桌面）；编号回复降级（白名单用户回复 `1`/`2` 裁决最近待决，优先精确匹配推送目标、无匹配回退全局最近）。
- `src/approval/escalation.mjs`：审批升级链状态机（默认 30s/60s 两轮再提醒，任何裁决/超时/异常立即叫停）。
- `apply()` 装配：`inbound.allowUsers` 非空才启动整栈；`inbound.telegram` 未配置时自动复用出站 telegram 渠道的 `botToken`/`chatId`；`approval` 配置块接入 `resolveConfig`。
- 测试 +56 例（`test/inbound.test.mjs` / `test/inbound.telegram.test.mjs` / `test/approval.test.mjs` / index 装配测试），全量 158 例通过。

### Added（阶段 5：远程对话，克制版）

- `src/inbound/conversation.mjs`：followup（空闲唤醒）/ inject（忙碌排队）/ steer（`!` 前缀纠偏）投递语义路由。
- 合并窗（默认 1500ms）聚合手机碎片输入；`..` 立即冲刷、`!!` 立即冲刷并按 steer 投递；`mergeWindowMs: 0` 关闭合并。
- 命令集：`/status`、`/bind <sessionId>`、`/unbind`、`/stop`、`/help`（未知命令当普通文本，不吞消息）。
- `src/inbound/segment.mjs`：出站长消息收敛分段（1200 Unicode 码点预算，`（i/n）` 前缀长度参与递归收敛）；`notify` 出站统一走分段，任一段失败即整体失败（部分送达在错误中说明）。
- 默认投递目标为最近活跃 agent，`/bind` 显式绑定持久化（`bind:<channel>:<userId>`）。
- 测试 +25 例（`test/segment.test.mjs` / `test/conversation.test.mjs`），全量 183 例通过。

### Added（阶段 2：桌面通知规则，host 半）

- `src/rules.mjs`：host 侧规则引擎——关键词 include/exclude（字面量+正则+大小写开关，非法正则降级字面量）与空闲宽限窗 `createGraceQueue`（可注入时钟/定时器，纯函数可单测）。
- 事件粒度分控接入自动推送线：`events.turnEnd` 支持整类开关与按结束原因分控（completed/error/blocked/aborted/max-tokens/interrupted），`events.approval` / `events.agentError` 整类开关；被拦事件不占 dedup 名额。
- 空闲宽限窗接入：turn/end 防抖到期后进 `graceSeconds` 宽限窗，期间任何 `user/*` 会话事件（人在键盘）即取消打扰；approval / agent/error 不进宽限窗（等人决策，晚到等于没到）；dispose 时 flush 送达（headless 退出路径）。
- `bell` 本地渠道（`src/adapters/bell.mjs`）：终端 BEL 响铃（headless/TUI 场景，Codex BEL 等价物），count 钳制 1-5，尊重 `silent`，零凭证。
- `src/client/desktop-sound.mjs`：client 半实验性骨架——分级音色决策（`pickSoundForLevel`）、同会话通知替换键（`buildDesktopNotification` 的 tag）、out-of-view 抑制判定（`shouldSuppressDesktop`）等纯逻辑 + `shell.overlay` 挂载契约说明；宿主仓库不含客户端构建产物。
- 测试 +25 例（`test/rules.test.mjs` + event-listener 集成用例），全量 208 例通过。

### Added（阶段 6：通知账本 + 健康自检 + 工具限流）

- `src/ledger.mjs`：通知账本——每次广播追加一条 JSONL（时间/分级/标题/送达/失败），超 2 倍上限时摊销重写；`summarize`/`compose` 产出昨日摘要；脏行跳过、不可写目录静默，账本失败绝不拖累推送。
- 每日摘要（`digest.enabled`）：启动时对「昨日」窗口汇总推送一次（passive 级走正常路由），同日重启不重发（`ledger-state.json` 记录已发日期）；账本目录复用 `inbound.stateDir`。
- `src/health.mjs` + `scripts/test-channel.mjs`：渠道真机自检（resolve → send 全链路），CLI 支持 `--config` / `--config-file` / stdin 传入配置并解析 `${ENV:NAME}` 引用；退出码 0/1 可脚本化。
- `notify_test` agent 工具：发送固定自检消息验证渠道（与 `notify` 的区别：不改用户语义、结果渲染面向配置排障），省略 `channel` 广播全部已配置渠道；同样受滑动窗口限流（独立计数，测试风暴不能绕过 `notify` 限流刷渠道）。
- `notify` 工具滑动窗口限流（`toolRateLimitPerMinute`，默认 10 次/分钟，0 = 不限）：防 prompt injection 把用户渠道刷成垃圾出口；超限返回 `rateLimited` 结果并中文提示调整方向。
- `createNotifier` 复用钩子 `onSend(record)`：每次广播结束回调（含分级/送达/失败明细），第三方插件可复用 notifier 落自己的账本。
- `npm test` / CI 显式钉到 `test/*.test.mjs` + `test/*.spec.mjs`：默认发现 glob（`test-*`）会误吞 `scripts/test-channel.mjs`。
- 测试 +18 例（`test/ledger.test.mjs` + 限流/notify_test 用例），全量 226 例通过。

### Changed

- `package.json`：description 改为双语对齐；keywords 补充新渠道。
- 既有 8 个适配器零行为变更（仅 telegram 增加 `disable_notification`、钉钉/飞书增加配置门控的 `atAll` 一行语义对接）。

### Security

- 白名单默认全拒；token 单次核销；静默永不批准（超时/无响应/解析失败一律 `next()` 交还桌面）。
- 入站文本只能进会话流（`source.kind = 'plugin'`），永不直接执行 shell。
- secret 脱敏扩展到日志与错误消息全路径；token 不落库。

## [0.1.0] - 2026-08（基线）

首个发布：8 渠道（telegram/dingtalk/feishu/wxpusher/pushplus/serverchan/bark/webhook）单向推送，
双触发线（session/event 自动推送 + `notify` 工具），零运行时依赖，72 个 `node:test` 用例。
