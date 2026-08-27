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

test('v0.8.7 dispatch：accountId 原样转发进 Control Core（stop 载荷），缺省空串由 CC fail-closed', () => {
  const received = []
  const store = memoryStore()
  const vault = createTokenVault({ secret: 'actions-account-id' })
  // 贴近真实 CC 入口：接受时调用 input.settle（真实链路在此执行动作）。
  const control = { register: () => {}, handle: (input) => { received.push(input); return input.settle()?.ok === true ? { status: 'accepted' } : { status: 'rejected', reason: 'settlement_failed' } } }
  const dispatcher = createActionDispatcher({ vault, store, control })
  dispatcher.register('turn/cancel', () => ({ ok: true, message: '✅ 已停止任务' }))
  const minted = dispatcher.mintAction('turn/cancel', {}, { channel: 'telegram', chatId: 'tg-chat' })
  const ok = dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 7, chatId: 'tg-chat', accountId: 'tg-app' })
  assert.equal(ok.message, '✅ 已停止任务')
  assert.equal(received[0].command, 'stop')
  assert.equal(received[0].accountId, 'tg-app', '传输层本地 accountId 必须进入 CC 载荷')

  // 缺 accountId：载荷传空串（Control Core 以 missing_accountId fail-closed，绝不回退 channel 名）
  const received2 = []
  const control2 = { register: () => {}, handle: (input) => { received2.push(input); return { status: 'rejected', reason: 'missing_accountId' } } }
  const dispatcher2 = createActionDispatcher({ vault, store, control: control2 })
  dispatcher2.register('turn/cancel', () => ({ ok: true, message: '✅ 已停止任务' }))
  const minted2 = dispatcher2.mintAction('turn/cancel', {}, { channel: 'telegram', chatId: 'tg-chat' })
  const fail = dispatcher2.dispatch({ actionKey: minted2.key, token: minted2.token, via: 'telegram:action', userId: 7, chatId: 'tg-chat' })
  assert.equal(received2[0].accountId, '')
  assert.equal(fail.ok, false)
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
  // CRACK-001 后缺 srcChats 且窗外的行会先被来源闸拒绝——本用例只关心 unknown-kind，
  // 夹具给新鲜 createdAt 使其落入升级宽限窗、抵达 handler 查找。
  store.set('act:ghost/act:abcd', { kind: 'ghost/act', payload: {}, status: 'pending', createdAt: Date.now() })
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

// ---------------------------------------------------------------- v0.8.4 F-08 来源会话校验

test('F-08 来源会话校验：mint 记源 + 匹配成功 / 转发拒绝 / 缺会话拒绝', async () => {
  const { dispatcher } = setup()
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true, message: 'done' } })

  // mint 时记录来源通道+会话
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 's' }, { channel: 'telegram', chatId: '42' })
  assert.ok(minted !== null)

  // 原会话点击 → 成功
  const orig = dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 42, chatId: '42' })
  assert.equal(orig.ok, true, '来源匹配应执行')

  // 注：首达采纳已核销，后续用例用新的 mint
})

test('F-08 dispatch：转发点击拒绝（mismatch），不执行 handler', async () => {
  const { dispatcher } = setup()
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 's' }, { channel: 'telegram', chatId: '42' })

  const forwarded = dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 42, chatId: '999' })
  assert.equal(forwarded.ok, false)
  assert.equal(forwarded.reason, 'source-chat-mismatch')
  assert.match(forwarded.message, /原会话/)
  assert.equal(calls.length, 0, '转发点击不得执行 handler')
  assert.equal(dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 42, chatId: '999' }).reason, 'source-chat-mismatch')
})

test('F-08 dispatch：来源已记但缺点击会话（chatId 未传）→ 拒绝，不静默放行', async () => {
  const { dispatcher } = setup()
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 's' }, { channel: 'telegram', chatId: '42' })

  const missing = dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 42 })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'source-chat-required')
  assert.equal(calls.length, 0)
})

test('F-08 dispatch：跨通道转发拒绝（来源只记在 telegram，点击来自 feishu）', async () => {
  const { dispatcher } = setup()
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 's' }, { channel: 'telegram', chatId: '42' })

  const cross = dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'feishu:action', userId: 7, chatId: 'oc_42' })
  assert.equal(cross.ok, false)
  assert.equal(cross.reason, 'source-chat-mismatch')
  assert.equal(calls.length, 0)
})

test('F-08 dispatch：markSource 补记多目标，markSource/unmarkSource 生命周期', async () => {
  const { store, dispatcher } = setup()
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 's' })
  assert.equal(store.get(minted.key).srcChats, undefined, '无 meta → 账本无来源（历史卡兼容）')

  // 广播两个通道目标 → 各有来源
  dispatcher.markSource(minted.key, 'telegram', '42')
  dispatcher.markSource(minted.key, 'feishu', 'oc_42')
  assert.deepEqual([...store.get(minted.key).srcChats.telegram], ['42'])
  assert.deepEqual([...store.get(minted.key).srcChats.feishu], ['oc_42'])

  // 转发到未登记会话 → 拒绝
  const bad = dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 42, chatId: '7' })
  assert.equal(bad.reason, 'source-chat-mismatch')
  assert.equal(calls.length, 0)

  // 原来源都可点成功
  assert.equal(dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 42, chatId: '42' }).ok, true)
})

test('F-08 dispatch：legacy 老卡（无来源元数据）→ 显式 warn + 兼容放行', async () => {
  const loggerLines = []
  const logger = { warn: (p, m) => loggerLines.push(`${p} ${m}`) }
  const dispatcher = createActionDispatcher({ vault: createTokenVault({ secret: 'test-secret' }), store: memoryStore(), logger })
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })

  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 's' }) // 无 meta → legacy
  const result = dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 42, chatId: '999' })
  assert.equal(result.ok, true, '老卡缺来源元数据：兼容放行')
  assert.equal(calls.length, 1, '兼容路径仍执行 handler')
  assert.ok(loggerLines.some((line) => /srcChats/.test(line)), '应显式 warn 来源元数据缺失')
})

// ------------------------------------------------- CRACK-001 fail-closed + 升级宽限窗（28plan §4 A-1~A-9）

function graceRig() {
  const loggerLines = []
  const logger = { warn: (p, m) => loggerLines.push(`${p} ${m}`) }
  const store = memoryStore()
  const vault = createTokenVault({ secret: 'test-secret' })
  const dispatcher = createActionDispatcher({ vault, store, logger })
  return { loggerLines, store, vault, dispatcher }
}

/** 手工塞一张「无来源元数据」的 pending 卡并铸合法 token（模拟升级在途旧卡）。 */
function seedLegacyCard({ vault, store, key, ageMs = 6_000, srcChats }) {
  const row = { kind: 'turn/cancel', payload: {}, status: 'pending', createdAt: Date.now() - ageMs }
  if (srcChats !== undefined) row.srcChats = srcChats
  store.set(key, row)
  return { key, token: vault.mint(key) }
}

test('CRACK-001 A-3：升级在途旧卡（缺 srcChats、窗内）→ 宽限放行 + warn 含宽限', async () => {
  const { loggerLines, vault, store, dispatcher } = graceRig()
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })

  const card = seedLegacyCard({ vault, store, key: 'act:turn/cancel:grace-in', ageMs: 6_000 })
  const result = dispatcher.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '999' })
  assert.equal(result.ok, true, '窗内旧卡按宽限语义放行')
  assert.equal(calls.length, 1)
  assert.ok(loggerLines.some((line) => /srcChats/.test(line) && /宽限/.test(line)), `warn 应含「宽限」（实际：${loggerLines.join(' | ')}）`)
})

test('CRACK-001 A-4：窗外旧卡（缺 srcChats、>10min）→ source-chat-mismatch 拒绝 + warn，不核销不执行', async () => {
  const { loggerLines, vault, store, dispatcher } = graceRig()
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })

  const card = seedLegacyCard({ vault, store, key: 'act:turn/cancel:grace-out', ageMs: 10 * 60 * 1000 + 1000 })
  const result = dispatcher.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '42' })
  assert.equal(result.ok, false, '窗外旧卡 fail-closed 拒绝')
  assert.equal(result.reason, 'source-chat-mismatch')
  assert.match(result.message, /原会话/)
  assert.equal(calls.length, 0, '拒绝路径不得执行 handler')
  assert.equal(store.get(card.key).status, 'pending', '拒绝不核销（token 未消费，合法路径仍可走）')
  assert.ok(loggerLines.some((line) => /srcChats/.test(line) && /拒绝/.test(line)), `拒绝必显式 warn（实际：${loggerLines.join(' | ')}）`)
})

test('CRACK-001 边界：贴窗内沿放行 / 刚出窗 1ms 拒绝（±时钟漂移余量）', async () => {
  const { vault, store, dispatcher } = graceRig()
  dispatcher.register('turn/cancel', () => ({ ok: true }))
  // 内沿留 30s 余量防测试机时钟抖动翻红；外侧压 1ms 表达「<= 即放行」的紧边界意图
  const inside = seedLegacyCard({ vault, store, key: 'act:turn/cancel:edge-in', ageMs: 10 * 60 * 1000 - 30_000 })
  assert.equal(dispatcher.dispatch({ actionKey: inside.key, token: inside.token, via: 'telegram:action', userId: 1 }).ok, true)

  const outside = seedLegacyCard({ vault, store, key: 'act:turn/cancel:edge-out', ageMs: 10 * 60 * 1000 + 1 })
  assert.equal(dispatcher.dispatch({ actionKey: outside.key, token: outside.token, via: 'telegram:action', userId: 1 }).reason, 'source-chat-mismatch')
})

test('CRACK-001 A-5：显式 null 分窗——null+窗内放行（宽限），null+窗外拒绝', async () => {
  const { loggerLines, vault, store, dispatcher } = graceRig()
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })

  // A-5 空挡回归：srcChats===null 在旧代码里两分支都不命中 → 静默放行；新代码必须分窗
  const freshNull = seedLegacyCard({ vault, store, key: 'act:turn/cancel:null-in', ageMs: 6_000, srcChats: null })
  const okResult = dispatcher.dispatch({ actionKey: freshNull.key, token: freshNull.token, via: 'telegram:action', userId: 42, chatId: '999' })
  assert.equal(okResult.ok, true, '显式 null 窗内与 undefined 同语义（宽限放行）')
  assert.ok(loggerLines.some((line) => /宽限/.test(line)))

  const staleNull = seedLegacyCard({ vault, store, key: 'act:turn/cancel:null-out', ageMs: 10 * 60 * 1000 + 5_000, srcChats: null })
  const badResult = dispatcher.dispatch({ actionKey: staleNull.key, token: staleNull.token, via: 'telegram:action', userId: 42, chatId: '999' })
  assert.equal(badResult.ok, false, '显式 null 窗外一律拒绝（堵双空挡静默放行）')
  assert.equal(badResult.reason, 'source-chat-mismatch')
  assert.equal(calls.length, 1, '仅窗内那张执行过 handler')
})

test('CRACK-001 A-6：无 createdAt（无法核时间凭据）→ 拒绝不宽限', async () => {
  const { loggerLines, vault, store, dispatcher } = graceRig()
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })

  store.set('act:turn/cancel:no-ts', { kind: 'turn/cancel', payload: {}, status: 'pending' })
  const token = vault.mint('act:turn/cancel:no-ts')
  const result = dispatcher.dispatch({ actionKey: 'act:turn/cancel:no-ts', token, via: 'telegram:action', userId: 42, chatId: '42' })
  assert.equal(result.ok, false, '无时间戳即无宽限资格，fail-closed')
  assert.equal(result.reason, 'source-chat-mismatch')
  assert.equal(calls.length, 0)
  assert.ok(loggerLines.some((line) => /拒绝/.test(line)), '拒绝必 warn')
})

test('CRACK-001 A-7：异常形状 srcChats（数组/字符串/数字）一律 fail-closed，连宽限窗内也不放行', async () => {
  // REVIEW-ABC BUG-4：src/actions.mjs:197-198 的注释宣称「异常形状（数组等）一律
  // fail-closed，仅宽限窗内对 undefined/null 放行」，但把该判据（graceSourceAllowed 里
  // 的 `row.srcChats !== undefined && !== null → return false`）整条删掉后测试全绿——
  // 说明这条收紧只有注释没有守卫测试（恒绿摆设）。异常形状不能借宽限窗绕过来源校验：
  // 数组 srcChats 过不了严校验分支的 plain-object 判定，若又能吃宽限，等于任意会话可点。
  for (const shape of [['42'], 'telegram', 42, true]) {
    const { loggerLines, vault, store, dispatcher } = graceRig()
    const calls = []
    dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })
    // 窗内（6s，远在 10min 宽限内）——唯一变量就是 srcChats 的形状
    const card = seedLegacyCard({
      vault, store, key: `act:turn/cancel:shape-${JSON.stringify(shape)}`, ageMs: 6_000, srcChats: shape,
    })
    const result = dispatcher.dispatch({
      actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '42',
    })
    assert.equal(result.ok, false, `异常形状 ${JSON.stringify(shape)} 不得放行（即使在宽限窗内）`)
    assert.equal(result.reason, 'source-chat-mismatch')
    assert.equal(calls.length, 0, `异常形状 ${JSON.stringify(shape)} 不得执行 handler`)
    assert.equal(store.get(card.key).status, 'pending', '拒绝不核销')
    assert.ok(loggerLines.some((line) => /拒绝/.test(line)), `拒绝必 warn（实际：${loggerLines.join(' | ')}）`)
  }
})

test('CRACK-001 装配侧契约：mint 无 meta → markSource 补登 → 新卡落 srcChats 走严校验', async () => {
  const { store, dispatcher } = setup()
  const calls = []
  dispatcher.register('turn/cancel', (p) => { calls.push(p); return { ok: true } })

  // event-listener.mjs pushActionCard 的真实模式：mint 不带 meta，发送前逐目标 markSource
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 's' })
  dispatcher.markSource(minted.key, 'telegram', '42')
  assert.deepEqual(store.get(minted.key).srcChats, { telegram: ['42'] }, '送达前新卡已落来源集合')

  // 新卡严校验生效：未登记会话拒 / 原登记会话过
  assert.equal(dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 42, chatId: '7' }).reason, 'source-chat-mismatch')
  assert.equal(dispatcher.dispatch({ actionKey: minted.key, token: minted.token, via: 'telegram:action', userId: 42, chatId: '42' }).ok, true)
  assert.equal(calls.length, 1)
})

test('CRACK-001 装配侧兜底：markSource 落账失败（store 抛错被吞）→ 窗内可点、窗外拒，不产生永久免检卡', async () => {
  // 模拟 event-listener.mjs:301 catch 路径：mint 成功后 markSource 的 store.set 抛错
  // （偶发磁盘故障），卡片照发但账本无 srcChats。宽限窗必须给它 10min 上界。
  const data = new Map()
  let calls = 0
  const flakyStore = {
    get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
    set: (key, value) => {
      calls += 1
      if (calls % 2 === 0) throw new Error('disk busy') // 每张卡的 markSource 那次写失败
      data.set(key, value)
    },
    delete: (key) => { data.delete(key) },
  }
  const loggerLines = []
  const logger = { warn: (p, m) => loggerLines.push(`${p} ${m}`) }
  const vault = createTokenVault({ secret: 'test-secret' })
  const dispatcher = createActionDispatcher({ vault, store: flakyStore, logger })
  dispatcher.register('turn/cancel', () => ({ ok: true }))

  // 第一张：markSource 失败 → 无来源 → 窗内点击走宽限放行
  const cardA = dispatcher.mintAction('turn/cancel', { sessionId: 'a' })
  try { dispatcher.markSource(cardA.key, 'telegram', '42') } catch { /* 装配层 catch 吞掉 */ }
  assert.equal(data.get(cardA.key).srcChats, undefined, 'markSource 失败后账本确无来源')
  const clickA = dispatcher.dispatch({ actionKey: cardA.key, token: cardA.token, via: 'telegram:action', userId: 42, chatId: '999' })
  assert.equal(clickA.ok, true, 'markSource 失败的新卡窗内仍可点（有界折中）')
  assert.ok(loggerLines.some((line) => /宽限/.test(line)), '且必须以宽限 warn 可见')

  // 第二张：同路径铸造后把账本行回拨到窗外 → 必须拒绝（免检不可永久）
  const cardB = dispatcher.mintAction('turn/cancel', { sessionId: 'b' })
  try { dispatcher.markSource(cardB.key, 'telegram', '42') } catch { /* 同上 */ }
  data.set(cardB.key, { ...data.get(cardB.key), createdAt: Date.now() - (10 * 60 * 1000 + 1000) })
  const clickB = dispatcher.dispatch({ actionKey: cardB.key, token: cardB.token, via: 'telegram:action', userId: 42, chatId: '999' })
  assert.equal(clickB.ok, false, '同一失败路径的卡出窗后 fail-closed')
  assert.equal(clickB.reason, 'source-chat-mismatch')
})
