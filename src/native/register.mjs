// dsh-notifier v0.15 Stage 1 — Native 宿主入口（窄动作表 + 既有宿主接缝）。
//
// 职责（03_ARCHITECTURE_REWRITE_PLAN）：
//  - 只负责接 DSH Host 的 Native 入口与 RPC；
//  - Host 能力不存在时 fail closed / 合理降级，**绝不启动独立端口**；
//  - 用**窄动作表**取代旧 service 的巨大 endpoint switch（10_REWRITE_DECISION_MATRIX）。
//
// 传输复用既有 `src/control-surface/rpc.mjs`（挂宿主 webServer 的 `/dsh-notifier` 前缀路由，
// 与宿主挂 `/api` 同款，带 connection 准入与信封）。S1 阶段本模块**不与旧 service 同时装配**
// ——同一前缀只能有一个路由；S2 切换客户端时用它替换旧 service，而不是并存。
//
// fail-closed 语义（U04「错/缺 service 不当空」）：读取能力缺失一律 `not-supported`，
// 绝不返回 `ok:true` 的空表——否则客户端会把「服务缺失」当成「暂无数据」。

import { CONTROL_SURFACE_CHANNEL, registerControlSurfaceRpc } from '../control-surface/rpc.mjs'

/** 可公开给浏览器的错误码（其余一律归一为 internal，细节留在服务端）。 */
const PUBLIC_ERROR_CODES = new Set([
  'bad-request', 'not-found', 'not-configured', 'not-supported',
  'storage-failed', 'stale-preview', 'conflict', 'host-unavailable', 'internal',
])

/** 窄动作表：读取（read-model）。 */
export const NATIVE_READ_METHODS = Object.freeze([
  'native.snapshot',
  'native.channel',
  'native.privateChat',
  'native.pending',
  'native.wait',
])

/** 窄动作表：写入（actions，每个动作只调一个 authority）。 */
export const NATIVE_ACTION_METHODS = Object.freeze([
  'native.saveChannel',
  'native.saveInboundChannel',
  'native.removeChannel',
  'native.testChannel',
  'native.settlePending',
  'native.updateUser',
  'native.removeUser',
  'native.approveUser',
  'native.dismissUser',
  'native.mintPairing',
  'native.revokePairing',
])

export const NATIVE_METHODS = Object.freeze([...NATIVE_READ_METHODS, ...NATIVE_ACTION_METHODS])

const normalizeCode = (error) => {
  const raw = String(error?.code ?? 'internal').replace(/^dsh-notifier\//, '')
  return PUBLIC_ERROR_CODES.has(raw) ? raw : 'internal'
}

const ok = (value) => ({ ok: true, value })

function failure(error) {
  const code = normalizeCode(error)
  return {
    ok: false,
    error: {
      code: `dsh-notifier/${code}`,
      message: code === 'internal' ? '内部错误' : String(error?.message ?? code).slice(0, 300),
      details: {},
    },
  }
}

const notSupported = (message) => Object.assign(new Error(message), { code: 'not-supported' })
const badRequest = (message) => Object.assign(new Error(message), { code: 'bad-request' })

const langOf = (payload) => (String(payload?.lang ?? '') === 'en' ? 'en' : 'zh')

/**
 * 窄动作表服务：只做「RPC 方法 → read-model / actions 方法」的形态映射与 fail-closed 判定。
 * 不持有业务状态、不写 store、不记账（记账归属在 actions 内）。
 *
 * @param {object} deps
 * @param {object|null} deps.readModel - createNativeReadModel() 实例
 * @param {object|null} deps.actions - createNativeActions() 实例
 */
export function createNativeSurfaceService({ readModel = null, actions = null } = {}) {
  const requireReadModel = () => {
    if (readModel === null || readModel === undefined) throw notSupported('Native 读取能力当前不可用')
    return readModel
  }
  const requireActions = () => {
    if (actions === null || actions === undefined) throw notSupported('Native 操作能力当前不可用')
    return actions
  }

  const table = {
    'native.snapshot': (payload) => ok(requireReadModel().snapshot({ lang: langOf(payload) })),
    'native.channel': (payload) => {
      const type = String(payload?.type ?? '')
      if (type === '') throw badRequest('缺少渠道标识')
      const detail = requireReadModel().channel(type, { lang: langOf(payload) })
      if (detail === null) throw Object.assign(new Error(`未知渠道 "${type}"`), { code: 'not-found' })
      return ok(detail)
    },
    'native.privateChat': (payload) => ok(requireReadModel().privateChat({ lang: langOf(payload) })),
    'native.pending': (payload) => ok(requireReadModel().pending({ lang: langOf(payload) })),
    'native.wait': async (payload, signal) => ok(await requireReadModel().wait({
      cursor: payload?.cursor,
      timeoutMs: payload?.timeoutMs,
      signal,
    })),

    'native.saveChannel': (payload) => ok(requireActions().saveChannel(payload)),
    'native.saveInboundChannel': async (payload) => ok(await requireActions().saveInboundChannel(payload)),
    'native.removeChannel': (payload) => ok(requireActions().removeChannel(payload)),
    'native.testChannel': async (payload) => ok(await requireActions().testChannel(payload)),
    'native.settlePending': (payload) => ok(requireActions().settlePending(payload)),
    'native.updateUser': (payload) => ok(requireActions().updateUser(payload)),
    'native.removeUser': (payload) => ok(requireActions().removeUser(payload)),
    'native.approveUser': (payload) => ok(requireActions().approveUser(payload)),
    'native.dismissUser': (payload) => ok(requireActions().dismissUser(payload)),
    'native.mintPairing': (payload) => ok(requireActions().mintPairing(payload)),
    'native.revokePairing': (payload) => ok(requireActions().revokePairing(payload)),
  }

  return {
    methods: NATIVE_METHODS,
    async call(method, payload = {}, signal) {
      try {
        const handler = Object.prototype.hasOwnProperty.call(table, method) ? table[method] : null
        if (handler === null) throw badRequest(`未知方法 "${String(method)}"`)
        return await handler(payload ?? {}, signal)
      } catch (error) {
        return failure(error)
      }
    },
  }
}

/**
 * 把 Native 服务挂到宿主接缝上。宿主不提供任何可用接缝时返回 null（调用方据此降级），
 * **绝不**自行 listen 端口。
 * @returns {(() => void)|null} disposer 或 null
 */
export function registerNativeSurface(ctx, service) {
  return registerControlSurfaceRpc(ctx, service)
}

export { CONTROL_SURFACE_CHANNEL as NATIVE_SURFACE_CHANNEL }
