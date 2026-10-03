import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/inbound/store.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createInboundChannelConfigPort } from '../src/inbound/channel-config.mjs'
import { createConfigPortabilityService } from '../src/control-plane/config-portability.mjs'
import { createCloudflareDeploymentService } from '../src/cloudflare/deployment.mjs'
import { createTelegramWorker } from '../src/cloudflare/templates/telegram/worker.mjs'
import { telegramRequest } from '../src/cloudflare/telegram-transport.mjs'
import { deploymentFromOutput, createWranglerRunner } from '../src/cloudflare/wrangler-runner.mjs'
import { EventEmitter } from 'node:events'
import { createNativeTunnelService } from '../src/cloudflare/tunnel.mjs'
import { writeFileSync } from 'node:fs'
const ACCOUNT = 'a'.repeat(32)
const BOT = '123456:fixture_token_abcdef'
const KEY = BOT
const req = (path, init = {}) => new Request(`https://worker.example${path}`, { headers: { 'x-notifier-gateway-key': KEY }, ...init })
const env = { BOT_TOKEN: BOT }

test('CF gateway rejects absent credentials, query keys, arbitrary upstream and tokens before fetch', async () => {
  let calls = 0
  const w = createTelegramWorker(() => { calls++; throw Error('must not send') })
  for (const [request, secrets, expected] of [
    [req('/api/getMe'), {}, 503], [new Request('https://worker.example/api/getMe'), env, 401],
    [req('/api/getMe?key=secret'), env, 403], [req('/api/getMe?api_base=https://internal'), env, 403],
    [req('/bot999:other/sendMessage'), env, 404], [req('/file/%2e%2e/private'), env, 404],
  ]) assert.equal((await w.fetch(request, secrets)).status, expected)
  assert.equal(calls, 0)
})
test('CF gateway preserves multipart bytes, fixed identity, 429 and Retry-After without forwarding auth', async () => {
  const body = '--fixture\r\nContent-Disposition: form-data; name="photo"\r\n\r\nraw\x00bytes\r\n--fixture--'
  let captured
  const w = createTelegramWorker(async request => {
    captured = request
    assert.equal(await request.text(), body)
    return new Response('{"ok":false,"parameters":{"retry_after":7}}', { status: 429, headers: { 'retry-after': '7', 'content-type': 'application/json' } })
  })
  const response = await w.fetch(req('/api/sendPhoto', { method: 'POST', body, headers: { 'x-notifier-gateway-key': KEY, 'content-type': 'multipart/form-data; boundary=fixture', authorization: 'secret' } }), env)
  assert.equal(captured.url, `https://api.telegram.org/bot${BOT}/sendPhoto`)
  assert.equal(captured.headers.get('x-notifier-gateway-key'), null)
  assert.equal(captured.headers.get('authorization'), null)
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '7')
})
test('CF gateway passes file streams and propagates abort without error details', async () => {
  const c = new AbortController()
  const worker = createTelegramWorker(async request => {
    assert.equal(request.url, `https://api.telegram.org/file/bot${BOT}/photos/file.jpg`)
    assert.equal(request.signal.aborted, true)
    throw Error(`private: ${BOT}`)
  })
  c.abort()
  const result = await worker.fetch(req('/file/photos/file.jpg', { signal: c.signal }), env)
  assert.equal(result.status, 502); assert.doesNotMatch(await result.text(), /private|fixture_token/)
})
test('CF transport omits token from gateway URLs; direct URL stays compatible', () => {
  assert.deepEqual(telegramRequest({ botToken: BOT, gatewayKey: KEY, apiBase: 'https://gateway.example' }, 'answerCallbackQuery'), { url: 'https://gateway.example/api/answerCallbackQuery', headers: { 'x-notifier-gateway-key': KEY } })
  assert.equal(telegramRequest({ botToken: BOT }, 'getUpdates').url, `https://api.telegram.org/bot${BOT}/getUpdates`)
  assert.throws(() => telegramRequest({ botToken: BOT, gatewayKey: KEY }, 'getMe'))
})
test('CF deployment parses structured output only and refuses ambiguous cloud success', () => {
  const row = { type: 'deploy', worker_name: 'dn-test', version_id: 'version1', targets: ['https://dn-test.user.workers.dev'] }
  assert.equal(deploymentFromOutput(JSON.stringify(row), 'dn-test').versionId, 'version1')
  assert.throws(() => deploymentFromOutput(`${JSON.stringify(row)}\n${JSON.stringify(row)}`, 'dn-test'))
  assert.throws(() => deploymentFromOutput('Deployed dn-test https://dn-test.user.workers.dev', 'dn-test'))
})
function rig({ failDeploy = false, failReadback = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dn-cf-'))
  const store = createStore(join(root, 'state.json'))
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({ store, source, yamlRows: new Map(), allowLegacy: false })
  const inboundConfig = createInboundChannelConfigPort({ store })
  let created = 0, deployed = 0, databases = [], remote = null
  const runner = {
    prepare: async () => {}, whoami: async () => ({ accounts: [{ id: ACCOUNT, name: 'Fixture account' }] }),
    loginDevice: async ({ onOutput }) => onOutput('To authorize, please visit:\nhttps://dash.cloudflare.com/oauth2/device\nand enter the code:\nABCD-EFGH'),
    d1List: async () => databases,
    d1Create: async ({ name }) => { created++; databases = [{ name, uuid: 'db-id' }]; return { id: 'db-id' } },
    d1Migrate: async () => {},
    deployWorker: async ({ name }) => { deployed++; if (failDeploy) { failDeploy = false; throw Error('failure') } remote = { endpoint: `https://${name}.account.workers.dev`, versionId: `v${deployed}` }; return remote },
    readDeployment: async () => { if (failReadback) throw Error('failure'); return remote ? [{ endpoint: remote.endpoint, created_on: '2026-10-01T00:00:00Z', versions: [{ version_id: remote.versionId, percentage: 100 }] }] : [] }, dispose() {},
  }
  const service = createCloudflareDeploymentService({ store, root: join(root, 'cloudflare'), outboundConfig, inboundConfig, runner, fetchImpl: async url => Response.json({ template: url.includes('dn-bark') ? 'notifier-bark-v1' : 'notifier-telegram-v1' }) })
  const reopen = () => {
    service.dispose()
    const disk = createStore(join(root, 'state.json'))
    return createCloudflareDeploymentService({ store: disk, root: join(root, 'cloudflare'), outboundConfig: createOutboundConfigService({ store: disk, source, yamlRows: new Map(), allowLegacy: false }), inboundConfig: createInboundChannelConfigPort({ store: disk }), runner, fetchImpl: async url => Response.json({ template: url.includes('dn-bark') ? 'notifier-bark-v1' : 'notifier-telegram-v1' }) })
  }
  return { root, store, source, service, outboundConfig, inboundConfig, runner, reopen, counts: () => ({ created, deployed }), cleanup() { service.dispose(); rmSync(root, { recursive: true, force: true }) } }
}
async function idle(service) { for (let i = 0; i < 200; i++) { if (!service.status().job) return; await new Promise(r => setImmediate(r)) }; throw Error('job did not settle') }
async function logged(service) { service.refresh(); await idle(service) }

test('CF absent account is inert: no CLI or cloud IO on construction/status', () => {
  const r = rig(); try { assert.deepEqual(r.counts(), { created: 0, deployed: 0 }); assert.equal(r.service.status().accounts.length, 0); assert.throws(() => r.service.deploy({ type: 'bark', accountId: ACCOUNT })); assert.equal(r.store.keys('cloudflare:').length, 0) } finally { r.cleanup() }
})
test('CF Bark DB is reused after deploy failure; credentials and ownership never enter public export', async () => {
  const r = rig({ failDeploy: true })
  try {
    await logged(r.service); r.service.deploy({ type: 'bark', accountId: ACCOUNT }); await idle(r.service)
    assert.equal(r.counts().created, 1)
    r.service.deploy({ type: 'bark', accountId: ACCOUNT }); await idle(r.service)
    assert.equal(r.counts().created, 1); assert.equal(r.service.status().deployments[0].state, 'unbound')
    const p = createConfigPortabilityService({ store: r.store, outboundConfig: r.outboundConfig, inboundConfig: r.inboundConfig })
    assert.doesNotMatch(JSON.stringify(p.exportConfig()), /databaseId|databaseName|gatewayKey|cloudflare:deployment/)
    assert.doesNotMatch(JSON.stringify(r.service.status()), /gatewayKey|botToken/)
  } finally { r.cleanup() }
})
test('CF cloud success survives readback failure and is truthfully unbound', async () => {
  const r = rig({ failReadback: true })
  try { await logged(r.service); r.service.deploy({ type: 'telegram', accountId: ACCOUNT, botToken: BOT }); await idle(r.service); assert.equal(r.service.status().deployments[0].state, 'unbound'); assert.throws(() => r.service.link({ type: 'telegram' })); assert.equal(r.source.has('telegram'), false) } finally { r.cleanup() }
})
test('CF link writes outbound + inbound atomically; unbind restores transport while retaining owned resources', async () => {
  const r = rig()
  try {
    r.outboundConfig.save('telegram', { botToken: BOT, chatId: '42', apiBase: 'https://old.example' })
    await logged(r.service); r.service.deploy({ type: 'telegram', accountId: ACCOUNT }); await idle(r.service)
    r.service.link({ type: 'telegram', directions: ['outbound', 'inbound'] })
    const outbound = r.store.get('channel:telegram:outbound'), inbound = r.store.get('telegram:account')
    assert.equal(outbound.apiBase, inbound.apiBase); assert.equal(outbound.gatewayKey, inbound.gatewayKey)
    assert.equal(r.service.status().deployments[0].state, 'bound')
    const value = r.service.unbind({ type: 'telegram' }); assert.equal(value.resourcesRetained, true)
    assert.equal(r.outboundConfig.raw('telegram').apiBase, 'https://old.example')
    assert.ok(r.store.get('cloudflare:deployment:telegram').endpoint)
  } finally { r.cleanup() }
})
test('CF failing local link commit preserves old channel and deployed/unbound metadata', async () => {
  const r = rig()
  try {
    r.outboundConfig.save('telegram', { botToken: BOT, chatId: '42', apiBase: 'https://old.example' })
    await logged(r.service); r.service.deploy({ type: 'telegram', accountId: ACCOUNT }); await idle(r.service)
    const original = r.store.transact; r.store.transact = () => ({ committed: false })
    assert.throws(() => r.service.link({ type: 'telegram' }), e => e.code === 'storage-failed')
    r.store.transact = original
    assert.equal(r.outboundConfig.raw('telegram').apiBase, 'https://old.example'); assert.equal(r.service.status().deployments[0].state, 'unbound')
  } finally { r.cleanup() }
})
test('CF unbind preserves manually changed endpoint', async () => {
  const r = rig()
  try {
    await logged(r.service); r.service.deploy({ type: 'telegram', accountId: ACCOUNT, botToken: BOT }); await idle(r.service)
    r.service.link({ type: 'telegram', chatId: '42' })
    r.outboundConfig.save('telegram', { apiBase: 'https://manual.example' })
    r.service.unbind({ type: 'telegram' }); assert.equal(r.outboundConfig.raw('telegram').apiBase, 'https://manual.example')
  } finally { r.cleanup() }
})
test('Wrangler runner uses shell:false, bounded output and abort settles even if child ignores SIGTERM', async () => {
  let options, child
  const runner = createWranglerRunner({ root: mkdtempSync(join(tmpdir(), 'dn-runner-')), cliPath: '/fixture/cli.js', spawnImpl: (_cmd, _args, opts) => {
    options = opts; child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() {} }; child.kill = () => {}; return child
  } })
  const abort = new AbortController(); const pending = runner.whoami({ signal: abort.signal }); abort.abort()
  await assert.rejects(pending); assert.equal(options.shell, false); runner.dispose()
})

 test('CF one-click deploy reads the address and atomically fills both directions using the bot token', async () => {
  const r = rig()
  try {
    r.outboundConfig.save('telegram', { botToken: BOT, chatId: '42' })
    await logged(r.service)
    r.service.deploy({ type: 'telegram', accountId: ACCOUNT, activate: true, inbound: true })
    await idle(r.service)
    const deployment = r.service.status().deployments[0]
    assert.equal(deployment.state, 'bound')
    const outbound = r.store.get('channel:telegram:outbound'), inbound = r.store.get('telegram:account')
    assert.equal(outbound.apiBase, deployment.endpoint)
    assert.equal(inbound.apiBase, deployment.endpoint)
    assert.equal(outbound.gatewayKey, BOT); assert.equal(inbound.gatewayKey, BOT)
    assert.equal(outbound.chatId, '42')
  } finally { r.cleanup() }
})
test('CF custom gateway address needs only the existing Bot API token', async () => {
  let captured
  const worker = createTelegramWorker(async request => { captured = request.url; return Response.json({ ok: true }) })
  const transport = telegramRequest({ botToken: BOT, apiBase: 'https://worker.example' }, 'getMe')
  assert.equal((await worker.fetch(new Request(transport.url), env)).status, 200)
  assert.equal(captured, `https://api.telegram.org/bot${BOT}/getMe`)
  assert.equal((await worker.fetch(new Request('https://worker.example/bot999:foreign/getMe'), env)).status, 401)
})

test('CF token rotation refuses stale gateway credentials rather than using another bot', () => {
  assert.throws(() => telegramRequest({ botToken: '999:new', gatewayKey: BOT, apiBase: 'https://gateway.example' }, 'sendMessage'), /重新开启/)
})

test('CF refuses local activation if deployment readback identifies a different active version', async () => {
  const r = rig()
  try {
    await logged(r.service)
    r.runner.readDeployment = async () => [{ created_on: '2026-10-01', versions: [{ version_id: 'foreign', percentage: 100 }] }]
    r.service.deploy({ type: 'telegram', accountId: ACCOUNT, botToken: BOT })
    await idle(r.service)
    assert.equal(r.service.status().deployments[0].health, 'unknown')
    assert.throws(() => r.service.link({ type: 'telegram' }))
    assert.equal(r.source.has('telegram'), false)
  } finally { r.cleanup() }
})

test('Native tunnel remains inert until an explicit start and uses only the supplied binary and credential file', async () => {
  const r = rig(); let child, invocation
  const binary = join(r.root, 'cloudflared'), credentialsSource = join(r.root, 'tunnel.json')
  writeFileSync(binary, 'fixture'); writeFileSync(credentialsSource, '{}')
  const tunnel = createNativeTunnelService({ store: r.store, spawnImpl: (command, args, options) => {
    invocation = { command, args, options }; child = new EventEmitter(); child.pid = 123
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true }
    queueMicrotask(() => child.emit('spawn')); return child
  } })
  try {
    assert.equal(invocation, undefined)
    await tunnel.start({ name: 'private', binary, credentialsSource, enabled: true, access: { applicationId: 'app-id' } })
    assert.equal(tunnel.status().running, true)
    assert.equal(invocation.command, binary); assert.equal(invocation.options.shell, false)
    assert.deepEqual(invocation.args, ['tunnel', '--no-autoupdate', '--credentials-file', credentialsSource, 'run', 'private'])
    await tunnel.stop(); assert.equal(tunnel.status().running, false)
    assert.ok(r.store.get('cloudflare:tunnel'))
  } finally { tunnel.dispose(); r.cleanup() }
})
test('Native tunnel refuses missing access protection and does not retain an unsaved configuration', () => {
  const r = rig(); const tunnel = createNativeTunnelService({ store: r.store })
  try {
    assert.throws(() => tunnel.configure({ name: 'private', binary: join(r.root, 'cloudflared'), credentialsSource: join(r.root, 'creds.json'), enabled: true }), /访问保护/)
    assert.equal(r.store.get('cloudflare:tunnel'), undefined)
    assert.equal(tunnel.status().configured, false)
  } finally { tunnel.dispose(); r.cleanup() }
})

test('Native tunnel failed save does not alter the controller or enable a new process', () => {
  const r = rig(), failing = { get: k => r.store.get(k), transact: () => ({ committed: false }) }
  const tunnel = createNativeTunnelService({ store: failing, spawnImpl: () => { throw Error('must not execute') } })
  try {
    assert.throws(() => tunnel.configure({ name: 'private', binary: join(r.root, 'cloudflared'), credentialsSource: join(r.root, 'creds.json'), enabled: true, access: { applicationId: 'app-id' } }), /未保存/)
    assert.equal(tunnel.status().configured, false)
    assert.equal(r.store.get('cloudflare:tunnel'), undefined)
  } finally { tunnel.dispose(); r.cleanup() }
})


test('F03/F04: deployment survives verification failure and process restart without redeploy or secret copies', async () => {
  const r = rig({ failReadback: true }); let recovered
  try {
    await logged(r.service)
    r.service.deploy({ type: 'telegram', accountId: ACCOUNT, botToken: BOT, activate: true, chatId: '42' }); await idle(r.service)
    const job = r.store.get(r.store.keys('cloud:job:')[0])
    assert.equal(job.state, 'recovery-required'); assert.equal(job.remoteReceipt.versionId, 'v1')
    assert.doesNotMatch(JSON.stringify(job), /fixture_token|gatewayKey|botToken/)
    assert.doesNotMatch(JSON.stringify(r.store.get('cloudflare:deployment:telegram')), /fixture_token|gatewayKey|botToken/)
    r.runner.readDeployment = async () => [{ versions: [{ version_id: 'v1', percentage: 100 }] }]
    recovered = r.reopen(); await new Promise(setImmediate); await idle(recovered)
    assert.equal(r.counts().deployed, 1)
    assert.equal(recovered.status().deployments[0].state, 'bound')
    assert.equal(createStore(join(r.root, 'state.json')).get(r.store.keys('cloud:job:')[0]).state, 'done')
  } finally { recovered?.dispose(); r.cleanup() }
})
test('F05: cancel during verification persists cancellation and retains created resource across restart', async () => {
  const r = rig(); let release, recovered
  try {
    await logged(r.service)
    r.runner.readDeployment = () => new Promise(resolve => { release = resolve })
    r.service.deploy({ type: 'telegram', accountId: ACCOUNT, botToken: BOT })
    for (let i = 0; i < 200 && !release; i++) await new Promise(setImmediate)
    r.service.cancel(); release([{ versions: [{ version_id: 'v1', percentage: 100 }] }]); await idle(r.service)
    const job = r.store.get(r.store.keys('cloud:job:')[0])
    assert.equal(job.cancelRequested, true)
    assert.ok(r.store.get('cloudflare:deployment:telegram').endpoint)
    recovered = r.reopen(); await new Promise(setImmediate)
    assert.equal(recovered.status().job, null); assert.equal(r.counts().deployed, 1)
  } finally { recovered?.dispose(); r.cleanup() }
})
test('Cloud remote creation with lost response resumes from exact resource readback, never blind create', async () => {
  const r = rig(); let recovered, calls = 0
  try {
    await logged(r.service)
    r.runner.deployWorker = async ({ name }) => { calls++; throw Error('response lost') }
    r.service.deploy({ type: 'telegram', accountId: ACCOUNT, botToken: BOT }); await idle(r.service)
    const record = r.store.get('cloudflare:deployment:telegram')
    r.runner.readDeployment = async () => [{ endpoint: `https://${record.name}.account.workers.dev`, versions: [{ version_id: 'remote-v1', percentage: 100 }] }]
    recovered = r.reopen(); await new Promise(setImmediate); await idle(recovered)
    assert.equal(calls, 1); assert.equal(recovered.status().deployments[0].health, 'ready')
  } finally { recovered?.dispose(); r.cleanup() }
})

test('P3 remote create succeeds but receipt write fails: restart reads exact resource without recreating', async () => {
  const r = rig(); let recovered
  const original = r.store.transact
  try {
    await logged(r.service)
    const create = r.runner.deployWorker
    r.runner.deployWorker = async args => {
      const result = await create(args)
      let once = true
      r.store.transact = fn => { if (once) { once = false; return { committed: false, code: 'STATE_WRITE_FAILED' } }; return original(fn) }
      return result
    }
    r.service.deploy({ type: 'telegram', accountId: ACCOUNT, botToken: BOT }); await idle(r.service)
    assert.equal(r.store.get('cloudflare:deployment:telegram').endpoint, undefined)
    recovered = r.reopen(); await new Promise(setImmediate); await idle(recovered)
    assert.equal(r.counts().deployed, 1); assert.equal(recovered.status().deployments[0].health, 'ready')
  } finally { r.store.transact = original; recovered?.dispose(); r.cleanup() }
})
test('P3 restart sweeps terminal Cloud rows; repeated status reads do not grow durable history', () => {
  const r = rig(); let recovered
  try {
    r.store.transact(draft => { for (let i = 0; i < 200; i++) draft[`cloud:job:history-${i}`] = { kind: 'deploy-bark', state: 'done', updatedAt: Date.now() - i } })
    recovered = r.reopen()
    for (let i = 0; i < 1000; i++) recovered.status()
    assert.equal(createStore(join(r.root, 'state.json')).keys('cloud:job:').length, 64)
  } finally { recovered?.dispose(); r.cleanup() }
})
for (const step of ['prepare', 'database', 'migration', 'create', 'verify', 'apply']) {
  test(`P3 restart at durable ${step} recovers retained Bark resource`, async () => {
    const r = rig(); let recovered
    try {
      await logged(r.service)
      r.service.deploy({ type: 'bark', accountId: ACCOUNT }); await idle(r.service)
      const key = r.store.keys('cloud:job:')[0]
      r.store.transact(draft => { draft[key] = { ...draft[key], state: 'running', step } })
      recovered = r.reopen(); await new Promise(setImmediate); await idle(recovered)
      assert.deepEqual(r.counts(), { created: 1, deployed: 1 })
      assert.equal(createStore(join(r.root, 'state.json')).get(key).state, 'done')
    } finally { recovered?.dispose(); r.cleanup() }
  })
}
test('P3 apply failure after durable settings resumes without another remote deployment', async () => {
  const r = rig(); let recovered
  try {
    await logged(r.service)
    r.outboundConfig.applyCommitted = () => ({ applied: false, restartPending: true })
    r.service.deploy({ type: 'telegram', accountId: ACCOUNT, botToken: BOT, activate: true, chatId: '42' }); await idle(r.service)
    assert.equal(r.store.get(r.store.keys('cloud:job:')[0]).step, 'apply')
    assert.ok(r.outboundConfig.raw('telegram').apiBase)
    recovered = r.reopen(); await new Promise(setImmediate); await idle(recovered)
    assert.equal(r.counts().deployed, 1)
    assert.equal(recovered.status().deployments[0].state, 'bound')
  } finally { recovered?.dispose(); r.cleanup() }
})
