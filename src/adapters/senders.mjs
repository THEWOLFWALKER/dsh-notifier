// dsh-notifier adapters/senders.mjs
// v0.15（T09/T10）：provider sender 契约的注册表。
//
// 分两类接入，**只切接缝、不改协议**：
//   - stateless（T09）：无跨调用资源（无 token/seq/socket/timer）——Bark、Webhook。
//   - stateful（T10）：持有跨调用运行时资源——QQ 官方机器人（token 管理器/限速门/msg_seq）、
//     企业微信应用（token 管理器）。它们经 bridgeStatefulAdapter 接入显式 runtime（start/stop/
//     dispose + epoch），资源仍由 adapter 持有于 live resolved（T08 分层）。
//
// 未登记的渠道**不在本表内**：传输路径按旧 `adapter.send` 原状运行（回退要求「其他渠道原状」）。
// 后续 T11 逐批把剩余资源型渠道以 stateful sender 接入，本表是其自然落点。

import * as bark from './bark.mjs'
import * as webhook from './webhook.mjs'
import * as qqBot from './qq-bot.mjs'
import * as wecomApp from './wecom-app.mjs'
import { bridgeStatelessAdapter, bridgeStatefulAdapter } from './sender.mjs'

/** 全部已登记的 sender：type -> sender。 */
export const SENDERS = Object.freeze({
  bark: bridgeStatelessAdapter(bark),
  webhook: bridgeStatelessAdapter(webhook),
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