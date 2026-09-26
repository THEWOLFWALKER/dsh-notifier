const PUBLIC_ERROR_CODES = new Set([
  'bad-request', 'not-found', 'not-configured', 'not-supported',
  'storage-failed', 'conflict', 'host-unavailable', 'internal',
])
import { inboundApplyMode, isHotApplied } from './apply-mode.mjs'

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

function summaryOf(channelRows, questionRows, storageStatus = {}) {
  if (storageStatus?.readFailed === true) return {
    status: 'attention',
    detail: { en: 'Persistent state could not be read', zh: '持久化状态读取失败' },
  }
  const configured = channelRows.some((row) => row?.notify?.configured === true)
  if (!configured) return {
    status: 'unconfigured',
    detail: { en: 'No notification channel configured', zh: '尚未配置通知渠道' },
  }
  const degraded = channelRows.find((row) => row?.health?.state === 'degraded')
  const inactive = channelRows.find((row) => row?.notify?.configured === true && row?.notify?.active !== true)
  if (questionRows.length > 0 || inactive || degraded) return {
    status: 'attention',
    detail: {
      en: questionRows.length > 0
        ? `${questionRows.length} question(s) need attention`
        : inactive
          ? `${inactive.type} is configured but inactive`
          : `${degraded.type} recently failed`,
      zh: questionRows.length > 0
        ? `${questionRows.length} 个问题待处理`
        : inactive
          ? `${inactive.type} 已配置但运行时未激活`
          : `${degraded.type} 最近发送失败`,
    },
  }
  return {
    status: 'healthy',
    detail: { en: 'Notification control plane is ready', zh: '通知控制面运行正常' },
  }
}

function testResult(result) {
  const at = new Date().toISOString()
  if (result?.ok === true) {
    // v0.12.1（P1-06 / D1 / D2）：provider 接受请求不等于端到端送达。
    const confirmed = result?.confirmed === true || result?.receipt === true
    const detail = result?.detail ?? (confirmed
      ? { en: 'Delivered', zh: '已送达' }
      : { en: 'Sent to the provider — confirm receipt on your device', zh: '已发送到提供方，请到客户端确认收到' })
    return {
      status: confirmed ? 'delivered' : 'accepted',
      delivered: confirmed,
      confirmed,
      accepted: true,
      detail,
      providerDetail: result?.detail ?? null,
      reasonCode: null,
      at,
    }
  }
  const text = String(result?.detail ?? '')
  const lower = text.toLowerCase()
  const reasonCode = /auth|token|secret|401|403/.test(lower) ? 'auth-failed'
    : /timeout|超时/.test(lower) ? 'timeout'
      : /network|fetch|dns|socket|网络/.test(lower) ? 'network-error'
        : 'provider-error'
  return {
    status: 'unknown',
    delivered: false,
    accepted: false,
    reasonCode,
    detail: text || { en: 'Delivery failed', zh: '发送失败' },
    providerDetail: text || null,
    at,
  }
}

export function createControlSurfaceService({
  revision,
  channels,
  outboundConfig,
  saveInbound,
  channelTest,
  tasks,
  questions,
  activity,
  health,
  storageStatus,
  launchTickets,
  adminLocation,
} = {}) {
  const call = async (method, payload = {}, signal) => {
    try {
      if (method === 'surface.home') {
        const channelRows = channels.list()
        const taskRows = tasks.list()
        const questionRows = questions.list()
        const activityRows = activity.list({ limit: 5 })
        return ok({
          revision: revision.current().revision,
          summary: summaryOf(channelRows, questionRows, typeof storageStatus === 'function' ? storageStatus() : storageStatus),
          storage: typeof storageStatus === 'function' ? storageStatus() : (storageStatus ?? { readFailed: false }),
          questions: questionRows.slice(0, 3),
          tasks: taskRows.slice(0, 5),
          channels: channelRows.filter((row) => row.notify?.configured || row.control?.configured).slice(0, 5),
          activity: activityRows,
        })
      }

      if (method === 'surface.wait') {
        const before = Number(payload?.after ?? 0)
        const value = await revision.wait({ after: before, timeoutMs: payload?.timeoutMs, signal })
        return ok({
          revision: value.revision,
          changed: value.revision > before,
          ...(value.topic ? { topic: value.topic } : {}),
          ...(value.capacity === true ? { capacity: true, retryAfterMs: Math.max(500, Number(value.retryAfterMs) || 1_000) } : {}),
        })
      }

      if (method === 'channels.list') {
        return ok({ revision: revision.current().revision, channels: channels.list() })
      }

      if (method === 'channels.get') {
        const channel = channels.get(payload?.type)
        if (channel === null) {
          const error = new Error(`未知渠道 "${String(payload?.type ?? '')}"`)
          error.code = 'not-found'
          throw error
        }
        return ok({ revision: revision.current().revision, channel })
      }

      if (method === 'channels.save') {
        const direction = String(payload?.direction ?? '')
        let result
        if (direction === 'outbound') {
          result = outboundConfig.save(payload?.type, payload?.patch)
        } else if (direction === 'inbound') {
          if (typeof saveInbound !== 'function') {
            const error = new Error('入站配置写入能力不可用')
            error.code = 'not-supported'
            throw error
          }
          const saved = await saveInbound(payload?.type, payload?.patch)
          if (saved?.saved !== true) {
            const error = new Error('入站配置写入失败：未落盘，已保留当前状态')
            error.code = 'storage-failed'
            throw error
          }
          result = {
            saved: true,
            applied: isHotApplied('inbound'),
            applyMode: inboundApplyMode(),
            configRevision: 0,
          }
        } else {
          const error = new Error('direction 必须是 outbound 或 inbound')
          error.code = 'bad-request'
          throw error
        }
        revision.touch('channels')
        activity.record('configuration', 'channel-saved', {
          channel: String(payload?.type ?? ''),
          direction,
          saved: result.saved === true,
          hotApplied: result.applied === true,
        })
        return ok(result)
      }

      if (method === 'channels.test') {
        const type = String(payload?.type ?? '')
        const raw = outboundConfig.raw(type)
        if (raw === null || Object.keys(raw).length === 0) {
          const error = new Error(`渠道 "${type}" 未配置`)
          error.code = 'not-configured'
          throw error
        }
        const rawResult = await channelTest(type, raw)
        health.recordTest(type, rawResult)
        revision.touch('health')
        const value = testResult(rawResult)
        const action = value.status === 'delivered' ? 'channel-test-ok'
          : value.status === 'accepted' ? 'channel-test-accepted'
            : 'channel-test-failed'
        activity.record('notification', action, {
          channel: type,
          status: value.status === 'unknown' ? 'failed' : 'ok',
          reason: value.status === 'unknown' ? value.detail : null,
        })
        return ok(value)
      }

      if (method === 'tasks.list') {
        return ok({ revision: revision.current().revision, tasks: tasks.list() })
      }

      if (method === 'questions.list') {
        return ok({ revision: revision.current().revision, questions: questions.list() })
      }

      if (method === 'questions.settle') {
        const value = questions.settle(payload)
        revision.touch('questions')
        activity.record('control', 'question-settled', { action: payload?.action ?? 'unknown', status: 'ok' })
        return ok(value)
      }

      if (method === 'activity.list') {
        return ok({ revision: revision.current().revision, items: activity.list(payload) })
      }

      if (method === 'standalone.createLaunch') {
        const location = typeof adminLocation === 'function' ? adminLocation() : null
        if (!location?.port) return ok({ available: false, reason: 'disabled' })
        const minted = launchTickets.mint()
        return ok({
          available: true,
          url: `http://${location.address || '127.0.0.1'}:${location.port}/#ticket=${encodeURIComponent(minted.ticket)}`,
        })
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
