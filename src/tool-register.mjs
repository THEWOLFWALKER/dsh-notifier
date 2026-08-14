// dsh-notifier tool-register.mjs
// agent 主动调用触发线：注册 notify 工具，让模型自己决定推送时机与渠道。
// compileParameters DSL 模式照搬 dsh-dingtalk：作者 DSL -> 原生 JSON Schema（wire 请求逐字携带）。

import { CHANNEL_TYPES } from './config.mjs'

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
 */
export function registerNotifyTool(ctx, notifier) {
  if (ctx?.tools?.register === undefined) {
    // 宿主没有 tools 服务时静默跳过工具注册，绝不弄崩启动
    return null
  }

  return ctx.tools.register({
    name: 'notify',
    description: '发送一条通知到用户配置的推送渠道（telegram/dingtalk/feishu/wxpusher/pushplus/serverchan/bark/webhook）。适合任务完成、长时间运行结束、需要用户关注或决策时主动提醒用户。channel 省略时广播到所有已配置渠道；message 为正文，title 为标题。未配置的渠道会静默跳过并在返回里说明。',
    parameters: compileParameters({
      message: { type: 'string', required: true, description: '通知正文（markdown / 纯文本均可）' },
      title: { type: 'string', description: '通知标题（默认空，各渠道自行兜底）' },
      channel: { type: 'string', description: `目标渠道类型：${CHANNEL_TYPES.join('/')}；省略则广播到所有已配置渠道` },
    }),
    output: {
      schema: notifySchema,
      render: (_args, value) => renderNotify(value),
    },
    async execute(rawArgs) {
      const args = rawArgs ?? {}
      if (typeof args.message !== 'string' || args.message.trim() === '') {
        throw new Error('message 不能为空')
      }
      const message = { title: typeof args.title === 'string' ? args.title : '', content: args.message }
      if (notifier.channelCount === 0) {
        return { ok: false, skipped: true, channel: args.channel, delivered: [], failed: [] }
      }
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
