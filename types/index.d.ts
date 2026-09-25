// dsh-notifier 公共面 TypeScript 契约。
//
// 用法（类型专用子路径，不是运行时入口）：
//
//   import type { NotifierFacade, NotifyMessage, PushResult } from 'dsh-notifier/types'
//
// 只声明**真实存在**的公共字段，逐项对照 `src/public.mjs` 与 `PLUGINS.md`：
//  - `public.mjs` 实际读取的 message 字段：`title` / `content` / `level` / `group`
//  - `public.mjs` 实际读取的 options 字段：`sourceName` / `channel`（内部 notify 选项不在此公开）
//  - `push` 的返回值形状来自 `src/public.mjs` 的每个出口分支
//  - `dsh-notifier/sent` 事件记录来自 `src/public.mjs` 的 `redactAuditRecord`（metadata-only）
//  - `dsh-notifier/testing` 的 fake 形状来自 `src/testing.mjs`
//
// 这是 type-only 子路径：根入口（`dsh-notifier`）是 DSH 插件契约本身（`{ name, inject, apply }`），
// 不在这里声明 root `"types"`，以免让人误以为类型覆盖整个包；请显式 `from 'dsh-notifier/types'`。

/** 通知分级；非法值由公共面丢弃并回落 `active`。 */
export type NotifyLevel = 'timeSensitive' | 'active' | 'passive'

/** `notifier.push()` 的消息体。`title`/`content` 非字符串按空处理，双空 → `skipped: ['(malformed)']`。 */
export interface NotifyMessage {
  title?: string
  content?: string
  level?: NotifyLevel
  group?: string
}

/** `notifier.push()` 的选项。`sourceName` 缺省/非字符串 = `anonymous`；`channel` 省略则广播。 */
export interface NotifyOptions {
  sourceName?: string
  channel?: string
}

/**
 * 已知的 `skipped` 标记；`(string & {})` 保留字面量自动补全，同时允许渠道名等自定义值。
 */
export type NotifySkip =
  | '(malformed)'
  | '(disabled)'
  | '(rate-limited)'
  | '(quiet)'
  | '(budget)'
  | '(busy)'
  | (string & {})

/** 推送来源标注。公共 facade 恒给出 `kind: 'plugin'`。 */
export interface NotifierSource {
  kind: 'plugin'
  name: string
}

/** 单条失败项：`channel`+`error` 来自渠道投递失败，`reason: 'internal'` 来自 never-reject 兜底。 */
export interface PushFailure {
  channel?: string
  error?: string
  reason?: string
}

/** `notifier.push()` 的返回值。永不 reject。 */
export interface PushResult {
  ok: boolean
  delivered: string[]
  skipped: NotifySkip[]
  failed: PushFailure[]
  source?: NotifierSource
}

/**
 * 注入到 `ctx.notifier` 的公共 facade。
 *
 * 注：公共 facade 运行时另有一个 `enabled()` 宿主诊断面，它不属类型契约——消费方按
 * 能力探测（`typeof notifier?.push === 'function'`）而不是版本或 `enabled()` 判断可用性；
 * `dsh-notifier/testing` 的 fake 同样不提供 `enabled()`。
 */
export interface NotifierFacade {
  readonly version: '0.7'
  push(message: NotifyMessage, options?: NotifyOptions): Promise<PushResult>
  flush(): Promise<void>
}

/** `dsh-notifier/sent` 事件里的脱敏失败项（不含适配器错误正文）。 */
export interface SentEventFailure {
  channel: string
  error: string
}

/**
 * `dsh-notifier/sent` 事件的记录：**metadata-only**。
 * 刻意不含 `title` / `content` / `message` / 原始错误正文——只有长度与字节数。
 */
export interface SentEventRecord {
  time: string
  ok: boolean
  delivered: string[]
  skipped: NotifySkip[]
  failed: SentEventFailure[]
  titleLength: number
  contentLength: number
  titleBytes: number
  contentBytes: number
  hasContent: boolean
  source?: NotifierSource
  channel?: string
}

/** `dsh-notifier/testing` 的失败分支回放值。 */
export type FakeSimulation = 'rate-limited' | 'disabled' | 'budget' | 'busy'

/** `dsh-notifier/testing` 的 push 选项；在公共选项上追加 `simulate`。 */
export interface FakeNotifyOptions extends NotifyOptions {
  simulate?: FakeSimulation
}

/** `fake.calls` 的一条记录（读取即深拷贝，改它不影响 fake 内部）。 */
export interface FakeNotifierCall {
  message: NotifyMessage
  options: FakeNotifyOptions
  at: number
}

/**
 * `createFakeNotifier()` 的返回值：公共 facade 形状 + 只读调用记录。
 * `push` 的消息与选项放宽为可选，并接受 `FakeNotifyOptions`（含 `simulate`）。
 */
export interface FakeNotifier extends NotifierFacade {
  readonly calls: readonly FakeNotifierCall[]
  push(message?: NotifyMessage, options?: FakeNotifyOptions): Promise<PushResult>
}