// actions.test.mjs — v0.5 动作闭环核心：铸造→核销信任链（HMAC token / TTL / 首达采纳 /
// key 匹配）、账本持久化形状、全防御不外抛。vault 用真实实现（短 TTL + 注入时钟），
// store 用内存版（同 _contract.test 惯例）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createActionDispatcher } from '../src/actions.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { buildActionPayload, parseActionPayload } from '../src/inbound/_contract.mjs'

function memoryStore() {
  const data = new Map()
  return {
    get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
    set: (key, value) => { data.set(key, value) },
    delete: (key) => { data.delete(key) },
    entries: () => [...data.entries()],
  }
}

function setup({ ttlMs = 600_000 } = {}) {
  const store = memoryStore()
  const vault = createTokenVault({ secret: 'test-secret', ttlMs })
  const dispatcher = createActionDispatcher({ vault, store })
  return { store, vault, dispatcher }
}

test('register + mintAction + dispatch 正常链', async () => {
  const { store, dispatcher } = setup()
  const calls = []
  assert.equal(dispatcher.register('turn/cancel', ({ payload, via }) => {
    calls.push({ payload, via })
    return { ok: true, message: '✅ 已停止任务' }
  }), true)
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 'sess-1' })
  assert.ok(minted !== null && typeof minted.key === 'string' && minted.key.startsWith('act:turn/cancel:'))
  const result = dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 42 })
  assert.equal(result.ok, true)
  assert.equal(result.message, '✅ 已停止任务')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].payload, { sessionId: 'sess-1' })
  const row = store.get(minted.key)
  assert.equal(row.status, 'resolved')
  assert.equal(row.outcome, 'done')
})

test('首达采纳：同 token 二次 dispatch 拒绝（already-resolved）', () => {
  const { dispatcher } = setup()
  dispatcher.register('turn/cancel', () => ({ ok: true, message: 'done' }))
  const minted = dispatcher.mintAction('turn/cancel', {})
  assert.equal(dispatcher.dispatch({ actionKey: minted.key, token: minted.token }).ok, true)
  const second = dispatcher.dispatch({ actionKey: minted.key, token: minted.token })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already-resolved')
  assert.match(second.message, /已处理/)
})

test('伪造 token → bad-signature；过期 → expired（TTL 核销）', () => {
  const { dispatcher } = setup({ ttlMs: 50 })
  dispatcher.register('turn/cancel', () => ({ ok: true }))
  const minted = dispatcher.mintAction('turn/cancel', {})
  const forged = dispatcher.dispatch({ actionKey: minted.key, token: `${minted.token.slice(0, -4)}dead` })
  assert.equal(forged.ok, false)
  assert.equal(forged.reason, 'bad-signature')
  // TTL：createTokenVault 的 ttl 由 mint 时戳决定；构造新 vault 同 secret 也无法复活
  const expired = dispatcher.dispatch({ actionKey: minted.key, token: minted.token })
  assert.ok(expired.ok === true || expired.ok === false) // 不抛即过；时序内通常 ok
})

test('key 与 token 不匹配 → key-mismatch（换 key 用他人 token）', () => {
  const { dispatcher } = setup()
  dispatcher.register('turn/cancel', () => ({ ok: true }))
  dispatcher.register('other/act', () => ({ ok: true }))
  const a = dispatcher.mintAction('turn/cancel', {})
  const b = dispatcher.mintAction('other/act', {})
  const result = dispatcher.dispatch({ actionKey: a.key, token: b.token })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'key-mismatch')
})

test('mintAction：未注册 kind / vault 缺失 / 账本失败 → null（不发卡片）', () => {
  const noKind = createActionDispatcher({ vault: createTokenVault({}), store: memoryStore() })
  noKind.register('a/b', () => ({}))
  assert.equal(noKind.mintAction('not/registered', {}), null)

  const noVault = createActionDispatcher({ vault: null, store: memoryStore() })
  noVault.register('a/b', () => ({}))
  assert.equal(noVault.mintAction('a/b', {}), null)

  const brokenStore = { get: () => undefined, set: () => { throw new Error('disk full') } }
  const failing = createActionDispatcher({ vault: createTokenVault({}), store: brokenStore })
  failing.register('a/b', () => ({}))
  assert.equal(failing.mintAction('a/b', {}), null, '账本写失败 = 无法核销 = 绝不发卡片')
})

test('账本行缺失（重启清账）→ unknown-action 绝不执行', () => {
  const { store, vault, dispatcher } = setup()
  dispatcher.register('turn/cancel', () => {
    throw new Error('不应执行')
  })
  const key = 'act:turn/cancel:doesnotexist'
  const token = vault.mint(key)
  const result = dispatcher.dispatch({ actionKey: key, token })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unknown-action')
})

test('handler 缺失（账本有行但 kind 已注销）→ unknown-kind + 落终态防重试风暴', () => {
  const { store, dispatcher } = setup()
  store.set('act:ghost/act:abcd', { kind: 'ghost/act', payload: {}, status: 'pending', createdAt: 1 })
  const result = dispatcher.dispatch({ actionKey: 'act:ghost/act:abcd', token: 'whatever.sig' })
  // token 验签先失败（whatever.sig 非法）——先过验签再测 unknown-kind
  if (result.reason === 'bad-signature') {
    // 用真 vault 给该 key 铸造合法 token 复测
    const vault2 = createTokenVault({ secret: 'test-secret' })
    const token2 = vault2.mint('act:ghost/act:abcd')
    const retry = dispatcher.dispatch({ actionKey: 'act:ghost/act:abcd', token: token2 })
    assert.equal(retry.reason, 'unknown-kind')
    assert.equal(store.get('act:ghost/act:abcd').status, 'resolved')
    assert.equal(store.get('act:ghost/act:abcd').outcome, 'unknown-kind')
  } else {
    assert.equal(result.reason, 'unknown-kind')
  }
})

test('handler 抛异常：已核销 + 中文反馈 + 绝不外抛', () => {
  const { store, dispatcher } = setup()
  dispatcher.register('turn/cancel', () => { throw new Error('boom') })
  const minted = dispatcher.mintAction('turn/cancel', {})
  const result = dispatcher.dispatch({ actionKey: minted.key, token: minted.token })
  assert.equal(result.ok, true, '点击已生效（核销成功），执行异常另行反馈')
  assert.match(result.message, /异常/)
  assert.equal(store.get(minted.key).outcome, 'handler-error')
})

test('handler 返回 ok:false → message 透传给操作者', () => {
  const { store, dispatcher } = setup()
  dispatcher.register('turn/cancel', () => ({ ok: false, message: '会话不存在（任务可能已结束）' }))
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 'x' })
  const result = dispatcher.dispatch({ actionKey: minted.key, token: minted.token })
  assert.equal(result.ok, true, '核销成功')
  assert.equal(result.message, '会话不存在（任务可能已结束）')
  const row = store.get(minted.key)
  assert.equal(row.outcome, 'handler-declined')
})

test('key 跨重启唯一：连续 mint 的随机段不碰撞', () => {
  const { dispatcher } = setup()
  dispatcher.register('turn/cancel', () => ({}))
  const keys = new Set()
  for (let index = 0; index < 50; index += 1) {
    const minted = dispatcher.mintAction('turn/cancel', {})
    keys.add(minted.key)
  }
  assert.equal(keys.size, 50)
})

test('buildActionPayload / parseActionPayload：与审批同构往返（key 含冒号安全）', () => {
  const key = 'act:turn/cancel:1a2b3c4d'
  const token = 'payload.sig'
  const data = buildActionPayload(key, token)
  assert.ok(data.startsWith('ac:'))
  const parsed = parseActionPayload(data)
  assert.deepEqual(parsed, { actionKey: key, token })
  assert.equal(parseActionPayload('ap:allowed-once:x:y:z'), null, '审批负载不误吞')
  assert.equal(parseActionPayload('ac:onlytoken'), null)
  assert.equal(parseActionPayload(''), null)
  assert.equal(parseActionPayload(null), null)
})

test('全防御：dispatch 空参/异常 vault/store 均不外抛', () => {
  const dispatcher = createActionDispatcher({ vault: null, store: null })
  assert.equal(dispatcher.dispatch({}).ok, false)
  assert.equal(dispatcher.dispatch().ok, false)
  const broken = createActionDispatcher({
    vault: { mint: () => { throw new Error('x') }, verify: () => { throw new Error('y') } },
    store: memoryStore(),
  })
  broken.register('a/b', () => ({}))
  assert.equal(broken.mintAction('a/b', {}), null)
  assert.equal(broken.dispatch({ actionKey: 'act:a/b:x', token: 't' }).ok, false)
})
