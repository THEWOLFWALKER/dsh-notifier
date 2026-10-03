// dsh-notifier v0.15 Stage 4 — optional dsh-im checked-delivery bridge.
// Only contractVersion 1 is accepted. Discovery is revalidated before each send;
// credentials and target routes never cross the bridge boundary. There is no send fallback.
import { createHash } from 'node:crypto'
import { readHostService } from '../host/seam.mjs'

const ERROR_CODES = Object.freeze({ UNAVAILABLE: 'host-unavailable', NO_TARGET: 'bad-request', UNSUPPORTED: 'not-supported' })
const PRE_SEND_REJECTIONS = new Set(['account-unverified', 'account-changed', 'target-changed', 'capability-unavailable', 'unknown-target', 'unknown-bot', 'fingerprint-mismatch', 'target-digest-mismatch'])
const FINGERPRINT_RE = /^[a-f0-9]{64}$/
const str = value => typeof value === 'string' ? value.trim() : ''
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isFingerprint = value => FINGERPRINT_RE.test(str(value))

function bridgeError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}
/** SHA-256(UTF-8 JSON({kind,route})), with object keys sorted. */
export function expectedTargetDigest(target) {
  if (!isRecord(target) || !str(target.kind) || !isRecord(target.route)) return null
  return createHash('sha256').update(JSON.stringify({ kind: str(target.kind), route: stableValue(target.route) }), 'utf8').digest('hex')
}
function errorCode(error) { return str(error?.code).replace(/^dsh-im\//, '').toLowerCase() }
function looksUncertain(error) {
  if (!isRecord(error)) return true
  return /timeout|timed.?out|abort|cancel|econnreset|econnrefused|socket|network|超时|中断|网络/.test(`${errorCode(error)} ${str(error.name)} ${str(error.message)}`.toLowerCase())
}
/** Bound host calls even when the service ignores AbortSignal. */
async function withDeadline(invoke, { timeoutMs, signal } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('operation cancelled'), { name: 'AbortError', code: 'ABORT_ERR' })
  const controller = new AbortController()
  let timer
  let removeAbort = () => {}
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(Object.assign(new Error('dsh-im operation timed out'), { name: 'TimeoutError', code: 'ETIMEDOUT' }))
    }, timeoutMs)
  })
  const aborted = signal ? new Promise((_, reject) => {
    const onAbort = () => {
      controller.abort()
      reject(Object.assign(new Error('dsh-im operation cancelled'), { name: 'AbortError', code: 'ABORT_ERR' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbort = () => signal.removeEventListener('abort', onAbort)
  }) : new Promise(() => {})
  try { return await Promise.race([Promise.resolve().then(() => invoke(controller.signal)), timeout, aborted]) }
  finally { clearTimeout(timer); removeAbort() }
}

export function createDshImBridge({ readService = null, ctx = null, warn = null, readTimeoutMs = 5_000, sendTimeoutMs = 15_000 } = {}) {
  const report = message => { try { warn?.(message) } catch { /* diagnostics must not break delivery */ } }
  const reader = typeof readService === 'function' ? readService : () => { try { return readHostService(ctx, 'dshIm') } catch { return null } }
  let epoch = 0
  let current = null
  const observe = () => {
    let service = null
    try { service = reader() } catch { service = null }
    service = isRecord(service) ? service : null
    if (service !== current) { current = service; epoch += 1 }
    return service
  }
  const validService = service => service !== null && service.contractVersion === 1
  const status = () => {
    const service = observe()
    const valid = validService(service)
    const hasListBots = valid && typeof service.listBots === 'function'
    const hasDescribeBot = valid && typeof service.describeBot === 'function'
    const hasListTargets = valid && typeof service.listTargets === 'function'
    const hasSendChecked = valid && typeof service.sendChecked === 'function'
    const complete = hasListBots && hasDescribeBot && hasListTargets && hasSendChecked
    return {
      available: complete,
      reason: service === null ? 'no-dsh-im' : !valid ? 'unsupported-contract' : complete ? 'ok' : 'incomplete-contract',
      contractVersion: service?.contractVersion ?? null,
      hasListBots, hasDescribeBot, hasListTargets, hasSendChecked,
    }
  }
  const requireService = service => {
    if (service === null) throw bridgeError('dsh-im 服务不可用', ERROR_CODES.UNAVAILABLE)
    if (!validService(service)) throw bridgeError('dsh-im contractVersion 必须为 1', ERROR_CODES.UNSUPPORTED)
    return service
  }
  const describe = (service, botId, signal) => {
    if (typeof service.describeBot !== 'function') throw bridgeError('dsh-im 服务不支持 describeBot', ERROR_CODES.UNSUPPORTED)
    return withDeadline(() => service.describeBot(botId), { timeoutMs: readTimeoutMs, signal })
  }
  const botProjection = (raw, description) => {
    if (!isRecord(raw) || !isRecord(description)) return null
    const botId = str(raw.botId ?? raw.id ?? description.botId)
    if (!botId) return null
    const channel = str(description.channel ?? raw.channel)
    const label = str(description.label ?? description.name ?? raw.label ?? raw.name) || botId
    const accountFingerprint = str(description.accountFingerprint ?? description.fingerprint)
    const capabilities = Array.isArray(description.capabilities) ? description.capabilities : []
    return {
      botId, ...(channel ? { channel } : {}), label,
      ...(isFingerprint(accountFingerprint) ? { accountFingerprint } : {}),
      connected: description.connected === true,
      checked: capabilities.includes('proactive-text-checked') && isFingerprint(accountFingerprint),
    }
  }
  const findBot = async (service, botId, signal) => {
    const wanted = str(botId)
    if (!wanted) return null
    if (typeof service.listBots !== 'function') throw bridgeError('dsh-im 服务不支持 listBots', ERROR_CODES.UNSUPPORTED)
    const raw = await withDeadline(() => service.listBots(), { timeoutMs: readTimeoutMs, signal })
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.bots) ? raw.bots : []
    const row = rows.find(item => isRecord(item) && str(item.botId ?? item.id) === wanted)
    if (!row) return null
    return botProjection(row, await describe(service, wanted, signal))
  }
  const checkedBot = async (service, botId, signal) => {
    const bot = await findBot(service, botId, signal)
    if (!bot) throw bridgeError('dsh-im bot 不存在或无法验证', 'not-found')
    if (bot.checked !== true || bot.connected !== true) throw bridgeError('dsh-im bot 不支持已验证的主动文本投递', 'not-supported')
    return bot
  }

  async function listBots({ signal } = {}) {
    const service = requireService(observe())
    if (typeof service.listBots !== 'function' || typeof service.describeBot !== 'function') throw bridgeError('dsh-im 服务不支持 bot discovery', ERROR_CODES.UNSUPPORTED)
    const raw = await withDeadline(() => service.listBots(), { timeoutMs: readTimeoutMs, signal })
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.bots) ? raw.bots : []
    const output = []
    for (const row of rows) {
      const botId = isRecord(row) ? str(row.botId ?? row.id) : ''
      if (!botId) continue
      try {
        const projected = botProjection(row, await describe(service, botId, signal))
        if (projected) output.push(projected)
      } catch { /* malformed or unresponsive bots fail closed individually */ }
    }
    return output
  }
  async function listTargets(botId, { signal } = {}) {
    const service = requireService(observe())
    if (typeof service.listTargets !== 'function') throw bridgeError('dsh-im 服务不支持 listTargets', ERROR_CODES.UNSUPPORTED)
    const bot = await checkedBot(service, botId, signal)
    const raw = await withDeadline(() => service.listTargets(bot.botId), { timeoutMs: readTimeoutMs, signal })
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.targets) ? raw.targets : []
    return rows.flatMap(target => {
      if (!isRecord(target)) return []
      const targetId = str(target.targetId ?? target.id)
      const digest = expectedTargetDigest(target)
      if (!targetId || !digest) return []
      return [{ targetId, label: str(target.label ?? target.name ?? target.title) || targetId, kind: str(target.kind), expectedTargetDigest: digest }]
    })
  }
  async function send(input = {}, { signal } = {}) {
    const botId = str(input.botId), targetId = str(input.targetId), text = str(input.text)
    const expectedFingerprint = str(input.expectedFingerprint), targetDigest = str(input.expectedTargetDigest)
    const options = isRecord(input.options) ? input.options : {}
    if (!botId || !targetId || !text) throw bridgeError('必须选择 bot、私聊目标并填写正文', ERROR_CODES.NO_TARGET)
    if (!isFingerprint(expectedFingerprint) || !FINGERPRINT_RE.test(targetDigest)) throw bridgeError('缺少有效的账户指纹或目标校验摘要', ERROR_CODES.NO_TARGET)
    if (options.media != null || options.interactive === true || options.card != null) throw bridgeError('dsh-im checked bridge 仅支持纯文本投递', ERROR_CODES.UNSUPPORTED)
    const format = options.format === 'markdown' ? 'markdown' : 'plain'
    const service = requireService(observe())
    if (typeof service.sendChecked !== 'function') throw bridgeError('dsh-im 服务不支持 sendChecked', ERROR_CODES.UNSUPPORTED)
    try {
      const bot = await checkedBot(service, botId, signal)
      if (bot.accountFingerprint !== expectedFingerprint) return rejected('account-changed')
      if (typeof service.listTargets !== 'function') throw bridgeError('dsh-im 服务不支持 listTargets', ERROR_CODES.UNSUPPORTED)
      const rawTargets = await withDeadline(() => service.listTargets(botId), { timeoutMs: readTimeoutMs, signal })
      const targets = Array.isArray(rawTargets) ? rawTargets : Array.isArray(rawTargets?.targets) ? rawTargets.targets : []
      const target = targets.find(row => isRecord(row) && str(row.targetId ?? row.id) === targetId)
      if (!target) return rejected('unknown-target')
      if (expectedTargetDigest(target) !== targetDigest) return rejected('target-changed')
      if (observe() !== service) return unknown('service-replaced')
      const startEpoch = epoch
      const result = await withDeadline(signalForSend => {
        if (observe() !== service || epoch !== startEpoch) throw bridgeError('dsh-im 服务在发送前被替换', 'service-replaced')
        return service.sendChecked(botId, targetId, text, {
          expectedFingerprint, expectedTargetDigest: targetDigest, format, signal: signalForSend,
        })
      }, { timeoutMs: sendTimeoutMs, signal })
      if (observe() !== service || epoch !== startEpoch) {
        report('dsh-im checked send 期间服务被替换，晚到结果按 unknown 隔离')
        return unknown('service-replaced')
      }
      const resultCode = errorCode(result) || errorCode(result?.error) || str(result?.reason).toLowerCase()
      if (PRE_SEND_REJECTIONS.has(resultCode)) return rejected(resultCode)
      if (result === true || (isRecord(result) && (result.sent === true || result.accepted === true || result.ok === true))) return accepted()
      if (result === false || (isRecord(result) && (result.sent === false || result.rejected === true || result.status === 'rejected'))) return rejected(resultCode || 'rejected')
      return unknown('ambiguous')
    } catch (error) {
      if (observe() !== service) return unknown('service-replaced')
      const code = errorCode(error)
      if (PRE_SEND_REJECTIONS.has(code)) return rejected(code)
      if (code === 'not-supported') return rejected('capability-unavailable')
      if (code === 'not-found') return rejected('unknown-bot')
      if (looksUncertain(error)) return unknown(code === 'etimedout' || code === 'abort_err' ? 'timeout' : 'uncertain')
      return unknown('sdk-ambiguous')
    }
  }
  function accepted() { return { ok: true, accepted: true, confirmed: false, unknown: false, rejected: false } }
  function rejected(reason) { return { ok: false, accepted: false, confirmed: false, unknown: false, rejected: true, reason } }
  function unknown(reason) { return { ok: false, accepted: false, confirmed: false, unknown: true, rejected: false, reason } }
  return Object.freeze({ status, listBots, listTargets, send, get epoch() { return epoch } })
}
