# dsh-notifier main：账号隔离、权限传播与生命周期独立静态审查

**审查日期：** 2026-10-25  
**唯一代码基线：** `THEWOLFWALKER/dsh-notifier`，`main@9d69dd7a8908fcfec6e20d92d56509764a8f23ec`（以下简称 S）。  
**方法：** 使用 GitHub 仓库文件读取接口，按 S 读取源码、配置装配及现有测试源文本。未下载、安装或运行项目代码、测试、模拟复现或宿主；未编辑仓库、配置、状态、Issue、PR、分支或远端。上传的其他开发分支压缩包未读取，也没有使用 dev 或重写分支补充结论。  
**引用方法：** 下文所有 `路径:Lx–Ly` 均指 **S 的对应行号**；固定基线浏览前缀：`https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/`。引号里的短代码是必要证据，而非另一次执行结果。

## 结论摘要与证明级别

本次确认了 **一条生产装配下的 Control Core 边界缺口**（非 `/stop` slash 入口绕过）、以及 **一组由单 profile 的账号状态未完整命名空间化造成的历史状态串用**。后者不能笼统称作“两个同渠道 Bot 在单个标准插件实例里同时收消息”：实际工厂 **每渠道只启动一个实例**；较可靠的触发前提是 **在同一 `stateDir` 更换机器人账号并重启、或明确为多个插件实例指定同一个 `stateDir`**。其中同一 profile 换号是配置能力和历史状态组合，不等于已证明所有平台的旧、新标识必然碰撞，也不等于任何未经配对者能够直接注入 Agent。

严格按四种证明级别区分：

| 级别 | 本次结论 |
|---|---|
| **A. 源码可确定且标准生产路径可到达** | ① `route()` 对 `/bind`、`/agent`、`/use`、`/quiet`、`/log` 等 slash `command=null` 后直接 `routeUnsafe`，不进入 Control Core；② 生产 `notifyTargets` 和 `/log` 的权限/目标解析实际使用仅按 `channel` 的 `identity.list(channel)`；③ 同 profile 的 `:account` 更新/删除只写配置，不做当前运行实例轮换。这里的“可到达”只保证该代码分支，不表示具体跨账号影响无条件成立。 |
| **B. 需要特定配置或历史状态** | ④ A→B 账号轮换后旧 `bind:` / `route:channels` / `taskselect:` / `dedup:` / `tg:offset` 被 B 的同一 Store 读取；⑤ 留存 A 的 owner、B 的 member 时，B 上 `/log` 权限存在错判条件，且可能复用 A 的通知目标。须满足同渠道可比较的 `userId/chatId`、目标仍可达、相关功能开启等各项条件。 |
| **C. 仅接口/遗留行形状可构造，生产可达性未证明** | ⑥ 单标准装配内同渠道多个实时实例互串；⑦ 仅因 `paired()` 和审批/提问 owner 兜底不比较 `accountId` 就认定跨号批准；⑧ 旧动作 token 在新账号上成功执行。以上至少还有渠道来源、token、投递记录、Control Core/session policy 等守卫，不能直接判定越权成功。 |
| **D. 无法仅静态确认的时序风险** | ⑨ dispose 后迟到入站、会话附件 await 后 Agent 提交、飞书 SDK WS 迟到回调、推送队列与通道并行析构。代码能证明缺少若干 epoch/abort 检查及依赖关系，但未证明特定宿主/SDK 下的实际竞态发生概率与结果。 |

**根因合并：** 历史状态跨号串用（身份角色、通知目标、bind/default、task selection、dedup、TG cursor、部分交互账本来源）属于**同一根因：状态所有权只覆盖 channel/profile 或单次会话，未以真实 accountId 全链封闭**，不是七八个互不关联的新漏洞。`slash` 控制旁路是独立根因；异步 epoch/清理责任不完整是第三个独立根因。

## 1. 生产装配与状态所有权

### 1.1 实际实例数、共享关系、回复路由

`src/index.mjs:L62–67` 的入口是 `apply(ctx,config)`。正常启用时，`src/index.mjs:L187–190`：

```js
const stateDir = ... inboundRaw.stateDir ... : defaultStateDir()
const store = createStore(`${stateDir}/state.json`)
```

同一次 `apply` 中，`src/index.mjs:L351–355` 创建一份 `registry/router`，`L473–490` 创建一份 `identity/control`，`L560–575` 创建一份 `vault/bus`，`L605–636` 将**同一份** `bus,store,identity,control` 注入所有启用渠道。`L642–656、L669–688、L740–760` 再把审批、提问、会话路由挂到同一总线。

`src/assembly/inbound-channels.mjs:L63–96`：

```js
const interactiveInstances = []
const replyTargets = new Map()
const running = new Map()
// attach() 内
value.start()
interactiveInstances.push(value)
replyTargets.set(name, value)
running.set(name, value)
```

`L98–148` 对 `telegram/feishu/qq/wxpusher/wechat/dingtalk` 各至多调用一次 `attach`，只有一个对应通道的配置对象，而非账号实例数组。`src/inbound/channel-config.mjs:L92–95,L172–175` 也只读写一个 `${type}:account` 配置槽。因此**标准一次 apply 不能同时启动同渠道两个 Bot；该实例内部的多渠道共享 Store、bus、Control、路由是有意装配；`replyTargets` 按 channel 索引在此实例基数下足够区分正在运行的渠道，但不能表达同渠道两个账号**。

`src/index.mjs:L729–737` 文本回执 `replyViaChannel(channel,chatId,text)` 用 `replyTargets.get(channel)`，`src/approval/router.mjs:L438–440,L499–501` 回执也按 `interactiveByChannel.get(envelope.channel)` 找适配器。因此在标准单实例内，**回到该渠道当前唯一实例**是能证明的；如果用户另行制造同 channel 的双实例注入，则容器模型不支持账号分发，但生产入口尚未证明这种装配成立。多次 `apply`（不同 host plugin context）是否在宿主层允许同时存活，也不能仅从该仓库证明。

### 1.2 账号标识来源、信任强度、缺失处理

| 渠道 | 生产来源与代码 | 边界评价 |
|---|---|---|
| Telegram | `src/assembly/inbound-channels.mjs:L98–106` 注入 `tgRaw.accountId`；`src/channels/telegram/index.mjs:L30–35`：`config.accountId ?? 'default'`；`src/inbound/telegram-bot.mjs:L58–63` 同值写 envelope | **显式本地配置或固定 `'default'`**，不根据 Bot token 解析真实 Bot 身份；token 改变、accountId 仍 default 时逻辑身份相同。不是外部消息伪造值，但也不是已验证的机器人身份。 |
| Feishu | `src/channels/feishu/index.mjs:L31–35`、`src/inbound/feishu-bot.mjs:L290–299`：`config.accountId ?? config.appId` | 本地显式覆盖或 App ID，事件不能自主指定 accountId；显式值未在此链证明与 App 身份一致。 |
| QQ | `src/inbound/qq-gw.mjs:L443–449,L473–477,L714–716`：`String(config?.appId ?? '')` | 本地 App ID；有助于区分不同 QQ Bot 配置。空值传播到 Control 时拒绝。 |
| DingTalk | `src/inbound/dingtalk-stream.mjs:L590–593`：`String(config?.appKey ?? '')` | 本地 App Key；是否真实对应提供方需要配置真实性。 |
| WeChat iLink | `src/channels/wechat-ilink/legacy-core.mjs:L63–79,L260–279`：有效 `config.accountId` | 解析时要求账号加 token；envelope 本地注入；新 provider 的 `wechat:<accountId>:` 游标/上下文前缀见 `L115–120` 与 `src/channels/wechat-ilink/index.mjs:L41–46`。 |
| WxPusher | `src/inbound/wxpusher-callback.mjs:L266–269`，其解析配置里的 `resolvedAccountId` | 需复核与外部应用绑定关系；不要把固定默认标识当成验证过的远端账号身份证明。 |

**统一 Control 端防御：** `src/control/contract.mjs:L8–25` 的 `REQUIRED` 包含 `accountId`，空值触发 `missing_accountId`；`src/control/entry.mjs:L62–94` 注释/实现明确不拿 `channel` 冒充账号；`src/control/session-arbiter.mjs:L156–170,L201–217` 对 owner/team 及一般命令进行完整来源约束。这些实际防线必须计入影响分析。与此不同，`src/inbound/identity.mjs:L63–73` **身份注册**把缺失账号归一为 `default`，两层的缺失语义不能混为一谈。

### 1.3 保存、删除、换号的状态生命周期

`src/index.mjs:L239–252` 将 Native 入站配置交给 `inboundConfigPort`。`src/inbound/channel-config.mjs:L172–188`：

```js
const existing = plain(read(`${normalized}:account`)) ?? {}
const next = { ...existing, ...obj }
const okSaved = setDurable(store, `${normalized}:account`, clone(next))
```

删除见 `src/inbound/channel-config.mjs:L191–205`：

```js
const key = `${normalized}:account`
const removal = deleteDurable(store, key)
```

这两条路径没有调用 `channelRegistry.dispose()/attach()`，也没有按旧账号撤销 `inbound:bindings`、`bind:`、`taskselect:`、`dedup:`、`tg:offset`、`ap:/aq:/act:` 行。`L92–110` 用 `restartRequired: !isHotApplied('inbound')` 把 desired/configured 与 active 分离；**不能据此指责保存时“热切换到了新 Bot”，相反源码标明需重启**。风险成立于随后**重启并在同一 stateDir 读取持久状态**，或历史配置文件显式复用。

同一 stateDir 的第二次 `apply` 会重新创建不同的 JS `store/bus/router` 对象，但指向**相同 `state.json`**；属于条件配置共享，不是“同一对象实例同时属于两个 profile”。这类跨进程/跨实例物理共享不在单正常 `apply` 内证明。`src/inbound/store.mjs:L382–419` 明确支持刷新、持久写和查询键。

## 2. 数据流、存储键、问题与条件

### F-01｜A：slash 命令绕开 Control Core converse/source gate（独立根因）

**输入来源：** 任一真实入站适配器产生 envelope → `bus.accept` 完成账号绑定白名单与去重 → 会话 router 消费。正常账号入口例：`src/inbound/feishu-bot.mjs:L403–415`、`src/inbound/qq-gw.mjs:L443–449`、`src/inbound/telegram-bot.mjs:L298–319`。`src/inbound/bus.mjs:L193–232` 必须先 `this.allows(envelope.channel,envelope.userId,envelope.accountId)`；**未配对用户不可直接利用此分支**。

**完整调用链：** `src/index.mjs:L740–760` 挂 router → `src/inbound/conversation.mjs:L1066–1077` 检测以 `/` 开头的文字，立即 `fireAsync(route(...))` → `L1027–1033`：

```js
const command = trimmed === '/stop' ? 'stop'
  : (trimmed.startsWith(steerPrefix) ? 'steer' : (trimmed.startsWith('/') ? null : 'ordinary-message'))
if (control === null || command === null) return routeUnsafe(envelope, text, items)
```

→ `L961–964` `routeUnsafe` 先 `handleCommand` → `L301–459,L555–640,L676–788` 执行 `/bind`、`/agent use/back`、`/quiet`、`/log`、`/use` 等实现。**Control Core 的** `capabilities.converse`、完整来源 `accountId/sessionId/chatId`、QQ 群控制规则以及 session policy 对这些命令没有执行同一条授权链。`src/control/session-arbiter.mjs:L174–217` 的校验仅在 `control.handle` 真被调用后才生效。

**边界说明：** `/stop` **恰好等于** `/stop` 且有可解析 session 时进入 Core（`src/inbound/conversation.mjs:L1031,L1042–1058`）；未知 slash 最终是否投 Agent 取决于 `handleCommand` 结果。`/quiet` 写的是 session outbound 覆盖，`/bind` 写 `bind:<channel>:<userId>`，`/use` 消费 `taskselect:`；不是所有 slash 都具备同样副作用。QQ group 只有当消息通过 `bus` 的实际账号/用户绑定时才有可能到此，群成员 `member_openid` 与 C2C `user_openid` 是否可命中同一绑定不可静态确认（`src/inbound/qq-gw.mjs:L438–477`）。不能仅凭手造 group envelope 宣告生产群聊越权。

**清理：** `/unbind` 和 `/agent back` 主动删除 `bind:`（`src/inbound/conversation.mjs:L349–361,L752–788`）；`/quiet` 覆盖保存在会话路由状态；卸载 `src/inbound/conversation.mjs:L1165–1172` 只反注册消息、agent 监听和内存合并 timer，**不会自动取消已经写入的 bind、quiet**。

### F-02｜B：单 profile 换号后持久会话 bind/default 可复用（账号状态根因）

**输入和历史：** 账号 A 的已配对用户在同一 profile 使用 `/bind` 或 `/agent use` → `src/inbound/conversation.mjs:L206–249,L320–361` 写路由；随后 `src/inbound/channel-config.mjs:L172–205` 更改配置并重启为账号 B。账号 B 必须有自己的有效入站凭证与配对身份，且 provider 能提供相同 `(channel,userId)`，旧目标 session 仍存在。这样仅需两次**合法的真实消息**，不是直接向模块塞伪造 event。

**存储键和读链：** `src/inbound/conversation.mjs:L206` 的 `bind:${identityBindingKey(channel,userId)}` 无账号；`src/routing/agent-router.mjs:L210–251` 的解析顺序为 bind → `route:channels[channel]` 默认 → 单一活跃/最近活跃；`src/inbound/conversation.mjs:L985–1018` 解析 agent 并通过 `deliver` 调 `agent.inject/followup/steer`（`L827–880`）。`src/routing/session-registry.mjs:L732–745` 的旧绑定建档继承也同 profile 生效。**作用**是 B 的合法成员可能命中 A 选定的会话、改变哪一个 Agent 接收文本；如果旧 agent 已失效，将退回 `sessionGone`，不能宣称必定越权投递成功。

**旧状态清理：** `/unbind`、`/agent back` 或主动重绑能变更旧路由；配置删除与 transport dispose 不删除 bind/default；任务 registry 的清理面向 session TTL 与 disposal，不按机器人账号代际清理。`src/index.mjs:L310–344` 定期 sweep 仅覆盖 `dedup/ap/act/aq`，不触达 bind/default。

### F-03｜B：owner/member 的 accountId 传播中断，影响 `/log` 和默认通知目标（同根因）

**正确入口与错误下游的对照：** `src/inbound/identity.mjs:L55–73` 账号非 default 使用三段 `principalKey(channel,accountId,userId)`；`L263–284` 的 `allows()` 查询三元身份；`src/inbound/bus.mjs:L193–232` 先用它准入。但是 `src/inbound/identity.mjs:L297–306`：

```js
list(channel = '') {
  const records = Object.values(readBindings())
  return channel === '' ? records : records.filter(record => record.channel === channel)
}
```

该 `list` 没有 account 过滤。`L236–258` 首个全局成员被赋 owner，其后的新账号用户通常被赋 member；绑定历史仍在同 `inbound:bindings` 表（`L118–140`）。因此对于账号 A 已有 `(telegram,A,U,owner)`、换到账号 B 后又增加 `(telegram,B,U,member)` 的历史形状，B 的 `identity.allows('telegram',U,B)` 为 true，但在下游 owner 查询时 A 的 owner 仍能命中。

**`/log` 影响链：** `src/inbound/conversation.mjs:L555–561` 实际使用 `identity.list(envelope.channel).some(r => r.userId === envelope.userId && r.role === 'owner')`；`L619–640` 在 `remoteLog.enabled === true` 且有 ledger 时展示受 `maxLines/maxBytes` 约束的近期**通知摘要**。`src/index.mjs:L159–175,L753–758` 注入同 profile 的 ledger/remoteLog。因此 **满足 A-owner 留存、B-member 已配对、同 provider userId、功能开启时，B 的 member 可以被当成 owner 读取 `/log` 摘要**。此结论不意味着未绑定的人也能用 `/log`，也不意味着可读取完整消息/密钥；日志仍有脱敏及大小上限。

**主动通知影响链：** `src/inbound/target-guard.mjs:L167–174`：

```js
bound = identity.list(channel)
if (bound.length > 0)
  primary = bound.map(record => ({ chatId: String(record.userId), userId: String(record.userId) }))
```

生产实例 `src/inbound/telegram-bot.mjs:L553–561`、`src/inbound/feishu-bot.mjs:L739–747`、`src/inbound/qq-gw.mjs:L755–762` 等用此函数。故 B Bot 的 `notifyTargets()` **包含旧 A 所有同渠道绑定用户**，且已绑定者优先级高于新 Bot `configTargets`。`src/approval/router.mjs:L328–375`、`src/questions/router.mjs:L319–359` 将其进一步用于卡片和问题送达；送达记录 `pushedTo` 会记录本次 inbound 的 accountId，所以后续裁决不自动越权。是否真的向旧 A 的用户投递成功还取决于 Bot B 是否可与对方对话、目标 ID 的 provider 作用域、路由分流与发送结果；**可证明的是生产目标列表串用，非每个平台都可成功发到错误的人**。

**清理：** 需明确移除旧 identity 绑定才能从表里消失；`src/inbound/channel-config.mjs:L191–205` 删除账号配置不会删除 `inbound:bindings`。`src/inbound/identity.mjs:L309–350` 一次性 YAML `allowUsers` 迁移按 `default` 写身份，是另一个“default 并非真实 Bot”兼容来源；不能把已有 legacy 绑定自动解释为新 app 所有权。

### F-04｜B：去重与拒绝回执节流未随账号轮换换 namespace（同根因）

`src/inbound/bus.mjs:L82–108`：

```js
const dedupKeyOf = envelope => `dedup:${envelope.channel}:${envelope.messageId}`
if (typeof store.get(key) === 'number' && now - seenAt < dedupWindowOf(envelope)) return true
```

`L125–130,L193–199,L217–232` 对绑定合法消息先检查去重，再写持久时间戳，故 A 的同 channel/messageId 在窗口内被 B 读取。`src/index.mjs:L323–343` 的清扫窗口仅按时效，不按账号。可能产生**把 B 的新入站误视为重复消息而不进入身份/命令路由**；要成立需 A、B 真实消息的 `messageId` 字符串碰撞，不能把理论构造直接说成每次换号都必然漏消息。`src/inbound/bus.mjs:L138–148` 拒绝回执节流键 `[channel,userId]` 也漏 accountId，但仅是进程内 Map；常规重启后的 A→B 不跨进程保存，**同进程多账号/迟到混用未证明**，因此它是静态弱键，不是已证生产换号影响。

### F-05｜B：任务选择卡把原始消息保留在无账号键中（同根因，高关注）

**写入：** `src/routing/task-selection.mjs:L153–160`：

```js
return `${KEY_PREFIX}${channel}:${userId}:${chatId}`
```

`L235–248` 把 `{ candidates, originalText, attachments, expiresAt }` 写入 Store；`src/inbound/conversation.mjs:L985–997` 确认这是标准生产中多活跃任务歧义时的真实调用，不是仅测试用接口。

**消费：** 在相同 `(channel,userId,chatId)` 的 B 账号上，`src/inbound/conversation.mjs:L965–973` 尝试 `taskSelection.resolve(envelope,text)`；`src/routing/task-selection.mjs:L277–298` 合法编号会先 durable 删除后返回 A 保存的 `originalText` 和 candidate session，再由 `selectAndDeliver` 提交。`L301–317` 的 `/use` 也可能 `take` 原消息。条件必须同时满足：A 遗留 pending 未过期、B 已配对、标识一致、候选 agent 被 `isActive` 判断为活跃、B 发正确编号或选择命令。**影响不只是 UI 串卡，存在将 A 保存的文本/附件意图在 B 的操作下路由到活动 Agent 的代码链**；仍不得称作普遍无条件的跨 Bot 注入。

**清理：** `taskSelection.cancel` 只清当前 `(channel,user,chat)`；`src/routing/task-selection.mjs:L207–216` TTL 惰性清扫；`L358–361` `dispose()` 只 `memory.clear()`，明确保留盘上待决。`src/index.mjs:L310–344` 统一 sweep 未涵盖 `taskselect:`。

### F-06｜B：Telegram 游标 `tg:offset` 不随 Bot 账号重置（同根因，确定的错误复用链）

`src/inbound/telegram-bot.mjs:L298–325`：

```js
let offset = Number(store?.get('tg:offset', 0)) || 0
// 成功处理后
setDurable(store, 'tg:offset', nextOffset)
```

`src/assembly/inbound-channels.mjs:L98–107` 将同一 profile 的 Store 注入当前 Telegram Bot，`src/inbound/channel-config.mjs:L172–205` 换号不删除这个游标。故**新的 Telegram Bot 在重启后的第一次轮询，确实使用旧 Bot 的数值 offset**；“会跳过新 Bot 更新”取决于两 Bot 的 Telegram `update_id` 序列和实际消息时间，不是静态必然事实。与 WeChat 新 provider 账号前缀 `src/channels/wechat-ilink/legacy-core.mjs:L115–120,L154` 形成对照。

**清理：** 本次所读配置删除、统一 sweep（`src/index.mjs:L323–344`）均未删除 `tg:offset`。同一 Bot 原地重连复用 offset 是期望行为；**仅机器人身份改变时**旧游标才不具备同等所有权。

### F-07｜C：审批、问题、stop/action 的账号来源存在不一致，但尚未证明越权结算

**弱点：** `src/control/entry.mjs:L97–104` 的 `paired(identity,event)` 只用 `identity.list(event.channel).some(entry.userId===event.userId)`；与前置 `bus.allows` 三元组不同。审批编号回复 owner 兜底 `src/approval/router.mjs:L531–535`、问题 hint owner 兜底 `src/questions/router.mjs:L948–951` 也只用 `(channel,userId)`。审批的 `latestPendingFor`、`authorize` 对旧 `pushedTo` 若无 accountId 容许 wildcard（`src/approval/router.mjs:L149–169,L247–272`）；问题 legacy 兼容也有类似判断（`src/questions/router.mjs:L243–275`）。`src/actions.mjs:L83–103,L120–132,L239–255,L306–317` 的动作来源 `srcChats` 为 `{ [channel]:[chatId] }`，没有账号维度。

**但真实的裁决链仍有必须的二次防线：**

- 审批按钮：`src/approval/router.mjs:L437–478` 查 live pending、`pushedTo` user+chat+已记账号、检查非空 envelope.accountId，再进入 `control.handle`。`L211–227` 需要 `vault.verify(token)` 对应 key，`finalizeApproval` durable-first，才调用 `bus.settle`。编号 `L488–525` 虽 `trusted:true` 不要求按钮 token，却仍经过 `control.handle` 和 source/policy 检查。
- Control Core：`src/control/entry.mjs:L168–217` 比对真实 pending/basePolicy/controlMeta 的来源；`L232–283` 调 spec.authorize 后调用 `createSessionArbiter`，`src/control/session-arbiter.mjs:L156–217` 在 owner-only/team/member 等条件下按 account、channel、user 和 chat/session 约束。
- 问题：`src/questions/router.mjs:L257–279` 对带 accountId 的真实投递目标 `accountBound` 要求精确匹配，`L897–945` 的编号进入 Control Core 后才调用 `settle`。
- stop/action：`src/actions.mjs:L209–224` 验 token，`L239–255` 校验来源 chat，`L272–287` durable claim 后才执行 handler；`src/index.mjs:L583–598` 内置仅 `turn/cancel`，不是任意 handler 执行。

因此可作的结论是：**账号敏感的前置资格和旧形状兼容判断存在差异，需要按真实待决行的 source metadata、`tokenSecret`、provider 点击上下文及 session policy 再做证明**。不可直接以某个 `paired()` 返回 true、或可构造 legacy `pushedTo` 行，宣称跨账号 approve、answer、cancel 一定成功。尤其 `approvalOwnerOnly` 对 source 缺失有 fail-closed 行为（`src/control/entry.mjs:L265–270`）。

**清理/持久账本：** `src/interaction/ledger.mjs:L33–185` 的 `ap:`、`aq:`、`act:` 共用同 Store，行会以 resolved/claimed/uncertain 终态保存；`src/index.mjs:L323–344` 只对状态/时间窗口做清扫，不按账号撤销。`src/approval/router.mjs:L677–710` 启动扫描会把旧 pending 审批判失效，并尝试向旧 `pushedTo` 发送失效通知；这不能算“旧卡仍直接可批准”，反而是缓解。但是失效通知当前通过 `interactiveByChannel.get(target.channel)` 选择 B 的 transport（`L696–700`），旧 `pushedTo` 不以 account 查适配器；这是**换号后向非同一 Bot 目标尝试发送清理通知**的条件行为，是否真的送达需 provider 证据。问题与动作生命周期须分别核对，不得误用审批扫描结论覆盖全部账本。

### F-08｜C：普通消息合并与拒绝回执弱键，在标准换号重启下没有证明跨号复用

`src/inbound/conversation.mjs:L923–945` 的 `mergeWindowKeyOf` 返回 `channel:userId:chatId`，没有 account；但 `L1165–1172` 卸载清 timer 和 pending，且同一标准工厂每 channel 最多一实例（`src/assembly/inbound-channels.mjs:L98–148`）。因此这段**静态结构缺少账号维度**，但不能把它定性为“标准生产环境中同渠道 A、B 的短消息必被拼接”：需要同个 JS router 生命周期内确有两个账号的包进入，同标准装配未证明。拒绝回执节流的 `src/inbound/bus.mjs:L138–148` 同理。

## 3. 生命周期、异步所有权与 teardown

### 3.1 真实卸载顺序和持有者

`src/index.mjs` 中主要 disposer 注册顺序：`registry` `L360` → `eventListener` `L394–401` → `control` `L490` → `bus` `L580` → `actions` `L601` → `channelRegistry` `L636` → `approval` `L656` → `ask_user/questions/native bridge` `L686–704` → `conversation` `L760` → `admin` `L973`。宿主调用 `src/index.mjs:L979–982` 的 `disposeAll(disposers)`。`src/assembly/lifecycle.mjs:L14–22`：

```js
for (const dispose of disposers ?? []) {
  const result = dispose()
  if (result?.then) cleanups.push(result)
}
return Promise.allSettled(cleanups).then(() => undefined)
```

**证明**：同步触发全部 dispose，异步停机动作统一并行等待，**没有“先 drain 上游生产者，再停止 Bus/Control，最后关闭 transport/flush”这样的阶段屏障**。不能光因并行调用就说真实资源发生冲突；要按每个具体协作链区分。

资源持有与现有清理：Telegram `src/inbound/telegram-bot.mjs:L95–105,L298–362` 持轮询 Promise、per-request AbortController、API timer；stop 等待 in-flight fetch 自然到期而不主动 abort（`L357–361`）。Feishu `src/inbound/feishu-bot.mjs:L308–377,L699–737` 持 SDK `WSClient`、`startPromise`，stop 调 close/stop/terminate 并等待启动 Promise。QQ `src/inbound/qq-gw.mjs:L720–750`、DingTalk `src/inbound/dingtalk-stream.mjs:L595–620` 处理 reconnectTimer/socket。WeChat `src/channels/wechat-ilink/legacy-core.mjs:L145–153,L311–365,L447–465` 持 pollLoop、AbortController、watchdog，并可 abort+await。WxPusher `src/inbound/wxpusher-callback.mjs:L271–303` 持 HTTP server；`src/inbound/http-callback.mjs:L38–120` 请求有计时器并在 close 尽力切断连接。`src/approval/escalation.mjs:L15–65` 管升级 timer；会话合并 timer 清理见 `src/inbound/conversation.mjs:L1165–1172`。上述不是“没有 stop/dispose”，而是**有局部清理，缺统一 generation/fencing**。

### F-09｜D：dispose 后入站与异步会话提交可能仍有副作用；发生时序未实测

- **总线 guard 的缺口是源码确定的。** `src/inbound/bus.mjs:L99–100` 有 `disposed=false`；`L384–395` 在 dispose 设为 true、清 handlers/waiters；但 `L193–249` 的 `accept()` **从未读取 `disposed`**，仍可调用 `remember/rememberInMemory`，并允许准入前 `/pair`/`/whoami` 路径更改持久 state。生产是否出现在 stop 后调用 `accept`，取决于旧 transport 已在途回调以及宿主协程调度，属于 D。`src/index.mjs:L580,L636` 的同步注销顺序更凸显此窗口：bus 先 dispose，channel transport stop 随后启动并可异步收敛。
- **Telegram 轮询存在可定位 await 边界。** `src/inbound/telegram-bot.mjs:L300–325` 在 `await api('getUpdates')` 后直接遍历和 `await handleUpdate(update)`，在写 `tg:offset` 前没有再次检查 `running`；`L357–362` stop 只 `running=false` 并 await loop。故若正好处于 getUpdates 返回/处理阶段，有可能在停机已请求后向旧 bus 处理与写游标。**不是证明每次 stop 都如此，也不是已经证明覆盖了新 Bot 的同一进程状态**。
- **会话异步投递缺全程 lease。** `src/inbound/conversation.mjs:L174–180` 的 `fireAsync` 只 `.catch`，没有跟踪 in-flight Promise；`L827–880` 的 `deliver` 会 `await admitAttachmentBlock` 后再 `agent.steer/inject/followup`，之间没有 `disposed/generation/signal` 检查。`L1165–1172` 只清未来 timer/监听。因此**已进入异步路径的任务可能在 dispose 后才提交 Agent**，前提是附件读取恰好跨过停机边界、宿主 agent 仍接受操作；静态不能证明实测发生。`L1016–1021` 还可能在之后更新 `registry.touch` 和回执。
- **WS/HTTP 迟到回调。** Feishu `src/inbound/feishu-bot.mjs:L371–377` 注册事件回调，`L380–415` 的 `handleMessage()` 不检查 `running`，虽然 stop 尝试关闭 SDK 连接（`L725–737`）。Qt/DingTalk socket cleanup 与 SDK 是否保证零迟到回调，单仓库不能判定。WxPusher `src/inbound/http-callback.mjs:L88–94` 只对 onPayload 返回的 Promise 安排响应，没有“超时即 abort 用户 handler”的效果；HTTP handler 超时/连接关闭和 callback 业务完成并非同一事。
- **通知发送与关闭并行的依赖冲突只能定为风险。** `src/event-listener.mjs:L394–432` 的动作卡发送是 `Promise.resolve(inbound.sendActionCard(...)).then/catch`，并回调 `dispatcher.unmarkSource()` 写旧 Store；`L566–576` disposer `notifier.flush()`；`src/index.mjs:L601,L636` 可能同一次整体卸载中先 clear actions handler、再开始停 inbound。`src/approval/router.mjs:L593–603` 与 `src/questions/router.mjs:L1048–1068` 还有 await 后更新 `pushedTo` 的链。它们能证明**跨资源依赖及异步后续状态写路径**，但不能静态断言数据一定被错写、一定漏送或旧 callback 一定进入新 Store。

### 3.2 正面防护（不是漏洞）

`src/inbound/bus.mjs:L384–395` 确实取消 waiter、清 timer、摘 handlers；`src/control/entry.mjs:L136–137,L291–295` 直接 handle 在 disposed 后退回，不做裁决；`src/inbound/conversation.mjs:L1165–1172` 清并包 timer；`src/questions/router.mjs:L975–999,L1156–1163` 有 `disposed` 与 `cancelDelivery`；`src/inbound/feishu-bot.mjs:L704–717` 对 start 中途 stop 有 `running` 复核；`src/channels/wechat-ilink/legacy-core.mjs:L357,L460–465` abort 并检查 running。这些减轻时序问题，但不足以构成全系统代际 fencing。

## 4. 现有测试：覆盖与缺口（仅阅读测试源；**0 次测试执行**）

**已经写入的断言**：

- `test/identity.test.mjs:L309–325`（C8）证明 `identity.allows` 的三元隔离及 legacy 绑定不扩大到另一个显式 account；`L45–87` 一次性迁移/持久绑定；`L466–483` 去重和未绑定语义。
- `test/control-entry.integration.test.mjs:L183–287,L323–385,L552–788` 验证 wrong account、wrong channel/chat/session、owner-only/team 及 overlay source、来源冲突的 fail-closed；`test/conversation.route.test.mjs:L652–698` 测普通对话 gate、account 缺失拒绝与 QQ group 普通文本拒绝。
- `test/approval-phase2-hardening.test.mjs:L160–236`、`test/questions.test.mjs:L676–738,L1504–1568` 关注 token 重放、hint owner、问题回答错误 account 不结算；`test/inbound.telegram.test.mjs:L345–458,L648–718` 验来源会话、eventId、offset 持久；`test/inbound.feishu.test.mjs:L229–258,L1093–1150` 验 WS 关闭/握手生命周期和 envelope 账号注入。
- `test/conversation.task-selection.test.mjs:L71–147` 验单账号 begin、编号 resolve、`/use`；`test/inbound-log-command.test.mjs:L92–149,L236–262` 验 `/log` 开关、同 channel 的 owner、跨 channel owner 拒绝、敏感摘要脱敏及大小限制；`test/inbound-dedup-bounded-v0121.test.mjs:L27–62` 验未绑定不持久化、绑定持久化。
- `test/inbound.test.mjs:L625–642` 验 bus.dispose 处理 waiters/handlers；`test/inbound-transport-timeout.test.mjs:L49–107` 验部分 provider HTTP 有限超时。以上均为**测试文本内容**，不宣称本次跑过或测试一定通过。

**本次没有找到直接闭环验证的跨账号矩阵**：① 用生产 `src/index.mjs`+实际 channelRegistry 在**同一个 stateDir** 按“账号 A 运行、留下 bind/pending/offset/owner → 换为 B → 有效 B 消息”检验残留；② `identity.list(channel)`、`resolveNotifyTargets`、`/log` 在**同 channel 不同 account、同一 userId** 的矩阵；③ 已存 `taskselect` 原消息在 B 的同键编号被消费；④ `dedup` 同键 A→B 的误拒；⑤ `tg:offset` 换 Bot 后不是读取旧游标；⑥ 普通对话 gate 与 **已识别 slash** 的能力矩阵，例如 `capabilities.converse=false` 下 `/quiet`、`/bind`；⑦ dispose 期间 in-flight `bus.accept`、`deliver` 的代际副作用；⑧ `ctx.effect()` 聚合析构、flush 与 transport close 的生命周期依赖测试。现有测试中的接口注入场景也不能自动替代生产装配证明。

## 5. 最小修复边界（不含补丁）与待证事项

**最小修复边界：**

1. **账号所有权定义与迁移边界。** 在生产装配先定义“实际 Bot 账号是谁”的可信、稳定、不泄密标识；分开 `configuredId` 与经 provider 能够证明的 `authenticatedId`（若 provider 无公开查询能力则明确配置可信假设），对缺失/换号/同号凭证更新设 fail-closed 或显式轮换策略。历史 `default` 与旧 `inbound:bindings` 不能无条件冒充新号授权。
2. **统一跨层主键。** 将 `owner/member` 查询、`notifyTargets`、session bind、channel 默认路由、task selection、message dedup、拒绝节流、TG offset 与交互发送来源的 owner 语义围绕 `(profile,channel,accountId, userId/chatId)` 收敛。不是“给每个 Map 简单拼 `accountId`”就结束：必须说明旧键可读兼容、清理、迁移窗口与不可恢复时的拒绝语义。已有 WeChat provider 自己的账号 cursor 命名空间不能误删。
3. **命令入口重新纳入一个明确的 control policy。** `/stop`、`/bind`、`/use`、`/quiet`、`/log` 的权限不必相同，但不得用“以 `/` 开头所以 `command=null`”跳过 account/session/source/group 检查。落实每种命令的 owner/member/capabilities 模型，并保留注册面 `/pair`、`/whoami` 的必要先行入口。
4. **异步所有权收口。** transport、bus、conversation、question/approval、send queue 共用一次启动代际/停止信号；在 `await` 之后、**任何 Store 写/Agent 提交/新发送之前**复核 epoch；区分停止接收、drain、最终关闭的真实依赖顺序。旧回调不得借用新配置/Store；未能在界内确认资源已清理时记录不确定状态，而非伪装完成。

**仍待确定：** 宿主是否允许相同 profile 插件重叠 `apply`；配置端口保存后宿主实际何时重启插件；各 provider 用户/会话 ID 是否跨 Bot 同作用域（特别 QQ group `member_openid`）；实际 Telegram 不同 Bot `update_id` 的可比性；按钮原生 provider 能否在不同 Bot 间带着原卡回调；旧 `pushedTo`/`controlMeta` 在真实升级文件中出现频率及默认 `tokenSecret` 对跨进程旧 token 的影响；SDK WS/HTTP 关闭是否保证无迟到 listener；并行 flush 和 transport close 在具体 host adapter 里是否有依赖冲突。上述不能用静态“看起来能构造”替代生产证据。

---

**审查结论：** 当前固定 main 的入站账户识别在 identity 准入及 Control arbiter 上已有明确三元约束，但权限/路由/持久运营状态尚未端到端纳入相同的 account 维度。最应优先确认的真实链条是 **A→B 同 profile 换号后 `/log` owner 继承、notifyTargets 带旧成员、旧 bind/task-selection/tg cursor 复用**；另有明确的 **slash 命令在生产订阅路径旁路 Control Core**。审批/问题不可因单个前置 owner 判定缺字段就定性为成功越权，其 token、来源、Control Core 与账本终态必须连同验证。
