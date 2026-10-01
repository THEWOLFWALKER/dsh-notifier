// One deployment authority, one job per process. Cloud success and local binding are separate facts.
import { mkdirSync, cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { transactDurable } from '../inbound/store.mjs'
import { createWranglerRunner, WRANGLER_VERSION } from './wrangler-runner.mjs'
const PREFIX = 'cloudflare:deployment:'
const error = (message, code = 'bad-request') => Object.assign(new Error(message), { code })
const templates = fileURLToPath(new URL('./templates/', import.meta.url))
export function createCloudflareDeploymentService({ store, root, outboundConfig, inboundConfig, runner = null, fetchImpl = globalThis.fetch } = {}) {
  const cli = runner ?? createWranglerRunner({ root })
  let job = null, sequence = 0, disposed = false
  let accounts = [], login = null, lastError = null
  function mutate(fn) {
    const r = transactDurable(store, fn)
    if (!r.committed) throw error('本地保存失败，云资源不会自动删除', 'storage-failed')
    return r.value
  }
  const keyOf = type => `${PREFIX}${type}`
  const raw = type => store.get(keyOf(type)) ?? null
  const publicRow = r => r && ({ type: r.type, accountId: r.accountId, name: r.name, endpoint: r.endpoint ?? null, versionId: r.versionId ?? null, state: r.endpoint ? (r.bound ? 'bound' : 'unbound') : 'pending', linkedDirections: r.linkedDirections ?? [], enrollment: r.enrollment === true, health: r.health ?? 'unknown' })
  function status() {
    return { wranglerVersion: WRANGLER_VERSION, accounts, login, job: job ? { id: job.id, kind: job.kind, step: job.step } : null, error: lastError, deployments: ['bark', 'telegram'].map(raw).filter(Boolean).map(publicRow) }
  }
  function start(kind, action) {
    if (disposed) throw error('Cloudflare 已关闭', 'host-unavailable')
    if (job) throw error('请等待当前操作结束', 'conflict')
    const controller = new AbortController()
    const current = { id: ++sequence, kind, step: 'preparing', controller }
    job = current; lastError = null
    const check = () => { if (disposed || controller.signal.aborted || job !== current) throw error('已取消', 'conflict') }
    const step = value => { check(); current.step = value }
    void (async () => {
      try { await cli.prepare(controller.signal); check(); await action({ signal: controller.signal, check, step }); check() }
      catch (e) { if (!disposed && job === current) lastError = e.code === 'storage-failed' ? e.message : '操作未完成。检查登录、权限或网络后重试；已有云资源会保留。' }
      finally { if (job === current) job = null }
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
    if (previous && previous.accountId !== accountId) throw error('此服务已有另一账号的资源，请使用原账号', 'conflict')
    const botToken = type === 'telegram' ? String(payload.botToken || previous?.botToken || outboundConfig.raw('telegram')?.botToken || '').trim() : null
    if (type === 'telegram' && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw error('请填写有效的 Telegram Bot Token')
    if (type === 'telegram' && payload.activate === true && !String(payload.chatId || outboundConfig.raw('telegram')?.chatId || '').trim()) throw error('请填写接收者，再开启网关')
    const suffix = randomBytes(8).toString('hex')
    // Durable ownership claim before any cloud resource creation. Retry always reuses it.
    const record = previous ?? { type, accountId, name: `dn-${type}-${suffix}`, databaseName: `dn-bark-${suffix}`, bound: false }
    if (botToken) { record.botToken = botToken; record.gatewayKey = botToken }
    record.enrollment = type === 'bark' && payload.enrollment === true
    mutate(draft => { draft[keyOf(type)] = record })
    return start(`deploy-${type}`, async ({ signal, check, step }) => {
      const cwd = join(root, record.name)
      mkdirSync(cwd, { recursive: true, mode: 0o700 })
      cpSync(join(templates, type), cwd, { recursive: true })
      const config = { name: record.name, main: 'worker.mjs', compatibility_date: '2026-08-01', workers_dev: true, account_id: accountId, send_metrics: false, observability: { enabled: false }, ...(type === 'bark' ? { vars: { ALLOW_NEW_DEVICE: record.enrollment ? 'true' : 'false', ALLOW_QUERY_NUMS: 'false' } } : {}) }
      if (type === 'bark') {
        step('database')
        // Resolve an ambiguous create using exact durable unique name, never repeat creation blindly.
        const databases = await cli.d1List({ accountId, signal }); check()
        const rows = databases.filter(r => r.name === record.databaseName)
        if (rows.length > 1) throw error('数据库结果不明确', 'conflict')
        if (!record.databaseId && rows.length === 1) record.databaseId = rows[0].uuid
        if (record.databaseId) config.d1_databases = [{ binding: 'database', database_name: record.databaseName, database_id: record.databaseId, migrations_dir: 'migrations' }]
      }
      writeFileSync(join(cwd, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 })
      if (type === 'bark') {
        if (!record.databaseId) { const db = await cli.d1Create({ name: record.databaseName, cwd, accountId, signal }); check(); record.databaseId = db.id }
        mutate(draft => { draft[keyOf(type)] = record })
        config.d1_databases = [{ binding: 'database', database_name: record.databaseName, database_id: record.databaseId, migrations_dir: 'migrations' }]
        writeFileSync(join(cwd, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 })
        step('migration'); await cli.d1Migrate({ cwd, accountId, signal }); check()
      }
      step('deploy')
      const value = await cli.deployWorker({ cwd, accountId, name: record.name, signal, secrets: type === 'telegram' ? { BOT_TOKEN: record.botToken } : {} })
      check(); record.endpoint = value.endpoint; record.versionId = value.versionId; record.health = 'unknown'; record.bound = false
      // Persist cloud success before verification/binding. Never pretend a read-back failure undid deployment.
      mutate(draft => { draft[keyOf(type)] = record })
      step('verify'); const deployments = await cli.readDeployment({ cwd, accountId, signal }); check()
      if (!Array.isArray(deployments) || !deployments.length) throw error('部署记录读回为空', 'host-unavailable')
      const latest = [...deployments].sort((a, b) => String(a.created_on ?? '').localeCompare(String(b.created_on ?? ''))).at(-1)
      if (latest.versions?.length !== 1 || latest.versions[0].version_id !== record.versionId || latest.versions[0].percentage !== 100) throw error('当前生效的服务版本不一致', 'host-unavailable')
      const response = await fetchImpl(`${record.endpoint}/healthz`, { headers: type === 'telegram' ? { 'x-notifier-gateway-key': record.gatewayKey } : {}, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error' })
      const health = await response.json(); check()
      if (!response.ok || health.template !== `notifier-${type}-v1`) throw error('部署完成，服务读回未通过', 'host-unavailable')
      record.health = 'ready'; mutate(draft => { draft[keyOf(type)] = record })
      if (payload.activate === true && type === 'telegram') {
        check(); link({ type, chatId: payload.chatId, directions: payload.inbound === true ? ['outbound', 'inbound'] : ['outbound'] }, true)
      }
    })
  }
  function link({ type, directions = ['outbound'], barkKey, chatId } = {}, deploymentJob = false) {
    if (disposed || (job && !deploymentJob)) throw error('请等待当前操作结束', 'conflict')
    const record = raw(type)
    if (!record?.endpoint || record.health !== 'ready') throw error('请先完成部署和服务检查')
    if (!Array.isArray(directions) || directions.length === 0 || directions.some(d => !['outbound', 'inbound'].includes(d)) || (type === 'bark' && directions.includes('inbound'))) throw error('请选择有效的绑定方向')
    const patch = type === 'telegram' ? { apiBase: record.endpoint, gatewayKey: record.gatewayKey, botToken: record.botToken, ...(chatId ? { chatId: String(chatId) } : {}) } : { server: record.endpoint, barkUrl: null, ...(barkKey ? { key: String(barkKey) } : {}) }
    const plans = [...new Set(directions)].map(direction => ({ direction, plan: direction === 'outbound' ? outboundConfig.planPatch(type, patch) : inboundConfig.planPut(type, { apiBase: patch.apiBase, gatewayKey: patch.gatewayKey, botToken: patch.botToken }) }))
    const committed = new Map()
    mutate(draft => {
      const fresh = draft[keyOf(type)]
      if (fresh?.versionId !== record.versionId) throw error('部署已更新，请刷新后绑定', 'conflict')
      const backup = { ...(fresh.backup ?? {}) }
      for (const { direction, plan } of plans) {
        if (!(direction in backup)) {
          const row = direction === 'outbound' ? outboundConfig.raw(type) : draft[`${type}:account`] ?? {}
          backup[direction] = Object.fromEntries(['apiBase', 'gatewayKey', ...(type === 'bark' ? ['server', 'barkUrl'] : [])].map(k => [k, row[k] ?? null]))
        }
        committed.set(direction, plan.mergeInto(draft))
      }
      draft[keyOf(type)] = { ...fresh, bound: true, backup, linkedDirections: [...new Set([...(fresh.linkedDirections ?? []), ...directions])] }
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
        if (!row || row[endpointKey] !== record.endpoint || (type === 'telegram' && row.gatewayKey !== record.gatewayKey)) continue
        const next = { ...row }
        for (const [k, v] of Object.entries(record.backup?.[direction] ?? {})) { if (v === null) delete next[k]; else next[k] = v }
        draft[key] = next; changed.push({ direction, row: next })
      }
      draft[keyOf(type)] = { ...draft[keyOf(type)], bound: false, backup: {}, linkedDirections: [] }
    })
    const results = changed.map(({ direction, row }) => ({ direction, ...(direction === 'outbound' ? outboundConfig.applyCommitted(type, row) : inboundConfig.applyCommitted(type)) }))
    return { unbound: true, resourcesRetained: true, results }
  }
  return { status, loginDevice, refresh, deploy, link, unbind,
    cancel() { job?.controller.abort(); return status() },
    dispose() { disposed = true; job?.controller.abort(); cli.dispose() },
  }
}
