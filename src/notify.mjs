// dsh-notifier notify.mjs
// 统一前端 API：notify(channel, msg) 单渠道 / notifyAll(msg) 广播。
// 共用 adapter 注册表（config.mjs 解析出的已启用渠道），未配置的渠道静默跳过并在日志提示。

import { ADAPTERS, normalizeMessage, channelResult } from './config.mjs'
import { resolveRouting, routeTargets, retryPolicyOf, sendWithRetry, normalizeLevel } from './routing.mjs'
import { sendSegmented } from './inbound/segment.mjs'

/**
 * 创建一个 notifier：内部持有「已启用渠道」列表。
 * @param ctx - cordis 插件上下文（提供 logger）。
 * @param channels - resolveConfig 返回的已启用渠道 [{ type, config }]。
 * @param {object} [options]
 * @param {object} [options.routing] - routing 配置原值（resolveRouting 解析）；未配置时广播全部渠道（基线行为）。
 * @param {object} [options.retry] - 重试覆盖（{ enabled?, attempts?, backoffMs? }）；仅配置 routing 后生效。
 * @param {object} [options.segment] - 出站分段（{ enabled?, maxCodepoints? }）；默认开、1200 码点。
 * @param {(record: object) => void} [options.onSend] - 每次广播结束的回调（通知账本用，阶段 6）。
 * @returns { notify, notifyAll, flush, channelCount }
 */
export function createNotifier(ctx, channels, options = {}) {
  const logger = ctx?.logger
  const warn = (...args) => {
    try { logger?.warn?.('[dsh-notifier]', ...args) } catch { /* 日志失败绝不致命 */ }
  }
  const routing = options.routing !== undefined ? resolveRouting(options.routing) : resolveRouting()
  const segment = (options.segment !== null && typeof options.segment === 'object')
    ? options.segment
    : { enabled: true, maxCodepoints: 1200 }

  /** 包装单渠道发送：分段开启且超预算时切段顺序送达，任一段失败即整体失败。 */
  const sendOne = (type, config, msg) => {
    const adapter = ADAPTERS[type]
    if (segment.enabled === false) return adapter.send(config, msg)
    return sendSegmented((piece) => adapter.send(config, piece), msg, { maxCodepoints: segment.maxCodepoints })
      .then(({ sent, total, error }) => {
        if (error === null) return undefined
        if (sent > 0) {
          // v0.6.3：部分送达标记 noRetry——重试单元若仍是「整条消息」，已送达的
          // 前 N 段会被重发（timeSensitive 3 次尝试 = 同通知收到多份前半段轰炸）。
          // 重试层见 routing.sendWithRetry 对 noRetry 的短路。
          const partial = new Error(`分段送达中断：${sent}/${total} 段成功`)
          partial.cause = error
          partial.noRetry = true
          throw partial
        }
        throw error
      })
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
    return track((async () => {
      try {
        await sendOne(type, entry.config, normalized)
        return channelResult(type, 'sent')
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        warn(`渠道 "${type}" 推送失败: ${reason}`)
        return channelResult(type, 'failed', error)
      }
    })())
  }

  /**
   * 广播到路由命中的渠道：按 level 走路由矩阵（未配置时全部渠道，向后兼容）；每渠道独立 try/catch，互不拖累。
   * v0.3.2 出站分流（可选 options，与全局 level 路由是 AND 关系）：
   *  - channelTypes：agent/会话路由解析出的目标类型集合；命中 level 路由后再按此过滤
   *    （未传/非数组 = 不过滤，全量广播——旧调用方零感知）。
   *  - quiet：true = 本次静音——不走任何渠道发送，但仍写通知账本（skipped 标 '(quiet)'）。
   * @param {object} msg - 通知消息（normalizeMessage 归一）。
   * @param {{ channelTypes?: string[], quiet?: boolean }} [options] - v0.3.2 分流选项。
   */
  async function notifyAll(msg, sendOptions = {}) {
    const normalized = normalizeMessage(msg)
    const quiet = sendOptions?.quiet === true
    const filterTypes = Array.isArray(sendOptions?.channelTypes) ? sendOptions.channelTypes : null
    // v0.6 来源标注（设计稿 §2.3）：source 只并入 onSend record（账本/事件可见），
    // 不进返回值（notify.test 全形状 deepEqual 守着）、不进渠道 msg（normalizeMessage 剥离契约不变）。
    const source = sendOptions?.source
    const sourceExtra = (source !== null && typeof source === 'object') ? { source } : {}
    if (quiet) {
      // 静音不等于没发生：账本照记（delivered 空、skipped 标记），方便晨报反映被静音的流量
      const quietOutcome = { ok: true, delivered: [], skipped: ['(quiet)'], failed: [] }
      if (typeof options.onSend === 'function') {
        try { options.onSend({ time: new Date().toISOString(), message: normalized, ...quietOutcome, ...sourceExtra }) } catch { /* 账本失败绝不影响 */ }
      }
      return quietOutcome
    }
    if (channels.length === 0) {
      warn('未配置任何已启用渠道，notifyAll 无操作')
      return { ok: false, delivered: [], skipped: [], failed: [] }
    }
    const targets = routeTargets(routing, channels, normalized)
      .filter((target) => filterTypes === null || filterTypes.includes(target.type))
    // v0.6.3 空目标可见化（审查 R1 P1-2）：路由矩阵/分流过滤后目标为空时，原实现
    // delivered/failed/skipped 三空 + ok:true + 零日志——agent 绑定的渠道后来被禁用/
    // routing 渠道名拼错时，通知（含 timeSensitive 审批提醒）静默消失且账本记成功，
    // 排障完全误导。现在 warn + skipped 标记（ok 语义不变：无失败即 true）。
    if (targets.length === 0) {
      const hint = filterTypes !== null
        ? `分流过滤（channelTypes: [${filterTypes.join(', ')}]）后无目标`
        : '路由矩阵（routing 配置）未命中任何已启用渠道'
      warn(`notifyAll 目标为空：${hint}（可用渠道：${channels.map((entry) => entry.type).join('/') || '无'}）`)
      const emptyOutcome = { ok: true, delivered: [], skipped: ['(no-targets)'], failed: [] }
      if (typeof options.onSend === 'function') {
        try { options.onSend({ time: new Date().toISOString(), message: normalized, ...emptyOutcome, ...sourceExtra }) } catch { /* 账本失败绝不影响推送 */ }
      }
      return emptyOutcome
    }
    const delivered = []
    const failed = []
    const skipped = []
    const retry = routing.configured
      ? retryPolicyOf(normalizeLevel(normalized.level), options.retry)
      : { attempts: 1, backoffMs: 0 }
    const batch = targets.map(async (target) => {
      try {
        await sendWithRetry(
          () => sendOne(target.type, target.entry.config, target.message),
          { ...retry, onRetry: (attempt, error) => warn(`渠道 "${target.type}" 第 ${attempt} 次失败，准备重试: ${error instanceof Error ? error.message : String(error)}`) },
        )
        delivered.push(target.type)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        warn(`渠道 "${target.type}" 推送失败: ${reason}`)
        failed.push({ channel: target.type, error: reason })
      }
    })
    await track(Promise.all(batch))
    const outcome = {
      ok: failed.length === 0,
      delivered,
      skipped,
      failed,
    }
    if (typeof options.onSend === 'function') {
      try { options.onSend({ time: new Date().toISOString(), message: normalized, ...outcome, ...sourceExtra }) } catch { /* 账本失败绝不影响推送 */ }
    }
    return outcome
  }

  return {
    notify,
    notifyAll,
    flush,
    channelCount: channels.length,
    channels: channels.map((entry) => entry.type),
  }
}
