# dsh-notifier 异步生命周期专项静态审查

> **审查日期：** 2026-10-31  
> **项目：** `THEWOLFWALKER/dsh-notifier`  
> **固定提交：** `main@9d69dd7a8908fcfec6e20d92d56509764a8f23ec`  
> **宿主对照：** `deepseek-ai/deepseek-harness` 的 `dsh-v0.2.1-rc.2`、`dsh-v0.2.1-rc.3`  
> **固定依赖：** `@larksuiteoapi/node-sdk@1.73.0`  
> **范围：** 只读静态控制流、生命周期及资源所有权审查；忽略 notifier dev、重写分支。  
> **执行声明：** 未运行代码、测试、fake timer、探针、故障注入、宿主或 provider API；未安装依赖、登录账户、发送消息或修改本地/远端项目状态。

## 阅读说明与证据等级

本文中的 `src/...` 均指向上述 notifier 固定提交；DSH 的 `vendor/...`、`packages/...` 均指向两个指定标签。**文件路径及行号是定位依据；事件顺序是静态可允许序列，不是动态复现记录。**

- **A｜确定缺少生命周期保护：** 控制流中明确缺少停止状态检查、generation/fencing、取消传播或 drain。
- **B｜有前提的可达副作用：** 源码允许给定的 await/回调交错；真实发生仍需要请求正常完成、SDK 回调到达、Agent 仍可调用等条件。
- **C｜外部保证未证实：** 必须核查固定 SDK、Node 或宿主的额外语义，不能从单一项目源码直接断言运行结果。

审查结论必须区分：**卸载请求开始**、**某组件的 stop 已返回**、**整个插件的 dispose Promise 已完成**；也必须区分 **同实例迟到副作用**、**跨新实例副作用**、**跨进程持久状态复用**。

## 一、执行摘要

整体判断：`main@9d69dd7` 已经具备许多实际有效的局部保护，例如 Bus waiter 释放、卡片终态补偿、Store durable-first、部分 transport 的 stop/connection fencing、通知 in-flight flush 以及 Cordis 的异步 disposer 支持；但**没有建立全插件范围的“先撤销新业务准入—停止生产者—结算/取消在途工作—受控 flush—释放状态”的生命周期屏障**。

| 主要结论 | 证据等级 | 关键源码 |
| --- | --- | --- |
| `disposeAll()` 调用并等待异步清理，却不对组件之间建立 stop-before-drain 顺序 | A | `src/assembly/lifecycle.mjs:14-22` |
| `bus.dispose()` 清 waiter/handler 后，`bus.accept()` 仍可执行身份命令与去重 Store 写入 | A；生产者到达为 B | `src/inbound/bus.mjs:193-249,384-395` |
| Telegram 在 `stop()` **开始之后、完成之前**，可能处理正常返回的 `getUpdates`，包括回执与 offset 持久化 | A/B | `src/inbound/telegram-bot.mjs:267-295,298-362` |
| 微信 iLink 的正常返回路径同样缺少停止后二次检查 | A/B | `src/channels/wechat-ilink/legacy-core.mjs:311-355,459-466` |
| 原生问题没有把宿主 `request.signal` 传入手机桥；内部 GUI-first abort 不等价于宿主取消 | A | `src/host/native-questions.mjs:88-115,168-200` |
| Conversation 下载附件后未再次核验插件与 Agent 的执行权，仍可能提交消息 | A/B | `src/inbound/conversation.mjs:827-880,888-906` |
| DSH Fiber **能等待** async dispose，但部分 Loader/Registry 调用不等待，不能推出所有旧/新实例绝无重叠 | A/B | DSH `vendor/cordis/src/fiber.ts:265-296,675-696`；`vendor/loader/src/config/entry.ts:135-155` |

**两个必须避免的误判：**

1. 不能笼统断言“DSH 不等待插件的异步 dispose”。Cordis Fiber 的 `_unload()` 明确等待自己的 disposer；问题在于上层调用者是否 await，以及 notifier 内部的组件清理缺少依赖顺序。
2. 不能笼统断言“Telegram stop 已经返回后仍在处理 getUpdates”。当前 `stop()` 等待 `loopPromise`；可达窗口在 **stop 已发起、循环尚未退出** 期间。

## 二、资源归属与停止顺序表

### 2.1 资源所有权清单

| 资源 | 创建者 / 所有者 | 停止及释放 | 是否等待工作结束 | 生命周期判断 |
| --- | --- | --- | --- | --- |
| 宿主 `session/event`、`agent/error`、`agent/disposed` 监听 | `createEventListener` | disposer 注销 | 注销同步；通知 flush 异步等待 | 阻止新监听分发，但不能撤销既发通知 |
| turn debounce timer | `createTrailingDebounce` | `flush()` 主动执行待发任务并清 timer | 等待返回的推送 Promise | 卸载时属于**主动触发**，不只是取消 |
| grace timer | `createGraceQueue` | `flush()` 主动执行 | 等待任务返回值 | 与 debounce 相同 |
| 心跳、stall timer | `turn-tracker` | `tracker.dispose()` 清 timer | timer 清理同步 | 无法撤回已经发起的通知 |
| 审批升级 timer | `createEscalationChain` | `stop()` / `dispose()` 清 timer | 不等待已启动的 `notifyAll` | timer 与发送不是一个资源 |
| 审批 waiter/resolver | `bus.wait` | 裁决、超时、abandon、`bus.dispose` | waiter Promise 可结束 | handler 仍可能继续执行终态和 `next()` |
| 提问 waiter/resolver | `bus.wait` | 同上 | waiter Promise 可结束 | 业务终态由 question router 另行管理 |
| Telegram 长轮询 | `createTelegramInbound` | `running=false`，等待 `loopPromise` | 是 | stop 开始后正常返回 batch 仍可处理 |
| 微信 iLink 长轮询 | `legacy-core` | abort 当前请求，等待循环 | 是 | 正常返回路径仍有停止窗口 |
| QQ WebSocket | `createQqInbound` | 停止标记、timer 清理、socket close | 等待 startup；不统一 drain 业务回调 | connection-level 校验与业务授权不等价 |
| DingTalk WebSocket | `createDingtalkInbound` | 同上 | 同上 | 已有连接身份校验，仍有在途发送 |
| 飞书 SDK WS | `createFeishuInbound` | SDK `close/stop`，超时尝试 terminate | 有时限等待 | SDK 1.73.0 回调结束保证未完成源码级验证 |
| WxPusher HTTP callback | `startHttpCallback` | `server.close()`、`closeAllConnections()` | 等待 server close | 不主动取消已启动的发送 |
| Admin HTTP/SSE | `startAdminServer` | 关 server/连接；SSE 清 heartbeat、unsubscribe | 等待连接关闭 | 独立 API handler 未统一 drain |
| Fetch/HTTP | 各 adapter、transport | 单请求超时/AbortController | 依赖上层 | 请求超时不等于业务取消 |
| 附件下载与 admission | Conversation `deliver` | 无统一插件卸载取消入口 | `deliver()` 自己等待；卸载 disposer 不等待 | await 后继续 Agent 提交的路径可达 |
| 通知队列 / in-flight | `createNotifier` | `notifier.flush()` 取 Promise 集合快照 | 等待快照 | 未先禁止所有新发送生产者 |
| Native question bridge | `createNativeQuestionBridge` | 注销 provider/waterfall | 不等待所有 `hostAsk` / `next` | 停止订阅不等于在途问题结束 |
| 通用 Store 写入 | `inbound/store` 及使用者 | 同步事务、跨进程文件锁 | 不适用 | 保护事务，不验证插件实例 generation |
| Task selection 待决 | `task-selection` | `dispose()` 清内存 | 同步 | 磁盘状态依设计保留至 TTL，不应误称竞态 |
| Task projection | `task-projection` | 只读派生 | 不适用 | 不持久化，不是同一类写入竞态 |

主要证据：

- `src/event-listener.mjs:207-263,490-576`
- `src/rules.mjs:121-163`
- `src/status/turn-tracker.mjs:87-104,181-186`
- `src/approval/escalation.mjs:20-66`
- `src/inbound/bus.mjs:265-395`
- `src/notify.mjs:74-85`
- `src/routing/task-selection.mjs:235-248,277-316,358-361`
- `src/routing/task-projection.mjs:1-17`
- `src/admin/server.mjs:304-341,489-502`

### 2.2 `disposeAll` 的实际序列与依赖

根入口为 `src/index.mjs:979-982`：

```js
ctx.effect(() => () => disposeAll(disposers))
```

聚合器位于 `src/assembly/lifecycle.mjs:14-22`：

```js
export function disposeAll(disposers) {
  const cleanups = []
  for (const dispose of disposers ?? []) {
    try {
      const result = typeof dispose === 'function' ? dispose() : undefined
      if (result !== null && typeof result?.then === 'function') cleanups.push(result)
    } catch { /* best effort */ }
  }
  return Promise.allSettled(cleanups).then(() => undefined)
}
```

遍历时会**按数组顺序调用**清理函数，但并不等待某个异步清理完成再调用下一个。所有 Promise 在最后并行等待。因此不能把清理函数的调用顺序当成其完成顺序。

| 资源阶段（注册顺序概括） | 现有行为 | 未建立的先后关系 |
| --- | --- | --- |
| 早期订阅、sweep、会话注册表等 | 停订阅/清 timer/释放状态 | 此时入站通道尚未停止 |
| event listener | 立即 flush debounce/grace 并等待通知 | 业务生产者仍可能新增发送 |
| Control Core / Bus | dispose controller、resolver、handler | transport 尚未完成 stop |
| Actions / Channel Registry | 清业务控制与通道注册 | 与 in-flight callbacks 无统一 barrier |
| Inbound transports | 调用各 `stop()` 并收集 Promise | stop 已发起但各通道异步结束顺序不保证 |
| Approval / Questions | 注销回调与 timer | 先前运行的审批、推卡、hostAsk 未统一 drain |
| Conversation | 注销 Bus handler、清 merge timer | 已由 `fireAsync(route(...))` 启动的任务未统一等待 |
| Native/Admin/RPC | 注销入口、关闭 HTTP 等 | 未对所有 in-flight API handler 建立 generation gate |

注册证据：`src/index.mjs:291-308,343-407,490,580,601,636,640-704,740-760,847-860,973-982`。

**细节：** 同步遍历这段 JS 时不能任意插入异步网络回调；可达交错发生在清理返回 Promise 后未完成期间、先前已经启动的业务 Promise 复工期间，或异步 SDK 关闭尚未完成时。

## 三、逐条控制流结论

### R01｜Bus 已 dispose，`accept` 仍可写持久状态

**等级：A（缺口确定）/ B（需生产者到达）。**

`bus.dispose()` 将 `disposed=true`、结束 waiter 并清空 `messageHandlers`，但 `accept()` 没有读取 `disposed`：`src/inbound/bus.mjs:193-249,384-395`。

**事件序列：**

1. 某 transport 回调尚未结束，或停止过程中仍有回调可达。
2. 插件开始 `disposeAll()`。
3. `bus.dispose()` 已清空 waiter、handlers。
4. transport 的 stop Promise 尚未完成。
5. 回调调用 `bus.accept(envelope)`。
6. `accept()` 继续进行去重、身份判断，可能执行命令处理及 Store 写入。

**副作用条件：**

| 输入条件 | 关闭后可能发生的副作用 | 具体证据 |
| --- | --- | --- |
| 绑定用户普通消息 | `remember()` 将 dedup 记录写入 Store | `src/inbound/bus.mjs:125-131,217-218` |
| 注册面 `/pair`、`/unpair` 等命令 | 在原有身份和命令条件允许下修改配对、绑定状态 | `src/inbound/bus.mjs:201-215` |
| `/whoami` 等回执命令 | 生成响应，随后由 transport 尝试发送 | `src/inbound/bus.mjs:201-215` |
| 未绑定消息 | 内存 dedup、拒绝回执 | `src/inbound/bus.mjs:235-248` |

**现存防线：** 消息 handler 在 Bus dispose 后已清空，因此不能说“关闭后普通消息必然还能进入 Conversation”。受影响的是 `accept()` 自身仍持有的命令、身份与 Store 写入能力。

**transport 入口完整路径：**

| Transport | 生产者入口 → Bus 入口 | 源码 |
| --- | --- | --- |
| Telegram | `getUpdates → handleUpdate → bus.accept` | `src/inbound/telegram-bot.mjs:302-318,267-287` |
| Feishu | `WSClient EventDispatcher → handleMessage → bus.accept` | `src/inbound/feishu-bot.mjs:372-375,380-414` |
| QQ | `WebSocket message → handleFrame → bus.accept` | `src/inbound/qq-gw.mjs:613-620,443-449` |
| DingTalk | `WebSocket message → handleFrame → handleBotMessage → bus.accept` | `src/inbound/dingtalk-stream.mjs:471-475,392-401` |
| WxPusher | `HTTP request.end → onPayload → handlePayload → bus.accept` | `src/inbound/http-callback.mjs:75-95`; `src/inbound/wxpusher-callback.mjs:168-203` |
| 微信 iLink | `getUpdates → handleInboundMsg → bus.accept` | `src/channels/wechat-ilink/legacy-core.mjs:318-345,256-282` |

这些路径证明**生产者有入口**，不证明每个 provider 在**整个 stop 已完成后**仍必然调用回调。不同 transport 的停止窗口下文分别判断。

### R02｜Telegram stop 开始后，正常返回 batch 可继续处理并推进 offset

**等级：A/B。**

`src/inbound/telegram-bot.mjs:298-341`：

```js
while (running) {
  const updates = await api('getUpdates', ...)
  for (const update of updates ?? []) {
    await handleUpdate(update)
    setDurable(store, 'tg:offset', nextOffset)
  }
}
```

`stop()` 在 `src/inbound/telegram-bot.mjs:356-362` 仅设置 `running=false` 并等待 `loopPromise`。

**允许的事件顺序：**

1. 轮询已经进入 `await api('getUpdates')`。
2. `stop()` 设置 `running=false`。
3. 在途 `getUpdates` **正常返回**一批更新。
4. 从 await 后恢复后，没有再次判断 `running`。
5. 逐条执行 `handleUpdate()`，可能 `bus.accept`、发送回执。
6. 在 `await handleUpdate()` 之后仍有 `setDurable(store,'tg:offset',...)`。
7. 只有本批处理结束后才回到 `while(running)`，随后退出。

**现存防线：** 每次 Telegram API 请求带独立 `AbortController` 和超时（`src/inbound/telegram-bot.mjs:95-119`）；offset 使用 process-before-commit 且检查持久化成功（`:307-324`）；stop 等待循环 Promise（`:356-362`）。

**边界结论：** stop **开始后**处理和写 offset 可达；不能据此声称 stop Promise **已完成后**该轮询仍在执行。

### R03｜微信 iLink 正常返回 batch 缺少停止后二次检查

**等级：A/B；前提是长轮询正常返回。**

`stop()` 执行 `running=false`、abort `currentAbort` 并等待 `loopPromise`：`src/channels/wechat-ilink/legacy-core.mjs:459-466`。

但 `await client.getUpdates(...)` 正常返回后仍进入 batch 归一、`handleInboundMsg`、`sync_buf` Store 写入：`src/channels/wechat-ilink/legacy-core.mjs:311-355`。只有异常捕获分支在 `:356-362` 检查 `running`。

**允许的顺序：** stop 发出 abort → 请求在 abort 生效前已正常完成或客户端返回正常结果 → 旧循环继续处理 batch → `bus.accept` / context token 学习 / `sync_buf` 写入 → 循环最终退出。

现有 abort 是实在保护，但**不能取消已经正常完成、进入后续处理的工作**。

另有图片下载采用 `Promise.race` 和独立 controller，未被轮询 stop 明确 drain：`src/channels/wechat-ilink/legacy-core.mjs:212-238`。它作为 best-effort 辅助任务，超时结束不代表底层媒体适配器一定已经停止。

### R04｜附件 `await` 后未重新核验权限，旧实例可尝试 Agent 写动作

**等级：A/B。**

`src/inbound/conversation.mjs:827-880`：

```js
for (const item of parts) {
  const admitted = await admitAttachmentBlock(item, ...)
}
const payload = buildRemoteUserMessage(...)
agent.steer(payload)  // 或 agent.inject(payload) / agent.followup(payload)
```

图片下载及保存：`:890-895`；文件下载及保存：`:897-906`。

**允许的事件顺序：** 已准入消息启动 `deliver` → 附件下载/admission 等待 → 卸载，Conversation disposer 清 handler/merge timer → 附件 Promise 完成 → 旧 `deliver` 没有重新检查插件 generation/Agent instance → 调用此前捕获的 Agent 对象。

`fireAsync(route(...))` 只记录失败，不将 Promise 交给 disposer 等待：`src/inbound/conversation.mjs:176-178,950-960,1067-1077,1100-1101,1165-1172`。

**成立条件：** 附件异步处理在卸载前启动，并在其后完成；旧 Agent 对象仍允许调用。若 Agent 已失效，方法可能拒绝或抛错，因此不能静态证明最终消息进入新 Agent。

另一个 await 后边界：`routeUnsafe` 在 `await deliver(...)` 后还调用 `registryCall('touch', bound)` 和回复：`src/inbound/conversation.mjs:1003-1022`。

### R05｜任务选择 durable-first 并不自动撤销已取出的原消息

**等级：A/B。**

`taskSelection.resolve()` 先 durable 删除待决再交还原消息：`src/routing/task-selection.mjs:277-299`。这实际解决了“消费成功后重启又复活待决”的一类问题。

但调用链为 `resolve/take → selectAndDeliver → await deliver → Agent 提交/回执`：`src/inbound/conversation.mjs:655-669,676-693,965-972`。

**允许的顺序：** durable 消费原消息成功 → 开始附件等待 → 插件卸载或 Agent 变化 → 等待完成 → 旧业务尝试提交。

两个性质不同：

- *持久化至多消费一次待决*：已有保护。
- *消费后因插件卸载不再提交*：缺少统一生命周期授权检查。

`task-selection.dispose()` 仅清内存，持久待决保留由 TTL 管理：`src/routing/task-selection.mjs:358-361`。这是持久恢复设计，不应直接归为竞态。

### R06｜`notifier.flush` 只等待快照，没有禁止后续新发送

**等级：A/B。**

`src/notify.mjs:74-85`：

```js
const inFlight = new Set()
async function flush() {
  await Promise.allSettled([...inFlight])
}
```

**允许的顺序：** 在途业务尚未调用 `notifyAll` → event listener 清理触发 flush → `notifier.flush()` 捕获当前 in-flight 快照 → 另一未终止的审批/问题/会话业务新启动发送 → 新 Promise 不属于旧快照 → flush 先完成。

`src/event-listener.mjs:567-576` 会先触发 debounce/grace，再调用 notifier.flush，因此**不能**说它当场触发的全部正常通知必然漏等；问题在于整个插件没有“先禁止新的发送生产者”的边界。

公共 facade 存在 disposed 和 `await acquire()` 后二次检查：`src/public.mjs:231-252`，但这不能替代底层 notifier 的统一撤权。通知自己的 await 后 audit 位置见 `src/notify.mjs:98-123,176-204`。

## 四、审批专项：单独的保护和缺口

### 4.1 已有的实际防线

- 审批账本 durable 成功后才投递：`src/approval/router.mjs:551-563`。
- waiter 在发送之前注册：`:564-592`。
- 每张卡增量记录送达：`:328-378`。
- 已决可抑制后续文字广播：`:400-410`。
- 升级 timer 自带 chain 身份校验：`src/approval/escalation.mjs:40-49`。
- 审批等待完成后停止升级链：`src/approval/router.mjs:652-653`。
- 终态落盘失败标记 uncertain：`src/approval/router.mjs:176-200`。
- 启动扫描历史 pending：`src/approval/router.mjs:677-713`。

以上防线不能因为发现新缺口而忽略；但它们没有提供**所有 await 后的插件 generation 检查**。

### AP-1｜发送卡片等待返回后继续落账、向其他目标发送

**等级：A/B。**

`src/approval/router.mjs:328-411` 的逐目标循环在 `await inbound.sendApprovalCard` 后 `pushedTo.push`、`persistPushed`，失败时还可能 `await inbound.sendText`，之后广播 `notifyAll`。

**事件顺序：** 审批已立账且 waiter 已登记 → 第一个 `sendApprovalCard` 在途 → Agent dispose 或插件卸载导致 waiter 结束 → 在途发送返回成功 → 旧代码记录送达证据 → 继续其他目标/广播。

**现有防线：** `ledger.get(key)?.decision==='terminated'` 在**完整 `pushApproval` 之后**才检查（`src/approval/router.mjs:593-604`），可以控制后续决策，但不能阻止之前发送循环继续执行。

**产生副作用的条件：** 一个或多个发送 Promise 在业务终止后正常返回；仍存在后续投递目标或可写 Store。

### AP-2｜Bus waiter 关闭后，审批 handler 仍可进入 timeout/desktop fallback

**等级：A/B。**

`bus.dispose()` resolve waiter 为 `null`：`src/inbound/bus.mjs:384-395`。

`approval` handler 的 `await decisionPromise` 恢复后若 `decision===null`，执行 `finalizeApproval(...,'timeout')`、`markRemoteResolved(...)`，随后 `return next()`：`src/approval/router.mjs:652-667`。

**事件顺序：** 审批正在等待 → 插件卸载 → `bus.dispose` resolve(null) → 原 handler 恢复 → 持久化终态/编辑卡片/尝试桌面 fallback。

`bus.abandon(...,'agent/disposed')` 会触发 `onAbandon`（`src/inbound/bus.mjs:298-309`），但 `bus.dispose` 本身不会触发相同回调。这意味着 Agent 结束和插件卸载是不同结算路径。

**边界：** 可证明旧 handler 会尝试继续业务；宿主的 `next()` 是否真的还能完成桌面审批，还取决于该时刻的 waterfall 和 Agent 生命周期，不能直接当作已发生重复审批。

### AP-3｜并行审批手机先胜，桌面 `next()` 仍在运行

**等级：A（缺取消），B（实际效果）。**

显式 opt-in 的 `approvalConfig.parallel===true` 路径提前启动 `desktopAsk = Promise.resolve().then(() => next())`，随后与手机结果 race：`src/approval/router.mjs:610-636`。

手机先答后，结果可能先返回，但没有撤销已开始的 `desktopAsk`。`.catch()` 仅消除 unhandled rejection。

**结论：** “只返回一个赢家”并不意味着“两个执行分支均已终止”。不能因此断言必然重复批准。

### AP-4｜升级 timer 停止不等于在途提醒已取消

**等级：A/B。**

升级回调直接启动 `notifier.notifyAll(...).catch(...)`：`src/approval/router.mjs:639-650`；`escalation.stop()` 清理 timer，而非已启动的发送：`src/approval/escalation.mjs:20-25,54-65`。

**事件顺序：** 升级 timer 已触发并启动通知 → 裁决或卸载 → 清 timer → 发送仍可能完成。只有 timer 触发先于停止才构成该路径。

## 五、原生问题和手机桥专项

### 5.1 宿主本身提供了什么取消能力

DSH 两个指定标签的关键文件 Git blob 一致。`UserQuestionService.ask()` 在进入 waterfall 前检查 `request.signal.aborted`，并在异常分支识别取消：DSH `packages/interaction/user-questions/src/index.ts:287-338`。

`askTimed()` 创建 `TimedQuestionWait(Date.now()+timeoutMs, request.signal, ...)`：同文件 `:234-268`。`TimedQuestionWait` 对 parent abort 添加一次性监听，关闭时清除：DSH `packages/interaction/user-questions/src/timed-wait.ts:15-31,72-80`。

因此“宿主没有取消机制”不成立。

### NQ-1｜`request.signal` 未传入手机桥

**等级：A。**

notifier `hostAsk` 将请求交给：

```js
questionBridge.askQuestions(payload, {
  agent: request?.agent,
  ...(execOptions ?? {}),
})
```

源码：`src/host/native-questions.mjs:88-115`。

这里没有 `signal: request.signal`。waterfall 另创建只用于自己 race 的 controller：`src/host/native-questions.mjs:168-183`。

```text
宿主 request.signal ────(未直接传入)────> 手机桥
notifier 内部 controller.signal ────────> GUI 先胜时 abort 手机桥
```

**结论：** 内部 GUI-first abort 无法覆盖宿主主动取消、TimedQuestionWait 超时、Client disconnect 等所有原生请求取消路径。

### 5.2 原生问题五个终止分支

| 分支 | 可证明的当前行为 | 未证明 / 缺少的行为 |
| --- | --- | --- |
| GUI 先答 | waterfall 返回 GUI 答案后 abort 内部 controller；手机 `askQuestions` 收到该内部 signal | 在途 provider 发送是否都停止；所有已发卡片是否确实撤回 |
| 手机先答 | 手机结果先返回；下游 rejection 有 catch | 没有主动取消已开始的 GUI `next()`，无法证明 GUI 卡片自动消失 |
| 宿主取消 | 宿主 `UserQuestionService` 能处理 `request.signal` | notifier 未向手机桥传递该 signal，不能证明手机 waiter 立即结束 |
| Agent 结束 | `agent/disposed` 可触发 `bus.abandonByAgent` | 在途推卡、Native waterfall、其他业务 Promise 未统一等待 |
| 插件卸载 | waiter 被 resolve；native provider/waterfall 监听被注销 | nativeBridge 不等待所有 `hostAsk`，questionsBridge 不等待所有 `runPush` |

证据：`src/host/native-questions.mjs:168-200,296-302`；`src/event-listener.mjs:554-563`；`src/inbound/bus.mjs:298-320`；`src/questions/router.mjs:1156-1163`。

**手机先答的 GUI 孤卡限制：** 代码注释已经记录手机抢答后宿主 GUI 卡片未必自动收起：`src/host/native-questions.mjs:28-30`。这是已知限制，不能扩大成“所有客户端一定留下孤卡”的动态断言。

### NQ-2｜取消后，迟到推卡可能写送达证据并尝试补偿更新

**等级：A/B。**

手机推卡在发送前执行 `isCancelled()` 检查，但在 `await inbound.sendQuestionCard(...)` 返回后仍可能记录 `pushedTo` 和 `persistPushed()`：`src/questions/router.mjs:295-350`。

后台 `runPush()` 的 await 后继续读取/写入 ledger：`src/questions/router.mjs:1048-1069`。其 `deliverySettled` 分支会调用 `markResolved(...)` 做迟到卡片补偿。

**事件顺序：** 推卡前检查通过 → 等待 provider → GUI 先答触发内部 abort → 账本终结、waiter abandon → provider 迟到返回成功 → 记录/更新送达证据 → 尝试编辑已送卡片为真实终态。

**现存防线：** `deliverySettled` 限制后续新投递；迟到成功有 `markResolved` best-effort 纠正，不会刻意标错终态：`src/questions/router.mjs:995-1040,1048-1089`。

**不能证明：** “取消完成后所有 provider 卡片必定已经撤回”；provider API 不一定可撤销，补偿编辑也可能失败。

### NQ-3｜waiter 已 resolve 不等于原生问题业务已 drain

`bus.dispose()` 将等待结果置 `null`，question router 会继续走自己的终态处理，因此并非 waiter Promise 永远悬空。但 `questionsBridge.dispose` 只撤 listener、清升级 timer，`nativeBridge.dispose` 只撤 provider/监听，不等待以前启动的 `askQuestions`/`hostAsk`：`src/questions/router.mjs:1019-1040,1048-1089,1094-1163`；`src/host/native-questions.mjs:296-302`。

**精确判断：** “未决 resolver 能够结束”已有实现；“所有与该问题相关的异步请求、发送、GUI next 和远端卡片编辑都已完成”没有整体保证。

## 六、Transport 关闭保证逐一对账

### 6.1 Telegram：正常返回路径已确认缺口

- API 请求超时：`src/inbound/telegram-bot.mjs:95-119`。
- `handleUpdate`：`:267-295`。
- poll/offset：`:298-341`。
- `stop`：`:349-362`。

**结论：** stop 开始后、Promise 完成前仍可处理已返回更新；stop Promise 完成之后循环继续工作的断言不成立。

### 6.2 Feishu SDK 1.73.0：回调层没有 fencing；SDK 保证未核实闭合

- 固定依赖：`package.json:95`。
- SDK 装配和 EventDispatcher 注册：`src/inbound/feishu-bot.mjs:306-378`。
- `handleMessage → bus.accept`：`:380-425`。
- `handleCardAction`：`:579-615`。
- 关闭：`:725-736`。

`handleMessage` 和 `handleCardAction` 不统一检查 `running` / generation。因此**若** SDK 关闭时仍调用旧回调，旧实例可能继续进入 Bus/Control Core。`disposeWsClient()` 有 deadline 和 terminate fallback：`src/inbound/feishu-bot.mjs:316-342`，但不能直接推出 SDK 内部监听、重连和在途 callback 均终止。

**固定版本中断点：** 本轮没有取得与 npm 发布物 `@larksuiteoapi/node-sdk@1.73.0` 完全对应的 SDK 源码快照，不能逐行证明其 close/stop 对事件回调及内部重连 timer 的全部保证。此前报告提及上游 Issue #197 和 `1.73.1` 的修复说法；其与固定 **1.73.0 发布包**的逐行对应关系在本次审查中**尚未完成确认**，因此不将它当成确定的 runtime 路径证据。相关公开讨论入口：<https://github.com/larksuite/node-sdk/issues/197>。

### 6.3 QQ：旧连接 message 有身份检查，其他窗口不能混称

- `stopRequested` 与重连 timer：`src/inbound/qq-gw.mjs:276-293`。
- `connect()` 的 await 后 stop 检查：`:602-607`。
- WS open/message/close：`:609-627`。
- stop：`:721-750`。
- 入站回执发送：`:443-480`。

现存保护包括 `if(stopRequested) return`、`if(ws!==conn) return`。重连 timer callback 本身未在入口再次检查停止状态，但 `connect()` 会在 gateway URL 返回后检查，因此不能说“stop 后重连 timer 一定重新建连”。

QQ close 回调 `:621-625` 不像 message 回调那样做 `ws===conn` 检查；旧连接 close 若迟到，可能触碰当前连接清理。真实触发还取决于 WS 事件顺序和监听释放，属于 B，不能写为确定运行结果。

### 6.4 DingTalk：连接级校验比 QQ 更完整，业务在途仍需收口

- 重连状态/timer：`src/inbound/dingtalk-stream.mjs:246-268`。
- gateway await 后 stop 检查：`:457-463`。
- WS message/close identity check：`:465-482`。
- stop：`:596-620`。
- `bus.accept` / fire-and-forget `sendReply`：`:392-405`。

DingTalk 同时对 message 和 close 做 `ws===conn` 检查。它和 QQ 的旧连接竞态**不能等同**。仍有已启动处理器和回复发送未统一取消/等待的问题。

### 6.5 微信 iLink：abort 有效，但正常完成路径要单独判定

- 正常 poll batch/游标：`src/channels/wechat-ilink/legacy-core.mjs:311-355`。
- stop abort + join：`:459-466`。
- 辅助图片下载：`:212-238`。

其 stop 对异常退出有防线；问题在于正常完成路径没有在 await 后重查 `running`。

### 6.6 WxPusher HTTP callback：HTTP 408 不是业务取消

`src/inbound/http-callback.mjs:38-119` 在 body 完成后开启处理超时 timer，然后调用 `Promise.resolve(onPayload(...))`。超时只调用 `finish(408,...)`，并未向 `onPayload` 传 AbortSignal 或撤权。

**泛用 helper 可允许的顺序：** async handler 已开始 → 超时响应 408 → handler Promise 继续执行 → 其内部副作用后续完成。

**但当前 WxPusher handler 是同步函数**：`src/inbound/wxpusher-callback.mjs:168-242,270-285`。不能直接断言它同步主体在超时响应后还会异步延续。实际被它启动的 `pushToUid(...).catch(...)` fire-and-forget 工作并不随 HTTP 结束而同步终止：`:192-206`。`app_subscribe` 还可能写待确认绑定：`:210-230`。

### 6.7 Admin HTTP/SSE：连接关闭不等于业务 handler drain

- 异步读取和路由 handler：`src/admin/server.mjs:388-409`。
- stop 等待关闭 server/连接：`:489-502`。
- SSE 的 heartbeat、unsubscribe：`:304-341`。

异步 API handler 在卸载前进入、await 后恢复时，没有统一的插件 generation 检查。

具体的 await 后投影更新例子：`src/index.mjs:921-931` 的 `adminApi.testOutboundChannel` 在 `await runChannelTest(...)` 后调用 `surfaceHealth.recordTest`、`surfaceRevision.touch('health')`。能确认的是缺少撤权检查；不能在未进一步核对投影生命周期时断言 Native UI 一定显示过时结果。

## 七、DSH Loader：异步 dispose 与重叠激活的真实语义

### 7.1 两个指定宿主标签的关键文件一致

以下文件在 `dsh-v0.2.1-rc.2` 与 `dsh-v0.2.1-rc.3` 的 Git blob SHA 相同：

| 文件 | 两标签共用的 blob SHA |
| --- | --- |
| `vendor/cordis/src/fiber.ts` | `6bb1caa7a5c66c0129cbd88b94e6d9a01025b455` |
| `vendor/cordis/src/registry.ts` | `478cf036cb2339fcd6c092ee0cb6f2babc500014` |
| `vendor/loader/src/config/entry.ts` | `15b566257ad48973f20d4a03c2b3c41ac478f60a` |
| `vendor/loader/src/config/tree.ts` | `b75d641375b9717fb8108b49d02ac6131a8f8c6a` |
| `packages/interaction/user-questions/src/index.ts` | `06cb67b8b6a2bf0c9b44e78db3d87fa695ff5887` |
| `packages/interaction/user-questions/src/timed-wait.ts` | `cc43cd98af45340d68d7e176b4a278d8c5d9b40e` |
| `packages/boot/app-boot/src/index.ts` | `fded02c9c8273207d342a96fe0587c9d23c03512` |

只表示这些**已核验文件**一致，不代表两个标签整个仓库完全一致。

### 7.2 Fiber 支持等待 async disposer

`vendor/cordis/src/fiber.ts:265-296` 的 Fiber disposer 会等待 lifecycle inertia 收敛；`fiber.ts:675-696` 的 `_unload()` 内执行：

```ts
await Promise.all(this._disposables.clear().map(async (dispose) => {
  // ...
  await runDisposable(dispose)
}))
```

单个 effect 内部多个 disposer 会逆序处理：`fiber.ts:418-442`。但多个顶层 effect 在 Fiber `_unload()` 使用 `Promise.all`，不能假设所有顶层组件严格逆序逐个结束。

### 7.3 上层调用不一定 await

Registry 删除路径：`vendor/cordis/src/registry.ts:253-266`：

```ts
for (const fiber of runtime.fibers) {
  fiber.dispose()
}
```

Loader 禁用路径：`vendor/loader/src/config/entry.ts:135-138`：

```ts
if (this.disabled) {
  this.fiber?.dispose()
  return
}
```

相反，Loader tree 有显式 `await()` 等待 `_initTask` / `fiber.inertia`：`vendor/loader/src/config/tree.ts:35-49`；应用重组路径会调用 `await ctx.loader.await()`：`packages/boot/app-boot/src/index.ts:344-398`。

**结论矩阵：**

| 问题 | 静态结论 |
| --- | --- |
| DSH 有没有能力等待插件 async dispose？ | **有** |
| notifier 的 `disposeAll()` Promise 能否被 Fiber 等待？ | **能** |
| 每个 Loader/Registry 停止入口都显式 await？ | **不是** |
| 同一 Fiber 在依赖 epoch 变化时有没有 unload/reload 顺序控制？ | **有**，见 `fiber.ts:625-695` |
| 所有旧 Fiber 删除与新 Fiber 创建之间都保证完全无重叠？ | **不能证明** |
| 该部署下必然发生重叠？ | **也不能证明** |

注意区分 **同一个 Fiber 依赖重激活** 与 **旧 Fiber 删除后新建另一个 Fiber**：前者有 inertia 顺序管理；后者还受具体调用者是否 join 旧 disposer 影响。

## 八、三类不同的竞态后果

### 8.1 同一实例的卸载后副作用

这是本次证据最充分的一类：

- Telegram stop 已开始后的 `getUpdates` 处理/offset 写入；
- 微信 iLink 正常返回后 batch/游标写入；
- 审批/问题的迟到卡片发送、送达记录、终态回写；
- Conversation 附件下载后的旧 Agent 写动作；
- 已启动通知发送及其 audit；
- 已进入的 Admin 异步 handler。

有些操作在 stop **开始后**执行，但在 stop **结束前**完成；有些可能由更外层业务 Promise 延续至组件 disposer 完成后。应逐条按所属 Promise 判断，不能合并成“所有请求关闭后都会继续”。

### 8.2 跨新实例副作用

需要增加条件：旧任务保留了服务/Agent/Store 引用；新实例已开始使用相同资源；旧任务跨 await 后没有 generation/fencing；宿主仍允许旧对象的操作到达有效副作用入口。

示例：旧实例开始下载附件 → 旧实例卸载 → 新实例激活 → 旧下载返回 → 旧任务尝试写原 Agent/共享资源。

可以证明旧业务缺少 generation 检查，但不能仅由此断言新 Agent 一定收到旧消息、或新实例状态一定污染。

### 8.3 跨进程持久状态复用

Store 有跨进程锁和事务机制：`src/inbound/store.mjs:8-13,381-415`；任务选择可以保留待决至 TTL：`src/routing/task-selection.mjs:235-248,358-361`；审批启动时扫描旧 pending：`src/approval/router.mjs:677-713`。

这几种性质不同：

1. 按设计恢复持久状态；
2. 启动时使旧 pending 失效；
3. 两个进程同时写共享 Store；
4. 旧实例在丧失业务所有权后仍有写盘资格。

文件锁保护文件事务，不自动证明“写入者是当前合法 generation”。同样，没有静态证据证明所有跨进程场景都会发生状态覆盖或丢失。

## 九、最小生命周期规则建议（不写补丁、不整仓重写）

| 优先级 | 最小规则 | 覆盖的边界 |
| --- | --- | --- |
| P0 | 每个插件实例具备 `active → stopping → stopped` 状态和独立 generation | 基础撤权 |
| P0 | `bus.accept()` 在 stopping 后拒绝新业务，特别是持久化身份命令及 dedup 写入 | Bus 关闭后副作用 |
| P0 | 卸载按“停新接收 → 取消/结算业务 → drain → 允许的通知 flush → 释放状态”建立依赖顺序 | disposeAll 并行清理 |
| P0 | 跨 await 后、进入 Store 写入/Agent 提交/发送/游标推进/投影更新前，重验 owner 与 generation | 迟到工作 |
| P0 | 将宿主 `request.signal` 合并进原生手机桥取消链，并保证赢家结算时清理输家等待者 | 原生问题 |
| P1 | 审批和问题分别维护 in-flight 工作与终态规则 | 不拿一模块保护替代另一模块 |
| P1 | 每个 transport 分别声明“拒绝新回调、取消在途请求、等待在途业务”的 stop 语义 | WS/long-poll/HTTP |
| P1 | 通知 flush 前关闭生产者，仅等待明确允许完成的发送 | in-flight 快照竞态 |
| P1 | 旧 generation 的 Store/投影写入不得成为新实例的有效更新 | 跨实例副作用 |
| P2 | 无法取消的 SDK/HTTP 操作必须将结果标为未知，并避免伪称撤销或已确认送达 | 外部不可逆副作用 |

最重要的三条规则是：

**停止接收要先于业务清理。** Bus 已 dispose 但 transport 仍可准入不是完整停止。

**AbortController 不等于全部取消。** 只有被调用操作实际接受 signal，且不可取消工作恢复后仍重新核验执行权，才形成可验证边界。

**Promise drain 不等于业务撤权。** 即使 `stop()` 等到循环退出，也必须明确循环退出之前允许或禁止哪些写入。

## 十、发现与证据级别总表

| 编号 | 风险 | 判断 |
| --- | --- | --- |
| R01 | Bus 关闭后身份命令、dedup 仍可进入 | **A** 缺口；**B** 需回调到达 |
| R02 | Telegram stop 开始后正常返回更新仍推进 offset | **A/B** 明确可达 |
| R03 | 微信 iLink 正常返回 batch 绕过停止检查 | **A/B** 需正常完成 |
| R04 | 附件 await 后旧实例尝试 Agent 提交 | **A/B** 最终提交依赖 Agent 状态 |
| R05 | durable 任务选择后异步投递未撤权 | **A/B** 明确可达 |
| R06 | 通知 flush 未阻止新生产者 | **A/B** 明确可达 |
| AP-1 | 审批推卡 await 后继续发送与落账 | **A/B** 明确可达 |
| AP-2 | 审批 waiter 关闭后 handler 仍可终态处理和 `next()` | **A/B** 明确可达 |
| AP-3 | 手机先胜未取消并行桌面 `next()` | **A** 缺少取消；结果为 **B** |
| AP-4 | 停止升级 timer 不撤销在途通知 | **A/B** 需 timer 先触发 |
| NQ-1 | 宿主 `request.signal` 未传手机桥 | **A** 确定缺失 |
| NQ-2 | GUI 先答后迟到推卡可完成并补偿更新 | **A/B** 明确可达 |
| NQ-3 | waiter resolve 不等于完整问题业务 drain | **A** 确定缺少统一等待 |
| SDK-1 | 飞书 1.73.0 全部关闭和回调保证 | **C** 固定包源码核验未闭合 |
| SDK-2 | QQ/DingTalk 旧 WS 回调与重连时序 | **B/C** 有局部保护，需分别核实 |
| HTTP-1 | 通用 HTTP 408 后不取消 async handler | **A**；WxPusher 同步 handler 后果须收窄 |
| HOST-1 | “宿主完全不等待异步 dispose” | **不成立** |
| HOST-2 | “所有 Loader 路径均等待旧实例后才激活新实例” | **不能证明** |
| STATE-1 | 旧实例缺 generation 而拥有 Store 写入能力 | **A/B**；跨实例污染另需条件 |

## 十一、最终判断和待核验边界

**可以从源码确定：**

- `disposeAll` 没有跨组件的 stop-before-drain 顺序。
- `bus.accept` 不检查 Bus disposed 状态。
- Telegram、微信 iLink 正常返回分支在 await 后未立即重新核验停止状态。
- Native `request.signal` 未进入手机桥。
- 附件下载完成后提交 Agent 缺少实例/generation 检查。
- 审批、问题各自都有局部保护，但后台发送和 resolver 结算没有统一的业务 drain。
- DSH Fiber 支持等待 async disposer，部分上层 Loader/Registry 调用没有显式 await。

**不能从本次纯静态证据断言：**

- 任何列出的事件顺序已经在真实设备或生产环境复现。
- Telegram 的 `stop()` Promise **已返回**后，该轮询仍在处理更新。
- Feishu 固定 SDK 1.73.0 在所有关停条件下具体如何调度迟到回调、重连及心跳；尚缺发布包对应源码的闭环核验。
- 旧实例的 Agent 方法调用一定成功并作用于新 Agent。
- HTTP 超时等于 handler 必然在超时后修改持久状态。
- Store 跨进程事务设计必然造成写损坏。

**优先级最高的四项最小收口：** Bus 的关闭准入、Telegram/iLink 的 await 后 stop 检查、原生问题取消传播、Conversation 附件 await 后的 Agent 写入授权。审批则应独立收口“waiter 已结束但 handler/推卡仍继续”的控制流。

> **严格结论：** 本报告记录的是固定源码可允许的事件顺序、现存防线、缺失的生命周期授权及运行结果成立所需前提，**不代表动态复现，也不声称已经跑过任何测试**。

---

## 固定源码入口索引

为方便审核人员定位，以下链接固定在审查对象，不指向 notifier `dev`：

- [notifier 固定提交](https://github.com/THEWOLFWALKER/dsh-notifier/tree/9d69dd7a8908fcfec6e20d92d56509764a8f23ec)
- [插件装配与卸载 `src/index.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/index.mjs)
- [生命周期聚合 `src/assembly/lifecycle.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/assembly/lifecycle.mjs)
- [Bus `src/inbound/bus.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/bus.mjs)
- [审批 `src/approval/router.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/approval/router.mjs)
- [问题 `src/questions/router.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/questions/router.mjs)
- [Native bridge `src/host/native-questions.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/native-questions.mjs)
- [Conversation `src/inbound/conversation.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs)
- [通知 `src/notify.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/notify.mjs)
- [Telegram `src/inbound/telegram-bot.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/telegram-bot.mjs)
- [Feishu `src/inbound/feishu-bot.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/feishu-bot.mjs)
- [QQ `src/inbound/qq-gw.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/qq-gw.mjs)
- [DingTalk `src/inbound/dingtalk-stream.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/dingtalk-stream.mjs)
- [微信 iLink `src/channels/wechat-ilink/legacy-core.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/channels/wechat-ilink/legacy-core.mjs)
- [HTTP callback `src/inbound/http-callback.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/http-callback.mjs)
- [DSH rc.2 Fiber](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/vendor/cordis/src/fiber.ts)
- [DSH rc.3 Fiber](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/vendor/cordis/src/fiber.ts)
- [DSH rc.3 Loader Entry](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/vendor/loader/src/config/entry.ts)
- [DSH rc.3 UserQuestions](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/interaction/user-questions/src/index.ts)
