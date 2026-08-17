// v0.7 测试：admin/api 成员五方法 + 配对码两方法（函数级，计划书 §3.4/§3.5 守卫全表）。
// 用真实 createIdentity/createPairing + 内存 mock store：装配一致性（api ↔ identity ↔ pairing
// 同一 store 时状态互见）+ 审计真实落盘读回（<stateDir>/admin-audit.jsonl）。
// 覆盖面：getMembers 三表聚合与降级 / putMember 键形状·字段校验·末位 owner / deleteMember
// 末位 owner / confirm·dismiss 待确认生命周期与 409 / mint ttl 边界与码面脱敏 / revoke 形状。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAdminApi, ApiError } from '../src/admin/api.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createPairing } from '../src/inbound/pairing.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'

const AUDIT_FILE = 'admin-audit.jsonl'

/** 内存 mock store：接口对齐 src/inbound/store.mjs（get/set/delete/keys）。 */
function makeStore(initial = {}) {
  const state = JSON.parse(JSON.stringify(initial))
  return {
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(state, key) ? state[key] : fallback),
    set: (key, value) => { state[key] = JSON.parse(JSON.stringify(value === undefined ? null : value)) },
    delete: (key) => { const had = Object.prototype.hasOwnProperty.call(state, key); delete state[key]; return had },
    keys: (prefix = '') => Object.keys(state).filter((key) => key.startsWith(prefix ?? '')),
  }
}

const throws = (status) => (error) => error instanceof ApiError && error.status === status

/** rig：真实 identity + pairing + admin api，同一 store 与临时 stateDir。 */
function makeRig({ state = {}, withIdentity = true, withPairing = true } = {}) {
  const store = makeStore(state)
  const identity = withIdentity ? createIdentity({ store }) : null
  const pairing = withPairing ? createPairing({ store }) : null
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-members-'))
  const api = createAdminApi({
    router: createAgentRouter({ store, agentsList: () => [] }),
    registry: { getSession: () => undefined, isActive: () => false },
    store,
    identity,
    pairing,
    // 引导态探针按装配层同口径接线（index.mjs guidedProbe；R5-2-P2-2：缺省按非引导态展示）
    guidedProbe: withIdentity ? () => identity.isEmpty() : null,
    stateDir,
  })
  return { api, store, identity, pairing, stateDir }
}

/** 读审计文件（原始行数组，过滤空行）。 */
const auditLines = (stateDir) =>
  readFileSync(join(stateDir, AUDIT_FILE), 'utf8').split('\n').filter((line) => line.trim() !== '')

// ---------------------------------------------------------------- getMembers

test('getMembers：三表聚合 + 引导态标记 + 配对码脱敏（无码面无哈希）', () => {
  const rig = makeRig()
  rig.identity.addBinding({ channel: 'feishu', userId: 'ou_owner' }) // 首条 = owner
  rig.identity.addBinding({ channel: 'qq', userId: 'qqmember01' })
  rig.identity.addPending({ channel: 'wxpusher', userId: '12345', origin: 'learned' })
  const minted = rig.pairing.mint({ origin: 'admin', mintedBy: 'admin:web' })
  assert.equal(minted.ok, true)

  const view = rig.api.getMembers()
  assert.equal(view.guided, false, '已有绑定 → 非引导态')
  assert.equal(view.members.length, 2)
  assert.deepEqual(
    view.members.map((member) => `${member.channel}:${member.userId}:${member.role}`).sort(),
    ['feishu:ou_owner:owner', 'qq:qqmember01:member'],
  )
  assert.equal(view.pending.length, 1)
  assert.equal(view.pending[0].key, 'wxpusher:12345')
  assert.equal(view.pairingCodes.length, 1)
  assert.equal(view.pairingCodes[0].id, minted.id)
  assert.equal('code' in view.pairingCodes[0], false, '码面绝不出现在列表')
  assert.equal('hash' in view.pairingCodes[0], false, '哈希也不暴露')
})

test('getMembers：空表 = 引导态；identity/pairing 未装配按空降级不抛', () => {
  const guided = makeRig().api.getMembers()
  assert.deepEqual(guided, { guided: true, members: [], pending: [], pairingCodes: [] })

  const bare = makeRig({ withIdentity: false, withPairing: false })
  assert.deepEqual(bare.api.getMembers(), { guided: false, members: [], pending: [], pairingCodes: [] })
})

test('getMembers：identity 读抛错降级为空表（warn 不上抛）', () => {
  const rig = makeRig()
  rig.identity.addBinding({ channel: 'qq', userId: 'qqmember01' })
  rig.store.get = (key) => { if (key === 'inbound:bindings') throw new Error('disk corrupted') }
  const view = rig.api.getMembers()
  assert.deepEqual(view.members, [], '绑定读失败按空表降级')
  assert.equal(view.guided, false, 'isEmpty 读失败不误报引导态（false 保守值）')
})

// ---------------------------------------------------------------- putMember

test('putMember：改 label 成功 + label 截断 64 + 审计落盘', () => {
  const rig = makeRig()
  rig.identity.addBinding({ channel: 'feishu', userId: 'ou_owner' })
  const result = rig.api.putMember('feishu:ou_owner', { label: '张三'.repeat(40) })
  assert.equal(result.saved, true)
  assert.equal(result.record.label.length, 64)
  assert.equal(rig.identity.list('feishu')[0].label.length, 64)
  const lines = auditLines(rig.stateDir)
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).action, 'putMember')
})

test('putMember：提升 member 为 owner（多 owner 允许）；角色轮换后旧 owner 可降级', () => {
  const rig = makeRig()
  rig.identity.addBinding({ channel: 'feishu', userId: 'ou_owner' })
  rig.identity.addBinding({ channel: 'qq', userId: 'qqmember01' })
  assert.equal(rig.api.putMember('qq:qqmember01', { role: 'owner' }).record.role, 'owner')
  // 两位 owner：旧的可以降级
  assert.equal(rig.api.putMember('feishu:ou_owner', { role: 'member' }).record.role, 'member')
  // 现在只剩一位 owner：新的末位 owner 不可再降
  assert.throws(() => rig.api.putMember('qq:qqmember01', { role: 'member' }), throws(422))
})

test('putMember 守卫全表：501 未装配 / 422 键形状 / 422 非对象体 / 422 未知字段 / 422 role 值 / 422 空 diff / 404 不存在', () => {
  const bare = makeRig({ withIdentity: false })
  assert.throws(() => bare.api.putMember('feishu:ou_x', { label: 'x' }), throws(501))

  const rig = makeRig()
  rig.identity.addBinding({ channel: 'feishu', userId: 'ou_owner' })
  assert.throws(() => rig.api.putMember('no-colon-key', { label: 'x' }), throws(422))
  assert.throws(() => rig.api.putMember('feishu:', { label: 'x' }), throws(422))
  assert.throws(() => rig.api.putMember('feishu:ou_owner', 'not-object'), throws(422))
  assert.throws(() => rig.api.putMember('feishu:ou_owner', { nickname: 'x' }), throws(422))
  assert.throws(() => rig.api.putMember('feishu:ou_owner', { role: 'admin' }), throws(422))
  assert.throws(() => rig.api.putMember('feishu:ou_owner', {}), throws(422))
  assert.throws(() => rig.api.putMember('feishu:ou_ghost', { label: 'x' }), throws(404))
})

test('putMember：末位 owner 降级 422（中文指引先提 owner）', () => {
  const rig = makeRig()
  rig.identity.addBinding({ channel: 'feishu', userId: 'ou_owner' })
  assert.throws(() => rig.api.putMember('feishu:ou_owner', { role: 'member' }), (error) =>
    error instanceof ApiError && error.status === 422 && /末位 owner/.test(error.message))
})

// ---------------------------------------------------------------- deleteMember

test('deleteMember：member 可删 + 审计记角色；末位 owner 422；404；501；422 键', () => {
  const bare = makeRig({ withIdentity: false })
  assert.throws(() => bare.api.deleteMember('feishu:ou_x'), throws(501))

  const rig = makeRig()
  rig.identity.addBinding({ channel: 'feishu', userId: 'ou_owner' })
  rig.identity.addBinding({ channel: 'qq', userId: 'qqmember01' })
  assert.throws(() => rig.api.deleteMember('bad-key'), throws(422))
  assert.throws(() => rig.api.deleteMember('qq:ghost'), throws(404))
  assert.equal(rig.api.deleteMember('qq:qqmember01').deleted, true)
  assert.equal(rig.identity.list('qq').length, 0)
  assert.equal(JSON.parse(auditLines(rig.stateDir).at(-1)).detail.role, 'member', '审计记录被删者角色')

  // feishu owner 是末位 owner：不可删
  assert.throws(() => rig.api.deleteMember('feishu:ou_owner'), (error) =>
    error instanceof ApiError && error.status === 422 && /末位 owner/.test(error.message))
  // 加一位 owner 后旧 owner 可删
  rig.identity.addBinding({ channel: 'qq', userId: 'qqmember02' })
  rig.identity.updateBinding('qq', 'qqmember02', { role: 'owner' })
  assert.equal(rig.api.deleteMember('feishu:ou_owner').deleted, true)
})

// ---------------------------------------------------------------- confirm / dismiss 待确认

test('confirmPendingMember：转正为成员（origin=confirmed）+ 审计；404；409 已是成员；422 键；501', () => {
  const bare = makeRig({ withIdentity: false })
  assert.throws(() => bare.api.confirmPendingMember('feishu:ou_x'), throws(501))

  const rig = makeRig()
  assert.throws(() => rig.api.confirmPendingMember('bad'), throws(422))
  assert.throws(() => rig.api.confirmPendingMember('feishu:ou_ghost'), throws(404))

  rig.identity.addPending({ channel: 'wxpusher', userId: '12345', origin: 'learned' })
  const result = rig.api.confirmPendingMember('wxpusher:12345')
  assert.equal(result.confirmed, true)
  assert.equal(result.record.origin, 'confirmed')
  assert.equal(rig.identity.listPending().length, 0, '待确认条目被消费')
  assert.equal(rig.identity.allows('wxpusher', '12345'), true, '转正后准入放行')
  assert.equal(JSON.parse(auditLines(rig.stateDir).at(-1)).action, 'confirmPending')

  // 409：store 里 bindings 与 pending 同键并存（addPending 正常路径会拒绝，手工构造该竞态现场）
  // at 用新鲜时间戳：待确认条目有 7 天 TTL，陈旧构造会被读路径清扫成 404
  rig.store.set('inbound:pending', { 'qq:dup01': { channel: 'qq', userId: 'dup01', origin: 'learned', at: Date.now(), extra: {} } })
  rig.store.set('inbound:bindings', { 'qq:dup01': { channel: 'qq', userId: 'dup01', label: '', role: 'member', pairedAt: 1, lastSeenAt: 0, origin: 'migrated' } })
  assert.throws(() => rig.api.confirmPendingMember('qq:dup01'), throws(409))
})

test('dismissPendingMember：条目清除不入成员表 + 审计；404；422；501', () => {
  const bare = makeRig({ withIdentity: false })
  assert.throws(() => bare.api.dismissPendingMember('feishu:ou_x'), throws(501))

  const rig = makeRig()
  assert.throws(() => rig.api.dismissPendingMember('bad'), throws(422))
  assert.throws(() => rig.api.dismissPendingMember('feishu:ou_ghost'), throws(404))

  rig.identity.addPending({ channel: 'feishu', userId: 'ou_new' })
  assert.equal(rig.api.dismissPendingMember('feishu:ou_new').dismissed, true)
  assert.equal(rig.identity.listPending().length, 0)
  assert.equal(rig.identity.list('feishu').length, 0, '忽略不转正')
  assert.equal(JSON.parse(auditLines(rig.stateDir).at(-1)).action, 'dismissPending')
})

// ---------------------------------------------------------------- mint / revoke 配对码

test('mintPairingCode：默认 TTL 铸码成功，响应带码面；列表脱敏；审计文件不落码面', () => {
  const rig = makeRig()
  const result = rig.api.mintPairingCode({})
  assert.match(result.code, /^[A-HJ-KM-NP-Z2-9]{8}$/, '8 位易读字母表（无 I/L/O/0/1）')
  assert.equal(result.expiresAt > Date.now(), true)
  const view = rig.api.getMembers()
  assert.equal(view.pairingCodes.length, 1)
  assert.equal(view.pairingCodes[0].code, undefined)
  // 审计走 pairing.onAudit 回调链（装配层接线），api 层不重复记：文件无 mint 行、无码面
  const raw = (() => { try { return readFileSync(join(rig.stateDir, AUDIT_FILE), 'utf8') } catch { return '' } })()
  assert.equal(raw.includes(result.code), false, '码面绝不落审计文件')
})

test('mintPairingCode：自定义 TTL 生效（expiresAt 差值）+ label 截断 64', () => {
  const rig = makeRig()
  const before = Date.now()
  const result = rig.api.mintPairingCode({ ttlMin: 60, label: 'L'.repeat(100) })
  assert.ok(result.expiresAt - before > 59 * 60 * 1000, '60 分钟 TTL 生效')
  assert.ok(result.expiresAt - before <= 61 * 60 * 1000)
  assert.equal(rig.api.getMembers().pairingCodes[0].label.length, 64)
})

test('mintPairingCode 守卫：501 未装配 / 422 ttlMin（0、1441、1.5、非数字、非整数串）', () => {
  const bare = makeRig({ withPairing: false })
  assert.throws(() => bare.api.mintPairingCode({}), throws(501))

  const rig = makeRig()
  for (const ttlMin of [0, 1441, 1.5, 'abc', true]) {
    assert.throws(() => rig.api.mintPairingCode({ ttlMin }), throws(422), `ttlMin=${String(ttlMin)} 应 422`)
  }
  // 边界值合法：1 与 1440（原断言是恒真式——R5 审查 R5-3-P3-8 改为真断言）
  assert.match(rig.api.mintPairingCode({ ttlMin: 1 }).code, /^[A-Z2-9]{8}$/, 'ttlMin=1 边界合法')
  assert.match(rig.api.mintPairingCode({ ttlMin: 1440 }).code, /^[A-Z2-9]{8}$/, 'ttlMin=1440 边界合法')
})

test('revokePairingCode：撤销在铸码 → 列表清空；422 形状；404 不存在；501；再撤 404', () => {
  const bare = makeRig({ withPairing: false })
  assert.throws(() => bare.api.revokePairingCode('x'), throws(501))

  const rig = makeRig()
  assert.throws(() => rig.api.revokePairingCode(''), throws(422))
  assert.throws(() => rig.api.revokePairingCode('x'.repeat(33)), throws(422))
  assert.throws(() => rig.api.revokePairingCode('deadbeef'), throws(404))

  const minted = rig.api.mintPairingCode({})
  assert.equal(rig.api.revokePairingCode(minted.id).revoked, true)
  assert.equal(rig.api.getMembers().pairingCodes.length, 0, '撤销后不在在铸列表')
  assert.throws(() => rig.api.revokePairingCode(minted.id), throws(404), '已终态再撤 404')
})
