// dsh-notifier tool-register.mjs
// agent 主动调用触发线：注册 notify 工具，让模型自己决定推送时机与渠道。
// compileParameters DSL 模式照搬 dsh-dingtalk：作者 DSL -> 原生 JSON Schema（wire 请求逐字携带）。

import { CHANNEL_TYPES } from './config.mjs'
import { TEST_MESSAGE } from './health.mjs'
import { workspaceOf } from './routing/session-registry.mjs'

/**
 * 滑动窗口限流器（阶段 6）：防 prompt injection 把用户渠道刷成垃圾出口。
 * @param {object} [options]
 * @param {number} [options.limitPerMinute=10] - 每分钟调用上限；0 = 不限。
 * @param {() => number} [options.now] - 可注入时钟（测试用）。
 */
export function createRateLimiter({ limitPerMinute = 10, now = Date.now } = {}) {
  const limit = Math.max(0, Math.trunc(limitPerMinute))
  const hits = []
  return {
    /** 未超限返回 true 并记录本次；超限返回 false（不记录）。 */
    allow() {
      if (limit === 0) return true
      const current = now()
      while (hits.length > 0 && current - hits[0] >= 60000) hits.shift()
      if (hits.length >= limit) return false
      hits.push(current)
      return true
    },
    used() {
      return hits.length
    },
    get limit() {
      return limit
    },
  }
}

/** 把作者 DSL 编译成原生 JSON Schema（defineTool 的 parameters 必须如此）。 */
export function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(spec)) {
    if (prop?.required === true) required.push(key)
    const node = {}
    if (typeof prop?.type === 'string') node.type = prop.type
    if (typeof prop?.description === 'string') node.description = prop.description
    properties[key] = node
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

const notifySchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    channel: { type: 'string' },
    delivered: { type: 'array', items: { type: 'string' } },
    failed: {
      type: 'array',
      items: { type: 'object', properties: { channel: { type: 'string' }, error: { type: 'string' } } },
    },
    skipped: { type: 'boolean' },
  },
  additionalProperties: true,
}

const oneText = (text) => [{ type: 'text', text }]

function renderNotify(value) {
  if (value.rateLimited === true) {
    return oneText(`已限流：notify 工具每分钟调用已达上限（防提示注入刷渠道，上限 ${value.rateLimit ?? ''} 次/分钟）。请稍后再试，或让用户调高 toolRateLimitPerMinute 配置。`)
  }
  if (value.skipped === true) {
    return oneText(`未发送：渠道 "${value.channel ?? ''}" 未配置。已配置渠道类型：${CHANNEL_TYPES.join('/')}。可在 profile 的 cordis.patch.yml 中为 dsh-notifier 添加对应 channels 后重启。`)
  }
  if (value.delivered !== undefined && value.delivered.length > 0) {
    const failText = value.failed.length > 0
      ? `；失败渠道：${value.failed.map((item) => `${item.channel}（${item.error}）`).join('、')}`
      : ''
    return oneText(`通知已发送${value.channel ? `到渠道 "${value.channel}"` : `（${value.delivered.join('、')}）`}${failText}`)
  }
  if (value.failed !== undefined && value.failed.length > 0) {
    return oneText(`通知发送失败：${value.failed.map((item) => `${item.channel}（${item.error}）`).join('、')}`)
  }
  return oneText('通知未发送')
}

/**
 * 注册 notify 工具。
 * @param ctx - cordis 上下文（ctx.tools）。
 * @param notifier - createNotifier 返回的 { notify, notifyAll, channelCount }。
 * @param {object} [options]
 * @param {number} [options.rateLimitPerMinute=10] - 每分钟调用上限（0 = 不限）。
 * @param {object} [options.router] - v0.3.2 agent 路由引擎（可空，向后兼容）：执行上下文
 *   能取到 agentId 且广播（未指定 channel）时，按该 agent 的绑定通道集合分流（设计稿 §8-5）；
 *   缺省 / 取不到 agentId / 解析异常 = 全局池广播（v0.3.1 行为不变）。
 * @param {() => string[]} [options.channelTypes] - 全局已启用渠道类型快照函数
 *   （resolveOutbound 的兜底池与过滤白名单）；缺省回落 notifier.channels。
 */
export function registerNotifyTool(ctx, notifier, options = {}) {
  if (ctx?.tools?.register === undefined) {
    // 宿主没有 tools 服务时静默跳过工具注册，绝不弄崩启动
    return null
  }
  const limiter = createRateLimiter({ limitPerMinute: options.rateLimitPerMinute ?? 10 })
  const router = options.router ?? null
  const globalChannelTypes = typeof options.channelTypes === 'function' ? options.channelTypes : null

  return ctx.tools.register({
    name: 'notify',
    description: `发送一条通知到用户配置的推送渠道（${CHANNEL_TYPES.join('/')}）。适合任务完成、长时间运行结束、需要用户关注或决策时主动提醒用户。channel 省略时广播到所有已配置渠道；message 为正文，title 为标题。未配置的渠道会静默跳过并在返回里说明。`,
    parameters: compileParameters({
      message: { type: 'string', required: true, description: '通知正文（markdown / 纯文本均可）' },
      title: { type: 'string', description: '通知标题（默认空，各渠道自行兜底）' },
      channel: { type: 'string', description: `目标渠道类型：${CHANNEL_TYPES.join('/')}；省略则广播到所有已配置渠道` },
    }),
    output: {
      schema: notifySchema,
      render: (_args, value) => renderNotify(value),
    },
    async execute(rawArgs, execContext) {
      const args = rawArgs ?? {}
      if (typeof args.message !== 'string' || args.message.trim() === '') {
        throw new Error('message 不能为空')
      }
      if (!limiter.allow()) {
        return { ok: false, rateLimited: true, rateLimit: limiter.limit, delivered: [], failed: [] }
      }
      const message = { title: typeof args.title === 'string' ? args.title : '', content: args.message }
      if (notifier.channelCount === 0) {
        return { ok: false, skipped: true, channel: args.channel, delivered: [], failed: [] }
      }
      if (typeof args.channel === 'string' && args.channel.trim() !== '') {
        // 单渠道路径不分流：agent 已显式点名渠道，路由过滤只会添乱（v0.3.1 行为原样保留）
        const result = await notifier.notify(args.channel.trim(), message)
        if (result.skipped === true) {
          return { ok: false, skipped: true, channel: result.channel, delivered: [], failed: [] }
        }
        if (result.ok) {
          return { ok: true, channel: result.channel, delivered: [result.channel], failed: [] }
        }
        return { ok: false, channel: result.channel, delivered: [], failed: [{ channel: result.channel, error: result.error?.message ?? String(result.error) }] }
      }
      // v0.3.2 广播分流（设计稿 §8-5）：工具执行上下文能取到 agentId 且注入了 router 时，
      // 广播按该 agent 的绑定通道集合过滤。agentId 三级防御兜底——宿主工具调用上下文
      // 形态不一（agent 裸对象 / { session } 包裹 / 直接给 session），全取不到则不分流。
      // 注意：quiet 永不作用于本工具——这是 agent 显式要求推送，静音（quiet）只管事件
      // 自动推送（event-listener）；把 quiet 带进来会让「agent 主动喊人」被无声吞掉。
      // 任何解析异常一律回落无过滤广播（全局池，向后兼容，绝不弄崩工具调用）。
      const agentId = execContext?.agent?.id ?? execContext?.agent?.session?.id ?? execContext?.session?.id ?? null
      let sendOptions = undefined
      if (agentId !== null && String(agentId) !== '' && router !== null) {
        try {
          const globalTypes = globalChannelTypes !== null
            ? globalChannelTypes()
            : (Array.isArray(notifier?.channels) ? notifier.channels : [])
          const resolved = router.resolveOutbound(
            String(agentId),
            workspaceOf(execContext?.agent ?? execContext?.session ?? {}),
            Array.isArray(globalTypes) ? globalTypes : [],
          )
          sendOptions = { channelTypes: resolved.channelTypes }
        } catch { /* 解析异常回落全局广播 */ }
      }
      // v0.7 候选：广播补 tool 来源（record 带 kind:'tool'）。v0.6 缓发——工具分流的
      // 存量测试对第二参做全形状断言，与「673 断言一条不改」军规冲突（同 event 线裁定）。
      const broadcast = sendOptions === undefined
        ? await notifier.notifyAll(message)
        : await notifier.notifyAll(message, sendOptions)
      return {
        ok: broadcast.failed.length === 0,
        delivered: broadcast.delivered,
        failed: broadcast.failed.map((item) => ({ channel: item.channel, error: item.error })),
      }
    },
  })
}

/**
 * 注册 notify_test 工具（阶段 6 健康自检）：发一条测试通知验证渠道配置。
 * 与 notify 工具的区别：固定内容、不改用户语义、结果渲染面向「配置排障」。
 * 同样受滑动窗口限流（独立计数）：测试消息也是真实推送，不能成为绕过 notify 限流的刷渠道后门。
 * @param ctx - cordis 上下文（ctx.tools）。
 * @param notifier - createNotifier 返回的 { notify, notifyAll, channelCount }。
 * @param {object} [options]
 * @param {number} [options.rateLimitPerMinute=10] - 每分钟调用上限（0 = 不限）。
 */
export function registerNotifyTestTool(ctx, notifier, options = {}) {
  if (ctx?.tools?.register === undefined) {
    return null
  }
  const limiter = createRateLimiter({ limitPerMinute: options.rateLimitPerMinute ?? 10 })
  return ctx.tools.register({
    name: 'notify_test',
    description: '向用户配置的推送渠道发送一条测试通知，验证渠道是否正常（健康自检）。仅在用户要求检查通知配置时调用；省略 channel 时广播到所有已配置渠道。',
    parameters: compileParameters({
      channel: { type: 'string', description: `目标渠道类型：${CHANNEL_TYPES.join('/')}；省略则广播到所有已配置渠道` },
    }),
    output: {
      schema: notifySchema,
      render: (_args, value) => renderNotify(value),
    },
    async execute(rawArgs) {
      const args = rawArgs ?? {}
      if (!limiter.allow()) {
        return { ok: false, rateLimited: true, rateLimit: limiter.limit, delivered: [], failed: [] }
      }
      if (notifier.channelCount === 0) {
        return { ok: false, skipped: true, channel: args.channel, delivered: [], failed: [] }
      }
      const message = { title: 'dsh-notifier 自检', content: TEST_MESSAGE, level: 'active' }
      if (typeof args.channel === 'string' && args.channel.trim() !== '') {
        const result = await notifier.notify(args.channel.trim(), message)
        if (result.skipped === true) {
          return { ok: false, skipped: true, channel: result.channel, delivered: [], failed: [] }
        }
        if (result.ok) {
          return { ok: true, channel: result.channel, delivered: [result.channel], failed: [] }
        }
        return { ok: false, channel: result.channel, delivered: [], failed: [{ channel: result.channel, error: result.error?.message ?? String(result.error) }] }
      }
      const broadcast = await notifier.notifyAll(message)
      return {
        ok: broadcast.failed.length === 0,
        delivered: broadcast.delivered,
        failed: broadcast.failed.map((item) => ({ channel: item.channel, error: item.error })),
      }
    },
  })
}
