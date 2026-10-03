const PUBLIC_ERROR_CODES = new Set([
  'bad-request', 'not-found', 'not-configured', 'not-supported',
  'storage-failed', 'stale-preview', 'conflict', 'host-unavailable', 'internal',
])
import { inboundApplyMode, isHotApplied } from './apply-mode.mjs'
import { createChannelControlService } from '../control-plane/channels.mjs'
import { isConfirmedReceipt } from '../delivery-evidence.mjs'
import { redactDiagnosticValue } from '../security/diagnostic.mjs'
import { isStorageUntrusted } from '../inbound/store.mjs'
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

/**
 * v0.15（T16）：查询在「能力不可用」时 fail-closed，绝不返回 `ok:true` 的空表——否则客户端
 * 会把「服务缺失」误当成「暂无数据」（U04「错/缺service不当空」）。能力标志由投影层给出。
 */
function requireRead(available, message) {
  if (available === true) return
  const error = new Error(String(message ?? '该查询当前不可用'))
  error.code = 'not-supported'
  throw error
}

function summaryOf(channelRows, questionRows, storageStatus = {}) {
  if (isStorageUntrusted(storageStatus)) return {
    status: 'attention',
    detail: storageStatus?.corrupt === true || storageStatus?.status === 'corrupt'
      ? { en: 'Persistent state is corrupt; writes are blocked until repaired', zh: '持久化状态已损坏，修复前禁止写入' }
      : { en: 'Persistent state could not be read', zh: '持久化状态读取失败' },
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
    const confirmed = isConfirmedReceipt(result)
    const detail = result?.detail ?? (confirmed
      ? { en: 'Delivered', zh: '已送达' }
      : { en: 'Sent to the provider — confirm receipt on your device', zh: '已发送到提供方，请到客户端确认收到' })
    return {
      status: confirmed ? 'delivered' : 'accepted',
      delivered: confirmed,
      confirmed,
      accepted: true,
      detail: redactDiagnosticValue(detail),
      providerDetail: redactDiagnosticValue(result?.detail ?? null),
      reasonCode: null,
      at,
    }
  }
  const safeDetail = redactDiagnosticValue(result?.detail ?? '')
  const text = typeof safeDetail === 'string' ? safeDetail : JSON.stringify(safeDetail)
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
    providerDetail: safeDetail || null,
    at,
  }
}

export function createCompatibilityAdapter({
  revision,
  channels,
  outboundConfig,
  channelControl = null,
  saveInbound,
  channelTest,
  tasks,
  questions,
  members,
  sessions = null,
  bindings = null,
  diagnostics = null,
  cloudflare = null,
  portability = null,
  dshIm = null,
  dshImImport = null,
  activity,
  health,
  storageStatus,
  launchTickets,
  adminLocation,
  native = null,
} = {}) {
  // v0.14（S01）：Native 不再自行编排通道写入——统一走共享 ChannelControlService。
  // 未注入时用既有依赖构造一个等价实例，保证旧调用方与测试行为不变。
  const control = channelControl ?? createChannelControlService({ outboundConfig, channelTest, saveInbound })
  const revisionView = () => {
    const current = revision.current()
    return { epoch: current.epoch, revision: current.revision }
  }
  const call = async (method, payload = {}, signal) => {
    try {
      if (method === 'surface.home') {
        const channelRows = channels.list()
        const taskRows = tasks.list()
        const questionRows = questions.list()
        const activityRows = activity.list({ limit: 5 })
        return ok({
          ...revisionView(),
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
          epoch: value.epoch,
          revision: value.revision,
          changed: value.revision > before,
          ...(value.topic ? { topic: value.topic } : {}),
          ...(value.capacity === true ? { capacity: true, retryAfterMs: Math.max(500, Number(value.retryAfterMs) || 1_000) } : {}),
        })
      }

      if (method === 'channels.list') {
        return ok({ ...revisionView(), channels: channels.list() })
      }

      if (method === 'channels.get') {
        const channel = channels.get(payload?.type)
        if (channel === null) {
          const error = new Error(`未知渠道 "${String(payload?.type ?? '')}"`)
          error.code = 'not-found'
          throw error
        }
        return ok({ ...revisionView(), channel })
      }

      if (method === 'channels.save') {
        const direction = String(payload?.direction ?? '')
        let result
        if (direction === 'outbound') {
          // v0.14（Stage F / P2-01）：出站保存的 revision/activity 唯一 owner 是
          // OutboundConfigService 的 domain event（onChange/onAudit，装配层已接线，Admin 与
          // Native 共用同一实例）。一处用户动作只应推进一代 revision、只记一条 activity——
          // 本层只做 RPC 形态映射，绝不再叠加 touch/record，避免 wait loop 被同一保存唤醒两次。
          result = control.saveOutbound(payload?.type, payload?.patch)
        } else if (direction === 'inbound') {
          const saved = await control.saveInbound(payload?.type, payload?.patch)
          result = {
            saved: true,
            applied: isHotApplied('inbound'),
            applyMode: inboundApplyMode(),
            configRevision: Number(saved?.configRevision) || 0,
          }
          // 入站没有 domain event（inbound port 只 warn 不 emit），故该 domain event 的唯一
          // owner 就是本 surface：入站保存由本层记账一次。
          revision.touch('channels')
          activity.record('configuration', 'channel-saved', {
            channel: String(payload?.type ?? ''),
            direction,
            saved: result.saved === true,
            hotApplied: result.applied === true,
          })
        } else {
          const error = new Error('direction 必须是 outbound 或 inbound')
          error.code = 'bad-request'
          throw error
        }
        return ok(result)
      }

      if (method === 'channels.test') {
        const type = String(payload?.type ?? '')
        const rawResult = await control.testOutbound(type)
        const raw = control.rawOutbound(type) ?? {}
        const safeRawResult = redactDiagnosticValue(rawResult, raw)
        health.recordTest(type, safeRawResult)
        revision.touch('health')
        const value = testResult(safeRawResult)
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
        return ok({ ...revisionView(), tasks: tasks.list() })
      }

      if (method === 'questions.list') {
        return ok({ ...revisionView(), questions: questions.list() })
      }

      if (method === 'questions.settle') {
        const value = questions.settle(payload)
        revision.touch('questions')
        activity.record('control', 'question-settled', { action: payload?.action ?? 'unknown', status: 'ok' })
        return ok(value)
      }

      // v0.14（S06）：Native 成员面。读取 / 校验 / 末位 owner 守卫都在共享
      // MembersControlService（S02）；本层只做 RPC 形态映射与 revision/activity 记账。
      if (members && method === 'members.list') {
        requireRead(members.canList, '成员数据当前不可用（身份绑定层未装配）')
        return ok({ ...revisionView(), members: members.list(), canUpdate: members.canUpdate === true, canRemove: members.canRemove === true })
      }

      if (members && method === 'members.update') {
        const value = members.update(payload)
        revision.touch('members')
        activity.record('control', 'member-updated', { channel: String(payload?.key ?? '').split(':')[0], status: 'ok' })
        return ok(value)
      }

      if (members && method === 'members.remove') {
        const value = members.remove(payload)
        revision.touch('members')
        activity.record('control', 'member-removed', { channel: String(payload?.key ?? '').split(':')[0], status: 'ok' })
        return ok(value)
      }

      // v0.14（S07）：Native 待确认身份 + 配对码面。同为共享 MembersControlService（S02）。
      if (members && method === 'members.pending') {
        requireRead(members.canList, '待确认身份当前不可用（身份绑定层未装配）')
        return ok({
          ...revisionView(),
          pending: members.listPending(),
          canApprove: members.canApprove === true,
          canDismiss: members.canDismiss === true,
        })
      }

      if (members && method === 'members.approve') {
        const value = members.approve(payload)
        revision.touch('members')
        activity.record('control', 'pending-approved', { status: 'ok' })
        return ok(value)
      }

      if (members && method === 'members.dismiss') {
        const value = members.dismiss(payload)
        revision.touch('members')
        activity.record('control', 'pending-dismissed', { status: 'ok' })
        return ok(value)
      }

      if (members && method === 'pairing.list') {
        requireRead(members.canList, '配对码列表当前不可用（身份绑定层未装配）')
        return ok({
          ...revisionView(),
          codes: members.listCodes(),
          canMint: members.canMint === true,
          canRevoke: members.canRevoke === true,
        })
      }

      if (members && method === 'pairing.mint') {
        const value = members.mintCode(payload)
        revision.touch('members')
        // 审计只记 id/来源，绝不记码面（码面只在本次响应出现一次）。
        activity.record('control', 'pairing-minted', { source: 'native', status: 'ok' })
        return ok(value)
      }

      if (members && method === 'pairing.revoke') {
        const value = members.revokeCode(payload)
        revision.touch('members')
        activity.record('control', 'pairing-revoked', { source: 'native', status: 'ok' })
        return ok(value)
      }

      // v0.14（S08）：Native 会话面。读取 / 校验 / 写入编排都在共享 RoutingControlService（S03）。
      if (sessions && method === 'sessions.list') {
        requireRead(sessions.canList, '会话数据当前不可用（路由层未装配）')
        return ok({ ...revisionView(), sessions: sessions.list(), canPatch: sessions.canPatch === true, canControl: sessions.canControl === true })
      }

      // v0.14（Stage E / P1-10）：Session Detail 单行读取（只读，不 touch revision / activity）。
      if (sessions && method === 'sessions.detail') {
        return ok({ ...revisionView(), ...sessions.detail(payload), canPatch: sessions.canPatch === true, canControl: sessions.canControl === true })
      }

      if (sessions && method === 'sessions.patch') {
        const value = sessions.patch(payload)
        revision.touch('sessions')
        activity.record('control', 'session-outbound', { status: 'ok' })
        return ok(value)
      }

      // v0.14（Stage E / P1-10）：会话控制覆盖层写入（mode/owner/approvalOwnerOnly/approvalMembers）。
      if (sessions && method === 'sessions.control') {
        const value = sessions.patchControl(payload)
        revision.touch('sessions')
        activity.record('control', 'session-control', { status: 'ok' })
        return ok(value)
      }

      // v0.14（S09）：Native 高级绑定面。写权威在 agent-router，经共享 RoutingControlService（S03）。
      if (bindings && method === 'bindings.get') {
        requireRead(bindings.canRead, '高级绑定当前不可用（路由层未装配）')
        return ok({ ...revisionView(), ...bindings.get(), canEdit: bindings.canEdit === true })
      }

      if (bindings && method === 'bindings.put') {
        const value = bindings.put(payload)
        revision.touch('bindings')
        activity.record('control', 'bindings-replaced', { status: 'ok' })
        return ok({ ...revisionView(), ...value, canEdit: bindings.canEdit === true })
      }

      // v0.14（S10）：只读 canonical 诊断快照。Diagnostics 不是 authority，
      // 不写状态、不自动修复，故不 touch revision、不记 activity。
      if (diagnostics && method === 'diagnostics.snapshot') {
        return ok({ ...revisionView(), ...diagnostics.snapshot() })
      }

      // v0.15（T21）：配置导出 / 导入。装配层注入共享 ConfigPortabilityService；未装配时
      // fail-closed（501 语义 = not-supported），绝不返回空文档冒充「无配置」。
      if (method.startsWith('cloudflare.')) {
        const action = method.slice('cloudflare.'.length)
        const allowed = new Set(['status', 'loginDevice', 'refresh', 'deploy', 'link', 'unbind', 'cancel', 'tunnelConfigure', 'tunnelStart', 'tunnelStop'])
        if (!allowed.has(action) || cloudflare === null) throw Object.assign(new Error('Cloudflare 部署不可用'), { code: 'not-supported' })
        return ok({ ...revisionView(), ...await cloudflare[action](payload) })
      }

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
        // 只读：只序列化已提交的 canonical 配置（不含 secret），不 touch revision。
        const value = portability.exportConfig(payload)
        return ok({ ...revisionView(), ...value, documentType: portability.documentType, formatVersion: portability.formatVersion })
      }

      if (method === 'portability.preview') {
        // 只读 dry-run：严格校验 + 生成计划；零写、零网络、不 touch revision。
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
        // 唯一 owner 记账：一次提交推进一代 revision、记一条 activity（绝不逐渠道重复）。
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

      // v0.15（T22）：可选 dsh-im 投递桥。状态只读可用性事实（服务缺失是正常态，不 fail-closed）；
      // 枚举/发送由桥接自身在服务缺失时抛 host-unavailable / not-supported。桥接未装配 → fail-closed。
      if (method === 'dshIm.status' || method === 'dshIm.listBots'
        || method === 'dshIm.listTargets' || method === 'dshIm.send') {
        if (dshIm === null) {
          const error = new Error('dsh-im 投递桥接当前不可用（本进程未装配）')
          error.code = 'not-supported'
          throw error
        }
      }

      if (method === 'dshIm.status') {
        return ok({ ...revisionView(), ...dshIm.status() })
      }

      if (method === 'dshIm.listBots') {
        return ok({ ...revisionView(), bots: await dshIm.listBots() })
      }

      if (method === 'dshIm.listTargets') {
        return ok({ ...revisionView(), targets: await dshIm.listTargets(payload?.botId) })
      }

      if (method === 'dshIm.send') {
        const value = await dshIm.send(payload)
        // 唯一 owner 记账：一次 send 记一条 activity（绝不重试或二次 send）。
        activity.record('notification', 'dsh-im-send', {
          channel: 'dsh-im',
          accepted: value.accepted === true,
          confirmed: value.confirmed === true,
          failed: value.unknown === true || value.rejected === true,
          status: value.rejected === true ? 'failed' : 'ok',
        })
        return ok(value)
      }

      // v0.15（T23）：dsh-im 已知格式迁移导入器。它把 dsh-im 导出翻译为 T21 portability v1
      // 文档，再交由 canonical portability 权威 dry-run / 提交；导入器自身零写、零网络，
      // 且绝不返回原始 detect 结果（那会携带源文档里的明文凭据），只暴露安全投影。
      if (method === 'dshIm.import.preview' || method === 'dshIm.import.commit'
        || method === 'dshIm.import.cancel') {
        if (dshImImport === null) {
          const error = new Error('dsh-im 迁移导入器当前不可用（本进程未装配）')
          error.code = 'not-supported'
          throw error
        }
      }

      if (method === 'dshIm.import.preview') {
        // 只读 dry-run：翻译 + 校验，零写、零网络，不 touch revision。
        return ok({ ...revisionView(), ...dshImImport.preview(payload) })
      }

      if (method === 'dshIm.import.cancel') {
        return ok(dshImImport.cancel(payload))
      }

      if (method === 'dshIm.import.commit') {
        const value = dshImImport.commit(payload)
        const applied = value.results.filter((row) => row.action === 'patched')
        const staged = value.results.filter((row) => row.action === 'staged')
        // 唯一 owner 记账：一次提交推进一代 revision、记一条 activity（绝不逐渠道重复）。
        revision.touch('channels')
        activity.record('configuration', 'config-imported', {
          source: 'dsh-im',
          applied: applied.length,
          staged: staged.length,
          skipped: value.results.filter((row) => row.action === 'skipped').length,
          status: 'ok',
        })
        return ok({ ...revisionView(), ...value })
      }

      // v0.15（T24）：远程入口 URL 校验。纯本地解析、零网络、零写、零 touch——绝不探测可达性、
      // 绝不构造深链。普通链接与二维码（qrPayload）等价，二者都来自同一规范化字符串（R04）。
      if (method === 'remote.validate') {
        const entry = buildRemoteEntry(payload?.url)
        if (entry.ok !== true) {
          const error = new Error(REMOTE_URL_REASONS[entry.reason] ?? '链接校验未通过')
          error.code = 'bad-request'
          throw error
        }
        return ok(entry)
      }

      if (method === 'activity.list') {
        return ok({ ...revisionView(), items: activity.list(payload) })
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
