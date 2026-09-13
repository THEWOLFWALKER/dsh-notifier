// Inbound channel registry and lifecycle wiring.
//
// This module owns only transport assembly: optional channel factories are
// started independently, successful instances are indexed for approval/reply
// routing, and each instance is stopped defensively. Permission, approval,
// question, and conversation semantics remain in their existing modules.

import { createTelegramInbound } from '../channels/telegram/index.mjs'
import { createFeishuInbound } from '../channels/feishu/index.mjs'
import { createQqInbound } from '../inbound/qq-gw.mjs'
import { createWxpusherInbound } from '../inbound/wxpusher-callback.mjs'
import { createWechatIlinkInbound, resolveWechatInboundConfig, ACCOUNT_KEY } from '../channels/wechat-ilink/index.mjs'
import { createDingtalkInbound } from '../inbound/dingtalk-stream.mjs'

// Telegram/Feishu factories are the provider facades (channels/*), which wrap the shared
// inbound bots and inject a stable per-provider accountId + capability evidence into every
// envelope. Callers may still override any entry via the `factories` option (merged below)
// or import the legacy `inbound/*-bot.mjs` `create*Inbound` directly — both stay exported.
const DEFAULT_FACTORIES = Object.freeze({
  telegram: createTelegramInbound,
  feishu: createFeishuInbound,
  qq: createQqInbound,
  wxpusher: createWxpusherInbound,
  wechat: createWechatIlinkInbound,
  dingtalk: createDingtalkInbound,
})

/**
 * Start configured inbound transports and expose the registry used by the
 * control/approval layers.
 *
 * @param {{
 *   inboundBotToken?: string, tgRaw?: object, notifyChatIds?: string[],
 *   feishuOk?: boolean, feishuResolved?: object|null,
 *   qqOk?: boolean, qqResolved?: object|null,
 *   wxOk?: boolean, wxResolved?: object|null,
 *   wechatWanted?: boolean, wechatRaw?: object,
 *   dingtalkOk?: boolean, dingtalkResolved?: object|null,
 *   bus: object, vault: object, store: object, identity: object,
 *   actions: object|null, questions: object|null, control: object,
 *   allowUsers?: string[], telegramReadyMessage?: () => string,
 *   logger?: object, warn?: (message: string) => void,
 *   factories?: object, resolveWechat?: Function
 * }} deps
 * @returns {{ interactiveInstances: object[], replyTargets: Map<string, object>, dispose: () => Promise<void> }}
 */
export function createInboundChannelRegistry(deps = {}) {
  const {
    inboundBotToken = '', tgRaw = {}, notifyChatIds = [],
    feishuOk = false, feishuResolved = null,
    qqOk = false, qqResolved = null,
    wxOk = false, wxResolved = null,
    wechatWanted = false, wechatRaw = {},
    dingtalkOk = false, dingtalkResolved = null,
    bus, vault, store, identity, actions = null, questions = null, control,
    strings = null, // lang 文案表（stringsOf(lang)）：透传给各渠道适配器
    allowUsers = [], telegramReadyMessage = () => 'inbound 已启动：telegram 长轮询', logger = null,
    warn = () => {}, factories = {}, resolveWechat = resolveWechatInboundConfig,
  } = deps
  const factory = { ...DEFAULT_FACTORIES, ...factories }
  const interactiveInstances = []
  const replyTargets = new Map()

  const startInboundChannel = (name, boot) => {
    try {
      return boot()
    } catch (error) {
      warn(`inbound:${name} 装配失败，已跳过（其余通道不受影响）: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  const attach = (name, create, options, readyMessage) => {
    const instance = startInboundChannel(name, () => {
      const value = create(options)
      try {
        value.start()
      } catch (error) {
        // A factory may allocate a socket before start() reports failure. Give
        // that instance one best-effort stop before the channel is abandoned.
        try { value.stop?.() } catch { /* cleanup is best effort */ }
        throw error
      }
      interactiveInstances.push(value)
      replyTargets.set(name, value)
      warn(readyMessage())
      return value
    })
    return instance
  }

  if (inboundBotToken !== '') {
    attach('telegram', factory.telegram, {
      config: {
        botToken: inboundBotToken,
        apiBase: tgRaw.apiBase,
        notifyChatIds,
        accountId: tgRaw.accountId,
      },
      bus, vault, store, logger, identity, actions, questions, control, strings,
    }, telegramReadyMessage)
  }

  if (feishuOk) {
    attach('feishu', factory.feishu, {
      config: feishuResolved.config, bus, fallbackTargets: allowUsers, identity, logger, actions, questions, control, strings,
    }, () => 'inbound 已启动：feishu WebSocket 长连接（卡片审批 + 命令回执）')
  }

  if (qqOk) {
    attach('qq', factory.qq, {
      config: qqResolved.config, bus, fallbackTargets: allowUsers, identity, logger, strings,
    }, () => 'inbound 已启动：qq WebSocket 网关（文本审批通知 + 编号回复裁决）')
  }

  if (wxOk) {
    attach('wxpusher', factory.wxpusher, {
      config: wxResolved.config, bus, store, fallbackTargets: allowUsers, identity, logger, strings,
    }, () => 'inbound 已启动：wxpusher HTTP 回调（密径鉴权 + 编号回复裁决）')
  }

  if (wechatWanted) {
    let wechatResolved = null
    try {
      wechatResolved = resolveWechat(wechatRaw, { credentials: store.get(ACCOUNT_KEY) })
    } catch (error) {
      warn(`inbound.wechat 跳过: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (wechatResolved?.ok !== true) {
      if (wechatResolved !== null) warn(`inbound.wechat 跳过: ${wechatResolved.reason}`)
    } else {
      attach('wechat', factory.wechat, {
        config: wechatResolved.config, bus, store, fallbackTargets: allowUsers, identity, logger, strings,
      }, () => 'inbound 已启动：wechat iLink 长轮询（文本审批通知 + 编号回复裁决）')
    }
  }

  if (dingtalkOk) {
    attach('dingtalk', factory.dingtalk, {
      config: dingtalkResolved.config, bus, store, fallbackTargets: allowUsers, identity, logger, strings,
    }, () => 'inbound 已启动：dingtalk Stream 长连接（文本审批通知 + 编号回复裁决）')
  }

  const dispose = async () => {
    const pending = []
    for (const instance of interactiveInstances) {
      try {
        const result = instance.stop?.()
        if (result !== null && typeof result?.then === 'function') pending.push(result)
      } catch { /* 单通道停机失败不影响其它通道 */ }
    }
    await Promise.allSettled(pending)
  }

  return { interactiveInstances, replyTargets, dispose }
}
