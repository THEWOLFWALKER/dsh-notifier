# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。
DSH 处于 developer preview，0.x 阶段的次版本号提升允许小幅破坏性变更（会在条目中标注）。

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
- 新增 `WECHAT-TEST.md` 随包分发（离线用例 + 网页/CLI 真机步骤 + 验收清单）。

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
