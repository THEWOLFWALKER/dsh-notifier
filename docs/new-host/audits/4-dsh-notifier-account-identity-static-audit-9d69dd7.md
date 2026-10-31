# dsh-notifier 账号身份与持久状态迁移专项静态审查

- **固定对象**：`THEWOLFWALKER/dsh-notifier` / `main@9d69dd7a8908fcfec6e20d92d56509764a8f23ec`
- **检查时间**：2026-10-31；仅读取上述 SHA 的 GitHub 提交、源码、类型/配置、已有测试，以及公开 provider 文档。未读取 dev/重写分支；没有运行项目、测试、渠道、登录、复现，未改动仓库及远端状态。
- **判定语言**：**[C]** 源码直接证明；**[I]** 在明确前提下的静态推演；**[U]** 平台行为/既有现场不具备证据，不能断定。下文的“可发”是代码尝试发送，**不等于**平台成功送达。

## 一、结论摘要（按可造成的后果排序）

**P1-A：读授权与读通知目标使用了不同的账号边界。[C]** 入站准入已经检查 `(channel,accountId,userId)`，但 `resolveNotifyTargets()` 只调用 `identity.list(channel)`，把这个渠道下**所有账号**的成员当作当前 transport 的通知目标，投递时丢弃 `accountId`。因此“Bot A 的老成员”在 Bot B 启动后仍可成为 B 的主动推送、审批/问题卡接收人。能否真的送达取决于具体平台作用域与对话许可；不能声称所有平台都必然泄漏。`src/inbound/bus.mjs:L193-L232`；`src/inbound/identity.mjs:L296-L308`；`src/inbound/target-guard.mjs:L128-L187`。

**P1-B：微信扫码成功所生成的权限归属与运行时权限归属不一致。[C]** `scripts/wechat-login.mjs:L68-L101` 从确认响应取得 `ilink_bot_id` 写 `wechat:account.accountId`，随后 `createIdentity().addBinding({channel:'wechat',userId,...})` **没有传 `accountId`**，所以绑定写入 `wechat:<userId>`（default）。新 provider 运行时 envelope 却携带真实 `config.accountId`（`src/channels/wechat-ilink/legacy-core.mjs:L258-L282`），`identity.allows()` 使用精确账号键，不会把 default 自动当作真实微信账号。因而“扫码即配对成功”的打印文案与通常非 `default` 的实际准入存在直接矛盾；**除非**另有针对真实 accountId 的绑定、账号恰好名为 default 或其他未核实入口，扫码本身不足以证明业务准入。`test/login-credential-durability-v013.test.mjs:L130-L163` 仅测 CLI 写账/提示，没把 CLI → 真微信 adapter → bus 的键贯通验收。

**P1-C：Telegram offset 没有 Bot 归属。[C/I]** `src/inbound/telegram-bot.mjs:L299-L324` 每次建实例都用 `tg:offset`，不读取 token 所属 `getMe().id`，也不区分已轮换密钥与真正换 Bot。A 的高 offset 被 B 用作 `getUpdates(offset)` 会在 B 的更新序列中确认低于此值的更新，存在丢更新前提；A/B 的消息 ID 又可能与 `dedup:telegram:<messageId>` 共享，产生误抑制窗口。Telegram 官方明确更高 offset 会确认旧更新。**单看 token 字符串无法静态证明新旧 token 指向同一个 Bot**，必须以平台返回的不可变 Bot ID 为准。

**P1-D：重启残留审批失效通知可能被新账号发往旧目标。[C/I]** `src/approval/router.mjs:L675-L714` 扫描全部 `ap:` pending，持久化标记 expired 后，按旧 `pushedTo + hintTargets` 遍历；只通过 `interactiveByChannel.get(target.channel)` 查 **本次启动的 transport**，没有检查 `target.accountId === active.accountId`，然后用当前凭据调用 `sendText(target.chatId,…)`。这不表示旧审批仍可获批：`liveWaiters` 和 Control Core 保持额外保护；但确实存在**旧账本驱动新 Bot 外部发消息**的路径。

**P1-E：taskselect、会话 bind、dedup、钉钉 robotCode、WxPusher 学习键未随账号隔离。[C]** `taskselect:<channel>:<userId>:<chatId>` 可以在新 bot 对该用户合法准入后，凭旧卡选择消费旧消息/附件（有严格的具体前提，详见第五节）；`bind:<channel>:<userId>` 可能继承旧会话；`dingtalk:robot-code` 可能与新 `appKey` 不匹配；`wxpusher:bind:<uid>` 和学习 `inbound:pending` 缺显式 accountId。

**P1-F：default 不是机器人本体证明。[C]** Telegram/WxPusher 的 `default` 只是稳定本地别名，不由平台签发；QQ/钉钉真实用 appId/appKey，飞书真实用 appId；微信用 ilink_bot_id。`inbound:migrated` 只证明 YAML allowUsers 已播撒一次，不能证明播撒给了哪个真实机器人。盲目把 default 绑定复制给新账号，或拿旧权限表无条件覆盖，都会扩大授权。

以上均为**静态风险与明确条件推演**，不是实际利用成功/渠道送达或动态复现报告。

## 二、六渠道怎样证明“同一个机器人账号”

| 渠道 | 运行时 accountId 的**实际生产者**与是否可覆盖 | 凭据和稳定身份的关系 | 用户/聊天 ID 的有效作用域；换号迁移结论 | 固定源码 |
|---|---|---|---|---|
| Telegram | facade 从 `inbound.telegram.accountId` 取值，空值 `default`；**YAML 可自定义**，当前 Native 凭据白名单仅 botToken。事件本身不能指定 accountId。 | `botToken` 是对 Bot 的访问密钥；`accountId` 与 token **无自动绑定校验**。token 变化可能是原 Bot 轮换，也可能是另一个 Bot。要用 `getMe().id` 经可信服务端验证，不能从 token 文本/默认名猜测。 | Telegram User ID 全平台身份，私聊 chat ID 一般与该用户对应；但 B 无权无条件给从未与 B 建立联系的用户发私聊。群 chat ID 全局标识不等于 B 已加入群。**保持原 Bot ID** 才可考虑游标连续；换 Bot 必须单独授权/选择通知目标。 | `src/channels/telegram/index.mjs:L17-L53`; `src/assembly/inbound-channels.mjs:L98-L108` |
| 飞书 | facade 取 `config.accountId ?? config.appId`，但**生产解析器只保留 appId/appSecret，丢弃 raw.accountId**，所以通常实际是 appId；Native 仅编辑 appId/Secret。 | appId 是应用主体，appSecret 是可轮换凭据。**相同 appId** 换 Secret 可认定同应用（前提可信配置）；改变 appId 即换应用。 | adapter `userId` 是 `ou_` open_id，**跨应用不同**；`chatId` 是飞书会话 ID（私聊通常 `oc_`），不能当 open_id 机械复制。换应用需要重新采集 open_id / chatId 与配对。 | `src/inbound/feishu-bot.mjs:L77-L104,L290-L299,L405-L414`; `src/channels/feishu/index.mjs:L31-L35` |
| QQ | 真实 envelope、adapter 都固定 `accountId = config.appId`；不采信事件方指定、不接受独立账号覆盖。 | appId 对应 Bot 应用，appSecret 用于获取 API token。相同 appId 重置 Secret 属同应用；appId 变化是另一 Bot。 | QQ Bot 私聊 `userId/chatId` 是面向机器人应用的 OpenID；**Bot A 的 OpenID 不能供 Bot B 发消息**，需要在 B 重新收事件。 | `src/inbound/qq-gw.mjs:L71-L83,L238-L246,L440-L477,L710-L717` |
| 钉钉 | 真实 `accountId=config.appKey`，无独立覆盖。 | appKey 标识企业应用，appSecret 认证。换 appSecret（appKey 不变）倾向同应用；换 appKey 不可视为同一机器人。 | 员工 `userId` 与企业/租户有关；同企业不同应用可能相同员工 ID，但**同人 ≠ 对 B 有操作授权**。聊天 `conversationId`、`robotCode` 均需按当前应用与权限重新验证。 | `src/inbound/dingtalk-stream.mjs:L120-L149,L237-L240,L358-L398,L539-L552,L590-L596` |
| WxPusher | `config.accountId` 可显式覆盖，默认 `default`，不是 appId；回调的 `data.appId` 不参与身份证明。 | appToken 是**某应用**的密钥；官方允许对同一应用重置 appToken，但项目没有存/验证不可变 WxPusher appId。token 改变时仅靠旧本地别名不能判断是否同应用。 | UID 是平台用户 ID，**发送许可由应用订阅关系 + appToken 决定**。UID 文本可能同，但不能推出 B 订阅/授权继承。更新 token 不等于换用户也不等于安全迁移。 | `src/inbound/wxpusher-callback.mjs:L58-L82,L104-L115,L188-L227` |
| 微信 iLink | `wechat:account` 的 `accountId` 优先由 CLI 确认响应 `ilink_bot_id` 提供；`inbound.wechat.accountId` 可以显式覆盖。运行时 envelope 用它。 | `token` 是登录会话凭据；若**可信服务端 bot ID** 不变可区分凭据续期；手填同名/冲突配置不能证明实体相同。注意协议归一的 `normalizeQrStatus` 使用 `ilink_user_id`，而登录 CLI 用 `ilink_bot_id`，两处语义不一致，需要对照实际协议证据。 | `userId` 来自 iLink 消息发送者，作为当前 Bot 的对应对话标识；跨 iLink Bot 是否稳定不可由本仓库及已审规范证明，应对新 Bot 重新配对/重新采集聊天目标。 | `scripts/wechat-login.mjs:L68-L101`; `src/channels/wechat-ilink/protocol.mjs:L49-L55`; `src/channels/wechat-ilink/legacy-core.mjs:L64-L82,L258-L280` |

**平台依据**：Telegram Bot API `getMe` / `getUpdates`（https://core.telegram.org/bots/api）；飞书官方用户身份及 `open_id` app scope（https://open.feishu.cn/document/platform-overveiw/basic-concepts/user-identity-introduction/introduction）；腾讯连接官方 QQ Bot 插件 README 对跨 Bot OpenID 的明确约束（https://github.com/tencent-connect/openclaw-qqbot#readme）；WxPusher 官方文档说明应用独立、AppToken 可重置、UID 配合应用授权（https://github.com/wxpusher/wxpusher-docs/blob/master/docs/README.md；https://wxpusher.zjiecode.com/docs/api-reference.html）。钉钉可参考其开发者百科中的应用唯一 ClientID/ClientSecret（https://opensource.dingtalk.com/developerpedia/docs/learn/permission/intro/permission-glossary/）及钉钉基础概念镜像的企业 UserId 作用域（https://dingtalk.apifox.cn/doc-392299）。iLink 更细的跨账号稳定性、微信会话重新签发条件未获充分权威证据，**不拿旧 ID 可用性作迁移前提**。

## 三、完整持久状态目录与生产调用链

此表覆盖发现的**实际 state.json 键域、额外持久文件、显式配置与纯内存状态**；明确区分权限、业务偏好、游标、凭据、审计。`=A` 表示 local accountId 不变，`A→B` 表示**真实 Bot/App 已更换**，`D` 表示删掉凭据再重新添加。除另有说明，**删除 `${channel}:account` 不会删除这里列的其它键**，相同 accountId 重加仍可读到旧值；如需静态迁移必须指定“证据由谁提供”。

| 持久状态键 / 形态 | 类型；读→写生产链；当前账号归属 | 同号换密钥、A→B、D、缺 ID、升级与落盘失败的当前行为 | 迁移/授权及外部动作建议 | 源码位置 |
|---|---|---|---|---|
| `inbound:bindings` | **权限**。`identity.allows/list` ← bus/notify/admin；`/pair`→`pairing.redeemAndBind`→draft、`/unpair`/admin增删写。表内键 `channel:user`=`default` 或 `channel:account:user`，存角色/来源。 | =A 精确账号键可继续准入；A→B 除 default 别名复用外精确拒绝；D 同 ID 会复活旧成员；缺 ID `identity` 归一成 default，但 Control Core 缺 ID另拒；升级原两段绑定只能算 default；写失败不应视为授权已保存。 | **必须以验证的 provider 主体重绑定权限**；原账号保留隔离，迁移到新 bot 默认不授权。default→显式 account 只有能证明就是同一实际 bot 且每项同用户 ID 仍有效，才允许一次性可审计显式授权，否则重配。A 的旧成员可能被 `notifyTargets` 再使用。 | `src/inbound/identity.mjs:L15-L24,L49-L95,L235-L285,L297-L308,L359-L390` |
| `inbound:migrated` | **迁移元信息**。启动 `identity.migrate(allowUsers, enabledInboundChannels)`→标记；一次性 YAML 白名单播撒到 default。 | 换号仍标记已完成，不会为 B 再播；旧版无标记才尝试播散；失败后启动继续旧绑定，不能把迁移失败说成权限完成。 | **保留一次性防复活标记**；不能用它证明 old default 属于 current Bot。更换 bot 需要新版本化迁移判据/人工配对。 | `src/inbound/identity.mjs:L310-L353`; `src/index.mjs:L505-L520` |
| `inbound:pending` | **待确认身份**。`identity.addPending/listPending/confirmPending/dismissPending`，表复合键同 bindings；管理台确认为成员、7 天 TTL。 | A→B 显式 account pending 不匹配；default 复用会重新出现旧申请；缺 ID 落 default；确认使用事务，失败不应移除 pending/创建 member。 | 待确认项不是授权，**不得跨账号确认**；仅同 bot 同源证据有效，跨 bot 要重新学习并确认；保留旧记录可审计至 TTL。 | `src/inbound/identity.mjs:L99-L110,L409-L506`; `src/admin/api.mjs:L1213-L1245` |
| `inbound:pairing` | **全局授权凭证**。admin/owner/bootstrap `pairing.mint/revoke`→哈希+状态；`/pair` 核销→bind，码本身未绑定具体账号。 | =A 与 A→B/删除重加时，只要码仍 active、有知码者能在**任一已启用 Bot**核销（真实 actor/accountId 从收到消息的 transport 来）；10min TTL、一次性。失败时原子核销+绑定事务；不能把 active 码误认为特定 bot 的授权。 | **换 Bot 期间撤销尚未使用的全局配对码，重新按目标账号发放/限制**。保留核销终态审计。 | `src/inbound/pairing.mjs:L20-L45,L266-L354`; `src/inbound/commands.mjs:L168-L235` |
| `inbound:pairing:lockout` | **安全限流**。`/pair`失败→`pairing.recordFailure`；principal 为 default 二段或显式三段。 | =A 继续限制；A→B 默认隔离、default 相同则共限流；旧版二段只算 default；锁出写入失败可能无法持续限流。 | 同一 verified bot 可保留；换 B 隔离，不能让 A 的失败成为 B 授权证据，也不必当作用户偏好移植。 | `src/inbound/pairing.mjs:L23-L33,L181-L241,L296-L354` |
| `wxpusher:bind:<uid>` | **订阅学习记录，非直接权限**。回调 `app_subscribe`→`setDurable`、清理；**未包含 WxPusher 应用 ID/accountId**。 | appToken 换应用/复用本地 default 后可读旧 UID；D 仍在；失败写则本次学习不可靠；本身不能直接准入。 | 新应用**重新观察真实订阅**；按 appId 命名空间；不能自动升级为 member。 | `src/inbound/wxpusher-callback.mjs:L118-L138,L205-L230` |
| WxPusher 学习产生的 `inbound:pending` | **待确认身份**。`app_subscribe`→`identity.addPending({channel:'wxpusher',userId,...})` **未传 resolvedAccountId**。 | 显式 WxPusher 账号不是 default 时，pending 错归 default；管理员确认也变成 default 权限，runtime 显式账号不能使用。 | 建议根据**可信 callback 绑定的 app 与 runtime account**重新采集、重新确认；不能以 UID 文本证明旧应用配对。 | `src/inbound/wxpusher-callback.mjs:L219-L229`; `src/inbound/identity.mjs:L410-L428` |
| `bind:<channel>:<userId>` | **业务控制入口**。`conversation /bind,/use,/unbind` 写删；`agent-router.resolveInbound` 优先 L1 读；`route:sessions[].inbound` 附着。**没有 accountId/chatId**。 | =A 沿用会话；A→B 若同 channel:userId 可命中旧 sid；D 读回旧绑定；缺 ID 不改变 lookup；升级 `registry.migrateLegacyBinds` 会按该键补建会话占位。 | 账号更换需**重新选择会话**，仅认证用户仍获准时才允许新绑定；旧键作为历史存档，不自动把 B 指向旧 Agent。 | `src/inbound/conversation.mjs:L203-L206,L286-L298,L320-L360,L643-L653`; `src/routing/agent-router.mjs:L207-L241` |
| `route:sessions`（含 `inbound`、`control`、`outbound`） | **混合**：会话历史、出站偏好、控制权。registry 持久保存，`attachInbound` 仅 `{channel,userId}`；`control.approvalMembers` 精确三元组。 | A→B `inbound` 挂钩可能呈旧身份仍关联会话；policy 三元组可阻止 B 代入 A（前提提供 accountId）；outbound quiet/channels 不应因此全删；旧 `bind` 补会话可能使旧 SID 可见。 | 分字段处理：`inbound` 脱钩/重配；control 成员和 owner 来源重鉴；出站 quiet/channels 可保留为业务偏好；历史保留审计。 | `src/routing/session-registry.mjs:L23-L27,L578-L665,L686-L755`; `src/control/session-arbiter.mjs:L19-L41` |
| `route:agents` | **业务偏好**。router / Admin 写 agent/workspace 通道、quiet 规则，依赖 enabled channel 集合。 | 更换 Bot 但渠道类型相同会继续向该类型发送业务通知；权限不因此自动授予，但通知内容可能到新目标。 | 优先保留 workspace 偏好，**重验发送目标与凭据主体**；新 bot 不应凭 channel 名继承审批目标授权。 | `src/routing/agent-router.mjs:L6-L20,L139-L190,L254-L341` |
| `route:channels` | **业务默认路由**。`channel → defaultAgent`，router/Admin 设置，`resolveInbound` L2 读取。 | A→B 在同 channel 下继续把消息路由到原会话/工作区；D 同；与身份准入是两道不同门。 | 保留可编辑默认值，但**重新选择/确认当前 Bot 的入站默认路由**，不能当成新成员授权。 | `src/routing/agent-router.mjs:L6-L11,L210-L241,L357-L421` |
| `taskselect:<channel>:<userId>:<chatId>` | **待执行原消息/附件**。会话歧义 `begin` 写候选、originalText、attachments、TTL10min；`resolve` 裸编号/`take` `/use` 读取并 durable 删除，`selectAndDeliver` 执行。**没有 accountId**。 | =A 仍在 10min 左右可选；A→B 只有键一致且 B 已能通过准入、对话/Control 路由等门才可能消费；D 同键重现；失败删除不投；升级无账号迁移；部分 TTL 清理由定时惰性完成。 | **不迁移任何待执行消息/媒体引用**；换 Bot 后要求**重新发消息、重新选择任务**；只保留不含秘密的统计审计，不能复用旧卡。详见第五节。 | `src/routing/task-selection.mjs:L24-L35,L148-L317`; `src/inbound/conversation.mjs:L655-L701,L960-L1010` |
| `dedup:<channel>:<messageId>` | **传输幂等**。bus 对已授权/已处理消息写持久 dedup；对**未绑定被拒绝**消息仅记内存 dedup（避免陌生人污染 state）；两者都基于 channel/messageId，**无 Bot 账号**；TTL 正常约24h，合成约60s；扫键过期。 | A→B 相同消息 ID 字符串可误判重复而阻止 B 消息，含 `/pair`；D 保留窗口；保存失败只记内存。旧版共用同名键。 | 按**provider 实际不变 ID**隔离，并在换账号时仅隔离新命名空间；不要直接丢失 A 的重放保护。 | `src/inbound/bus.mjs:L80-L129,L193-L215`; `src/index.mjs:L314-L340` |
| `tg:offset` | **Bot 长轮询游标**。`telegram.loop` `get(store)`→`getUpdates(offset)`→逐 update 处理→`setDurable`。全局唯一，完全未带 accountId/token fingerprint。 | =A 真同 Bot 更 token可保留；A→B **会把 A offset 用在 B 更新序列**；D 同；保存失败停止推进；缺 ID 不影响误用。 | 仅 provider `getMe.id` 相同才能原位继续。真正换 Bot 建新游标，先保留旧 Bot 游标作隔离快照；不得将旧高值发送给 B。 | `src/inbound/telegram-bot.mjs:L299-L324` |
| `wechat:<accountId>:sync_buf` | **iLink 游标**。新 facade `accountScoped=true`，构造时按当前 config.accountId 读，处理完整 batch 后 durable 写。 | 真同账号同 cursor 可复用；A→B 键不同原则隔离；D 相同 ID 仍复用；缺 ID 解析 fail；写失败保留内存旧值；无自动 legacy cursor 转换。 | 保留已验证 Bot 的游标，B 新建；旧 `wechat:sync_buf` 只能在**证明是哪一 Bot**后定向一次性导入，否则隔离。 | `src/channels/wechat-ilink/index.mjs:L37-L55`; `src/channels/wechat-ilink/legacy-core.mjs:L112-L155,L318-L355` |
| `wechat:<accountId>:ctx:<uid>` | **传输回信 context_token**。从入站消息学、发送时取；用户与账号双层作用域；定额淘汰。 | =A 同会话可能有效；A→B 分键；D 相同 ID 可复用旧 token 但会话过期可能导致 -14/-2，代码剥 token 重试；存失败不应算可靠。 | 只作为缓存保留/过期失效；换账号不复制；过期或重新登录后重新学习，绝不视为权限。 | `src/channels/wechat-ilink/legacy-core.mjs:L116-L120,L178-L208,L379-L404` |
| 旧 `wechat:sync_buf`、`wechat:ctx:<uid>` | **历史未隔离传输缓存**。旧 `legacy-core` 入口 `accountScoped=false` 才读写；新 facade 不使用这些键。 | 升级后旧缓存成为孤儿，不代表已迁至新键；A→B 若误复制会跨 bot 复用不透明 cursor/token；D/回滚至 legacy 可能**重新读**旧值。 | **按账户可验证来源迁移**，不能证明则隔离旧键；记录迁移版本防回滚重新激活。 | `src/channels/wechat-ilink/legacy-core.mjs:L33-L35,L112-L120`; `src/channels/wechat-ilink/index.mjs:L37-L47` |
| `wechat:account` / `wechat:<accountId>:account` | **登录凭据/会话**。扫码 CLI 写 global `wechat:account`；provider 新 facade 读 global。legacy/scoped 的 `accountKey` 用于过期时删除，而 scoped `<id>:account` 未发现由生产登录 CLI 写入。 | A→B 新 CLI 覆写 global 仅保留最新账号；运行中的旧实例未因此热换。D 移除/再加相同 ID 可读其它旧状态；会话过期清 scoped 缓存与 global 凭据，但不清 identity。 | 凭据与账号声明一起原子版本化；过期仅失效会话+cursor/context，**不要删除成员审计**；保留最后可证主体和旧账号隔离记录。 | `scripts/wechat-login.mjs:L68-L82`; `src/channels/wechat-ilink/index.mjs:L44-L55`; `src/channels/wechat-ilink/legacy-core.mjs:L241-L253` |
| `dingtalk:robot-code` | **应用发送目标/运行时学得的协议身份**。构造时 `store.get`，首条新 inbound 的 `robotCode` 再覆盖并 durable 落盘；主动推送直接读取内存 robotCode。 | 同 appKey 续 Secret 可能有效；A→B 在尚未收到 B 首条消息时直接带**旧 robotCode**构造 B 的主动推送；D 同。真实平台是否拒绝/错投未知，代码会尝试。 | 与 appKey 或可信机器人主体绑定；换应用先置不可用，等 B 的可信事件重新学习；旧 code 不自动迁移。 | `src/inbound/dingtalk-stream.mjs:L51,L233-L240,L353-L361,L539-L552` |
| `wxpusher:webhookPath` | **回调接入秘密/传输偏好**。首次按 appToken 随机生成，持久化；之后复用；显式 path 可覆盖。 | A→B 继续使用同一个旧密径；D 仍在；更新 appToken 本身不轮换 URL/path；若平台 A 的回调仍指向路径且缺独立可信 app 验证，安全边界需额外核验。 | 同一应用改 Token 可保留路径但应评估是否轮换；新应用应新密径/验证回调来源，旧路径应注销而非当作 B 的认证。 | `src/assembly/inbound-signals.mjs:L81-L112`; `src/inbound/wxpusher-callback.mjs:L58-L83` |
| `<type>:account`：`telegram`、`qq`、`feishu`、`dingtalk`、`wxpusher` | **凭据/目标配置**。Native/admin PUT 与登录 CLI 写；启动 `resolveInboundSignals` 按 YAML/出站/store 优先级解析；`put/delete` 不等于更换 active transport。 | =A 续密钥凭据可以继续同主体（QQ/Feishu/Ding appId/appKey 不变）；A→B 只修改本键但旧授权/状态全在；D 再加会复活；字段级 YAML 优先造成表面保存成功却仍在用旧声明。 | 需要`desired` vs `active` 原子切换合同与主体确认，不要保存完成就迁移授权/游标；先撤旧 transport 确权后启新；失败不制造已切换假象。 | `src/assembly/inbound-signals.mjs:L15-L126`; `src/inbound/channel-config.mjs:L150-L207`; `src/admin/api.mjs:L997-L1056` |
| `channel:<type>:outbound` | **出站配置偏好与凭据**。v0.13 canonical，配置/API/出站装配读取；与入站 Bot 凭据有时共享外部同一 Bot 但配置域不同。 | 新的 outbound 配置优先；默认不证明 inbound 已切；回滚时可能恢复 outbound 老目标，但不会撤销 `inbound:bindings`。 | 按方向分别迁移。可保留不敏感频道偏好，密钥和接收人按 verified Bot/App 分片；避免只迁 inbound 不迁 outbound 造成分裂。 | `src/control-surface/channel-config-migration.mjs:L10-L113`; `src/assembly/outbound.mjs:L19-L81` |
| 旧 `admin:channel:<type>:outbound`、非双域旧 `<type>:account` | **历史出站 overlay**。v0.13 迁移到 canonical，迁移结果标记，不应让 runtime 重新落回旧键。 | 迁移成功后读 canonical；失败/延迟以禁旧回退处理；`<type>:account` 仍可能是**入站凭据**，不能当纯旧键直接删除。D 或版本回滚可能使旧代码再次读旧 overlay。 | 保留来源/版本、区分输入凭据共享；迁移失败 fail-closed，绝不因为“清理旧出站”误删扫码凭据。 | `src/control-surface/channel-config-migration.mjs:L41-L113`; `src/assembly/outbound.mjs:L33-L56` |
| `state:schema-version`、`state:migration:v0.13` | **schema/迁移审计元数据**。启动 v0.13 canonical 迁移判断和原子提交；与 bot principal 不是一回事。 | 只描述出站配置迁移，不能证明 identity/游标已按账号迁移；失败后不可假装 completed。 | **保留**，并另建可审计的 account-identity 迁移版本记录，不能复用该 marker 偷渡授权。 | `src/control-surface/channel-config-migration.mjs:L10-L19,L40-L105` |
| `ap:<...>` 与其 `pushedTo`/`hintTargets`/`intendedChannels` | **审批权限过程 + 送达历史**。`approval/request`→`ledger.add`→`pushCards` 逐目标写 `pushedTo`→Control Core/编号核销→终态；重启扫描僵尸。`pushedTo` 新行带 accountId，旧行可缺。 | =A 活 waiter 可继续处理；重启 pending 为僵尸，**标 expired 并用当前 channel transport 发失效通知**；A→B 旧 row 仍被扫描且缺发送账号比较；失效回执可能触发意外外发。旧 row accountId 缺时部分匹配按 wildcard；失败终态会尝试 uncertain 标记。 | 原审批不跨账号迁移、不跨进程恢复 waiter；**仅以原 sender 发送失效通知**，否则只落内部审计；保留终态短期审计。 | `src/approval/router.mjs:L118-L178,L332-L378,L439-L476,L675-L714`; `src/interaction/ledger.mjs:L65-L185` |
| `aq:<...>` 与 `pushedTo`/`hintTargets`/`escalationTargets` | **问题待答与投递历史**。`ask_user`→ledger.add→notifyTargets/card/hint→Control/编号/按钮 settle；new targets accountId，old missing considered wildcard in部分检查。 | =A 在 waiter/TTL 存活可答；A→B 不应重用问题目标；D/回滚若旧键/secret/活 waiter 仍在有潜在跨账号误匹配；重启旧 pending 通常没有 live waiter，代码有拒绝/终止处理但须分支核查。 | 换账号终止待答、重新问新对象；历史保留脱敏，**不得把缺 accountId 的旧 pushedTo 当成“所有账号”授权**。 | `src/questions/router.mjs:L39-L48,L143-L207,L244-L274,L304-L408,L970-L1068` |
| `act:<kind>:<rand>` 与 `srcChats` | **不可逆动作执行台账**。动作铸造写 pending；发送前 markSource 把来源存 `{channel:[chatId]}` **没有 accountId**；Control/动作回调先校验 HMAC+来源、durable claim，再执行 handler。 | A→B `srcChats` 文本可能碰撞；真正触发还要 token、bus 身份、Control Core 和有效 pending；没有来源元数据的旧卡有最多 10min 宽限条件；崩溃后 claimed 不重执行。 | 不迁移待执行动作；旧 pending 应终止/隔离，claimed/uncertain 保留诊断；新 action 来源应至少是 `(channel,accountId,chatId)`。不能一律删历史导致失去副作用证据。 | `src/actions.mjs:L15-L34,L54-L133,L176-L195,L225-L297`; `src/interaction/ledger.mjs:L89-L123` |
| `inbound.tokenSecret`（YAML/配置） | **密钥材料，非 state.json 键**。启动 `createTokenVault` 使用显式 `inboundRaw.tokenSecret`；未配置则进程随机 HMAC key。 | 同密钥换 Bot，旧签名在 TTL 内仍能验真，是否授权还要 ledger + source gates；不配置则重启旧 token 一律签名失效；它**不证明同一个 bot**，不得直接做迁移依据。 | 不复制作为账号身份；按安全域评估轮换与令牌寿命，保留所需历史核销记录。 | `src/index.mjs:L559-L570`; `src/inbound/tokens.mjs:L1-L5,L22-L64` |
| `admin:token-hash` | **管理台实例鉴权**。首启/配置 admin token 相关逻辑，hash durable 存储，未按机器人分片。 | 换 Bot 不重置此凭据；管理台权限与外部 IM 身份角色不同。 | **保留**独立安全域；账号变更不应静默授予新外部用户 Admin 权限。 | `src/assembly/admin-token.mjs:L5-L80` |
| `stateDir/bootstrap-paircode.txt` | **配对凭据的本地副本**。引导创建成功后写 0600，绑定非空、过期/核销/撤销后尽力清除。 | 账号换号但旧 owner 留存时 guided 不再触发，旧文件清除；存储异常可能影响码面展示，但不能代替服务端码状态。 | 待重配期间不要复用旧码面；只保留审计事件，不保留明文码。 | `src/index.mjs:L183-L190,L458-L495,L520-L556` |
| `stateDir/ledger.jsonl` | **通知投递审计**。notifier onSend→`ledger.append({delivered,failed,...})`，不是授权表；未完整标注 provider accountId。 | 换号继续混合记录，不会自动发旧记录本身；但启用 digest 会根据“昨日”旧记录重新生成新 Bot 的**摘要外发**。 | **保留带来源标签的历史**，新增账号分片/标注、审计摘要切换时的披露范围；不要删除原始事故证据。 | `src/ledger.mjs:L60-L107,L150-L160`; `src/index.mjs:L159-L176,L412-L425` |
| `stateDir/ledger-state.json` (`lastDigestDate`) | **通知摘要游标/偏好**。昨日摘要成功判定使用日期，全实例共用。 | A→B 同一天的摘要可能被“已推过”抑制，或**B 的新启动**推送含 A 历史投递的摘要；写失败可能跨重启重发。 | 摘要标记应按用户意图与接收账号/通知计划判断；保留审计，避免按换 bot 清空导致重复发。 | `src/ledger.mjs:L191-L207`; `src/index.mjs:L412-L425` |
| `stateDir/admin-audit.jsonl` 等管理台审计 | **审计历史**。admin 配对/配置操作写 JSONL；`pairing` 事件从内存 backlog 注入审计 sink。 | 账号更替不代表旧审计无效；不会自动变成成员权限；账户名如果只记 display alias 则历史解释可能歧义。 | **保留不可变历史**，未来追加 verified provider ID、desired/active generation、迁移决议。 | `src/index.mjs:L446-L480`; `src/admin/api.mjs:L103-L111,L397-L417` |
| 非持久化：`callback-refs`、pending merge window、waiters、provider access-token caches | **短生命周期运行态**。ref map、会话合并、Live 审批/问题 waiter、SDK/网络 token cache；不在 state.json。 | 进程重启自然消失；**保存新配置但未重启时，旧 active transport 与这些内存状态仍可能使用 A**；绝对不能把 desired B 当 active B。 | 迁移设计必须显式停止/撤权旧实例、取消/收尾相关 waiter/回调，再启动 B；不可通过“改数据库键”模拟完成。 | `src/inbound/callback-refs.mjs:L1-L96`; `src/inbound/conversation.mjs:L920-L958`; `src/inbound/bus.mjs:L89-L92`; `src/assembly/inbound-channels.mjs:L69-L179` |

**特别注意**：有些已知配置（如 `inbound.allowUsers`、per-channel `notifyUsers/notifyChatIds/notifyUids`、出站 `channels`、`route`）可能存在 YAML 与 state overlay 两层。这些并非每个字段都有独立 `state.json` 键，不能虚构“每用户一个键”；它们与 `inbound:bindings` 的优先级和迁移风险已列入上表。

## 四、场景矩阵：相同账号、真换号、删除重加、缺失账号、旧版、失败回滚

| 场景 | 代码现在的关键事实 | 对应允许保留什么 / 不应保留什么 |
|---|---|---|
| **同一平台 Bot/App，轮换 Secret/Token** | QQ appId、飞书 appId、钉钉 appKey 未变可作为应用一致性的**配置级线索**，不等于对外认证成功；Telegram/WxPusher 无 Bot-ID ↔ 本地 alias 校验；WeChat 使用扫码真实 id 的前提是无手填覆盖。 | 有可信平台主体证明后可保留该主体下成员、偏好、适用协议游标；仅凭字符串 token 变化/不变不能裁决 Telegram/WxPusher。过期凭据必须失效，不能带旧 access_token。 |
| **实际 Bot A→B** | 账号精确 keyed `inbound:bindings` 的 A 行通常不能通过 B 的 allows；但是 `notifyTargets` 扫全渠道，`taskselect/bind/dedup` 没有账号，`tg:offset` 复用，`ap:` 重启通知无账号校验。 | **授权、配对申请、未完成控制/任务、通知目标、传输游标必须隔离或重配**；`route`偏好和审计可按字段保留/待确认。 |
| **删除凭据后又添加** | Native `delete` 只删除 `<type>:account` 或 outbound overlay，其他绑定、游标、路由都不自动删除；如果 YAML 显式优先，删除 store 不代表停旧 active；重启后同 alias/同 ID 旧数据复活。 | 删除动作要分为“停用但保留状态”（可恢复）与“撤销授权”（不可复活）两种明确语义；重新启用需经过主体连续性检验。 |
| **缺失 `accountId`** | `identity` 层缺省 default，Control Core 远程动作显式缺值 fail-closed；普通对话 route、notifyTargets 和 tokenless 缓存有各自宽松路径；不统一。 | 不应把 default 当平台身份，不能自动推断成 channel；高权限指令拒绝/重新配对；偏好只保留为无主体标记的草稿。 |
| **旧版升级** | `inbound:migrated` 只播 YAML 到 default 一次；路由旧 bind 会补 registry 记录；v0.13 出站 canonical 迁移不处理身份；WeChat 新 provider 不读老游标，Telegram 始终读老 global offset。 | 必须各键族单独做**可证来源的单向迁移**，并标记结果与回滚语义。旧 state 不应反向成为新 Bot 授权。 |
| **持久化失败、回滚/崩溃** | pairing 使用事务绑定+核码，actions claim 在副作用前；approval/questions 有 uncertain 标记分支；然而可见源码也有副作用外发前后多步落盘、CLI 凭据成功但身份部分成功、startup stale notice 和 digest 标记次序。 | 凭据存储提交 ≠ 账号热切换、绑定提交 ≠ 实际消息送达。回滚需以 `desiredAccount`, `activeAccount`, `generation`, `durableDecision`, `transportConfirmed` 分别建证；不跨失败边界重放副作用。 |

## 五、四个指定争点的完整静态准入证明

### 5.1 taskselect 换号后怎样才会消费旧原消息？

生产：`bus.accept(envelope)` 先经去重和 `identity.allows(channel,user,account)`；成功才进入 `conversation` 消息监听。若多个活跃任务歧义，`taskSelection.begin(envelope,candidates,text,attachments)` 把候选、**原始正文和附件元数据/URL**写入不含账号的 `taskselect:<channel>:<user>:<chat>`。`src/inbound/bus.mjs:L193-L232` → `src/inbound/conversation.mjs:L960-L1001` → `src/routing/task-selection.mjs:L148-L249`。

换成 B 后，只有同时满足以下事实才存在旧消息被送给 Agent 的路径：**(i)** B 输入的 `channel、userId、chatId` 与 A 产生的键**完全相同**；**(ii)** B 这个来源通过当下入站 bus 的配对准入（如已对 B 重新配对，或复用了 `default` 绑定；B 未授权则不进会话路由）；**(iii)** `taskselect` 旧行仍在，候选及正文满足读路径的结构检查，尚未被消费/惰性清理（TTL 10min，惰性清扫有边界）；**(iv)** 用户回复有效编号或 `/use` 匹配旧候选；**(v)** `resolve`/`take` 的 durable 删除成功；**(vi)** `agentOf(sessionId)` 仍存在，`applyBinding` 的 durable 写成功；**(vii)** 会话消息路由/Control Core 对该输入的实际政策许可（`/use` 是命令路径，与普通消息路径不完全相同），然后 `deliver` 才会收到旧 `originalText` 和 `attachments`。`src/routing/task-selection.mjs:L255-L317`; `src/inbound/conversation.mjs:L643-L701,L961-L1069`。

**不是**“只要换 Bot 就能注入旧消息”：必须有以上同键+新账号有效准入等条件。**也不是**“pair 过就安全”：pair 对 B 成功后，旧卡的**内容来源仍是 A**，现有 consumer 未检查记录原生产 `accountId/generation`。另：候选活跃过滤发生在 `begin`，`take/resolve` 对旧行不重新调用 `isActive`；`selectAndDeliver` 仅检查 `agentOf` 存在。建议**换账号强制旧卡失效、重新发送原消息/重新选择**，不复制附件 URL 等潜在敏感元数据。

### 5.2 notifyTargets 读取“旧成员”后每个平台意味着什么？

读取：每个 provider 的 `notifyTargets` 都调用 `resolveNotifyTargets({identity,channel,...})`，其最高优先级仅 `identity.list(channel)`，丢弃 record.accountId；形状校验只做 ID 字符串格式，**不能证明该 ID 属于 active Bot**。`src/inbound/target-guard.mjs:L128-L190`，六个实际调用点见第四节引用。

- **Telegram**：用户/chat ID 是平台级，不随 Bot 切换重新生成，但 Bot B 对此用户是否建立会话/被允许主动发送另当别论；**具备 B 交互关系时** B 可能成功给 A 的旧成员发送通知，直接造成跨账号目标继承。
- **飞书**：旧 `ou_` open_id 属于应用 A，B 不能把它当成 B 的用户；平台一般拒绝/无法找到 B 的目标。若旧 `chatId` 属旧应用创建/访问的会话，B 的权限也不由同一字符串保证。错误目标会导致丢通知与重试/告警，不能把 API 失败当作隔离策略。
- **QQ**：腾讯官方对多 Bot 明确告知 A 的 OpenID 不能由 B 使用，典型是 500；旧成员变成 B 的错误目标，不应自动迁移。
- **钉钉**：若 A、B 在同企业，员工 userId 可能保持不变，B 的应用拥有发送范围/robotCode 时可能真发给同一人员；因此**实质越权通知风险**不能以“换了 AppKey 所以发送失败”打消。跨企业或权限不足则可能失败。
- **WxPusher**：UID 是用户号，发送依赖 appToken 和订阅/应用关联；**同 UID 不等于订阅了 B**。若仍可经 B 向该 UID 发送，则会出现非预期通知；其具体服务端授信条件不能静态保证。
- **微信 iLink**：旧 `userId` 与新 Bot `to` 的映射范围没有充分平台证据；代码会尝试用 B 的 token 发送到旧 `chatId`，成功/拒绝均未实测。不能把“没有到达”当作安全设计。

优先级上，一旦该渠道存在任何 A 旧成员，`notifyTargets` 的 configTargets 也会被旧表覆盖，导致 **B 合法配置目标不被使用**；Telegram 负数通知群、QQ notifyGroups 作为 `extraTargets` 仍无条件加入（即便当前产品需求仅私聊，也要按**本提交实际源码**审查）。正确做法应是**先按 verified active account 过滤成员与目标，再校验 provider 的私聊来源许可**，不能只改键名。

### 5.3 Telegram 旧 offset 在哪里读、如何归属？

`createTelegramTransport` 在 facade 将 `config.accountId` 填到 envelope，但这只用于来源鉴权；它没有传给 offset 存储层。`createTelegramInbound.loop()` 一开始执行 `Number(store?.get('tg:offset',0))||0`；每处理一条更新后 durable 写回**同一个** `tg:offset`。`src/channels/telegram/index.mjs:L30-L53`; `src/inbound/telegram-bot.mjs:L299-L324`。

同 Bot token 正常轮换：**若**通过 `getMe.id` 证明同一主体，保留 offset 是合理的；换新 Bot：旧 offset 完全没有意义，传 `getUpdates` 可能确认 B 尚未处理的较小 update_id，造成不可恢复的入口丢消息。旧 offset 低/重用同名 `dedup` 又可能误吞或重放。Telegram 官方明确更新在调用带更高 offset 的 `getUpdates` 时即视为 confirmed；并明确新 Bot 的 `getMe()` 可提供 Bot User ID（规范链接见第二区）。**单看 token 前缀虽可能提供线索，不能当可信认证/迁移证明。**

### 5.4 启动旧 pending 审批，到底由哪个 Bot 发送“失效通知”？

`registerApprovalHandler` 建 `interactiveByChannel`（**当前进程本次启动**的 interactive adapters），启动扫描全部 `ap:` pending。若终态 `resolve(key,'expired')` durable 成功，逐旧 `pushedTo + hintTargets` 找 `interactiveByChannel.get(target.channel)`，调用 `inbound.sendText(target.chatId, staleNotice)`；**没有 target.accountId 与 inbound.accountId 检查，也不要求新 B 绑定了该旧成员**。因此**发送者是当前 active transport 所持凭据对应的 Bot B**，不是账本记录中旧 Bot A。`src/approval/router.mjs:L119-L137,L675-L714`。

必要前提：旧 `ap:` 行在启动时仍是 pending，尚未被启动先行 sweep 删掉；账本失效 durable 写成功；B 对应渠道 adapter 被注册；外发 API 能对该旧 chatId 发送。若 B 未启用或 provider 拒绝，实际不会送达；若能投递，属于有真实外部动作的旧状态复活。**注意：这条链只发失效提示，不会直接批准旧请求**；旧 waiter 消失和源约束仍是独立防线。安全迁移建议仅由已证实的原发送账号完成补发；否则内部记录 `notice_skipped_account_mismatch`，不要用新 Bot 代发。

## 六、关于 default、allowUsers 和“既不扩大授权也不误删偏好”的迁移判据

`default` 是**本地别名**而不是 Bot ID。首次 YAML `inbound.allowUsers` 被 `identity.migrate` 按启用渠道“播撒”到 default（**微信显式不在迁移列表中**），只写一次 `inbound:migrated`。之后移除 YAML 不撤销成员；移除成员不允许下一次从旧 YAML 自动复活。`src/index.mjs:L501-L521`; `src/inbound/identity.mjs:L310-L353`。所以无法仅凭 `default`、用户名/UID 形态或渠道“telegram”自动做 `default → <新 accountId>` 的安全迁移。

能安全自动迁移的**必要**条件同时包括：旧 state 所代表的实际 provider Bot/App 主体**有持久的可信证据**（不是本地随意填写的 default）；新凭据经可信平台校验为**完全相同的不可变主体**；旧 user/chat ID 对该主体仍在对应作用域内；不存在来源冲突/旧与新两个活动实例；操作通过 durable 且有 migration marker、可审计/幂等；所有待执行消息、临时授权、传输游标分别处理。这些条件在当前历史 default 表和 TG/WxPusher 实际记录里**普遍缺少第一项**，因此无法无条件自动迁移。**不能把“同一个用户好像在两个机器人里都存在”当成授权证明。**

相对可以安全保留：过去的 `ledger.jsonl/admin-audit.jsonl` 历史、已决/claimed 动作状态用于“不重放”、不敏感 `route:agents` 的静音/偏好、合法的 outbounds 配置来源记录，以及已按确认**同 Bot ID**绑定的游标。必须重新配对/重新选择：`inbound:bindings` 的 A→B 成员、所有 legacy default 无证据归属、旧 `inbound:pending`、`taskselect` 原文和附件、`bind` 会话、`ap:/aq:/act:` 待决交互、旧 provider 账号的通知 chat/UID。具体保留/撤销应由“安全语义”驱动，而非“一律清空”。

## 七、desired 与 active：保存配置不能伪装 transport 已切换

当前源码把 UI/管理台保存入站账号到 `<type>:account` 视为持久 **configured/desired**；`src/inbound/channel-config.mjs:L91-L110,L150-L207` 明确 `configured=true` 不能推出 `active=true`，`restartRequired=true`。只有 `src/assembly/inbound-channels.mjs:L69-L175` 在 `apply()` 创建/启动的 transport 实例才是 active，其 `accountId`、botToken/appSecret 绑定在构造阶段。`src/assembly/inbound-signals.mjs:L15-L123` 的 YAML/出站/store 源优先级可能导致用户改了一处却被高优先级旧凭据覆盖。旧 transport 停用/重启前，它仍可能轮询 A、推送 A、处理 A 的 callback，即便管理台已经显示 desired B。

应在报告层将状态最少分成 `desiredPrincipal`（存储声明）、`activePrincipal`（当前已启动 transport）、`verifiedProviderPrincipal`（平台可信核实，**目前部分渠道不可获得**）、`transportEpoch`（实际实例代际）、`configRevision`（落盘代际）、`draining/failed/restartPending`。当前提交的 runtime status 可以报告 active 与 restartPending，但未形成跨权限、游标、pending 和通知动作的全局迁移事务，因此**不能宣称这是已实现功能**。换账号建议在**旧实例仍 active 时不迁移权限**；旧实例停用确认以后再切新主体并重新配对，失败要保留分裂状态证据，不能用回滚 desired 配置去“证明”旧外发动作没发生。出站 hot-apply 与入站需重启是两条不同机制，不能混同。

## 八、已有测试覆盖与真正缺口（均仅阅读，未执行）

**已有覆盖，不能抹杀**：

- `test/identity.test.mjs:L309-L325` 检查显式 `accountId` 复合键不会给其他账号扩大准入；`L69-L85` 测一次性 YAML 迁移防旧人复活；`L253-L268` 测 pending/绑定事务失败。
- `test/target-guard.test.mjs:L128-L180` 覆盖“按渠道成员优先”“配置目标回退”，但该 fixture 正好将**跨 account 混合**固化为既有逻辑。
- `test/conversation.task-selection.test.mjs:L71-L150` 覆盖正常选择与一次投递，**未覆盖 A→B 同键旧 originalText+附件**。
- `test/inbound.telegram.test.mjs:L682-L718,L1010-L1097` 覆盖同 token/同 store offset 续读和持久写失败，**未覆盖两个不同 Bot 共用旧 offset**。
- `test/channels/wechat-ilink.test.mjs:L103-L178,L291-L314` 覆盖新 scoped cursor/context、会话过期清理，但**没贯通扫码 CLI default 身份 → 真实 accountId envelope 的 bus 权限**。
- `test/login-credential-durability-v013.test.mjs:L130-L163` 测微信登录成功/失败/部分绑定成功并断言提示，未证明该成员实际在对应 iLink account 下可发指令。
- `test/config-runtime-truth-v013.test.mjs:L40-L75` 承认 configured≠active、`L99-L150` 覆盖删除 transport 的运行时失败，但**没有账号 A→B 切换期间的状态迁移+回滚+外发隔离矩阵**。
- 审批/提问/Control Core 已有 account-bound source 和持久状态 winner 保护；**这些测试不能替代跨 credential/transport generation 切换场景**。

**建议补的独立静态/单元契约用例（本审查未执行）**：

1. `notifyTargets`：A/B 两张绑定（同 channel 不同 account）、A 旧 UID/B 新 UID，断言 B 不读取 A；覆盖 TG/QQ/飞书/钉钉/WxPusher/微信及 `extraTargets`（其中产品“仅私聊”应收紧群目标）。
2. WeChat：`applyWechatConfirmation` 写入 `wechat:account` 后构造真实 facade，检查 `{channel:'wechat',accountId:ilink_bot_id,userId:ilink_user_id}` 的准入（预期现状 fail），再验证无权陌生人 fail。
3. WxPusher：显式 `accountId=B` 的 `app_subscribe` 学习→admin confirm→B 上行验证，防 pending 错归 default；更换 appToken/appID 后历史 UID 不自动授权。
4. Telegram：同 Bot token 更新/不同 Bot token 切换分别模拟可信 bot ID，检查 offset 的继承/隔离、dedup 交叉消息 ID、不错误确认新 Bot 的事件；不调用真实 API。
5. DingTalk：A 机器人先学习 `robotCode=A` 再改 `appKey=B` 重建尚未收首消息时，断言禁止带 A code 主动推送。
6. `taskselect`：旧 A 卡含正文、图片/附件元数据，B 相同 userId/chatId 且已合法配对时，`/use` 与数字两条路径**都不能**消费 A 原消息；覆盖 TTL 清扫边界、同 SID 存活、durable 删失败、Control Core 不同 policy。
7. 审批启动扫描：旧 `pushedTo` 带 A accountId、B 当前 transport 同 channel，标记过期但**禁止 B sendText**；另测 legacy target 缺 accountId 时安全隔离、失效持久化失败不外发。
8. Route/bind：同 userId 在 A/B 中完成授权各自进入不同 session；重新启动与旧 bind migrate 不重建对 B 的暗路由。
9. 删除重加、desired 已保存但 A active、transport start 失败、YAML 优先于新 store 值、旧 outbounds hot-apply 等组合；断言实际发送账号、权限凭据及状态迁移 marker 一致。
10. 配对码待核销遇换号，确保旧全局配对码不因 B 启用而自动成为 B 的跨账号授权；落盘失败/回滚时不制造“迁移完成”假回执。

## 九、迁移建议的最小可实现合同（仅设计判断，不是已落地）

以**verified provider principal**作为唯一“同一机器人”权威：Telegram `getMe.id`（未来授权运行时校验，不是本审查调用）、飞书 `appId`、QQ `appId`、钉钉 `appKey`、微信可信登录确认的 `ilink_bot_id`、WxPusher 可信 appId；不能用凭据原文、local default、userId 或保存表单顺序代替。与**本地 accountId（可改别名）**分别记录。将每条权限绑定附到 verified principal 和用户作用域，不从 source data 直接自报 accountId。

迁移只允许以下三类结果，三者均有 durable 记录：**CONTINUE_SAME_PRINCIPAL**（证据充分，仅适用状态保留/更新密钥）、**NEW_PRINCIPAL_REQUIRE_REPAIR**（不复制旧授权，重新配对/选会话/收通知目标/新建游标）、**UNKNOWN_QUARANTINE**（不按假定迁移；只保存旧 state 的只读快照供人工判断）。优先处理 active old → quiesced old → verified new → policies re-established；不要把 `save desired` 当作这一流程完成。待执行动作应 durable cancel/uncertain 并保留副作用账本；历史和业务偏好留存而不变成权限；每阶段遇持久化失败停在可诊断状态，不允许偷偷回退后继续从不明身份发送。

## 十、可核验源码入口与公开规范索引

所有源码路径基于固定树：`https://github.com/THEWOLFWALKER/dsh-notifier/tree/9d69dd7a8908fcfec6e20d92d56509764a8f23ec`。下面链接直接锁定 commit 和行号，便于主 Agent 复审：

- [identity 默认/显式复合键与权限](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/identity.mjs#L49-L95)；[identity `list/migrate`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/identity.mjs#L262-L353)；[pending](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/identity.mjs#L409-L506)。
- [notifyTargets 账号未过滤](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/target-guard.mjs#L128-L190)；[bus 复合准入与去重](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/bus.mjs#L80-L129)。
- [微信 CLI 登录绑定 default](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/scripts/wechat-login.mjs#L68-L101)；[微信 runtime 原账号 envelope](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/channels/wechat-ilink/legacy-core.mjs#L258-L282)；[微信新 provider 分片](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/channels/wechat-ilink/index.mjs#L37-L55)。
- [TG offset 全局键](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/telegram-bot.mjs#L299-L324)；[TG local account](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/channels/telegram/index.mjs#L30-L53)；[飞书 config resolver 不透传 accountId](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/feishu-bot.mjs#L77-L104)。
- [taskselect 原消息缓存/领取](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/routing/task-selection.mjs#L148-L317)；[对话选择与投递](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs#L643-L701)。
- [审批重启僵尸告知](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/approval/router.mjs#L675-L714)；[动作 claim 前落盘](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/actions.mjs#L225-L297)；[交互持久状态机](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/interaction/ledger.mjs#L65-L185)。
- [钉钉旧 robotCode](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/dingtalk-stream.mjs#L233-L240)；[WxPusher default pending](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/wxpusher-callback.mjs#L205-L230)；[入站 desired/active 语义](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/channel-config.mjs#L91-L110)。

**未解决的外部事实**：实际运行时各渠道 server 返回的 Bot 身份、WxPusher UID 在跨应用订阅状态、iLink 官方关于 `ilink_bot_id` 与 user ID 的长期稳定保证、真实应用权限/主动推送规则，均未登录或调用渠道，不能由静态测试替代。需要动态验证时应另行授权，由其他 Agent 实施；本报告所有“缺口”不是运行失败记录。
