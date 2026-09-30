// dsh-notifier adapters/senders.mjs
// v0.15（T09）：简单 HTTP sender 试点的注册表。
//
// 试点范围（T09 先读范围）：当前**实际简单 HTTP 渠道**——Bark 与 Webhook。它们没有常驻
// 资源（无 token/seq/socket/timer），因此只走 stateless sender 契约；协议实现仍由
// `bark.mjs` / `webhook.mjs` 持有，这里只做契约接入，不改 endpoint/payload/校验/timeout/SSRF。
//
// 未登记的渠道**不在本表内**：传输路径按旧 `adapter.send` 原状运行（回退要求「其他渠道原状」）。
// 后续 T10/T11 逐批把资源型渠道以 stateful sender 接入，本表是其自然的落点。

import * as bark from './bark.mjs'
import * as webhook from './webhook.mjs'
import { bridgeStatelessAdapter } from './sender.mjs'

/** 全部已登记的 sender：type -> sender。 */
export const SENDERS = Object.freeze({
  bark: bridgeStatelessAdapter(bark),
  webhook: bridgeStatelessAdapter(webhook),
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