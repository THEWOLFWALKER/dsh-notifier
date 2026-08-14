// dsh-notifier notify.mjs
// 统一前端 API：notify(channel, msg) 单渠道 / notifyAll(msg) 广播。
// 共用 adapter 注册表（config.mjs 解析出的已启用渠道），未配置的渠道静默跳过并在日志提示。

import { ADAPTERS, normalizeMessage, channelResult } from './config.mjs'

/**
 * 创建一个 notifier：内部持有「已启用渠道」列表。
 * @param ctx - cordis 插件上下文（提供 logger）。
 * @param channels - resolveConfig 返回的已启用渠道 [{ type, config }]。
 * @returns { notify, notifyAll, channelCount }
 */
export function createNotifier(ctx, channels) {
  const logger = ctx?.logger
  const warn = (...args) => {
    try { logger?.warn?.('[dsh-notifier]', ...args) } catch { /* 日志失败绝不致命 */ }
  }

  // 在途推送账本：flush 时等待它们完成（headless 一次性运行退出前也能送达）。
  const inFlight = new Set()
  const track = (promise) => {
    inFlight.add(promise)
    promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise))
    return promise
  }

  /** 等待所有在途推送完成（进程退出 / 插件卸载前的 flush）。 */
  async function flush() {
    await Promise.allSettled([...inFlight])
  }

  /** 单渠道推送：未配置/未知渠道静默跳过 + warn 提示；已配置渠道失败返回 failed 结果（不抛出，供工具渲染中文反馈）。 */
  async function notify(channel, msg) {
    const type = typeof channel === 'string' ? channel.trim() : ''
    const normalized = normalizeMessage(msg)
    const entry = channels.find((item) => item.type === type)
    if (entry === undefined) {
      warn(`渠道 "${type || '(空)'}" 未配置，已跳过推送（可用类型：${Object.keys(ADAPTERS).join('/')}）`)
      return channelResult(type || '(空)', 'skipped')
    }
    const adapter = ADAPTERS[type]
    return track((async () => {
      try {
        await adapter.send(entry.config, normalized)
        return channelResult(type, 'sent')
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        warn(`渠道 "${type}" 推送失败: ${reason}`)
        return channelResult(type, 'failed', error)
      }
    })())
  }

  /** 广播到所有已启用渠道：每个渠道独立 try/catch，互不拖累。 */
  async function notifyAll(msg) {
    const normalized = normalizeMessage(msg)
    if (channels.length === 0) {
      warn('未配置任何已启用渠道，notifyAll 无操作')
      return { ok: false, delivered: [], skipped: [], failed: [] }
    }
    const delivered = []
    const failed = []
    const skipped = []
    const batch = channels.map(async (entry) => {
      try {
        await ADAPTERS[entry.type].send(entry.config, normalized)
        delivered.push(entry.type)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        warn(`渠道 "${entry.type}" 推送失败: ${reason}`)
        failed.push({ channel: entry.type, error: reason })
      }
    })
    await track(Promise.all(batch))
    return {
      ok: failed.length === 0,
      delivered,
      skipped,
      failed,
    }
  }

  return {
    notify,
    notifyAll,
    flush,
    channelCount: channels.length,
    channels: channels.map((entry) => entry.type),
  }
}
