// Actual workerd + SQLite/D1 migrations. No Cloudflare account or live APNs needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import miniflare from 'miniflare'
const { Miniflare } = miniflare
const rootPath = fileURLToPath(new URL('../../', import.meta.url))
const directory = fileURLToPath(new URL('../../src/cloudflare/templates/bark/', import.meta.url))
function bark(bindings = {}) {
  return new Miniflare({ rootPath, modulesRoot: rootPath, modules: true, scriptPath: `${directory}worker.mjs`, compatibilityDate: '2026-08-01', d1Databases: ['database'], bindings, outboundService: async request => { assert.equal(new URL(request.url).hostname, 'api.push.apple.com'); assert.equal(request.method, 'POST'); return new Response('', { status: 200 }) } })
}
async function migrate(mf) {
  const database = await mf.getD1Database('database')
  for (const file of readdirSync(`${directory}migrations`).sort()) if (file.endsWith('.sql')) await database.exec(readFileSync(`${directory}migrations/${file}`, 'utf8'))
  return database
}
test('Bark runs migrations in D1, defaults to closed registration and hides info/MCP', async () => {
  const mf = bark()
  try {
    const db = await migrate(mf)
    const response = await mf.dispatchFetch('https://bark.example/register?devicetoken=fixture-device')
    assert.equal(response.status, 500)
    assert.equal((await db.prepare('SELECT count(*) AS n FROM devices').first()).n, 0)
    assert.equal((await mf.dispatchFetch('https://bark.example/info')).status, 404)
    assert.equal((await mf.dispatchFetch('https://bark.example/mcp')).status, 404)
    assert.equal((await (await mf.dispatchFetch('https://bark.example/healthz')).json()).template, 'notifier-bark-v1')
  } finally { await mf.dispose() }
})
test('Bark explicit enrollment + APNs signed push works in workerd using official published key', async () => {
  const mf = bark({ ALLOW_NEW_DEVICE: 'true' })
  try {
    const db = await migrate(mf)
    const registered = await (await mf.dispatchFetch('https://bark.example/register?devicetoken=fixture-device')).json()
    assert.equal(registered.code, 200)
    const key = registered.data.key
    const response = await mf.dispatchFetch(`https://bark.example/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Test', body: 'Fixture' }) })
    const payload = await response.json()
    assert.equal(payload.code, 200)
    const stored = await db.prepare('SELECT token FROM authorization LIMIT 1').first()
    const parts = stored.token.split('.')
    assert.equal(JSON.parse(Buffer.from(parts[0], 'base64url').toString()).kid, 'LH4T9V5U4R')
    assert.equal(Buffer.from(parts[2], 'base64url').length, 64)
    assert.equal((await db.prepare('SELECT count(*) AS n FROM devices').first()).n, 1)
  } finally { await mf.dispose() }
})
test('Telegram gateway executes in workerd with streamed file response and 429', async () => {
  const mf = new Miniflare({ rootPath, modulesRoot: rootPath, modules: true, scriptPath: fileURLToPath(new URL('../../src/cloudflare/templates/telegram/worker.mjs', import.meta.url)), compatibilityDate: '2026-08-01', bindings: { BOT_TOKEN: '123:fixed' }, outboundService: async request => {
    assert.equal(new URL(request.url).hostname, 'api.telegram.org')
    if (new URL(request.url).pathname === '/bot123:fixed/sendMessage') return new Response('{"ok":false}', { status: 429, headers: { 'retry-after': '8' } })
    assert.equal(new URL(request.url).pathname, '/file/bot123:fixed/photos/x.jpg')
    return new Response('binary-fixture', { headers: { 'content-type': 'image/jpeg' } })
  } })
  try {
    const response = await mf.dispatchFetch('https://gateway.example/api/sendMessage', { method: 'POST', headers: { 'x-notifier-gateway-key': '123:fixed', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '8')
    const file = await mf.dispatchFetch('https://gateway.example/file/photos/x.jpg', { headers: { 'x-notifier-gateway-key': '123:fixed' } })
    assert.equal(file.headers.get('content-type'), 'image/jpeg'); assert.equal(await file.text(), 'binary-fixture')
  } finally { await mf.dispose() }
})
