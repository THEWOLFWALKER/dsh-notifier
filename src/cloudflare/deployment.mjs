import { createNativeTunnelService } from './tunnel.mjs'
// One deployment authority, one job per process. Cloud success and local binding are separate facts.
import { mkdirSync, cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { transactDurable } from '../inbound/store.mjs'
import { createWranglerRunner, WRANGLER_VERSION } from './wrangler-runner.mjs'
const PREFIX = 'cloudflare:deployment:'
const error = (message, code = 'bad-request') => Object.assign(new Error(message), { code })
const templates = fileURLToPath(new URL('./templates/', import.meta.url))
export function createCloudflareDeploymentService({ store, root, outboundConfig, inboundConfig, runner = null, tunnelService = null, fetchImpl = globalThis.fetch } = {}) {
  const tunnel = tunnelService ?? createNativeTunnelService({ store })
  const cli = runner ?? createWranglerRunner({ root })
  let job = null, disposed = false
  let recoveryQueue = [], recoveryScheduled = false
  const JOB_PREFIX = 'cloud:job:'
  const fingerprint = value => createHash('sha256').update(String(value)).digest('hex')
  const token = () => { const ref = store.get(`${PREFIX}telegram`)?.secretReference; return String((ref ? store.get(ref)?.botToken : outboundConfig.raw('telegram')?.botToken) ?? '').trim() }
  let accounts = [], login = null, lastError = null
  function mutate(fn) {
    const r = transactDurable(store, fn)
    if (!r.committed) throw error('保存失败，已创建的服务会保留', 'storage-failed')
    return r.value
  }
  const keyOf = type => `${PREFIX}${type}`
  const raw = type => store.get(keyOf(type)) ?? null
  const publicRow = r => r && ({ type: r.type, accountId: r.accountId, name: r.name, endpoint: r.endpoint ?? null, versionId: r.versionId ?? null, state: r.endpoint ? (r.bound ? 'bound' : 'unbound') : 'pending', linkedDirections: r.linkedDirections ?? [], enrollment: r.enrollment === true, health: r.health ?? 'unknown' })
  function status() {
    return { tunnel: tunnel.status(), wranglerVersion: WRANGLER_VERSION, accounts, login, job: job ? { id: job.id, kind: job.kind, step: job.step, state: job.state } : null, error: lastError, deployments: ['bark', 'telegram'].map(raw).filter(Boolean).map(publicRow) }
  }
  function saveJob(current, patch = {}) {
    const next = { ...current, ...patch, updatedAt: Date.now(), revision: (current.revision ?? 0) + 1 }
    const { controller, ...durable } = next
    mutate(draft => { draft[`${JOB_PREFIX}${current.id}`] = durable })
    Object.assign(current, next)
  }
  function start(kind, action, durable = null) {
    if (disposed) throw error('连接设置已关闭', 'host-unavailable')
    if (job) throw error('请等待当前操作结束', 'conflict')
    const controller = new AbortController()
    const current = { id: randomBytes(12).toString('hex'), kind, step: 'prepare', state: 'planned', createdAt: Date.now(), cancelRequested: false, recoveryRequired: false, revision: 0, ...durable, controller }
    if (durable) saveJob(current)
    job = current; lastError = null
    const check = () => { if (disposed || controller.signal.aborted || current.cancelRequested || job !== current) throw error('已取消', 'cancelled') }
    const step = value => { check(); if (durable) saveJob(current, { step: value, state: 'running' }); else current.step = value }
    void (async () => {
      try {
        await cli.prepare(controller.signal); check()
        await action({ signal: controller.signal, check, step, current }); check()
        if (durable) saveJob(current, { state: 'done', recoveryRequired: false })
      } catch (e) {
        if (durable && !disposed) {
          try { saveJob(current, { state: current.cancelRequested ? 'cancel-requested' : 'recovery-required', recoveryRequired: !current.cancelRequested, errorCode: e.code ?? 'operation-failed' }) } catch {}
        }
        if (!disposed && job === current) lastError = e.code === 'storage-failed' ? e.message : '操作未完成，请检查登录和网络后重试。已有服务会保留。'
      } finally { if (job === current) job = null; drainRecovery() }
    })()
    return status()
  }
  function loginDevice() {
    login = null
    return start('login', async ({ signal, step, check }) => {
      step('login')
      let output = ''
      await cli.loginDevice({ signal, onOutput: chunk => {
        output = (output + chunk).slice(-8192)
        const urls = output.match(/https:\/\/[A-Za-z0-9./?=&_%:-]+/g) ?? []
        const url = urls.find(u => { try { return new URL(u).hostname === 'dash.cloudflare.com' } catch { return false } })
        // Only official verification URL and user code, never OAuth/device token.
        const code = /(?:user code|enter (?:the )?code:?|code:)\s*([A-Z0-9-]{6,20})/i.exec(output)?.[1]
        if (url) login = { url, ...(code ? { code } : {}) }
      } })
      check(); accounts = (await cli.whoami({ signal })).accounts; login = null
    })
  }
  const refresh = () => start('refresh', async ({ signal, check }) => { const result = await cli.whoami({ signal }); check(); accounts = result.accounts })
  function deploy(payload = {}) {
    if (disposed || job) throw error('请等待当前操作结束', 'conflict')
    const type = payload.type
    if (!['bark', 'telegram'].includes(type)) throw error('请选择 Bark 或 Telegram')
    const accountId = String(payload.accountId ?? '')
    if (!accounts.some(a => a.id === accountId)) throw error('请选择已登录的 Cloudflare 账号')
    const previous = raw(type)
    if (previous && previous.accountId !== accountId) throw error('请使用原来的 Cloudflare 账号', 'conflict')
    const botToken = type === 'telegram' ? String(payload.botToken || token()).trim() : null
    if (type === 'telegram' && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw error('请填写有效的 Telegram Bot Token')
    if (type === 'telegram' && payload.activate === true && !String(payload.chatId || outboundConfig.raw('telegram')?.chatId || '').trim()) throw error('请填写接收者，再开启备用连接')
    const pending = store.keys(JOB_PREFIX).map(k => store.get(k)).find(r => r.kind === `deploy-${type}` && !['done', 'failed', 'cancel-requested'].includes(r.state))
    // Retry means recover the existing claim; do not create another operation over an uncertain one.
    if (pending) return resume(pending)
    const suffix = randomBytes(8).toString('hex')
    const record = { ...(previous ?? { type, accountId, name: `dn-${type}-${suffix}`, databaseName: `dn-bark-${suffix}`, bound: false }), enrollment: type === 'bark' && payload.enrollment === true }
    const claim = { id: randomBytes(12).toString('hex'), kind: `deploy-${type}`, type, resourceKey: keyOf(type), accountId, resourceIdentity: record.name, step: 'prepare', state: 'planned', createdAt: Date.now(), updatedAt: Date.now(), cancelRequested: false, recoveryRequired: false, revision: 0, options: { activate: payload.activate === true, inbound: payload.inbound === true, chatId: payload.chatId }, configSecretGeneration: botToken ? fingerprint(botToken) : null }
    if (type === 'telegram') record.secretReference = payload.botToken ? 'telegram:account' : (previous?.secretReference ?? 'channel:telegram:outbound')
    const secretPlan = type === 'telegram' && payload.botToken ? inboundConfig.planPut(type, { botToken }) : null
    mutate(draft => {
      secretPlan?.mergeInto(draft)
      delete record.botToken; delete record.gatewayKey
      draft[keyOf(type)] = record
      draft[`${JOB_PREFIX}${claim.id}`] = claim
      const terminal = Object.entries(draft).filter(([k, r]) => k.startsWith(JOB_PREFIX) && ['done', 'failed', 'cancel-requested'].includes(r.state)).sort((a,b) => b[1].updatedAt - a[1].updatedAt)
      for (const [k] of terminal.slice(64)) delete draft[k]
    })
    return runDeployment(claim, false)
  }
  function resume(claim) {
    if (claim.cancelRequested) return status()
    return runDeployment(claim, true)
  }
  function runDeployment(claim, recovery) {
    return start(claim.kind, async ({ signal, check, step, current }) => {
      let record = { ...raw(claim.type) }
      const type = claim.type, accountId = claim.accountId, payload = claim.options ?? {}
      const cwd = join(root, record.name)
      mkdirSync(cwd, { recursive: true, mode: 0o700 })
      cpSync(join(templates, type), cwd, { recursive: true })
      const config = { name: record.name, main: 'worker.mjs', compatibility_date: '2026-08-01', workers_dev: true, account_id: accountId, send_metrics: false, observability: { enabled: false }, ...(type === 'bark' ? { vars: { ALLOW_NEW_DEVICE: record.enrollment ? 'true' : 'false', ALLOW_QUERY_NUMS: 'false' } } : {}) }
      const saveRecord = () => mutate(draft => { draft[keyOf(type)] = { ...record } })
      if (type === 'bark') {
        step('database')
        const rows = (await cli.d1List({ accountId, signal })).filter(r => r.name === record.databaseName); check()
        if (rows.length > 1) throw error('服务结果不明确', 'conflict')
        if (!record.databaseId && rows.length === 1) { record.databaseId = rows[0].uuid; saveRecord() }
        if (record.databaseId) config.d1_databases = [{ binding: 'database', database_name: record.databaseName, database_id: record.databaseId, migrations_dir: 'migrations' }]
      }
      writeFileSync(join(cwd, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 })
      if (type === 'bark') {
        if (!record.databaseId) { const db = await cli.d1Create({ name: record.databaseName, cwd, accountId, signal }); record.databaseId = db.id; saveRecord(); check() }
        config.d1_databases = [{ binding: 'database', database_name: record.databaseName, database_id: record.databaseId, migrations_dir: 'migrations' }]
        writeFileSync(join(cwd, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 })
        step('migration'); await cli.d1Migrate({ cwd, accountId, signal }); check()
      }
      let deployments = null
      if (recovery && ['create', 'deploy', 'verify', 'apply'].includes(claim.step)) {
        deployments = await cli.readDeployment({ cwd, accountId, signal }); check()
        const latest = [...(deployments ?? [])].sort((a,b) => String(a.created_on ?? '').localeCompare(String(b.created_on ?? ''))).at(-1)
        if (latest && !record.endpoint) {
          const endpoint = latest.endpoint ?? current.remoteReceipt?.endpoint
          if (!endpoint || latest.versions?.length !== 1) throw error('请检查已有服务的地址', 'recovery-required')
          record.endpoint = endpoint; record.versionId = latest.versions[0].version_id; record.health = 'unknown'; record.secretGeneration = current.configSecretGeneration; saveRecord()
        }
        // A failed readback never proves absence. Only an explicit empty list allows create.
        if (!Array.isArray(deployments)) throw error('暂时无法确认已有服务', 'recovery-required')
      }
      if (!recovery || !record.endpoint) {
        step('create')
        const currentToken = token()
        if (type === 'telegram' && fingerprint(currentToken) !== current.configSecretGeneration) throw error('凭证已更改，请重新设置连接', 'conflict')
        const value = await cli.deployWorker({ cwd, accountId, name: record.name, signal, secrets: type === 'telegram' ? { BOT_TOKEN: currentToken } : {} })
        // Save the receipt before any cancellation check or local configuration apply.
        saveJob(current, { remoteReceipt: { endpoint: value.endpoint, versionId: value.versionId }, step: 'verify' })
        record.endpoint = value.endpoint; record.versionId = value.versionId; record.health = 'unknown'; record.bound = false; record.secretGeneration = current.configSecretGeneration; saveRecord(); check()
      }
      step('verify')
      deployments = await cli.readDeployment({ cwd, accountId, signal }); check()
      if (!Array.isArray(deployments) || !deployments.length) throw error('服务暂时无法确认', 'host-unavailable')
      const latest = [...deployments].sort((a,b) => String(a.created_on ?? '').localeCompare(String(b.created_on ?? ''))).at(-1)
      if (latest.versions?.length !== 1 || latest.versions[0].version_id !== record.versionId || latest.versions[0].percentage !== 100) throw error('当前服务尚未就绪', 'host-unavailable')
      if (type === 'telegram' && fingerprint(token()) !== current.configSecretGeneration) throw error('凭证已更改，请重新设置连接', 'conflict')
      const response = await fetchImpl(`${record.endpoint}/healthz`, { headers: type === 'telegram' ? { 'x-notifier-gateway-key': token() } : {}, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error' })
      const health = await response.json(); check()
      if (!response.ok || health.template !== `notifier-${type}-v1`) throw error('服务检查未通过', 'host-unavailable')
      record.health = 'ready'; saveRecord()
      if (payload.activate === true && type === 'telegram') {
        step('apply')
        const result = link({ type, chatId: payload.chatId, directions: payload.inbound ? ['outbound', 'inbound'] : ['outbound'] }, true)
        saveJob(current, { applyReceipt: { linked: true, directions: result.results.map(r => r.direction) } })
        if (result.results.some(r => r.restartPending === true || r.applied === false)) throw error('设置已保存，请重试开启连接', 'apply-failed')
      }
    }, claim)
  }
  function link({ type, directions = ['outbound'], barkKey, chatId } = {}, deploymentJob = false) {
    if (disposed || (job && !deploymentJob)) throw error('请等待当前操作结束', 'conflict')
    const record = raw(type)
    if (!record?.endpoint || record.health !== 'ready') throw error('请先完成连接设置和检查')
    if (type === 'telegram' && record.secretGeneration && fingerprint(token()) !== record.secretGeneration) throw error('凭证已更改，请重新设置连接', 'conflict')
    if (!Array.isArray(directions) || directions.length === 0 || directions.some(d => !['outbound', 'inbound'].includes(d)) || (type === 'bark' && directions.includes('inbound'))) throw error('请选择通知或私聊')
    const patch = type === 'telegram' ? { apiBase: record.endpoint, gatewayKey: token(), botToken: token(), ...(chatId ? { chatId: String(chatId) } : {}) } : { server: record.endpoint, barkUrl: null, ...(barkKey ? { key: String(barkKey) } : {}) }
    const plans = [...new Set(directions)].map(direction => ({ direction, plan: direction === 'outbound' ? outboundConfig.planPatch(type, patch) : inboundConfig.planPut(type, { apiBase: patch.apiBase, gatewayKey: patch.gatewayKey, botToken: patch.botToken }) }))
    const committed = new Map()
    mutate(draft => {
      const fresh = draft[keyOf(type)]
      if (fresh?.versionId !== record.versionId) throw error('连接已更新，请刷新后重试', 'conflict')
      const backup = { ...(fresh.backup ?? {}) }
      for (const { direction, plan } of plans) {
        if (!(direction in backup)) {
          const row = direction === 'outbound' ? outboundConfig.raw(type) : draft[`${type}:account`] ?? {}
          backup[direction] = Object.fromEntries(['apiBase', ...(type === 'bark' ? ['server', 'barkUrl'] : [])].map(k => [k, row[k] ?? null]))
        }
        committed.set(direction, plan.mergeInto(draft))
      }
      draft[keyOf(type)] = { ...fresh, bound: true, backup, appliedSecretGeneration: type === 'telegram' ? fingerprint(token()) : null, linkedDirections: [...new Set([...(fresh.linkedDirections ?? []), ...directions])] }
    })
    const results = plans.map(({ direction }) => ({ direction, ...(direction === 'outbound' ? outboundConfig.applyCommitted(type, committed.get(direction)) : inboundConfig.applyCommitted(type)) }))
    return { linked: true, results, deployment: publicRow(raw(type)) }
  }
  function unbind({ type } = {}) {
    if (job) throw error('请等待当前操作结束', 'conflict')
    const record = raw(type)
    if (!record || (!record.bound && !record.linkedDirections?.length)) return { unbound: true }
    // Restore only our endpoint/key if it is still current. Preserve later manual edits.
    const changed = []
    mutate(draft => {
      for (const direction of record.linkedDirections ?? []) {
        const key = direction === 'outbound' ? `channel:${type}:outbound` : `${type}:account`
        const row = draft[key]
        const endpointKey = type === 'bark' ? 'server' : 'apiBase'
        if (!row || row[endpointKey] !== record.endpoint || (type === 'telegram' && fingerprint(row.gatewayKey) !== record.appliedSecretGeneration)) continue
        const next = { ...row }
        if (type === 'telegram') delete next.gatewayKey
        for (const [k, v] of Object.entries(record.backup?.[direction] ?? {})) { if (v === null) delete next[k]; else next[k] = v }
        draft[key] = next; changed.push({ direction, row: next })
      }
      draft[keyOf(type)] = { ...draft[keyOf(type)], bound: false, backup: {}, linkedDirections: [] }
    })
    const results = changed.map(({ direction, row }) => ({ direction, ...(direction === 'outbound' ? outboundConfig.applyCommitted(type, row) : inboundConfig.applyCommitted(type)) }))
    return { unbound: true, resourcesRetained: true, results }
  }
  // Upgrade old deployment rows once: Config keeps the secret; deployment metadata does not.
  for (const type of ['bark', 'telegram']) {
    const r = raw(type)
    if (r && (r.botToken || r.gatewayKey || Object.values(r.backup ?? {}).some(b => b.gatewayKey))) {
      const plan = type === 'telegram' && !token() && r.botToken ? inboundConfig.planPut(type, { botToken: r.botToken }) : null
      mutate(draft => {
        plan?.mergeInto(draft)
        const next = { ...draft[keyOf(type)] }; delete next.botToken; delete next.gatewayKey
        if (plan) next.secretReference = 'telegram:account'
        next.backup = Object.fromEntries(Object.entries(next.backup ?? {}).map(([direction,b]) => { const copy = { ...b }; delete copy.gatewayKey; return [direction,copy] }))
        draft[keyOf(type)] = next
      })
    }
  }
  // Terminal history is bounded even if no new deployment is requested after restart.
  const terminal = store.keys(JOB_PREFIX).map(k => [k, store.get(k)]).filter(([,r]) => ['done', 'failed', 'cancel-requested'].includes(r?.state)).sort((a,b) => b[1].updatedAt - a[1].updatedAt)
  const expired = terminal.filter(([,r], i) => i >= 64 || r.updatedAt < Date.now() - 7 * 86400000)
  if (expired.length) mutate(draft => { for (const [k] of expired) delete draft[k] })
  function drainRecovery() {
    if (disposed || job || recoveryScheduled || !recoveryQueue.length) return
    recoveryScheduled = true
    queueMicrotask(() => {
      recoveryScheduled = false
      if (disposed || job) return
      const next = recoveryQueue.shift()
      try { resume(next) } catch { lastError = '请重试连接设置'; drainRecovery() }
    })
  }
  const unfinished = store.keys(JOB_PREFIX).map(k => store.get(k)).filter(r => r?.kind?.startsWith('deploy-') && !['done', 'failed', 'cancel-requested'].includes(r.state))
  recoveryQueue = unfinished.sort((a,b) => a.createdAt - b.createdAt)
  drainRecovery()
  return { status, loginDevice, refresh, deploy, link, unbind,
    tunnelConfigure: payload => tunnel.configure(payload),
    tunnelStart: payload => tunnel.start(payload),
    tunnelStop: () => tunnel.stop(),
    cancel() { if (job) { if (job.kind.startsWith('deploy-')) saveJob(job, { cancelRequested: true, state: 'cancel-requested', recoveryRequired: false }); job.controller.abort() }; return status() },
    dispose() { disposed = true; job?.controller.abort(); cli.dispose(); tunnel.dispose() },
  }
}
