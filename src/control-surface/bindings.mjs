// dsh-notifier control-surface/bindings.mjs
// v0.14（S09）：Native 高级绑定（`bindings.*`）的 RPC 投影适配器。
//
// 绑定是「业务关系」而非 raw `route:*` 键：Native 面向用户呈现 agent→channels/quiet 与
// inbound channel→defaultAgent 两张业务表，绝不把内部键名当作产品概念。
//
// 本层只做「传输形态映射」：把共享 `RoutingControlService`（S03）的绑定快照与整表替换映射
// 成 Native RPC 契约形状，并把展示层形状校验失败映射成 `bad-request`。绑定的写权威仍在
// agent-router（I1/I9）；本层不自行触达 store，也不持有第二份缓存真相。
//
// 未装配服务时 fail-closed：读取空表、写入 `not-supported`。

import { CHANNEL_TYPES } from '../config.mjs'
import { INBOUND_CHANNELS } from '../inbound/channels-registry.mjs'

const OUTBOUND_SET = new Set(CHANNEL_TYPES)
const INBOUND_SET = new Set(INBOUND_CHANNELS)
// 保留键：经赋值语义可触达原型链（router 整表重建 / store 合并写都会中招），入口即拒。
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 取「普通对象」：null / 数组 / 标量一律视为非对象。 */
function plainObjectOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

/** 服务 reason → RPC 公开错误码（与 members/sessions 投影口径对齐）。 */
function reasonCode(reason) {
  switch (reason) {
    case 'not-supported': return 'not-supported'
    case 'invalid': return 'bad-request'
    case 'not-found': return 'not-found'
    case 'storage-failed': return 'storage-failed'
    default: return 'internal'
  }
}

function reasonError(reason, message) {
  const error = new Error(String(message ?? reason ?? '绑定操作未生效'))
  error.code = reasonCode(reason)
  return error
}

/**
 * 展示层形状校验（与 Native putBindings 同口径，adapter 侧，I9）。
 * agents 值必须是普通对象；channels 若出现必须是 string[] ⊆ CHANNEL_TYPES；quiet 若是布尔。
 * channels 表键必须 ∈ INBOUND_CHANNELS；值对象的 defaultAgent 必须是非空字符串。
 * 只出现者参与替换；两侧都不出现 = 空操作（返回当前快照）。
 * @returns {{ agents?: object, channels?: object }}
 */
function normalizeBindingPatch(patch) {
  const body = plainObjectOf(patch)
  if (body === null) throw reasonError('invalid', '请求体必须是对象（{ agents?, channels? }）')

  const normalized = {}
  if (body.agents !== undefined) {
    const table = plainObjectOf(body.agents)
    if (table === null) throw reasonError('invalid', 'agents 必须是对象表（键 → { channels?: string[], quiet?: boolean }）')
    for (const [key, entry] of Object.entries(table)) {
      if (key.trim() === '') throw reasonError('invalid', 'agents 的键必须是非空字符串')
      if (DANGEROUS_KEYS.has(key)) throw reasonError('invalid', `agents 的键 "${key}" 是保留键，不可用作绑定键`)
      const row = plainObjectOf(entry)
      if (row === null) throw reasonError('invalid', `agents["${key}"] 必须是对象（{ channels?, quiet? }）`)
      if (row.channels !== undefined) {
        if (!Array.isArray(row.channels)) throw reasonError('invalid', `agents["${key}"].channels 必须是字符串数组`)
        for (const type of row.channels) {
          if (typeof type !== 'string' || !OUTBOUND_SET.has(type)) {
            throw reasonError('invalid', `agents["${key}"].channels 含未知出站渠道 "${String(type)}"`)
          }
        }
      }
      if (row.quiet !== undefined && typeof row.quiet !== 'boolean') {
        throw reasonError('invalid', `agents["${key}"].quiet 必须是布尔值`)
      }
    }
    normalized.agents = table
  }
  if (body.channels !== undefined) {
    const table = plainObjectOf(body.channels)
    if (table === null) throw reasonError('invalid', 'channels 必须是对象表（入站通道 → { defaultAgent: string }）')
    for (const [channel, entry] of Object.entries(table)) {
      if (!INBOUND_SET.has(channel)) {
        throw reasonError('invalid', `channels 键 "${channel}" 不是合法入站通道`)
      }
      const row = plainObjectOf(entry)
      if (row === null) throw reasonError('invalid', `channels["${channel}"] 必须是对象（{ defaultAgent }）`)
      if (typeof row.defaultAgent !== 'string' || row.defaultAgent.trim() === '') {
        throw reasonError('invalid', `channels["${channel}"].defaultAgent 必须是非空字符串`)
      }
    }
    normalized.channels = table
  }
  return normalized
}

/**
 * 从共享路由控制服务构造 Native 绑定 RPC 投影。
 * @param {object} [deps]
 * @param {ReturnType<typeof import('../control-plane/sessions.mjs').createRoutingControlService>} [deps.service]
 *   - 共享路由控制服务（Native 使用同一实例）；缺失时按空表 / 不可用降级
 */
export function createBindingsProjection({ service = null } = {}) {
  const canRead = service !== null && service !== undefined && typeof service.bindingsSnapshot === 'function'
  const canEdit = canRead && typeof service.replaceBindings === 'function'

  return {
    canRead,
    canEdit,

    /** 绑定快照；读取失败按空表降级（查询可本地降级，I16）。 */
    get() {
      if (!canRead) return { agents: {}, channels: {} }
      try {
        const snapshot = service.bindingsSnapshot()
        return {
          agents: plainObjectOf(snapshot?.agents) ?? {},
          channels: plainObjectOf(snapshot?.channels) ?? {},
        }
      } catch {
        return { agents: {}, channels: {} }
      }
    },

    /** 整表替换绑定（只出现者替换，两侧同现经 router 单事务提交，I3）。 */
    put(payload = {}) {
      if (!canEdit) throw reasonError('not-supported', '路由层未装配')
      const normalized = normalizeBindingPatch(payload)
      const result = service.replaceBindings(normalized)
      if (result?.ok !== true) throw reasonError(result?.reason, '绑定写入存储失败')
      return this.get()
    },
  }
}