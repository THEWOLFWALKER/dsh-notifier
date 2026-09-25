# Consumer demo — 从另一个插件调用 dsh-notifier

最小消费方插件示例：`examples/` 目录**不随 npm 包发布**，仅作接入参考。完整公共契约见仓库根的 [PLUGINS.md](../../PLUGINS.md)。

## 1. 安装 dsh-notifier

把 dsh-notifier 列为你的插件安装前置（服务和限流/账本/flush 都由它提供）：

```bash
dsh plugin add dsh-notifier
```

## 2. 获取服务：静态 `inject` 是唯一形态

```js
// src/index.mjs
export const inject = ['notifier']

export function apply(ctx) {
  // 静态声明后，apply 执行时 ctx.notifier 已就绪，直接取用。
  const notifier = ctx.notifier
}
```

回调式 `ctx.inject(['notifier'], cb)` 与未声明直接访问 `ctx.notifier` 在真机均不可用——见 PLUGINS.md「服务获取」。

## 3. push 推送

```js
void notifier.push(
  { title: 'Consumer demo', content: 'Hello from another plugin.' },
  { sourceName: 'consumer-demo' }, // 进账本与 sent 事件，便于审计
).then((result) => {
  if (!result.ok) ctx.logger?.warn?.('push failed', result.failed)
})
```

`push` **永不 reject**；返回 `{ ok, delivered, skipped, failed, source }`。`skipped` 常见值 `(malformed)` / `(disabled)` / `(rate-limited)` / `(quiet)`。

## 4. 订阅 `sent`：metadata-only

```js
ctx.on?.('dsh-notifier/sent', (record) => {
  // record: { time, ok, delivered, skipped, failed, source, channel,
  //   titleLength, contentLength, titleBytes, contentBytes, hasContent }
  // 只有长度与字节数——永久不含 title/content/审批文本/原始错误正文。
})
```

**军规**：监听器必须 O(1) 立即返回；**禁止在 `sent` handler 里再次 push**——会形成通知回环（限流兜底但不该发生）。

## 5. 单测：`dsh-notifier/testing`

消费方单测不必手写 stub：

```js
import { createFakeNotifier } from 'dsh-notifier/testing'

const fake = createFakeNotifier({ sourceName: 'consumer-demo', now: () => 0 })
const result = await fake.push({ title: 'T', content: 'C' }, { sourceName: 'consumer-demo' })
// fake.version === '0.7'，fake.calls 为只读深拷贝
```

fake `push` 同样永不 reject；`options.simulate: 'rate-limited' | 'disabled' | 'budget' | 'busy'` 可回放失败分支。

## 6. 类型：`dsh-notifier/types`

用 TypeScript 写插件时，类型从 type-only 子路径取：

```ts
import type { NotifierFacade, NotifyMessage, PushResult } from 'dsh-notifier/types'
```

`SentEventRecord` 同样是 metadata-only 类型（无 `title`/`content`）。入口刻意不设 root `"types"`，请始终 `from 'dsh-notifier/types'`。