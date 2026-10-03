// dsh-notifier v0.15 Stage 4 — Secondary user surface（取代旧 538 行 compatibility switch）。
//
// Stage 3 独立 Review R3：旧 `compatibility-adapter.mjs` 是一个巨型 switch，把 Native 已被替代的
// legacy endpoint（surface.home / channels.* / tasks.* / questions.* / members.* / pairing.* /
// sessions.* / bindings.* / diagnostics 原始面 / dshIm.import.*）全部继续暴露给任何已 admitted
// 客户端。本模块只保留「当前 daily UI 真的有调用者」的 secondary 方法；其余一律由 service 层
// 按 `surface-allowlist.mjs` 拒绝为 `not-supported`（能力不存在，而不是 UI 不可见）。
//
// 注意：本层不做任何通道/成员/会话/路由写编排——那些写入的唯一权威是 Native 窄动作表
// （native.* → 各 authority）。这里仅剩用户功能与只读投影。

const PUBLIC_ERROR_CODES = new Set([
  'bad-request', 'not-found', 'not-configured', 'not-supported',
  'storage-failed', 'stale-preview', 'conflict', 'host-unavailable', 'internal',
])

import { buildRemoteEntry, REMOTE_URL_REASONS } from '../control-plane/remote-url.mjs'

function normalizeCode(error) {
  const raw = String(error?.code ?? 'internal').replace(/^dsh-notifier\//, '')
  return PUBLIC_ERROR_CODES.has(raw) ? raw : 'internal'
}

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

const ok = (value) => ({ ok: true, value })

/** Cloudflare 部署面允许的动作（与 ui client 实际使用的方法一致）。 */
const CLOUDFLARE_ACTIONS = new Set([
  'status', 'loginDevice', 'refresh', 'deploy', 'link', 'unbind', 'cancel',
  'tunnelConfigure', 'tunnelStart', 'tunnelStop',
])

/**
 * Secondary 用户功能服务：只实现 `surface-allowlist.mjs` 中列出的非 Native 方法。
 * 未命中任何分支的方法返回 `bad-request`（绝不落到旧巨型 switch 的默认成功分支）。
 */
export function createSecondarySurfaceService({
  revision,
  diagnostics = null,
  cloudflare = null,
  portability = null,
  dshIm = null,
  activity,
  launchTickets,
  adminLocation,
} = {}) {
  const revisionView = () => {
    const current = revision.current()
    return { epoch: current.epoch, revision: current.revision }
  }

  const call = async (method, payload = {}, signal) => {
    try {
      // v0.12.1（P2-11）：世代 wait（只读长轮询）。容量耗尽时回退信息由 UI 用于退避。
      if (method === 'surface.wait') {
        const before = Number(payload?.after ?? 0)
        const value = await revision.wait({ after: before, timeoutMs: payload?.timeoutMs, signal })
        return ok({
          epoch: value.epoch,
          revision: value.revision,
          changed: value.revision > before,
          ...(value.topic ? { topic: value.topic } : {}),
          ...(value.capacity === true ? { capacity: true, retryAfterMs: Math.max(500, Number(value.retryAfterMs) || 1_000) } : {}),
        })
      }

      // v0.14（S11）：只读 canonical 诊断快照（帮助页 support report / Recovery 台同源）。
      if (method === 'diagnostics.snapshot') {
        if (diagnostics === null) throw Object.assign(new Error('诊断快照当前不可用'), { code: 'not-supported' })
        return ok({ ...revisionView(), ...diagnostics.snapshot() })
      }

      // v0.15（T21）：配置导出 / 导入。导入走 canonical 权威，交付前 dry-run。
      if (method === 'portability.export' || method === 'portability.preview'
        || method === 'portability.cancel' || method === 'portability.readBack'
        || method === 'portability.commit') {
        if (portability === null || typeof portability.exportConfig !== 'function') {
          const error = new Error('配置导出/导入当前不可用（本进程未装配 portability 服务）')
          error.code = 'not-supported'
          throw error
        }
      }
      if (method === 'portability.export') {
        const value = portability.exportConfig(payload)
        return ok({ ...revisionView(), ...value, documentType: portability.documentType, formatVersion: portability.formatVersion })
      }
      if (method === 'portability.preview') {
        return ok({ ...revisionView(), ...portability.previewImport(payload) })
      }
      if (method === 'portability.cancel') {
        return ok(portability.cancelImport(payload))
      }
      if (method === 'portability.readBack') {
        return ok({ ...revisionView(), ...portability.readBack() })
      }
      if (method === 'portability.commit') {
        const value = portability.commitImport(payload)
        const applied = value.results.filter((row) => row.action === 'patched')
        const staged = value.results.filter((row) => row.action === 'staged')
        revision.touch('channels')
        activity.record('configuration', 'config-imported', {
          applied: applied.length,
          staged: staged.length,
          skipped: value.results.filter((row) => row.action === 'skipped').length,
          status: 'ok',
        })
        for (const row of applied) {
          activity.record('configuration', 'channel-saved', {
            channel: `${row.direction}:${row.type}`,
            saved: true,
            hotApplied: row.applied === true,
          })
        }
        return ok({ ...revisionView(), ...value })
      }

      // v0.15：Cloudflare 自动连接（只服务 UI 实际动作）。
      if (method.startsWith('cloudflare.')) {
        const action = method.slice('cloudflare.'.length)
        if (!CLOUDFLARE_ACTIONS.has(action) || cloudflare === null) {
          throw Object.assign(new Error('Cloudflare 部署不可用'), { code: 'not-supported' })
        }
        return ok({ ...revisionView(), ...await cloudflare[action](payload) })
      }

      // v0.15（T24）：远程入口 URL 校验。纯本地解析、零网络、零写。
      if (method === 'remote.validate') {
        const entry = buildRemoteEntry(payload?.url)
        if (entry.ok !== true) {
          const error = new Error(REMOTE_URL_REASONS[entry.reason] ?? '链接校验未通过')
          error.code = 'bad-request'
          throw error
        }
        return ok(entry)
      }

      // 独立 Recovery 启动票据。
      if (method === 'standalone.createLaunch') {
        const location = typeof adminLocation === 'function' ? adminLocation() : null
        if (!location?.port) return ok({ available: false, reason: 'disabled' })
        const minted = launchTickets.mint()
        return ok({
          available: true,
          url: `http://${location.address || '127.0.0.1'}:${location.port}/#ticket=${encodeURIComponent(minted.ticket)}`,
        })
      }

      // v0.15（T22）：可选 dsh-im 投递桥（缺失是正常态；发送走 checked 契约，见 P3）。
      if (method === 'dshIm.status' || method === 'dshIm.listBots'
        || method === 'dshIm.listTargets' || method === 'dshIm.send') {
        if (dshIm === null) {
          const error = new Error('dsh-im 投递桥接当前不可用（本进程未装配）')
          error.code = 'not-supported'
          throw error
        }
      }
      if (method === 'dshIm.status') return ok({ ...revisionView(), ...dshIm.status() })
      if (method === 'dshIm.listBots') return ok({ ...revisionView(), bots: await dshIm.listBots() })
      if (method === 'dshIm.listTargets') return ok({ ...revisionView(), targets: await dshIm.listTargets(payload?.botId) })
      if (method === 'dshIm.send') {
        const value = await dshIm.send(payload)
        activity.record('notification', 'dsh-im-send', {
          channel: 'dsh-im',
          accepted: value.accepted === true,
          confirmed: value.confirmed === true,
          failed: value.unknown === true || value.rejected === true,
          status: value.rejected === true ? 'failed' : 'ok',
        })
        return ok(value)
      }

      const error = new Error(`未知方法 "${String(method)}"`)
      error.code = 'bad-request'
      throw error
    } catch (error) {
      return failure(error)
    }
  }

  return { call }
}