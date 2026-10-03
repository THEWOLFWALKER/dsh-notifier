import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../../src/inbound/store.mjs'
import { createOutboundSource } from '../../src/runtime/outbound-source.mjs'
import { createOutboundConfigService } from '../../src/control-surface/outbound-config.mjs'
import { createInboundChannelConfigPort } from '../../src/inbound/channel-config.mjs'
import { createConfigPortabilityService } from '../../src/control-plane/config-portability.mjs'
import { EventEmitter } from 'node:events'
import { createNativeTunnelService } from '../../src/cloudflare/tunnel.mjs'
import { createCloudflareDeploymentService } from '../../src/cloudflare/deployment.mjs'
import { act, actAsync, buttonByText, click, createContext, flush, installDomEnvironment, loadClient, mount, React, typeInput } from './harness.mjs'
const { mod } = loadClient()
test.beforeEach(installDomEnvironment)
function rig() {
  const root = mkdtempSync(join(tmpdir(), 'dn-dom-release-'))
  const store = createStore(join(root, 'state.json')), source = createOutboundSource([])
  const outbound = createOutboundConfigService({ store, source, yamlRows: new Map(), allowLegacy: false })
  const inbound = createInboundChannelConfigPort({ store })
  const portability = createConfigPortabilityService({ store, outboundConfig: outbound, inboundConfig: inbound })
  const account = 'a'.repeat(32)
  const tunnelService = createNativeTunnelService({ store, spawnImpl: () => {
    const child = new EventEmitter(); child.pid = 123
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true }
    queueMicrotask(() => child.emit('spawn')); return child
  } })
  const cloud = createCloudflareDeploymentService({ store, root, tunnelService, outboundConfig: outbound, inboundConfig: inbound, runner: {
    prepare: async () => {}, whoami: async () => ({ accounts: [{ id: account, name: 'Account' }] }),
    loginDevice: async () => {}, deployWorker: async ({ name }) => ({ endpoint: `https://${name}.user.workers.dev`, versionId: 'v1' }), readDeployment: async () => [{ created_on: '2026-10-01', versions: [{ version_id: 'v1', percentage: 100 }] }], dispose() {},
  }, fetchImpl: async () => Response.json({ template: 'notifier-telegram-v1' }) })
  const calls = []
  const { ctx } = createContext({ rpcCall: async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload })
    try {
      let value
      if (endpoint.startsWith('cloudflare.')) value = await cloud[endpoint.split('.')[1]](payload)
      else if (endpoint === 'portability.readBack') value = portability.readBack()
      else if (endpoint === 'portability.preview') value = portability.previewImport(payload)
      else if (endpoint === 'portability.commit') value = portability.commitImport(payload)
      else if (endpoint === 'portability.cancel') value = portability.cancelImport(payload)
      else if (endpoint === 'portability.export') value = portability.exportConfig()
      else value = {}
      return { ok: true, value }
    } catch (e) { return { ok: false, error: { code: e.code, message: e.message } } }
  } })
  const controller = mod.__test.createController(ctx)
  return { root, store, source, outbound, portability, cloud, calls, ctx, controller, close(view) { view.unmount(); controller.dispose(); cloud.dispose(); rmSync(root, { recursive: true, force: true }) } }
}
function textArea(input, value) {
  act(() => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })) })
}
const documentText = config => JSON.stringify({ documentType: 'dsh-notifier-config', formatVersion: 1, channels: [{ direction: 'outbound', type: 'telegram', config }] })
async function renderTransfer(r) {
  const view = mount(React.createElement(mod.__test.PortabilityView, { ctx: r.ctx, controller: r.controller, t: k => k }))
  await flush(); return view
}
test('Native import previews a conflict, defaults to skip and requires explicit selection before real commit', async () => {
  const r = rig(); r.outbound.save('telegram', { botToken: '123:secret', chatId: 'old' })
  const v = await renderTransfer(r)
  try {
    textArea(v.container.querySelector('textarea'), documentText({ chatId: 'new' })); click(buttonByText(v.container, 'previewImport')); await flush()
    assert.equal(r.outbound.raw('telegram').chatId, 'old'); assert.match(v.container.textContent, /importConflict/)
    const checkbox = v.container.querySelector('input[type=checkbox]'); assert.equal(checkbox.checked, false)
    click(checkbox); click(buttonByText(v.container, 'confirmImport')); await flush()
    assert.equal(r.outbound.raw('telegram').chatId, 'new'); assert.equal(r.outbound.raw('telegram').botToken, '123:secret')
    assert.equal(r.calls.find(c => c.endpoint === 'portability.commit').payload.selections[0].action, 'apply')
    assert.match(v.container.textContent, /importDone/)
  } finally { r.close(v) }
})
test('Native cancel and explicit zero selection preserve configuration; secret values never rendered', async () => {
  const r = rig(); r.outbound.save('telegram', { botToken: '123:secret', chatId: 'old' })
  const v = await renderTransfer(r)
  try {
    textArea(v.container.querySelector('textarea'), documentText({ chatId: 'new' })); click(buttonByText(v.container, 'previewImport')); await flush()
    assert.doesNotMatch(v.container.textContent, /123:secret/)
    click(buttonByText(v.container, 'cancelAction')); await flush(); assert.equal(r.outbound.raw('telegram').chatId, 'old')
    click(buttonByText(v.container, 'previewImport')); await flush(); click(buttonByText(v.container, 'confirmImport')); await flush()
    assert.equal(r.outbound.raw('telegram').chatId, 'old')
    assert.equal(r.calls.find(c => c.endpoint === 'portability.commit').payload.selections[0].action, 'skip')
  } finally { r.close(v) }
})
test('Native stale preview refuses commit and retains the preview for cancellation', async () => {
  const r = rig(); r.outbound.save('telegram', { botToken: '123:secret', chatId: 'old' })
  const v = await renderTransfer(r)
  try {
    textArea(v.container.querySelector('textarea'), documentText({ chatId: 'new' })); click(buttonByText(v.container, 'previewImport')); await flush()
    click(v.container.querySelector('input[type=checkbox]')); r.outbound.save('telegram', { chatId: 'other-writer' })
    click(buttonByText(v.container, 'confirmImport')); await flush()
    assert.equal(r.outbound.raw('telegram').chatId, 'other-writer'); assert.ok(v.container.querySelector('[role=alert]')); assert.ok(buttonByText(v.container, 'cancelAction'))
  } finally { r.close(v) }
})
test('Native new import stays inert and opens staged public fields as an editable unsaved draft', async () => {
  const r = rig(), v = await renderTransfer(r)
  try {
    textArea(v.container.querySelector('textarea'), documentText({ chatId: '42' })); click(buttonByText(v.container, 'previewImport')); await flush(); click(buttonByText(v.container, 'confirmImport')); await flush()
    assert.equal(r.source.has('telegram'), false); assert.equal(r.store.get('channel:telegram:outbound'), undefined)
    click(buttonByText(v.container, 'importConfigure')); await flush()
    assert.deepEqual(r.controller.getSnapshot().view.importDraft, { chatId: '42' })
    r.outbound.save('telegram', { botToken: '123:secret', chatId: '42' })
    assert.equal(r.portability.listStaged().length, 0)
  } finally { r.close(v) }
})
test('Native export downloads JSON; browser download failure displays only public fallback', async () => {
  const r = rig(); r.outbound.save('telegram', { botToken: '123:secret', chatId: '42' })
  const v = await renderTransfer(r)
  const original = URL.createObjectURL
  try {
    URL.createObjectURL = () => { throw Error('unavailable') }
    click(buttonByText(v.container, 'exportConfig')); await flush()
    const fallback = v.container.querySelector('textarea[readonly]')
    assert.ok(fallback); assert.doesNotMatch(fallback.value, /123:secret/); assert.equal(JSON.parse(fallback.value).documentType, 'dsh-notifier-config')
  } finally { URL.createObjectURL = original; r.close(v) }
})
test('Native Cloudflare deploy/link/unbind goes through real authority and preserves cloud resource', async () => {
  const r = rig(); r.cloud.refresh(); for (let i = 0; r.cloud.status().job && i < 100; i++) await new Promise(resolve => setImmediate(resolve))
  const v = mount(React.createElement(mod.__test.CloudflareView, { ctx: r.ctx, controller: r.controller, t: k => k }))
  await flush()
  try {
    typeInput(v.container.querySelector('input[aria-label="Bot Token"]'), '123:secret')
    click(v.container.querySelector('input[type=checkbox]')); click(buttonByText(v.container, 'Enable fallback connection')); await flush()
    // Explicit refresh read; the job runs outside React and is polled in the product.
    for (let i = 0; r.cloud.status().job && i < 100; i++) await new Promise(resolve => setImmediate(resolve))
    click(buttonByText(v.container, 'refresh')); await flush(); await actAsync(() => new Promise(resolve => setTimeout(resolve, 1550))); await flush()
    assert.ok(buttonByText(v.container, 'Link channel'))
    typeInput(v.container.querySelector('input[aria-label="Chat ID"]'), '42')
    click(buttonByText(v.container, 'Link channel')); await flush()
    assert.equal(r.cloud.status().deployments[0].state, 'bound'); assert.ok(r.outbound.raw('telegram').gatewayKey)
    assert.equal(v.container.querySelector('input[aria-label="Bot Token"]').value, '')
    click(buttonByText(v.container, 'Unbind')); await flush()
    assert.equal(r.cloud.status().deployments[0].state, 'unbound'); assert.ok(r.store.get('cloudflare:deployment:telegram').endpoint)
  } finally { r.close(v) }
})

test('Native one-click gateway deploy fills address and reuses token without a manual link step', async () => {
  const r = rig(); r.outbound.save('telegram', { botToken: '123:secret', chatId: '42' })
  r.cloud.refresh(); for (let i = 0; r.cloud.status().job && i < 100; i++) await new Promise(resolve => setImmediate(resolve))
  const v = mount(React.createElement(mod.__test.CloudflareView, { ctx: r.ctx, controller: r.controller, t: k => k }))
  await flush()
  try {
    assert.equal(v.container.querySelector('input[type=checkbox]').checked, true)
    click(buttonByText(v.container, 'Enable fallback connection')); await flush()
    for (let i = 0; r.cloud.status().job && i < 100; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.cloud.status().deployments[0].state, 'bound')
    const row = r.outbound.raw('telegram')
    assert.match(row.apiBase, /^https:\/\/dn-telegram-/)
    assert.equal(row.gatewayKey, '123:secret')
    assert.equal(row.chatId, '42')
    assert.equal(r.calls.some(c => c.endpoint === 'cloudflare.link'), false)
    assert.doesNotMatch(v.container.textContent, /123:secret/)
  } finally { r.close(v) }
})
test('Native Telegram custom address remains editable and saves with the existing token', async () => {
  const r = rig(); r.outbound.save('telegram', { botToken: '123:secret', chatId: '42' })
  const controller = { async nativeSaveChannel(type, direction, patch) { return r.outbound.save(type, patch) }, reportError(e) { throw e } }
  const fields = [{ key: 'apiBase', label: 'Custom address', type: 'text', secret: false }]
  const v = mount(React.createElement(mod.__test.NativeDirectionForm, { ctx: r.ctx, controller, state: {}, t: k => k, type: 'telegram', direction: 'outbound', fields, values: {}, revision: 1 }))
  await flush()
  try {
    const input = v.container.querySelector('input[aria-label="Custom address"]')
    typeInput(input, 'https://g'); assert.equal(input.disabled, false)
    typeInput(input, 'https://gateway.example')
    click(buttonByText(v.container, 'save')); await flush()
    assert.equal(r.outbound.raw('telegram').apiBase, 'https://gateway.example')
    assert.equal(r.outbound.raw('telegram').botToken, '123:secret')
  } finally { r.close(v) }
})

test('Native advanced tunnel saves, starts and stops through the real tunnel authority', async () => {
  const r = rig(), binary = join(r.root, 'cloudflared'), credentials = join(r.root, 'creds.json')
  writeFileSync(binary, 'fixture'); writeFileSync(credentials, '{}')
  const v = mount(React.createElement(mod.__test.CloudflareView, { ctx: r.ctx, controller: r.controller, t: k => k })); await flush()
  try {
    typeInput(v.container.querySelector('input[aria-label="Tunnel name"]'), 'private')
    typeInput(v.container.querySelector('input[aria-label="cloudflared full path"]'), binary)
    typeInput(v.container.querySelector('input[aria-label="Credentials file full path"]'), credentials)
    typeInput(v.container.querySelector('input[aria-label="Access application ID"]'), 'protected-app')
    click(buttonByText(v.container, 'Save and start')); await flush()
    assert.equal(r.cloud.status().tunnel.running, true)
    assert.ok(r.store.get('cloudflare:tunnel'))
    click(buttonByText(v.container, 'Stop')); await flush()
    assert.equal(r.cloud.status().tunnel.running, false)
    assert.equal(r.calls.some(c => c.endpoint === 'cloudflare.tunnelStart'), true)
  } finally { r.close(v) }
})
