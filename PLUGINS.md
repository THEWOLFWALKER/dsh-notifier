# PLUGINS.md — 从你的插件调用 dsh-notifier

> dsh-notifier v0.6 起开放两条面:**出向** `ctx.notifier` 服务注入(推送)与**入向** `dsh-notifier/sent` 事件(订阅)。
> 本文档面向**消费方插件作者**。公共面版本:`0.6`(`ctx.notifier.version`,只在公共面 breaking 时 bump,与包版本不联动)。

## 30 秒上手

```js
// 你的插件 src/index.mjs
export const inject = ['notifier']

export function apply(ctx) {
  // 静态声明后，apply 执行时服务已就绪（宿主保证等待），直接取用
  ctx.notifier.push({ title: '📧 新邮件', content: '来自 x@y.z：周报初稿', level: 'active' }, { sourceName: 'my-email-plugin' })
    .then((result) => { if (!result.ok) ctx.logger.warn('推送失败', result.failed) })
}
```

## 服务获取：静态声明是唯一形态（真机验证定稿）

> 2026-08-16 真机验证（DSH 0.1.0-rc.6 / Node 24）裁定：宿主 cordis **只认静态 `inject` 声明**。以下两种曾被当作备选的写法在 rc.6 实测不可用。

| 写法 | 真机结论 | 说明 |
|---|---|---|
| ✅ 静态声明 `export const inject = ['notifier']` | **成立（唯一可用）** | apply 执行时服务已就绪；探针实测解析到 `version=0.6` 真服务 |
| ❌ 回调式 `ctx.inject(['notifier'], cb)` | **回调不触发** | API 存在但回调从未执行，等待分支挂死——不要用 |
| ❌ 探测式 `typeof ctx.notifier?.push === 'function'` | **直接抛错** | 未声明 inject 时访问服务属性被宿主拦截：`cannot get property "notifier" without inject` |

**静态声明为什么安全**：dsh-notifier v0.6 承诺任何形态下（含 `enabled: false`、零渠道、顶层禁用）都 `ctx.provide` 服务（禁用时为 no-op stub）——只要**装了** dsh-notifier，静态声明永远不会卡启动。反之**没装**它而静态声明，宿主会因等待服务而 pending（阻塞启动）——把 dsh-notifier 列为你插件的安装前置，并在文档写明。

**同理**：要注册工具就得声明 `inject: ['tools']`（rc.6 对 `ctx.tools` 同样要求静态声明，未声明访问即抛错）；`ctx.on`（事件订阅）不需要声明。

## push API

```js
const result = await notifier.push(message, options)
```

- `message: { title?, content?, level?, group? }`
  - `level`: `timeSensitive` / `active` / `passive`(缺省 `active`;非法值丢弃)
  - `title`/`content` 非字符串按空处理;**两者都空** → `skipped: ['(malformed)']`(不推送、不记账、不占限流名额)
  - 长度钳制:各 20000 码点,超出截断并 warn(防止超长文本引发分段风暴)
- `options: { sourceName?, channel? }`
  - `sourceName`: 来源标注(进账本与 sent 事件,便于审计与将来按源静默);缺省/非字符串 = `anonymous`(与其他匿名调用共享单个限流窗)
  - `channel`: 定向推送某渠道类型(如 `'telegram'`);省略则广播全部已配置渠道并走分级路由

**返回值(永不 reject——内部错误返回 `failed: [{ reason: 'internal' }]`,你不必写 try-catch)**:

```js
const result = { ok: true, delivered: ['telegram'], skipped: [], failed: [], source: { kind: 'plugin', name: 'my-email-plugin' } }
```

- `skipped` 常见值:`(malformed)` 双空 / `(disabled)` 服务关闭 / `(rate-limited)` 超额 / `(quiet)` 会话静音 / `(渠道名)` 定向未配置
- 定向推送(`channel` 有值)走单渠道路径:**不进账本、不发 sent 事件**,结果只看返回值

## 限流

每源独立滑动窗,默认 10 次/分钟(宿主可用 `public.limitPerMinutePerSource` 调整,0 = 不限)。超限返回 `skipped: ['(rate-limited)']`——**照记账、照发事件**(静音不等于没发生),你能感知到自己被限。

## 订阅 sent 事件

```js
ctx.on?.('dsh-notifier/sent', (record) => {
  // record: { time, message: {title, content, level, group}, ok, delivered[], skipped[], failed[], source }
  // source v0.6 仅 { kind: 'plugin', name } 一路;本插件自动推送线 v0.7 起逐步补齐
})
```

- payload **深冻结、视为只读**:改它会抛 `TypeError`;要改先自拷贝 `{ ...record }`
- 宿主未开启 `public.emit`(默认开)时不发射
- **监听器军规**:必须 O(1) 立即返回(emit 是同步调用,重活自查队列);**禁止在监听器里 push**(会引发循环推送,限流兜底但不该发生)

## flush(卸载前等待在途送达)

```js
export const inject = ['notifier']

export function apply(ctx) {
  const notifier = ctx.notifier // apply 时已就绪，直接捕获引用
  ctx.on?.('dispose', () => { notifier?.flush?.() })
}
```

flush 幂等,可重复调用。

## 三态语义(你拿到的是什么)

| 宿主状态 | 你拿到的 | push 行为 |
|---|---|---|
| 正常运行 | 完整 facade | 真实推送 |
| `public.enabled: false` / 顶层 `enabled: false` | no-op stub | `skipped: ['(disabled)']` |
| 零渠道配置 | 完整 facade | `ok: false` + 三空数组(诚实空投递,不进账本不发事件——真机验证与 `notify.mjs` 零渠道出口一致) |

## 版本与兼容

- **能力探测优先**:`typeof notifier?.push === 'function'`;不要做 `version === '0.6'` 相等比较(我们发 0.7 当天你的插件就会误报)
- `notifier.version` 仅用于展示/日志
- 公共面 breaking 变更才会 bump `version` 并在 CHANGELOG 置顶声明

## 完整示例(防御式配方)

```js
export const name = 'my-plugin'
export const inject = ['notifier']

export function apply(ctx) {
  const notifier = ctx.notifier
  const log = (...args) => { try { ctx.logger?.info?.(...args) } catch { /* 缺 logger 不致命 */ } }

  // 出向:推送(静态声明后直接取用;never-reject,不需要 .catch)
  notifier.push(
    { title: '⏰ 定时提醒', content: '该复盘了', level: 'timeSensitive' },
    { sourceName: 'my-plugin' },
  ).then((result) => log('推送结果', result.ok, result.delivered))

  // 入向:订阅广播结果(事件订阅不需要 inject 声明;只读 + O(1) + 禁 push)
  ctx.on?.('dsh-notifier/sent', (record) => {
    log('sent', record.source?.name ?? '(internal)', record.ok ? 'ok' : 'failed')
  })

  // 卸载:flush 在途送达
  ctx.on?.('dispose', () => { notifier?.flush?.() })
}
```

## 真机验证记录

- **2026-08-16 · DSH 0.1.0-rc.6(profile web,Node 24)**:特性 A/B 双确认——静态 inject 消费方解析到 `version=0.6` 真服务(非 stub);`dsh-notifier/sent` 事件跨插件可见(15/15,payload 形状完整);零渠道语义符合设计(`ok:false` 三空数组,不崩不阻塞)。同时裁定:回调式 `ctx.inject` 不触发、未声明访问服务属性直接抛错——本文档全部配方据此定稿为静态声明。安装注意:宿主用 pnpm 管理依赖时,手动覆盖 `node_modules/dsh-notifier` 会被回滚,升级请用 `dsh plugin add file:<路径>`。

## FAQ

**Q: 为什么不直接 `import dsh-notifier`?**
import 拿到的是构造器,你得自己解析配置、自建实例——配置两份、账本两份、限流各管各的。服务注入共享 dsh-notifier 的全部基础设施(渠道配置、路由、账本、限流、flush)。

**Q: 我的插件能收到自己 push 的 sent 事件吗?**
能(广播无过滤)。所以监听器里 push = 无限循环,军规禁止。

**Q: sourceName 可以随便填吗?**
会进通知账本供用户审计;建议用你的插件名。恶意伪造他人 sourceName 属进程内信任域问题(与 inject 同级),不做签名。
