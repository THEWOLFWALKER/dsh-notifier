// 阶段 4 测试：inbound/store + inbound/tokens + inbound/bus。
// 覆盖安全红线：白名单默认全拒、双层去重跨重启、token 伪造/篡改/过期全拒、首达采纳。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, defaultStateDir } from '../src/inbound/store.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'

function tempStorePath() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notifier-inbound-'))
  return { dir, path: join(dir, 'state.json') }
}

// ---------------------------------------------------------------- store

test('store：set/get/delete 往返，且原子落盘（新实例可读）', () => {
  const { path } = tempStorePath()
  const a = createStore(path)
  assert.equal(a.get('k'), undefined)
  a.set('k', { v: 1 })
  assert.deepEqual(a.get('k'), { v: 1 })
  assert.equal(a.delete('k'), true)
  assert.equal(a.get('k'), undefined)
  assert.equal(a.delete('k'), false) // 再删返回 false

  a.set('ap:1', { status: 'pending' })
  a.set('dedup:x', 1)
  const b = createStore(path) // 新实例 = 重启恢复
  assert.deepEqual(b.get('ap:1'), { status: 'pending' })
  assert.deepEqual(b.keys('ap:'), ['ap:1'])
  assert.deepEqual(b.keys('dedup:'), ['dedup:x'])
  assert.equal(b.size(), 2)
})

test('store：损坏 JSON 文件回退空状态，绝不抛错（fail-open 到无记忆）', () => {
  const { path } = tempStorePath()
  writeFileSync(path, '{oops not json', 'utf8')
  const store = createStore(path)
  assert.equal(store.size(), 0)
  store.set('k', 'v') // 损坏后仍可写入（覆盖坏文件）
  assert.equal(createStore(path).get('k'), 'v')
})

test('store：sweepPrefix 只清理判定超期的键，返回清理数', () => {
  const { path } = tempStorePath()
  const store = createStore(path)
  const now = Date.now()
  store.set('dedup:a', now - 20_000) // 超期
  store.set('dedup:b', now)          // 窗口内
  store.set('dedup:c', now - 99_999) // 超期
  store.set('ap:keep', { status: 'pending' })
  const removed = store.sweepPrefix('dedup:', (_key, seenAt) => now - seenAt > 10_000)
  assert.equal(removed, 2) // a 与 c 超期
  assert.deepEqual(store.keys('dedup:').sort(), ['dedup:b'])
  assert.deepEqual(store.keys('ap:'), ['ap:keep'])
})

test('store：defaultStateDir 尊重 DSH_HOME，回退 ~/.dsh/dsh-notifier', () => {
  const savedHome = process.env.DSH_HOME
  const savedUser = process.env.HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-home'
    assert.equal(defaultStateDir(), '/tmp/dsh-home/dsh-notifier')
    delete process.env.DSH_HOME
    process.env.HOME = '/tmp/user-home'
    assert.equal(defaultStateDir(), '/tmp/user-home/.dsh/dsh-notifier')
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedUser === undefined) delete process.env.HOME
    else process.env.HOME = savedUser
  }
})

// ---------------------------------------------------------------- tokens

test('tokens：mint/verify 往返，verify 返回 key', () => {
  const vault = createTokenVault({ secret: 's3cret' })
  const token = vault.mint('ap:rm:1')
  const verdict = vault.verify(token)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.key, 'ap:rm:1')
  assert.equal(verdict.reason, null)
})

test('tokens：显式 secret 跨实例可验；随机 secret 跨实例必拒', () => {
  const token = createTokenVault({ secret: 'k' }).mint('ap:x:1')
  assert.equal(createTokenVault({ secret: 'k' }).verify(token).ok, true)
  assert.equal(createTokenVault({ secret: 'other' }).verify(token).reason, 'bad-signature')
  // 未配置 secret：进程内随机，两个实例密钥不同
  const randomToken = createTokenVault().mint('ap:y:1')
  assert.equal(createTokenVault().verify(randomToken).reason, 'bad-signature')
})

test('tokens：malformed 一律拒绝（非字符串 / 无分隔点 / 坏 base64）', () => {
  const vault = createTokenVault({ secret: 'k' })
  assert.equal(vault.verify(null).reason, 'malformed')
  assert.equal(vault.verify(123).reason, 'malformed')
  assert.equal(vault.verify('no-dot-here').reason, 'malformed')
  assert.equal(vault.verify('.deadbeef').reason, 'malformed')
  // 坏 base64 解码宽松（非法字符被忽略），落在签名校验被拒——同样全拒
  assert.equal(vault.verify('!!!.zzz').reason, 'bad-signature')
})

test('tokens：篡改 payload 或签名 → bad-signature（HMAC 覆盖整个 payload）', () => {
  const vault = createTokenVault({ secret: 'k' })
  const token = vault.mint('ap:a:1')
  const [payload, sig] = token.split('.')
  // 换 key 重放（签名不变）
  const forged = `${Buffer.from(JSON.stringify({ k: 'ap:b:2', e: Date.now() + 60000 })).toString('base64url')}.${sig}`
  assert.equal(vault.verify(forged).reason, 'bad-signature')
  // 改签名一位
  const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0')
  assert.equal(vault.verify(`${payload}.${flipped}`).reason, 'bad-signature')
})

test('tokens：过期 token → expired；TTL 可配置', () => {
  const vault = createTokenVault({ secret: 'k', ttlMs: 1000 })
  const token = vault.mint('ap:t:1')
  assert.equal(vault.verify(token, Date.now() + 2000).reason, 'expired')
  assert.equal(vault.verify(token, Date.now()).ok, true)
})

// ---------------------------------------------------------------- bus

function envelope(overrides = {}) {
  return { channel: 'telegram', userId: '42', chatId: '42', messageId: 'msg:1:42', text: 'hi', ...overrides }
}

test('bus：白名单默认全拒（allowUsers 为空时任何人都不通过）', () => {
  const bus = createInboundBus({ allowUsers: [] })
  assert.equal(bus.allows('42'), false)
  assert.equal(bus.allows(''), false)
  assert.deepEqual(bus.accept(envelope()), { ok: false, reason: 'whitelist' })
})

test('bus：白名单外用户被拒，白名单内用户通过并触发处理器', () => {
  const seen = []
  const bus = createInboundBus({ allowUsers: ['42'] })
  bus.onMessage((env) => seen.push(env))
  assert.equal(bus.allows('42'), true)
  assert.equal(bus.allows('43'), false)
  assert.deepEqual(bus.accept(envelope({ userId: '43' })), { ok: false, reason: 'whitelist' })
  assert.equal(seen.length, 0)
  assert.deepEqual(bus.accept(envelope()), { ok: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].text, 'hi')
})

test('bus：同 messageId 重复投递被拒（内存 FIFO 快速路径）', () => {
  const seen = []
  const bus = createInboundBus({ allowUsers: ['42'] })
  bus.onMessage((env) => seen.push(env))
  assert.deepEqual(bus.accept(envelope()), { ok: true })
  assert.deepEqual(bus.accept(envelope()), { ok: false, reason: 'duplicate' })
  // 不同 messageId 正常通过
  assert.deepEqual(bus.accept(envelope({ messageId: 'msg:2:42' })), { ok: true })
  assert.equal(seen.length, 2)
})

test('bus：去重跨重启（store 持久层）——新 bus 实例共享 store 仍判重', () => {
  const { path } = tempStorePath()
  const store = createStore(path)
  const first = createInboundBus({ allowUsers: ['42'], store })
  assert.deepEqual(first.accept(envelope()), { ok: true })
  const restarted = createInboundBus({ allowUsers: ['42'], store }) // 模拟重启
  assert.deepEqual(restarted.accept(envelope()), { ok: false, reason: 'duplicate' })
})

test('bus：去重窗口外的旧记录不再拦截（dedupWindowMs）', () => {
  const { path } = tempStorePath()
  const store = createStore(path)
  store.set('dedup:telegram:msg:1:42', Date.now() - 60_000)
  const bus = createInboundBus({ allowUsers: ['42'], store, dedupWindowMs: 10_000 })
  assert.deepEqual(bus.accept(envelope()), { ok: true }) // 窗口外，放行
})

test('bus：处理器抛异常不影响 accept 结果（A listener never throws）', () => {
  const bus = createInboundBus({ allowUsers: ['42'] })
  bus.onMessage(() => { throw new Error('boom') })
  bus.onMessage(() => { /* 正常 */ })
  assert.deepEqual(bus.accept(envelope({ messageId: 'msg:x:42' })), { ok: true })
})

test('bus：onMessage 退订后不再收到消息', () => {
  const seen = []
  const bus = createInboundBus({ allowUsers: ['42'] })
  const off = bus.onMessage((env) => seen.push(env))
  bus.accept(envelope({ messageId: 'm1' }))
  off()
  bus.accept(envelope({ messageId: 'm2' }))
  assert.equal(seen.length, 1)
})

test('bus：wait + decide（带合法 token）→ 决议送达等待者', async () => {
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['42'], vault })
  const waiting = bus.wait('ap:rm:1', 5000)
  assert.equal(bus.pendingCount(), 1)
  const token = vault.mint('ap:rm:1')
  const verdict = bus.decide({ approvalKey: 'ap:rm:1', decision: 'allowed-once', token, via: 'telegram', userId: 42 })
  assert.deepEqual(verdict, { ok: true })
  assert.deepEqual(await waiting, { decision: 'allowed-once', via: 'telegram', userId: '42' })
  assert.equal(bus.pendingCount(), 0)
})

test('bus：vault 存在时 decide 缺 token → token-required（防无凭裁决）', () => {
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['42'], vault })
  bus.wait('ap:a:1', 5000)
  assert.deepEqual(
    bus.decide({ approvalKey: 'ap:a:1', decision: 'rejected', via: 'x' }),
    { ok: false, reason: 'token-required' },
  )
})

test('bus：token 验签通过但 key 不匹配 → key-mismatch（防跨审批重放）', () => {
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['42'], vault })
  bus.wait('ap:a:1', 5000)
  const otherToken = vault.mint('ap:b:2')
  assert.deepEqual(
    bus.decide({ approvalKey: 'ap:a:1', decision: 'allowed-once', token: otherToken }),
    { ok: false, reason: 'key-mismatch' },
  )
})

test('bus：非法 decision 值被拒', () => {
  const bus = createInboundBus({ allowUsers: ['42'] })
  bus.wait('ap:a:1', 5000)
  assert.deepEqual(bus.decide({ approvalKey: 'ap:a:1', decision: 'allow-forever', token: 'x' }), { ok: false, reason: 'invalid-decision' })
})

test('bus：首达采纳——同一审批的第二次裁决返回 already-resolved', async () => {
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['42'], vault })
  const waiting = bus.wait('ap:rm:1', 5000)
  const token = vault.mint('ap:rm:1')
  assert.equal(bus.decide({ approvalKey: 'ap:rm:1', decision: 'rejected', token }).ok, true)
  // 同一枚 token 重放（按钮双击 / 消息重投）
  assert.deepEqual(
    bus.decide({ approvalKey: 'ap:rm:1', decision: 'allowed-once', token }),
    { ok: false, reason: 'already-resolved' },
  )
  assert.deepEqual(await waiting, { decision: 'rejected', via: 'unknown', userId: '(unknown)' })
})

test('bus：无等待者时裁决 → already-resolved（绝不凭空生效）', () => {
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['42'], vault })
  const token = vault.mint('ap:gone:1')
  assert.deepEqual(
    bus.decide({ approvalKey: 'ap:gone:1', decision: 'allowed-once', token }),
    { ok: false, reason: 'already-resolved' },
  )
})

test('bus：wait 超时 → resolve(null)（静默永不批准）', async () => {
  const bus = createInboundBus({ allowUsers: ['42'] })
  assert.equal(await bus.wait('ap:t:1', 30), null)
  assert.equal(bus.pendingCount(), 0)
})

test('bus：abandon 让等待者以 null 收场且清理计时器', async () => {
  const bus = createInboundBus({ allowUsers: ['42'] })
  const waiting = bus.wait('ap:ab:1', 5000)
  assert.equal(bus.abandon('ap:ab:1'), true)
  assert.equal(await waiting, null)
  assert.equal(bus.abandon('ap:ab:1'), false) // 不存在 → false
  assert.equal(bus.pendingCount(), 0)
})

test('bus：decideTrusted 跳过 token 校验但仍受首达采纳约束（编号回复降级）', async () => {
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['42'], vault })
  const waiting = bus.wait('ap:nr:1', 5000)
  assert.deepEqual(
    bus.decideTrusted({ approvalKey: 'ap:nr:1', decision: 'allowed-once', via: 'wechat:reply', userId: '42' }),
    { ok: true },
  )
  assert.deepEqual(
    bus.decideTrusted({ approvalKey: 'ap:nr:1', decision: 'rejected', via: 'wechat:reply', userId: '42' }),
    { ok: false, reason: 'already-resolved' },
  )
  assert.deepEqual(await waiting, { decision: 'allowed-once', via: 'wechat:reply', userId: '42' })
})
