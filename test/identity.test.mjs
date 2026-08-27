// v0.7 Phase 1 测试：identity 绑定层 + bus 复合准入/引导态/回执矩阵。
// 覆盖计划书 §3.1/§3.2/§3.4 与验收红线：
//  - 迁移幂等、播撒全通道、只增不减（删 YAML 后 store 留存）
//  - 跨渠道准入隔离（同 id 不同渠道互不命中）
//  - 引导态三命令放行 + 裸消息拒（负控：不触审批、不进会话扇出）
//  - 拒绝回执含发送者自身渠道身份；60s 节流
//  - bootstrap 并发单胜（两用户同码，仅一人成 owner）
//  - 静默永不批准：引导态伪造「1」不裁决任何等待中的审批

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/inbound/store.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createPairing } from '../src/inbound/pairing.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notifier-identity-'))
  return { dir, store: createStore(join(dir, 'state.json')) }
}

const quiet = { warn: () => {}, info: () => {} }

function makeRig({ bindings = null, allowUsers = [] } = {}) {
  const { store } = tempStore()
  const identity = createIdentity({ store, logger: quiet })
  const pairing = createPairing({ store, logger: quiet })
  if (bindings !== null) {
    for (const [channel, userId] of bindings) identity.addBinding({ channel, userId })
  }
  const bus = createInboundBus({ allowUsers, identity, pairing, store, logger: quiet })
  return { store, identity, pairing, bus }
}

const env = (over = {}) => ({
  channel: 'telegram', userId: '42', chatId: '42', chatType: 'private',
  messageId: `m${Math.random().toString(36).slice(2)}`, text: 'hi', ...over,
})

// ---------------------------------------------------------------- identity 绑定层

test('identity：迁移一次性播撒——按渠道形态过滤，空表首条 owner（R5 对账）', () => {
  const { store } = tempStore()
  const identity = createIdentity({ store, logger: quiet })
  // 数字 id 只播给接受数字形态的通道（telegram/wxpusher），feishu 形态过滤拦下（R5-3-P1-3：
  // 异形状 id 曾被无差别播撒，占据一级解析后永久遮蔽通道自己的配置清单）
  const first = identity.migrate(['42', '100'], ['telegram', 'feishu'])
  assert.equal(first.added, 2, '2 人 × 仅 telegram（feishu 不吃裸数字）')
  assert.equal(identity.size(), 2)
  assert.equal(identity.allows('telegram', '42'), true)
  assert.equal(identity.allows('feishu', '42'), false, '异形状 id 不播给飞书')
  // 空表首条 owner：迁移实例也有 owner（R5-1-P2-2：硬编码 member 曾让 ownerCount 恒 0）
  assert.equal(identity.list()[0].role, 'owner')
  // 一次性标记：二次启动不再播撒（R5-1-P1-1：重播会复活管理台已删成员）
  const second = identity.migrate(['42', '100', '999'], ['telegram', 'qq'])
  assert.equal(second.added, 0)
  assert.equal(second.skipped, true)
  assert.equal(identity.size(), 2)
  // 飞书形态 id 首次迁移可播给飞书
  const feishu = createIdentity({ store: createStore(join(mkdtempSync(join(tmpdir(), 'dsh-2-')), 'state.json')), logger: quiet })
  const seeded = feishu.migrate(['ou_alice'], ['feishu', 'telegram'])
  assert.equal(seeded.added, 1, 'ou_ 只进 feishu（TG 不吃前缀形态）')
  assert.equal(feishu.allows('feishu', 'ou_alice'), true)
})

test('identity：迁移只增不减——YAML 删人后 store 绑定留存', () => {
  const { store } = tempStore()
  const identity = createIdentity({ store, logger: quiet })
  identity.migrate(['42'], ['telegram'])
  identity.migrate([], ['telegram']) // YAML 清空重启
  assert.equal(identity.allows('telegram', '42'), true, '删减权收归管理台，YAML 清空不回收绑定')
})

test('identity：迁移不复活管理台已删成员（一次性标记的验收面）', () => {
  const { store } = tempStore()
  const identity = createIdentity({ store, logger: quiet })
  identity.migrate(['42'], ['telegram'])
  identity.removeBinding('telegram', '42') // 管理台删人
  identity.migrate(['42'], ['telegram']) // YAML 仍在，重启
  assert.equal(identity.allows('telegram', '42'), false, '重启后不复活（R5-1-P1-1 验收）')
  assert.equal(identity.size(), 0)
})

test('identity：跨渠道准入隔离——同 id 不同渠道互不命中（修审查 #5 入站半边）', () => {
  const { store } = tempStore()
  const identity = createIdentity({ store, logger: quiet })
  identity.addBinding({ channel: 'telegram', userId: '12345' })
  assert.equal(identity.allows('telegram', '12345'), true)
  assert.equal(identity.allows('feishu', '12345'), false, 'TG 数字 id 不得命中飞书名单位')
  assert.equal(identity.allows('qq', '12345'), false)
  assert.equal(identity.allows('wxpusher', '12345'), false)
})

test('identity：首条绑定为 owner，其后为 member；label 长度截断', () => {
  const { store } = tempStore()
  const identity = createIdentity({ store, logger: quiet })
  const first = identity.addBinding({ channel: 'telegram', userId: '1', label: 'x'.repeat(100) })
  assert.equal(first.ok, true)
  assert.equal(first.record.role, 'owner')
  assert.equal(first.record.label.length, 64)
  const second = identity.addBinding({ channel: 'feishu', userId: 'ou_2' })
  assert.equal(second.record.role, 'member')
  assert.equal(identity.ownerCount(), 1)
  // 重复绑定拒绝
  assert.equal(identity.addBinding({ channel: 'telegram', userId: '1' }).reason, 'already-bound')
  // 非法入参拒绝
  assert.equal(identity.addBinding({ channel: 'nope', userId: '1' }).reason, 'invalid-channel')
  assert.equal(identity.addBinding({ channel: 'qq', userId: '' }).reason, 'invalid-user')
})

test('identity：绑定记录读盘防御——坏形状整条丢弃、坏字段回退默认', () => {
  const { store } = tempStore()
  store.set('inbound:bindings', {
    'telegram:ok': { channel: 'telegram', userId: 'ok', role: 'owner', pairedAt: 1, origin: 'paired' },
    'feishu:bad-role': { channel: 'feishu', userId: 'bad-role', role: 'hacker' }, // role 回退 member
    'qq:bad-shape': 'not-an-object', // 整条丢弃
    'badchannel:x': { channel: '??', userId: 'x' }, // 渠道非法整条丢弃
  })
  const identity = createIdentity({ store, logger: quiet })
  assert.equal(identity.size(), 2)
  assert.equal(identity.list().find((r) => r.userId === 'bad-role').role, 'member')
})

test('identity：addBinding 拒绝 userId 含冒号（纵深防御，防复合键截断）', () => {
  const { store } = tempStore()
  const warns = []
  const identity = createIdentity({ store, logger: { warn: (...args) => warns.push(args.join(' ')), info: () => {} } })
  const rejected = identity.addBinding({ channel: 'telegram', userId: 'a:b' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.reason, 'invalid-user')
  assert.ok(warns.some((w) => /含冒号/.test(w)), `应显式 warn 含冒号绑定（实际：${warns.join(' | ')}）`)
  assert.equal(identity.allows('telegram', 'a'), false, '截断前半不得命中')
  assert.equal(identity.allows('telegram', 'a:b'), false, '冒号 uid 整段不得准入')
  // 无冒号仍正常
  assert.equal(identity.addBinding({ channel: 'telegram', userId: 'ok' }).ok, true)
})

test('identity：normalizeBinding 用 indexOf 切分，与 admin parseMemberKey 对齐（冒号 userId 不被截断）', () => {
  const { store } = tempStore()
  // 显式字段正确 + key 含冒号：应完整保留 userId
  store.set('inbound:bindings', {
    'telegram:foo:bar': { channel: 'telegram', userId: 'foo:bar', role: 'owner', pairedAt: 1, origin: 'paired' },
    // 字段缺失时依赖 fallbackKey 解析：indexOf 只切第一个冒号
    'wxpusher:UID_1:extra': { role: 'member', pairedAt: 2, origin: 'paired' },
  })
  const identity = createIdentity({ store, logger: quiet })
  assert.equal(identity.size(), 2)
  const explicit = identity.list().find((r) => r.userId === 'foo:bar')
  assert.ok(explicit, '显式字段的冒号 userId 应被完整保留')
  assert.equal(explicit.channel, 'telegram')
  const fallback = identity.list().find((r) => r.userId === 'UID_1:extra')
  assert.ok(fallback, `fallbackKey 应取第一个冒号后整段（实际：${fallback?.userId}）`)
  assert.equal(fallback.channel, 'wxpusher')
  assert.equal(identity.allows('wxpusher', 'UID_1:extra'), true)
})

test('identity：readPending 剔除含冒号的存量待确认键（旧版投毒行清扫，且不复活为绑定）', () => {
  // REVIEW-ABC BUG-5：src/inbound/identity.mjs readPending 的 `userId.includes(':')`
  // 过滤此前无测试——删掉它全套仍绿（恒绿摆设）。旧版 wxpusher UID_PATTERN 放行冒号，
  // app_subscribe 可把 `wxpusher:UID:EVIL` 写进待确认表；若读盘仍认这类键，管理台待确认
  // 列表会展示一条截断/歧义身份，点「确认」即触碰越权路径。
  const { store } = tempStore()
  const warns = []
  store.set('inbound:pending', {
    'wxpusher:UID:EVIL': { channel: 'wxpusher', userId: 'UID:EVIL', origin: 'learned', at: Date.now(), extra: {} },
    'wxpusher:UID_OK': { channel: 'wxpusher', userId: 'UID_OK', origin: 'learned', at: Date.now(), extra: {} },
  })
  const identity = createIdentity({ store, logger: { warn: (...args) => warns.push(args.join(' ')), info: () => {} } })
  assert.deepEqual(identity.listPending().map((r) => r.userId), ['UID_OK'], '含冒号待确认键不得读出')
  assert.deepEqual(Object.keys(store.get('inbound:pending', {})), ['wxpusher:UID_OK'], '坏键顺带清扫落盘')
  assert.ok(warns.some((w) => /清扫/.test(w)), `清扫必须可见，不得静默（实际：${warns.join(' | ')}）`)
  // 不得经 confirm 复活成绑定
  assert.equal(identity.confirmPending('wxpusher', 'UID:EVIL').ok, false)
  assert.equal(identity.allows('wxpusher', 'UID:EVIL'), false)
  assert.equal(identity.size(), 0)
})

test('identity：待确认绑定 add/confirm/dismiss 生命周期', () => {
  const { store } = tempStore()
  const identity = createIdentity({ store, logger: quiet })
  identity.addBinding({ channel: 'telegram', userId: 'owner' })
  assert.equal(identity.addPending({ channel: 'feishu', userId: 'ou_new', origin: 'learned' }).ok, true)
  assert.equal(identity.listPending().length, 1)
  // 已绑定者不进待确认
  assert.equal(identity.addPending({ channel: 'telegram', userId: 'owner' }).reason, 'already-bound')
  // 确认 → 转正
  const confirmed = identity.confirmPending('feishu', 'ou_new')
  assert.equal(confirmed.ok, true)
  assert.equal(identity.allows('feishu', 'ou_new'), true)
  assert.equal(identity.listPending().length, 0)
  // 忽略 → 消失且不绑定
  identity.addPending({ channel: 'qq', userId: 'q1' })
  assert.equal(identity.dismissPending('qq', 'q1').ok, true)
  assert.equal(identity.allows('qq', 'q1'), false)
  assert.equal(identity.confirmPending('qq', 'q1').reason, 'not-found')
})

// ---------------------------------------------------------------- bus 复合准入与引导态

test('bus：引导态判定——绑定表空 + allowUsers 空 = guided；注册命令放行', () => {
  const { bus } = makeRig()
  assert.equal(bus.guided(), true)
  // /help /whoami 在引导态被受理（返回 reply，不进业务扇出）
  const help = bus.accept(env({ text: '/help' }))
  assert.equal(help.ok, true)
  assert.match(help.reply, /引导模式/)
  const whoami = bus.accept(env({ text: '/whoami', userId: '99' }))
  assert.equal(whoami.ok, true)
  assert.match(whoami.reply, /99/)
  assert.match(whoami.reply, /尚未绑定/)
})

test('bus：引导态裸消息 → guided 回执（含发送者身份），不进业务扇出（负控）', () => {
  const { bus } = makeRig()
  let fannedOut = 0
  bus.onMessage(() => { fannedOut += 1 })
  const result = bus.accept(env({ text: '你好', userId: '77' }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'guided')
  assert.match(result.reply, /77/)
  assert.match(result.reply, /\/pair/)
  assert.equal(fannedOut, 0, '业务面全拒：引导态消息绝不扇出')
})

test('bus 红线：引导态伪造审批回复「1」不裁决任何等待中的审批（静默永不批准）', async () => {
  const { bus } = makeRig()
  const pending = bus.wait('ap:test:1', 80)
  const forged = bus.accept(env({ text: '1' }))
  assert.equal(forged.reason, 'guided')
  const verdict = await pending
  assert.equal(verdict, null, '无人应答超时回落桌面——引导态消息永不触审批')
})

test('bus：名单非空未绑定 → whitelist 回执含自身身份 + 配对指引；60s 节流', () => {
  const { bus } = makeRig({ bindings: [['telegram', '42']] })
  assert.equal(bus.guided(), false)
  const first = bus.accept(env({ text: 'hi', userId: '88' }))
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'whitelist')
  assert.match(first.reply, /88/)
  assert.match(first.reply, /管理员/)
  // 节流：同用户窗口内第二条拒绝无 reply（吞掉，不轰炸）
  const second = bus.accept(env({ text: 'again', userId: '88' }))
  assert.equal(second.ok, false)
  assert.equal(second.reply, undefined, '60s 内第二次拒绝不重复回执')
  // 不同用户不受节流影响
  const other = bus.accept(env({ text: 'hi', userId: '99' }))
  assert.match(other.reply, /99/)
})

test('bus：绑定成员普通消息扇出且无 reply；/whoami 拦截消费不扇出', () => {
  const { bus } = makeRig({ bindings: [['telegram', '42']] })
  let fannedOut = 0
  bus.onMessage(() => { fannedOut += 1 })
  const plain = bus.accept(env({ text: '在吗' }))
  assert.equal(plain.ok, true)
  assert.equal(plain.reply, undefined)
  assert.equal(fannedOut, 1)
  const whoami = bus.accept(env({ text: '/whoami' }))
  assert.equal(whoami.ok, true)
  assert.match(whoami.reply, /已绑定/)
  assert.equal(fannedOut, 1, '注册面命令被消费，不进业务扇出')
})

test('bus：复合键准入——TG 绑定不等于飞书绑定（跨渠道串扰修入站半边）', () => {
  const { bus } = makeRig({ bindings: [['telegram', '42']] })
  assert.equal(bus.allows('telegram', '42'), true)
  assert.equal(bus.allows('feishu', '42'), false)
  const fromFeishu = bus.accept(env({ channel: 'feishu', userId: '42', chatId: 'oc_1', text: 'hi' }))
  assert.equal(fromFeishu.reason, 'whitelist')
})

test('bus：/pair 成员可自助换号入口——未绑定者持有效码可绑定（不在白名单也能配对）', () => {
  const { bus, pairing } = makeRig({ bindings: [['telegram', '42']] })
  const minted = pairing.mint({ origin: 'admin', mintedBy: 'admin' })
  const result = bus.accept(env({ text: `/pair ${minted.code} 新同事`, userId: '88' }))
  assert.equal(result.ok, true)
  assert.match(result.reply, /配对成功/)
  assert.equal(bus.allows('telegram', '88'), true)
})

test('bus：bootstrap 并发单胜——同码两用户先后核销，仅第一人成 owner（落盘验证）', () => {
  const rig = makeRig()
  const bootstrap = rig.pairing.mint({ origin: 'bootstrap', mintedBy: 'system:boot' })
  const alice = rig.bus.accept(env({ text: `/pair ${bootstrap.code}`, userId: '1' }))
  const bob = rig.bus.accept(env({ text: `/pair ${bootstrap.code}`, userId: '2' }))
  assert.match(alice.reply, /owner/)
  assert.match(bob.reply, /已被使用/, `第二人必败：${bob.reply}`)
  const table = rig.store.get('inbound:bindings', {})
  const owners = Object.values(table).filter((r) => r.role === 'owner')
  assert.equal(owners.length, 1, '单胜：只有一人是 owner')
  assert.equal(owners[0].userId, '1')
})

test('bus：群聊 /pair 拒答——码不消费，引导私聊', () => {
  const { bus, pairing } = makeRig()
  const bootstrap = pairing.mint({ origin: 'bootstrap', mintedBy: 'system:boot' })
  const group = bus.accept(env({
    text: `/pair ${bootstrap.code}`, chatId: '-100123', chatType: 'group',
  }))
  assert.match(group.reply, /私聊/, '群里发码拒答')
  // 码未被消费：私聊再发仍可核销
  const privateTry = bus.accept(env({ text: `/pair ${bootstrap.code}`, userId: '1' }))
  assert.match(privateTry.reply, /owner/)
})

test('bus：/unpair 末位 owner 拒绝；member 可自解绑', () => {
  const { bus, identity } = makeRig({ bindings: [['telegram', '1'], ['feishu', 'ou_2']] })
  const owner = identity.list().find((r) => r.role === 'owner')
  const member = identity.list().find((r) => r.role === 'member')
  const ownerTry = bus.accept(env({ channel: owner.channel, userId: owner.userId, text: '/unpair' }))
  assert.match(ownerTry.reply, /唯一.*owner/)
  const memberTry = bus.accept(env({ channel: member.channel, userId: member.userId, chatId: 'oc_9', chatType: 'p2p', text: '/unpair' }))
  assert.match(memberTry.reply, /已解绑/)
  assert.equal(bus.allows(member.channel, member.userId), false)
})

test('bus：命令处理异常不上抛（A listener never throws 覆盖注册面）', () => {
  const { store } = tempStore()
  const identity = createIdentity({ store, logger: quiet })
  // 注入一个会炸的 pairing：redeem 抛错
  const badPairing = { redeem: () => { throw new Error('boom') }, hasActiveBootstrap: () => false, mint: () => ({ ok: true, code: 'X', expiresAt: 1 }) }
  const bus = createInboundBus({ identity, pairing: badPairing, store, logger: quiet })
  const result = bus.accept(env({ text: '/pair ABC23456' }))
  assert.equal(result.ok, true)
  assert.match(result.reply, /内部错误|稍后重试/)
})

test('bus：旧构造（无 identity）保持 v0.6 扁平行为——allows(userId) 单参兼容', () => {
  const { store } = tempStore()
  const bus = createInboundBus({ allowUsers: ['42'], store, logger: quiet })
  assert.equal(bus.allows('42'), true)
  assert.equal(bus.allows('43'), false)
  assert.equal(bus.accept(env({ text: 'hi', userId: '42' })).ok, true)
  const rejected = bus.accept(env({ text: 'hi', userId: '43' }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.reply, undefined, '旧装配无回执（保持 v0.6 行为）')
})

test('bus：去重优先于一切——重复消息静默跳过（含命令）', () => {
  const { bus } = makeRig({ bindings: [['telegram', '42']] })
  const envelope = env({ text: '/whoami' })
  const first = bus.accept(envelope)
  assert.match(first.reply, /已绑定/)
  const dup = bus.accept(envelope)
  assert.equal(dup.reason, 'duplicate')
  assert.equal(dup.reply, undefined)
})

test('bus：拒绝路径也记账——平台重投同 messageId 直接 duplicate，不重走判定链', () => {
  const { bus } = makeRig({ bindings: [['telegram', '42']] })
  const envelope = env({ userId: '43' })
  const first = bus.accept(envelope)
  assert.equal(first.ok, false)
  assert.match(first.reply ?? '', /不在白名单/, '首投有拒绝回执')
  const retry = bus.accept(envelope)
  assert.deepEqual(retry, { ok: false, reason: 'duplicate' }, '重投被去重层拦下（R5-3-P3-2）')
})

test('identity：待确认绑定 7 天 TTL——超期条目读路径清扫，清扫后不可确认', () => {
  const { store } = tempStore()
  const identity = createIdentity({ store, logger: quiet })
  identity.addPending({ channel: 'feishu', userId: 'ou_fresh' })
  const pending = JSON.parse(JSON.stringify(store.get('inbound:pending', {})))
  pending['qq:stale'] = { channel: 'qq', userId: 'stale', origin: 'learned', at: Date.now() - 8 * 24 * 60 * 60 * 1000, extra: {} }
  store.set('inbound:pending', pending)

  const listed = identity.listPending()
  assert.equal(listed.length, 1, '超期条目被清扫（仅剩新鲜条目）')
  assert.equal(listed[0].userId, 'ou_fresh')
  assert.equal(identity.confirmPending('qq', 'stale').reason, 'not-found', '清扫后确认按不存在处理')
  assert.equal('qq:stale' in store.get('inbound:pending', {}), false, '清扫结果已写回')
})

// ---------------------------------------------------------------- pairing 审计与安全

test('pairing：落盘只有哈希无码面；码面仅在 mint 返回值出现一次', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  const minted = pairing.mint({ origin: 'admin', mintedBy: 'admin' })
  assert.match(minted.code, /^[A-HJ-NP-Z2-9]{8}$/, '8 位 base32（无 I/L/O/0/1）')
  const raw = JSON.stringify(store.get('inbound:pairing', {}))
  assert.ok(!raw.includes(minted.code), 'state.json 不得出现码面明文')
  assert.ok(raw.includes(minted.id), '以 id（哈希前 8 位）索引进落盘')
})

test('pairing：审计回调全事件（mint/redeem/revoke/lock/expire）', () => {
  const { store } = tempStore()
  const events = []
  const pairing = createPairing({
    store, logger: quiet, onAudit: (event, detail) => events.push([event, detail]),
  })
  const minted = pairing.mint({ origin: 'admin', mintedBy: 'boss' })
  pairing.redeem(minted.code, { channel: 'telegram', userId: '42' })
  const other = pairing.mint({ origin: 'admin', mintedBy: 'boss' })
  pairing.revoke(other.id, { by: 'boss' })
  const third = pairing.mint({ origin: 'admin', mintedBy: 'boss' })
  pairing.lock(third.id, { by: 'boss' })
  const expired = pairing.mint({ origin: 'admin', mintedBy: 'boss', ttlMs: 1 })
  pairing.redeem(expired.code, { channel: 'telegram', userId: '42', now: Date.now() + 5000 })
  const names = events.map(([name]) => name)
  for (const expected of ['mint', 'redeem', 'revoke', 'lock', 'expire']) {
    assert.ok(names.includes(expected), `审计缺 ${expected}：${names.join(',')}`)
  }
})

test('pairing：用户锁出——滑窗连续 5 次失败后 10 分钟内拒绝（防在线暴力）', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  const minted = pairing.mint({ origin: 'admin', mintedBy: 'boss' })
  for (let i = 0; i < 4; i += 1) {
    assert.equal(pairing.redeem('WRONG99' + 'X'.repeat(i), { channel: 'telegram', userId: '42' }).reason, 'invalid-code')
  }
  const fifth = pairing.redeem('WRONG99X999', { channel: 'telegram', userId: '42' })
  assert.equal(fifth.reason, 'locked-out', '第 5 次失败触发锁出')
  // 正确的码也进不来（锁出优先）
  assert.equal(pairing.redeem(minted.code, { channel: 'telegram', userId: '42' }).reason, 'locked-out')
  // 其他用户不受牵连
  assert.equal(pairing.redeem(minted.code, { channel: 'telegram', userId: '43' }).ok, true)
  // 时间前进越过锁出期后恢复（且失败计数已清）
  assert.equal(pairing.isLockedOut('telegram', '42', Date.now() + 11 * 60 * 1000), false)
})

test('pairing：锁出表有界化——完全过期的旧条目写路径顺手清除（R5-3-P3-6）', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  // 手工构造两条陈旧锁出记录：一条失败全滑出窗口，一条锁出期已过
  const stale = Date.now() - 20 * 60 * 1000
  store.set('inbound:pairing:lockout', {
    'telegram:old-fails': { fails: [stale, stale], lockedUntil: 0 },
    'qq:old-lock': { fails: [stale], lockedUntil: Date.now() - 5 * 60 * 1000 },
  })
  // 新用户一次失败记账 → 写路径顺带清扫两条死条目，只留新用户自己
  pairing.redeem('WRONGCODE', { channel: 'feishu', userId: 'u9' })
  const table = store.get('inbound:pairing:lockout', {})
  assert.deepEqual(Object.keys(table).sort(), ['feishu:u9'], '陈旧条目被清除')
  assert.equal(table['feishu:u9'].fails.length, 1, '新用户失败计数保留')
  // 锁出中的条目绝不清除（安全语义优先于有界化）
  store.set('inbound:pairing:lockout', {
    ...store.get('inbound:pairing:lockout', {}),
    'qq:still-locked': { fails: [Date.now()], lockedUntil: Date.now() + 9 * 60 * 1000 },
  })
  pairing.redeem('WRONGCODE', { channel: 'feishu', userId: 'u10' })
  const after = store.get('inbound:pairing:lockout', {})
  assert.equal('qq:still-locked' in after, true, '锁出中的条目保留')
})

test('pairing：bootstrap 重铸替换旧码（单实例单引导码）', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  const first = pairing.mint({ origin: 'bootstrap', mintedBy: 'system' })
  const second = pairing.mint({ origin: 'bootstrap', mintedBy: 'system' })
  assert.equal(pairing.hasActiveBootstrap(), true)
  assert.equal(pairing.listActive().length, 1, '旧 bootstrap 已被替换（撤销）')
  assert.equal(pairing.redeem(first.code, { channel: 'telegram', userId: '1' }).reason, 'revoked')
  assert.equal(pairing.redeem(second.code, { channel: 'telegram', userId: '1' }).ok, true)
})

test('pairing：redeem 大小写/空白归一 + 状态机终态语义', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  const minted = pairing.mint({ origin: 'admin', mintedBy: 'boss' })
  const normalized = pairing.redeem(` ${minted.code.toLowerCase()} `, { channel: 'qq', userId: 'q1' })
  assert.equal(normalized.ok, true)
  // 单次核销：同码二次必败
  assert.equal(pairing.redeem(minted.code, { channel: 'qq', userId: 'q2' }).reason, 'already-redeemed')
  // 垃圾输入快速失败
  assert.equal(pairing.redeem('', { channel: 'qq', userId: 'q3' }).reason, 'invalid-code')
  assert.equal(pairing.redeem('有中文的码', { channel: 'qq', userId: 'q3' }).reason, 'invalid-code')
})

test('pairing：终态条目 24h 后写路径清扫（防 state 无限膨胀）', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  const t0 = Date.now() - 25 * 60 * 60 * 1000 // 一天前铸的码
  const old = pairing.mint({ origin: 'admin', mintedBy: 'boss', ttlMs: 60_000, now: t0 })
  assert.equal(pairing.redeem(old.code, { channel: 'qq', userId: 'q1', now: t0 + 1000 }).ok, true)
  pairing.mint({ origin: 'admin', mintedBy: 'boss' }) // 触发写路径清扫
  const table = store.get('inbound:pairing', {})
  assert.equal(table[Object.keys(table).find((k) => k.startsWith(old.id))], undefined,
    'redeemed 超 24h 被清扫')
})

// ————————————————— v0.8.7 B1：过期码锁出 + 引导码重铸节流 —————————————————
// 漏洞原状（BYPASS-BOOT）：redeem 对 expired 码不记 recordFailure（直接 return），
// 过期码可无限次触发 ensureBootstrap 重铸；配合旧的 stderr 印码面 = 泵码 144 枚/天。
// 修法双保险：expired 计入失败计数（5 次锁出 10min）+ ensureBootstrap 节流 10min。

test('B1-4 过期码计入失败计数：连提 5 次过期码 → locked-out（BYPASS-BOOT 泵码堵死）', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  const stale = pairing.mint({ origin: 'bootstrap', mintedBy: 'system:boot', ttlMs: 1 })
  const later = Date.now() + 5000 // 码已过期
  // 前 4 次：过期回执，尚未触阈
  for (let i = 0; i < 4; i += 1) {
    assert.equal(pairing.redeem(stale.code, { channel: 'telegram', userId: '42', now: later }).reason, 'expired',
      `第 ${i + 1} 次应仍是 expired`)
  }
  // 第 5 次：触发锁出，reason 换成 locked-out（commands 的 expired 分支因此不再命中 → 不重铸）
  assert.equal(pairing.redeem(stale.code, { channel: 'telegram', userId: '42', now: later }).reason, 'locked-out',
    '第 5 次过期码提交必须触发锁出（否则可无限泵码）')
  assert.equal(pairing.isLockedOut('telegram', '42', later), true)
  // 锁出期内：连有效码也进不来（锁出优先，与 invalid-code 锁出同口径）
  const fresh = pairing.mint({ origin: 'admin', mintedBy: 'boss', now: later })
  assert.equal(pairing.redeem(fresh.code, { channel: 'telegram', userId: '42', now: later }).reason, 'locked-out')
  // 越过锁出期：恢复受理（注意 fresh 自身 10 分钟 TTL 此时也过期了，另铸一枚测恢复）
  const unlocked = later + 11 * 60 * 1000
  assert.equal(pairing.isLockedOut('telegram', '42', unlocked), false, '10 分钟后解锁')
  const afterUnlock = pairing.mint({ origin: 'admin', mintedBy: 'boss', now: unlocked })
  assert.equal(pairing.redeem(afterUnlock.code, { channel: 'telegram', userId: '42', now: unlocked }).ok, true,
    '解锁后合法用户可正常配对（宪法#6 用户失误不永久锁死）')
})

test('B1-4b 过期码锁出边界：第 4 次仍受理、恰好第 5 次翻锁（上下边界各钉一次）', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  const stale = pairing.mint({ origin: 'bootstrap', mintedBy: 'system:boot', ttlMs: 1 })
  const later = Date.now() + 5000
  for (let i = 0; i < 3; i += 1) pairing.redeem(stale.code, { channel: 'qq', userId: 'q1', now: later })
  assert.equal(pairing.isLockedOut('qq', 'q1', later), false, '3 次后不该锁（阈值是 5）')
  assert.equal(pairing.redeem(stale.code, { channel: 'qq', userId: 'q1', now: later }).reason, 'expired', '第 4 次仍是 expired')
  assert.equal(pairing.isLockedOut('qq', 'q1', later), false, '4 次后仍不该锁（下边界）')
  assert.equal(pairing.redeem(stale.code, { channel: 'qq', userId: 'q1', now: later }).reason, 'locked-out', '第 5 次翻锁（上边界）')
})

test('B1-5 过期码锁出按 (channel,userId) 隔离：一个用户被锁不牵连他人', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  const stale = pairing.mint({ origin: 'bootstrap', mintedBy: 'system:boot', ttlMs: 1 })
  const later = Date.now() + 5000
  for (let i = 0; i < 5; i += 1) pairing.redeem(stale.code, { channel: 'telegram', userId: '42', now: later })
  assert.equal(pairing.isLockedOut('telegram', '42', later), true, '前置：42 已锁')
  // 同渠道另一 userId：不受牵连
  assert.equal(pairing.isLockedOut('telegram', '43', later), false)
  // 同 userId 另一渠道：复合键隔离（身份是 (channel,userId) 不是全局用户串）
  assert.equal(pairing.isLockedOut('qq', '42', later), false)
  const fresh = pairing.mint({ origin: 'admin', mintedBy: 'boss', now: later })
  assert.equal(pairing.redeem(fresh.code, { channel: 'telegram', userId: '43', now: later }).ok, true,
    '无辜用户照常可配对')
})

test('B1-6 引导码重铸节流：过期码首提重铸一枚，紧随的第二次被节流（不再泵码）', () => {
  const { bus, pairing, identity } = makeRig()
  // ttlMs: 0 而非 1 —— 本例经 bus.accept 走真实钟（无 now 注入），ttlMs:1 时 mint 与
  // redeem 常落同一毫秒（实测 ~95%），码根本没过期，expired 分支不命中，断言前提失效
  // （全量跑更快时才暴露成偶发红）。0 让 expiresAt === mintedAt，sweep 的 now >= expiresAt
  // 必定成立 → 确定性过期。
  const stale = pairing.mint({ origin: 'bootstrap', mintedBy: 'system:boot', ttlMs: 0 })
  assert.equal(identity.isEmpty(), true, '前置：引导态（绑定表空）')
  // 第一次提交过期码：命中 expired 分支 → ensureBootstrap 重铸一枚
  const first = bus.accept(env({ text: `/pair ${stale.code}`, userId: '7' }))
  assert.match(first.reply, /已重铸一枚引导码/, `首提应重铸（实际：${first.reply}）`)
  assert.match(first.reply, /本机引导码文件|管理台/, '新文案指向文件/管理台')
  assert.ok(!/stderr|启动日志/.test(first.reply), '不得再指引用户翻 stderr')
  assert.equal(pairing.hasActiveBootstrap(), true, '重铸的码在铸')
  // 撤掉在铸码模拟「又过期了」，同 10 分钟窗口内第二次触发 → 必须被节流
  const active = pairing.listActive().find((e) => e.origin === 'bootstrap')
  pairing.revoke(active.id, { by: 'test' })
  assert.equal(pairing.hasActiveBootstrap(), false, '前置：无在铸引导码')
  const second = bus.accept(env({ text: `/pair ${stale.code}`, userId: '8' }))
  assert.match(second.reply, /重铸失败或节流中/, `10 分钟内第二次必须被节流（实际：${second.reply}）`)
  assert.equal(pairing.hasActiveBootstrap(), false, '节流生效：没有铸出新码')
})

test('B1-6b 引导码重铸回调异常不静默：onBootstrapRemint 抛错时 warn 出声且码仍有效', () => {
  const { store } = tempStore()
  const identity = createIdentity({ store, logger: quiet })
  const pairing = createPairing({ store, logger: quiet })
  const warns = []
  const bus = createInboundBus({
    identity,
    pairing,
    store,
    logger: { warn: (...args) => warns.push(args.join(' ')), info: () => {} },
    onBootstrapRemint: () => { throw new Error('文件系统炸了') },
  })
  const stale = pairing.mint({ origin: 'bootstrap', mintedBy: 'system:boot', ttlMs: 0 })
  const result = bus.accept(env({ text: `/pair ${stale.code}`, userId: '9' }))
  assert.match(result.reply, /已重铸一枚引导码/, '回调炸了不影响重铸结论')
  assert.equal(pairing.hasActiveBootstrap(), true, '码确实铸出来了')
  assert.ok(warns.some((w) => /onBootstrapRemint 回调异常/.test(w)),
    `回调异常必须可见，不能空 catch 吞掉（实际 warn：${warns.join(' | ')}）`)
  for (const line of warns) {
    assert.ok(!/\b[A-Z2-9]{8}\b/.test(line), `回调异常告警不得带码面：${line}`)
  }
})

test('B1-4c 单次过期码提交仍返回 expired（不因 B2 改动破坏既有回执语义）', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  const stale = pairing.mint({ origin: 'admin', mintedBy: 'boss', ttlMs: 1 })
  assert.equal(pairing.redeem(stale.code, { channel: 'telegram', userId: '42', now: Date.now() + 5000 }).reason,
    'expired', '首次过期提交的用户可见语义不变（宪法#6 用户失误不锁死）')
})

test('B1-6c 过期码但已有在铸引导码：回执指路取现码，不谎报「重铸失败」（诚实指引）', () => {
  const { bus, pairing } = makeRig()
  // 用 admin origin 的过期码（bootstrap 重铸会 revoke 同族旧码，reason 就不是 expired 了）
  // ttlMs: 0 —— 同 B1-6/B1-6b：本例经 bus.accept 走真实钟，ttlMs:1 会让 mint/redeem
  // 落同一毫秒而码未过期（实测 ~93%），expired 分支不命中即断言前提失效
  const stale = pairing.mint({ origin: 'admin', mintedBy: 'boss', ttlMs: 0 })
  // 在铸引导码（模拟管理台刚补铸 / 上一次提交已触发重铸）
  pairing.mint({ origin: 'bootstrap', mintedBy: 'admin:web' })
  assert.equal(pairing.hasActiveBootstrap(), true, '前置：有在铸引导码')
  const result = bus.accept(env({ text: `/pair ${stale.code}`, userId: '11' }))
  assert.match(result.reply, /已有在铸引导码/, `应指路取现码（实际：${result.reply}）`)
  assert.ok(!/重铸失败或节流中/.test(result.reply), '有现码时不得谎报重铸失败')
  assert.ok(!/stderr|启动日志/.test(result.reply), '不得指引 stderr')
})
