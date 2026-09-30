// dsh-notifier adapters/senders.mjs
// v0.15（T09/T10/T11）：provider sender 契约的注册表。
//
// 分两类接入，**只切接缝、不改协议**：
//   - stateless：无跨调用资源（无 token/seq/socket/timer）。有界 memo（serverchan 别名提示位、
//     desktop BurntToast 探测）随 resolved 回收，不需要生命周期动词 → 不伪造 createRuntime。
//   - stateful：持有跨调用运行时资源——QQ 官方机器人（token 管理器/限速门/msg_seq）、
//     企业微信应用（token 管理器）。经 bridgeStatefulAdapter 接入显式 runtime
//     （start/stop/dispose + epoch），资源仍由 adapter 持有于 live resolved（T08 分层）。
//
// T11：**全部 28 个出站 provider 均登记**（不再只留试点四个）。迁移是「切接缝」——sender.send
// 与旧 adapter.send 同形、（resolved,msg）→ 返回值，分段/重试/证据推断全部复用，故登记不改变
// 任何一条真实投递链路（协议 golden 一致）；分类事实来源见 provider-registry.mjs。
//
// 回退：任一渠道出问题时，从本表摘掉该条即回到旧 `adapter.send` 路径（调用方 senderOf→null
// 自动回落），不影响其他渠道——「只切该渠道 wrapper；其他渠道原状」。

import * as telegram from './telegram.mjs'
import * as dingtalk from './dingtalk.mjs'
import * as feishu from './feishu.mjs'
import * as wxpusher from './wxpusher.mjs'
import * as pushplus from './pushplus.mjs'
import * as serverchan from './serverchan.mjs'
import * as bark from './bark.mjs'
import * as webhook from './webhook.mjs'
import * as bell from './bell.mjs'
import * as desktop from './desktop.mjs'
import * as qqBot from './qq-bot.mjs'
import * as wecomApp from './wecom-app.mjs'
import { SPEC_CHANNELS } from './spec-channels.mjs'
import { makeSpecAdapters } from './_engine.mjs'
import { bridgeStatelessAdapter, bridgeStatefulAdapter } from './sender.mjs'

const SPEC_ADAPTERS = makeSpecAdapters(SPEC_CHANNELS)

/**
 * 全部已登记的 sender：type -> sender。
 * stateless 走 bridgeStatelessAdapter，stateful 走 bridgeStatefulAdapter（协议零改动）。
 */
export const SENDERS = Object.freeze({
  // ———— stateless：手写 HTTP / 本地渠道 ————
  telegram: bridgeStatelessAdapter(telegram),
  dingtalk: bridgeStatelessAdapter(dingtalk),
  feishu: bridgeStatelessAdapter(feishu),
  wxpusher: bridgeStatelessAdapter(wxpusher),
  pushplus: bridgeStatelessAdapter(pushplus),
  serverchan: bridgeStatelessAdapter(serverchan),
  bark: bridgeStatelessAdapter(bark),
  webhook: bridgeStatelessAdapter(webhook),
  bell: bridgeStatelessAdapter(bell),
  desktop: bridgeStatelessAdapter(desktop),
  // ———— stateless：声明表渠道（spec engine 产出）————
  ...Object.fromEntries(
    Object.entries(SPEC_ADAPTERS).map(([type, adapter]) => [type, bridgeStatelessAdapter(adapter)]),
  ),
  // ———— stateful：资源型渠道 ————
  'qq-bot': bridgeStatefulAdapter(qqBot),
  'wecom-app': bridgeStatefulAdapter(wecomApp),
})

/**
 * 取某渠道的 sender；未登记返回 null（调用方回落旧 adapter.send 路径）。
 * @param {string} type
 */
export function senderOf(type) {
  const key = typeof type === 'string' ? type.trim() : ''
  return Object.prototype.hasOwnProperty.call(SENDERS, key) ? SENDERS[key] : null
}

/** 已登记 sender 的渠道类型列表（诊断/测试用）。 */
export function senderTypes() {
  return Object.keys(SENDERS)
}

/**
 * v0.15（T10）：停用某渠道某份 resolved 配置的 runtime（渠道被移除/热替换时由运行时真值 owner 调用）。
 * 仅 stateful sender 有 retire；未登记/stateless/未知 config 一律返回 false（幂等，不抛错）。
 * @param {string} type
 * @param {object} config - 被丢弃的 live resolved 配置（outbound-source 的旧 config）
 */
export function retireSenderRuntime(type, config) {
  const sender = senderOf(type)
  if (sender === null || typeof sender.retire !== 'function') return false
  return sender.retire(config) === true
}