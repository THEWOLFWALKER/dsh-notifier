// v0.3.3 测试：admin/api（Web 管理台 API 函数层，函数级无 HTTP，设计稿 §5）。
// 覆盖面：overview 三态渠道分类与计数、getBindings 损坏数据防御、putBindings 整表替换/
// 部分传/422 四类、getSessions 排序与 resolved 注入、patchSession 404/422/null 删键、
// getChannels 深层脱敏、putChannel 422 与落盘读回、testChannel/scanChannel 501 与透传、
// 审计追加与读取、store 抛错时写方法不崩。
// mock：内存 store（set 走 JSON 往返，贴近真实文件存储的序列化隔离）+ 真实 agent-router
// （装配一致性：api 落盘路径与 CLI 完全一致）+ 最小 registry 桩；stateDir 用 mkdtempSync
// 临时目录，审计文件真实落盘读回。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAdminApi, ApiError, INBOUND_CHANNELS } from '../src/admin/api.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { CHANNEL_TYPES } from '../src/config.mjs'

/** 审计文件名（契约：<stateDir>/admin-audit.jsonl）。 */
const AUDIT_FILE = 'admin-audit.jsonl'

/** 内存 mock store：接口对齐 src/inbound/store.mjs（get/set/delete/keys）。 */
function makeStore(initial = {}, overrides = {}) {
  const state = JSON.parse(JSON.stringify(initial))
  const store = {
    state,
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(state, key) ? state[key] : fallback),
    set: (key, value) => { state[key] = JSON.parse(JSON.stringify(value === undefined ? null : value)) },
    delete: (key) => {
      const had = Object.prototype.hasOwnProperty.call(state, key)
      delete state[key]
      return had
    },
    keys: (prefix = '') => Object.keys(state).filter((key) => key.startsWith(prefix ?? '')),
  }
  return Object.assign(store, overrides)
}

/** 最小 registry 桩：isActive（活跃名单）+ getSession（内存记录，领先盘上时模拟 registry 内存态）。 */
function makeRegistry({ records = {}, active = [] } = {}) {
  return {
    getSession: (id) => (Object.prototype.hasOwnProperty.call(records, id) ? { ...records[id] } : undefined),
    isActive: (id) => active.includes(id),
  }
}

/** 断言辅助：抛 ApiError 且 status 匹配。 */
const apiErrorOf = (status) => (error) => error instanceof ApiError && error.status === status

/** rig：mock store + 真实 router + 可选依赖桩 + 独立临时 stateDir。 */
function makeApi({
  state = {},
  enabled = [],
  outboundConfigs = undefined,
  registry = makeRegistry(),
  channelTest = undefined,
  scanHandlers = undefined,
  identity = undefined,
  pairing = undefined,
  guidedProbe = undefined,
  storeOverrides = {},
} = {}) {
  const store = makeStore(state, storeOverrides)
  const router = createAgentRouter({ store, agentsList: () => [] })
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-admin-api-'))
  const api = createAdminApi({
    router,
    registry,
    store,
    channelsEnabled: () => [...enabled],
    outboundConfigs,
    channelTest,
    scanHandlers,
    identity,
    pairing,
    guidedProbe,
    stateDir,
  })
  return { api, store, router, stateDir }
}

// ———————— 契约常量与错误类型 ————————

test('契约：INBOUND_CHANNELS 常量逐字一致，ApiError 携带 status', () => {
  assert.deepEqual(INBOUND_CHANNELS, ['telegram', 'feishu', 'qq', 'wxpusher', 'wechat', 'dingtalk'])
  const error = new ApiError(422, '校验失败')
  assert.ok(error instanceof Error)
  assert.equal(error.status, 422)
  assert.equal(error.message, '校验失败')
})

// ———————— 缺省依赖降级 ————————

test('缺省依赖：全部查询方法不抛，按空数据降级', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-admin-api-'))
  const api = createAdminApi({ stateDir }) // router/registry/store/notifier/channelsEnabled 全缺省
  const overview = api.overview()
  assert.equal(overview.channels.length, CHANNEL_TYPES.length + INBOUND_CHANNELS.length)
  assert.ok(overview.channels.every((row) => row.configured === false && row.enabled === false))
  assert.deepEqual(overview.sessions, { active: 0, total: 0 })
  assert.deepEqual(overview.agents, { keys: 0 })
  assert.deepEqual(overview.audit, [])
  assert.deepEqual(api.getBindings(), { agents: {}, channels: {} })
  assert.deepEqual(api.getSessions(), [])
  const channels = api.getChannels()
  assert.equal(channels.length, CHANNEL_TYPES.length + INBOUND_CHANNELS.length)
  assert.ok(channels.every((row) => Object.keys(row.config).length === 0))
  assert.deepEqual(api.getAudit(), [])
})

// ———————— overview ————————

test('overview：渠道三态分类（出站 enabled/有凭证/全无；双域出站只认 YAML；入站有凭证=启用）', () => {
  const { api } = makeApi({
    state: {
      'bark:account': { key: 'k' }, // 有凭证、未启用
      'feishu:account': { appId: 'a', appSecret: 's' }, // 双域键：入站机器人凭证，不给出站行 configured
    },
    enabled: ['telegram', 'ntfy'], // telegram 启用但无 state 凭证（YAML bootstrap）
  })
  const rows = api.overview().channels
  const byType = (type, direction) => rows.find((row) => row.type === type && row.direction === direction)
  // 出站：已启用（凭证在 YAML）→ configured=true（enabled 兜底）、enabled=true、editable=true
  assert.deepEqual(byType('telegram', 'outbound'), { type: 'telegram', direction: 'outbound', configured: true, enabled: true, editable: true, restartRequired: true })
  // 出站：有 `<type>:account`、未启用 → configured=true、enabled=false、editable=true
  assert.deepEqual(byType('bark', 'outbound'), { type: 'bark', direction: 'outbound', configured: true, enabled: false, editable: true, restartRequired: true })
  // 出站：既无凭证也未启用 → 双 false
  assert.deepEqual(byType('pushplus', 'outbound'), { type: 'pushplus', direction: 'outbound', configured: false, enabled: false, editable: true, restartRequired: true })
  // 双域出站（feishu/dingtalk）：`<type>:account` 键域归入站机器人凭证 → 出站行只认
  // YAML（configured=enabled），store 有凭证也不算已配置，且 editable=false（webhook 走 YAML bootstrap）
  assert.deepEqual(byType('feishu', 'outbound'), { type: 'feishu', direction: 'outbound', configured: false, enabled: false, editable: false, restartRequired: true })
  assert.deepEqual(byType('dingtalk', 'outbound'), { type: 'dingtalk', direction: 'outbound', configured: false, enabled: false, editable: false, restartRequired: true })
  // 入站：有 `<channel>:account` → 双 true；无 → 双 false；editable 恒 true（扫码/表单可写）
  assert.deepEqual(byType('feishu', 'inbound'), { type: 'feishu', direction: 'inbound', configured: true, enabled: true, editable: true, restartRequired: false })
  assert.deepEqual(byType('qq', 'inbound'), { type: 'qq', direction: 'inbound', configured: false, enabled: false, editable: true, restartRequired: false })
})

test('overview：sessions active/total 与 agents.keys 计数', () => {
  const { api } = makeApi({
    state: {
      'route:agents': { proj: { channels: ['telegram'] }, 's-9': { quiet: true } },
      'route:sessions': {
        's-1': { workspace: 'proj', lastActiveAt: 1 },
        's-2': { workspace: 'proj', lastActiveAt: 2 },
        's-3': { workspace: 'other', lastActiveAt: 3, disposedAt: 9 },
      },
    },
    registry: makeRegistry({ active: ['s-1'] }),
  })
  const overview = api.overview()
  assert.deepEqual(overview.sessions, { active: 1, total: 3 })
  assert.deepEqual(overview.agents, { keys: 2 })
  assert.deepEqual(overview.audit, [])
})

test('overview：audit 取最近 20 条新在前', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-admin-api-'))
  const lines = Array.from({ length: 22 }, (_, i) => (
    JSON.stringify({ time: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`, action: `act-${i + 1}`, detail: { i } })
  ))
  writeFileSync(join(stateDir, AUDIT_FILE), `${lines.join('\n')}\n`, 'utf8')
  const store = makeStore()
  const api = createAdminApi({ router: createAgentRouter({ store }), store, stateDir })
  const audit = api.overview().audit
  assert.equal(audit.length, 20)
  assert.equal(audit[0].action, 'act-22') // 最新在前
  assert.equal(audit[19].action, 'act-3') // 截断到最近 20 条
})

// ———————— overview.members（Issue #10 UX 回归：总览成员计数与降级） ————————

test('overview.members：identity 正常装配时返回 total/owners/guided，与 identity.list() 一致', () => {
  const { api } = makeApi({
    identity: {
      list() {
        return [
          { channel: 'telegram', userId: 'u1', role: 'owner' },
          { channel: 'feishu', userId: 'u2', role: 'member' },
          { channel: 'qq', userId: 'u3', role: 'member' },
        ]
      },
    },
    guidedProbe: () => false,
  })
  const m = api.overview().members
  assert.deepEqual(m, { total: 3, owners: 1, guided: false })
})

test('overview.members：identity 未装配（null / 未注入）时 total=0 owners=0 guided=true，不抛错', () => {
  // 缺省 makeApi 不传 identity → createAdminApi 里 identity 默认 undefined
  const { api } = makeApi()
  const m = api.overview().members
  assert.deepEqual(m, { total: 0, owners: 0, guided: true })
})

test('overview.members：identity.list 抛异常时降级为 0/guided，绝不击穿 overview', () => {
  const { api } = makeApi({
    identity: {
      list() { throw new Error('store corrupted') },
    },
  })
  let m
  assert.doesNotThrow(() => { m = api.overview().members })
  assert.equal(m.total, 0, '异常时 total 应降级为 0')
  assert.equal(m.guided, true, '异常时 guided 应按引导态降级')
})

test('overview.members：空成员表 → guided=true，与成员页引导态口径一致', () => {
  const { api } = makeApi({
    identity: { list() { return [] } },
    guidedProbe: () => true,
  })
  const m = api.overview().members
  assert.deepEqual(m, { total: 0, owners: 0, guided: true })
})

// ———————— getBindings ————————

test('getBindings：表拷贝语义（修改返回值不污染 store）', () => {
  const { api, store } = makeApi({
    state: {
      'route:agents': { proj: { channels: ['telegram'], quiet: true } },
      'route:channels': { feishu: { defaultAgent: 'proj' } },
    },
  })
  const bindings = api.getBindings()
  assert.deepEqual(bindings, {
    agents: { proj: { channels: ['telegram'], quiet: true } },
    channels: { feishu: { defaultAgent: 'proj' } },
  })
  bindings.agents.proj.channels.push('bark')
  bindings.agents.extra = {}
  delete bindings.channels.feishu
  assert.deepEqual(api.getBindings().agents, { proj: { channels: ['telegram'], quiet: true } })
  assert.deepEqual(api.getBindings().channels, { feishu: { defaultAgent: 'proj' } })
  assert.equal(store.state['route:agents'].proj.channels.length, 1)
})

test('getBindings：损坏数据防御（表级非对象 → 空表）', () => {
  const { api } = makeApi({ state: { 'route:agents': 'garbage', 'route:channels': ['a', 'b'] } })
  assert.deepEqual(api.getBindings(), { agents: {}, channels: {} })
})

// ———————— putBindings ————————

test('putBindings：整表替换（旧键消失、条目内未传字段清除、审计追加、返回新全量）', () => {
  const { api } = makeApi({
    state: {
      'route:agents': { proj: { channels: ['telegram'], quiet: true }, gone: { quiet: false } },
      'route:channels': { feishu: { defaultAgent: 'proj' } },
    },
  })
  const result = api.putBindings({
    agents: { proj: { channels: ['bark'] } },
    channels: { qq: { defaultAgent: 's-1' } },
  })
  assert.deepEqual(result, {
    agents: { proj: { channels: ['bark'] } }, // gone 键消失；proj.quiet 未传 → 已清除（替换语义）
    channels: { qq: { defaultAgent: 's-1' } }, // feishu 未传 → 整键消失
  })
  assert.deepEqual(api.getBindings(), result) // 返回值 = 新完整 getBindings()
  const audit = api.getAudit()
  assert.equal(audit.length, 1)
  assert.equal(audit[0].action, 'putBindings')
})

test('putBindings：只出现者替换（未出现的表不动）', () => {
  const { api } = makeApi({
    state: {
      'route:agents': { proj: { channels: ['telegram'] } },
      'route:channels': { feishu: { defaultAgent: 'proj' }, qq: { defaultAgent: 'x' } },
    },
  })
  const result = api.putBindings({ channels: { wxpusher: { defaultAgent: 'w' } } })
  assert.deepEqual(result.channels, { wxpusher: { defaultAgent: 'w' } }) // channels 整表替换
  assert.deepEqual(result.agents, { proj: { channels: ['telegram'] } }) // agents 未出现 → 原样
})

test('putBindings 422：agents[].channels 非法类型（非数组 / 含未知出站渠道）+ 值非对象', () => {
  const { api, store } = makeApi({ state: { 'route:agents': { proj: { channels: ['telegram'] } } } })
  assert.throws(() => api.putBindings({ agents: { proj: { channels: 'telegram' } } }), apiErrorOf(422))
  assert.throws(() => api.putBindings({ agents: { proj: { channels: ['telegram', 'nope'] } } }), apiErrorOf(422))
  assert.throws(() => api.putBindings({ agents: { proj: 42 } }), apiErrorOf(422))
  // 校验失败零写入：原表逐字节不变
  assert.deepEqual(store.state['route:agents'], { proj: { channels: ['telegram'] } })
  assert.deepEqual(api.getAudit(), []) // 也不追加审计
})

test('putBindings 422：quiet 非 boolean', () => {
  const { api } = makeApi()
  assert.throws(() => api.putBindings({ agents: { proj: { quiet: 'yes' } } }), apiErrorOf(422))
  assert.throws(() => api.putBindings({ agents: { proj: { quiet: 1 } } }), apiErrorOf(422))
})

test('putBindings 422：channels 表键非入站通道', () => {
  const { api } = makeApi()
  assert.throws(() => api.putBindings({ channels: { slack: { defaultAgent: 'w' } } }), apiErrorOf(422))
  assert.throws(() => api.putBindings({ channels: { '': { defaultAgent: 'w' } } }), apiErrorOf(422))
})

test('putBindings 422：defaultAgent 空串 / 非字符串', () => {
  const { api } = makeApi()
  assert.throws(() => api.putBindings({ channels: { feishu: { defaultAgent: '' } } }), apiErrorOf(422))
  assert.throws(() => api.putBindings({ channels: { feishu: { defaultAgent: 7 } } }), apiErrorOf(422))
})

// ———————— getSessions ————————

test('getSessions：活跃在前、同组 lastActiveAt 降序，行形状完整', () => {
  const { api } = makeApi({
    state: {
      'route:sessions': {
        's-old': { workspace: 'proj', inherit: 'proj', lastActiveAt: 900, disposedAt: 950, inbound: [{ channel: 'feishu', userId: 'u1' }] },
        's-a': { workspace: 'proj', inherit: 'proj', createdAt: 50, lastActiveAt: 100 },
        's-b': { workspace: 'proj', inherit: 'proj', createdAt: 50, lastActiveAt: 300, outbound: { channels: ['telegram'], quiet: true } },
        's-c': { workspace: 'other', inherit: 'other', createdAt: 50, lastActiveAt: 200 },
      },
    },
    enabled: ['telegram'],
    registry: makeRegistry({ active: ['s-a', 's-b', 's-c'] }),
  })
  const rows = api.getSessions()
  assert.deepEqual(rows.map((row) => row.id), ['s-b', 's-c', 's-a', 's-old']) // 活跃组内按 lastActiveAt 降序
  const rowB = rows[0]
  assert.equal(rowB.workspace, 'proj')
  assert.equal(rowB.inherit, 'proj')
  assert.equal(rowB.active, true)
  assert.equal(rowB.lastActiveAt, 300)
  assert.deepEqual(rowB.outbound, { channels: ['telegram'], quiet: true })
  assert.deepEqual(rowB.resolved, { channelTypes: ['telegram'], quiet: true, source: 'session' })
  assert.equal('disposedAt' in rowB, false)
  const rowOld = rows[3]
  assert.equal(rowOld.active, false)
  assert.equal(rowOld.disposedAt, 950)
  assert.deepEqual(rowOld.inbound, [{ channel: 'feishu', userId: 'u1' }])
})

test('getSessions：resolved 实时注入（workspace 绑定层与 global 兜底）', () => {
  const { api } = makeApi({
    state: {
      'route:agents': { proj: { channels: ['bark'], quiet: true } },
      'route:sessions': {
        's-1': { workspace: 'proj', lastActiveAt: 1 },
        's-2': { workspace: 'nowhere', lastActiveAt: 2 },
      },
    },
    enabled: ['telegram', 'bark'],
  })
  const byId = Object.fromEntries(api.getSessions().map((row) => [row.id, row]))
  assert.deepEqual(byId['s-1'].resolved, { channelTypes: ['bark'], quiet: true, source: 'agent-workspace' })
  assert.deepEqual(byId['s-2'].resolved, { channelTypes: ['telegram', 'bark'], quiet: false, source: 'global' })
})

test('getSessions：control 是安全脱敏摘要，绝不给原始标识符', () => {
  const { api } = makeApi({
    state: {
      'route:sessions': {
        's-1': {
          workspace: 'proj', lastActiveAt: 1,
          control: {
            mode: 'team', owner: 'o-very-secret-id', approvalOwnerOnly: true,
            approvalMembers: [{ channel: 'telegram', accountId: 'a-account', userId: 'u-very-secret' }],
          },
        },
        's-2': { workspace: 'proj', lastActiveAt: 2, control: { owner: 'u1' } },
      },
    },
  })
  const byId = Object.fromEntries(api.getSessions().map((row) => [row.id, row]))
  const c1 = byId['s-1'].control
  assert.deepEqual(c1, { mode: 'team', approvalOwnerOnly: true, ownerConfigured: true, approvalMembersCount: 1 })
  assert.equal('owner' in c1, false)           // 原始 owner id 不外泄
  assert.equal('approvalMembers' in c1, false) // 原始成员三元组不外泄
  const rawJson = JSON.stringify(byId)
  assert.equal(rawJson.includes('o-very-secret-id'), false)
  assert.equal(rawJson.includes('a-account'), false)
  assert.equal(rawJson.includes('u-very-secret'), false)
  assert.deepEqual(byId['s-2'].control, { ownerConfigured: true })
})

// ———————— patchSession ————————

test('patchSession：写 diff 合并、返回新 outbound、追加审计', () => {
  const { api, store } = makeApi({
    state: { 'route:sessions': { 's-1': { workspace: 'proj', lastActiveAt: 1, outbound: { quiet: true } } } },
    enabled: ['bark'],
  })
  const result = api.patchSession('s-1', { channels: ['bark'] })
  assert.deepEqual(result, { id: 's-1', outbound: { quiet: true, channels: ['bark'] } })
  assert.deepEqual(store.state['route:sessions']['s-1'].outbound, { quiet: true, channels: ['bark'] })
  const audit = api.getAudit()
  assert.equal(audit.length, 1)
  assert.equal(audit[0].action, 'patchSession')
  assert.equal(audit[0].detail.id, 's-1')
})

test('patchSession：会话从未建档（store 无且 registry 无）→ 404', () => {
  const { api } = makeApi({ state: { 'route:sessions': { 's-1': { workspace: 'p' } } } })
  assert.throws(() => api.patchSession('nope', { quiet: true }), apiErrorOf(404))
  assert.deepEqual(api.getAudit(), []) // 404 不审计
})

test('patchSession：registry 有记录但 store 无 → 惰性建档写入（不 404）', () => {
  const registry = makeRegistry({ records: { 's-9': { workspace: 'proj', inherit: 'proj' } }, active: ['s-9'] })
  const { api, store } = makeApi({ registry })
  const result = api.patchSession('s-9', { quiet: true })
  assert.deepEqual(result, { id: 's-9', outbound: { quiet: true } })
  assert.equal(store.state['route:sessions']['s-9'].outbound.quiet, true)
})

test('patchSession 422：channels 非数组 / 含未知渠道 / quiet 非 bool / diff 非对象', () => {
  const { api } = makeApi({ state: { 'route:sessions': { 's-1': { workspace: 'p' } } } })
  assert.throws(() => api.patchSession('s-1', { channels: 'bark' }), apiErrorOf(422))
  assert.throws(() => api.patchSession('s-1', { channels: ['nope'] }), apiErrorOf(422))
  assert.throws(() => api.patchSession('s-1', { channels: [42] }), apiErrorOf(422))
  assert.throws(() => api.patchSession('s-1', { quiet: 'true' }), apiErrorOf(422))
  assert.throws(() => api.patchSession('s-1', 'quiet'), apiErrorOf(422))
  assert.throws(() => api.patchSession('', { quiet: true }), apiErrorOf(422))
})

test('patchSession：null = 删该覆盖键（diff 清空后 outbound 键消失）', () => {
  const { api, store } = makeApi({
    state: { 'route:sessions': { 's-1': { workspace: 'p', outbound: { channels: ['bark'], quiet: true } } } },
  })
  const first = api.patchSession('s-1', { channels: null })
  assert.deepEqual(first, { id: 's-1', outbound: { quiet: true } }) // 只删 channels，quiet 保留
  const second = api.patchSession('s-1', { quiet: null })
  assert.equal(second.outbound, undefined) // diff 清空 → outbound 键移除
  assert.equal('outbound' in store.state['route:sessions']['s-1'], false)
})

// ———————— patchSessionControl（Stage 4） ————————

test('patchSessionControl：写覆盖层、审计为脱敏摘要、返回也脱敏，字段级 null 删键', () => {
  const { api, store } = makeApi({ state: { 'route:sessions': { 's-1': { workspace: 'p' } } } })
  const result = api.patchSessionControl('s-1', {
    mode: 'team', owner: 'o-secret', approvalOwnerOnly: true,
    approvalMembers: [{ channel: 'telegram', accountId: 'a-acc', userId: 'u-secret' }],
  })
  assert.deepEqual(result, { id: 's-1', control: { mode: 'team', approvalOwnerOnly: true, ownerConfigured: true, approvalMembersCount: 1 } })
  assert.equal('owner' in result.control, false)
  assert.equal('approvalMembers' in result.control, false)
  // 真正落盘的是规范覆盖层，不含来源字段
  const persisted = store.state['route:sessions']['s-1'].control
  assert.deepEqual(persisted, {
    mode: 'team', owner: 'o-secret', approvalOwnerOnly: true,
    approvalMembers: [{ channel: 'telegram', accountId: 'a-acc', userId: 'u-secret' }],
  })
  // 审计 action 与脱敏 detail
  const audit = api.getAudit()
  assert.equal(audit.length, 1)
  assert.equal(audit[0].action, 'setSessionControl')
  const rawAudit = JSON.stringify(audit)
  assert.equal(rawAudit.includes('o-secret'), false)
  assert.equal(rawAudit.includes('u-secret'), false)
  // 字段级 null 删键：只清 owner
  const partial = api.patchSessionControl('s-1', { owner: null })
  assert.deepEqual(partial.control, { mode: 'team', approvalOwnerOnly: true, approvalMembersCount: 1 })
  assert.equal('owner' in store.state['route:sessions']['s-1'].control, false)
})

test('patchSessionControl：全部字段 null 清空后 control 键移除并另一字段独立', () => {
  const { api, store } = makeApi({ state: { 'route:sessions': { 's-1': { workspace: 'p', control: { owner: 'u1' } } } } })
  const result = api.patchSessionControl('s-1', { owner: null })
  assert.equal(result.id, 's-1')
  assert.equal(result.control, undefined) // 无剩余覆盖层 → 摘要 undefined
  assert.equal('control' in store.state['route:sessions']['s-1'], false)
})

test('patchSessionControl 422：来源字段 / 未知字段 / 保留键 / 越界 / 通配 / 空 diff 全拒', () => {
  const { api } = makeApi({ state: { 'route:sessions': { 's-1': { workspace: 'p' } } } })
  for (const key of ['channel', 'accountId', 'userId', 'chatId', 'sessionId', 'policyVersion', 'expiresAt', 'revoked']) {
    assert.throws(() => api.patchSessionControl('s-1', { [key]: 'x' }), apiErrorOf(422), key)
  }
  assert.throws(() => api.patchSessionControl('s-1', { garbage: 1 }), apiErrorOf(422))       // 未知字段
  assert.throws(() => api.patchSessionControl('s-1', { __proto__: {} }), apiErrorOf(422))    // 保留键
  assert.throws(() => api.patchSessionControl('s-1', { constructor: 1 }), apiErrorOf(422))   // 保留键
  assert.throws(() => api.patchSessionControl('s-1', { mode: 'bogus' }), apiErrorOf(422))
  assert.throws(() => api.patchSessionControl('s-1', { owner: '' }), apiErrorOf(422))
  assert.throws(() => api.patchSessionControl('s-1', { owner: '*harmless' }), apiErrorOf(422)) // 含 * → 通配
  assert.throws(() => api.patchSessionControl('s-1', { owner: 'x'.repeat(129) }), apiErrorOf(422))
  assert.throws(() => api.patchSessionControl('s-1', { approvalOwnerOnly: 'yes' }), apiErrorOf(422))
  assert.throws(() => api.patchSessionControl('s-1', { approvalMembers: 'not-array' }), apiErrorOf(422))
  assert.throws(() => api.patchSessionControl('s-1', { approvalMembers: [
    { channel: 'telegram', accountId: 'a1', userId: 'u1', extra: 1 }, // 项内未知键
  ] }), apiErrorOf(422))
  assert.throws(() => api.patchSessionControl('s-1', { approvalMembers: [{}] }), apiErrorOf(422)) // 项缺字段
  assert.throws(() => api.patchSessionControl('s-1', { approvalMembers: [
    { channel: '*', accountId: 'a1', userId: 'u1' },
  ] }), apiErrorOf(422)) // 项内通配
  const many = []
  for (let i = 0; i < 65; i++) many.push({ channel: 'telegram', accountId: 'a1', userId: `u${i}` })
  assert.throws(() => api.patchSessionControl('s-1', { approvalMembers: many }), apiErrorOf(422)) // 超 64
  assert.throws(() => api.patchSessionControl('s-1', {}), apiErrorOf(422))                       // 空 diff
  assert.throws(() => api.patchSessionControl('', { owner: 'u1' }), apiErrorOf(422))             // 空 id
  assert.throws(() => api.patchSessionControl('s-1', 'not-obj'), apiErrorOf(422))                // diff 非对象
})

test('patchSessionControl：从未建档会话 → 404；registry 有记录 → 不 404；store 故障 → 500', () => {
  const { api } = makeApi({ state: { 'route:sessions': { 's-1': { workspace: 'p' } } } })
  assert.throws(() => api.patchSessionControl('nope', { owner: 'u1' }), apiErrorOf(404))
  const registry = makeRegistry({ records: { 's-9': { workspace: 'p' } } })
  const api2 = makeApi({ registry }).api
  assert.deepEqual(api2.patchSessionControl('s-9', { owner: 'u1' }), { id: 's-9', control: { ownerConfigured: true } })
  // store set 抛错 → 路由写入失败 → 500
  const { api: api3 } = makeApi({
    state: { 'route:sessions': { 's-1': { workspace: 'p' } } },
    storeOverrides: { set: () => { throw new Error('disk full') } },
  })
  assert.throws(() => api3.patchSessionControl('s-1', { owner: 'u1' }), apiErrorOf(500))
})

test('patchSessionControl：真实 createStore 落盘失败 → 500（真实写路径，非假 setter 抛错）', () => {
  // 对抗评审 P1-2：不能只测「假 setter 抛错」——真实 createStore 过去会把磁盘失败吞掉并
  // 当成功返回 200。这里用真实 createStore + 真实 router：父路径被常规文件占用 → durable 写
  // 失败显式返回 false → router.safeSet 视为失败 → admin 报 500，重启即丢不再被谎报为成功。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-admin-fail-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'i am a regular file')
  const store = createStore(join(blocker, 'state.json')) // 父级普通文件 → 落盘必然失败
  const router = createAgentRouter({ store, agentsList: () => [] })
  const registry = makeRegistry({ records: { 's-1': { workspace: 'p' } } }) // registry 建档 → 不 404
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-admin-audit-'))
  const api = createAdminApi({
    router, registry, store, stateDir,
    channelsEnabled: () => [], outboundConfigs: undefined,
  })
  assert.throws(() => api.patchSessionControl('s-1', { owner: 'u1' }), apiErrorOf(500))
})

// ———————— getChannels / putChannel ————————

test('getChannels：深层脱敏（嵌套对象/数组里的字符串 → ***，非字符串值保留）', () => {
  const { api } = makeApi({
    state: {
      'telegram:account': { botToken: 'secret-token', port: 3, nested: { hook: 'h', ok: true, list: ['a', 2, null] } },
      'feishu:account': { webhook: 'https://x' },
    },
  })
  const rows = api.getChannels()
  const telegram = rows.find((row) => row.type === 'telegram' && row.direction === 'outbound')
  assert.deepEqual(telegram.config, {
    botToken: '***',
    port: 3,
    nested: { hook: '***', ok: true, list: ['***', 2, null] },
  })
  assert.equal(telegram.configured, true)
  const feishuIn = rows.find((row) => row.type === 'feishu' && row.direction === 'inbound')
  assert.deepEqual(feishuIn.config, { webhook: '***' })
  const bare = rows.find((row) => row.type === 'bark' && row.direction === 'outbound')
  assert.deepEqual(bare.config, {}) // 未配置 → 空对象
})

test('getChannels：fields 字段表（手写渠道 FIELD_HINTS / spec 渠道声明表含 desc / 入站 INBOUND_FIELDS / wechat 空表）', () => {
  const { api } = makeApi()
  const rows = api.getChannels()
  const byType = (type, direction) => rows.find((row) => row.type === type && row.direction === direction)
  // 手写出站渠道：telegram 两字段（required + desc），空配置通道也返回 fields（零 YAML 建单的数据源）
  const telegram = byType('telegram', 'outbound')
  assert.equal(telegram.configured, false)
  assert.deepEqual(Object.keys(telegram.fields).sort(), ['botToken', 'chatId'])
  assert.equal(telegram.fields.botToken.required, true)
  assert.equal(typeof telegram.fields.botToken.desc, 'string')
  // spec 渠道：slack 的 webhook 字段来自声明表（含 desc，单一事实源）
  const slack = byType('slack', 'outbound')
  assert.equal(typeof slack.fields.webhook.desc, 'string')
  assert.equal(slack.fields.webhook.required, true)
  // 入站：feishu 两字段；wechat 为 iLink 扫码产物，fields 空对象（不手填）
  const feishu = byType('feishu', 'inbound')
  assert.deepEqual(Object.keys(feishu.fields).sort(), ['appId', 'appSecret'])
  assert.deepEqual(byType('wechat', 'inbound').fields, {})
})

test('getChannels：YAML ⊕ store 合并视图（store 覆盖同名 YAML 字段；双域出站只展示 YAML；入站行与 YAML 无关）', () => {
  const { api } = makeApi({
    state: {
      'bark:account': { key: 'store-key' }, // store 覆盖 YAML 的 key
      'feishu:account': { appId: 'a', appSecret: 's' }, // 双域：入站域，不混入出站视图
    },
    outboundConfigs: () => ({
      bark: { key: 'yaml-key', device: 'yaml-device' }, // YAML 独有字段 device 保留
      feishu: { webhook: 'https://open.feishu.cn/hook/yaml' },
    }),
  })
  const rows = api.getChannels()
  const bark = rows.find((row) => row.type === 'bark' && row.direction === 'outbound')
  assert.deepEqual(bark.config, { key: '***', device: '***' }) // store.key 覆盖，yaml.device 保留，均脱敏
  const feishuOut = rows.find((row) => row.type === 'feishu' && row.direction === 'outbound')
  assert.deepEqual(feishuOut.config, { webhook: '***' }) // 双域出站不混入 store 的 appId/appSecret
  assert.equal(feishuOut.editable, false)
  const feishuIn = rows.find((row) => row.type === 'feishu' && row.direction === 'inbound')
  assert.deepEqual(feishuIn.config, { appId: '***', appSecret: '***' }) // 入站行 = store 账号视图
})

test('putChannel 422：双域通道携带 webhook 键 → 拒绝（键域归入站机器人凭证，防抹掉扫码凭证）', () => {
  const { api, store } = makeApi({ state: { 'feishu:account': { appId: 'a', appSecret: 's' } } })
  assert.throws(() => api.putChannel('feishu', { webhook: 'https://open.feishu.cn/hook/x' }), apiErrorOf(422))
  assert.throws(() => api.putChannel('dingtalk', { webhook: 'https://oapi.dingtalk.com/x', secret: 's' }), apiErrorOf(422))
  // 非双域渠道的 webhook 键合法（slack 本就是 webhook 型 spec 渠道）
  assert.deepEqual(api.putChannel('slack', { webhook: 'https://hooks.slack.com/x' }), { type: 'slack', saved: true, restartRequired: true })
  // 被拒的写入不落盘不审计：扫码凭证原样保留
  assert.deepEqual(store.get('feishu:account'), { appId: 'a', appSecret: 's' })
  assert.deepEqual(api.getAudit().map((row) => row.action), ['putChannel'])
})

test('putChannel：双域通道写机器人凭证键（appId/appKey）合法（UI 表单 → 入站扫码域同键）', () => {
  const { api, store } = makeApi()
  // 双域通道 UI 写的是入站机器人凭证域 → restartRequired=false（出站 webhook 只读走 YAML）
  assert.deepEqual(api.putChannel('dingtalk', { appKey: 'k', appSecret: 's' }), { type: 'dingtalk', saved: true, restartRequired: false })
  assert.deepEqual(store.get('dingtalk:account'), { appKey: 'k', appSecret: 's' })
})

test('wxpusher accountId：管理台允许非密账号标识并与既有凭证合并', () => {
  const { api, store } = makeApi({ state: { 'wxpusher:account': { appToken: 'tok', uids: ['u1'] } } })
  const rows = api.getChannels()
  const outbound = rows.find((row) => row.type === 'wxpusher' && row.direction === 'outbound')
  const inbound = rows.find((row) => row.type === 'wxpusher' && row.direction === 'inbound')
  assert.equal(outbound.fields.accountId.secret, false)
  assert.equal(inbound.fields.accountId.required, false)
  assert.match(inbound.fields.accountId.desc, /多账号/)
  assert.deepEqual(api.putChannel('wxpusher', { accountId: 'primary' }), { type: 'wxpusher', saved: true, restartRequired: true })
  assert.deepEqual(store.get('wxpusher:account'), { appToken: 'tok', uids: ['u1'], accountId: 'primary' })
})

test('putChannel：字段级合并（patch 语义）——只提交部分字段，其余既有键保留不丢失', () => {
  const { api, store } = makeApi()
  api.putChannel('telegram', { botToken: 't1', chatId: 'c1' })
  // UI 场景：表单只改 botToken（值为 *** 的字段被剔除），chatId 不得静默丢失
  api.putChannel('telegram', { botToken: 't2' })
  assert.deepEqual(store.get('telegram:account'), { botToken: 't2', chatId: 'c1' })
  // store 既有非普通对象（损坏数据防御）：按空对象起步，新值全量落盘
  store.set('bark:account', 'oops')
  api.putChannel('bark', { key: 'k', device: 'd' })
  assert.deepEqual(store.get('bark:account'), { key: 'k', device: 'd' })
  // 覆盖值可再被新值覆盖（同名键覆盖，深对象整体替换）
  api.putChannel('telegram', { chatId: 'c2' })
  assert.deepEqual(store.get('telegram:account'), { botToken: 't2', chatId: 'c2' })
})

test('putChannel：422（未知类型/空对象/非对象）与落盘读回（出站 + 入站类型）', () => {
  const { api, store } = makeApi()
  assert.throws(() => api.putChannel('nope', { a: 1 }), apiErrorOf(422))
  assert.throws(() => api.putChannel('telegram', {}), apiErrorOf(422))
  assert.throws(() => api.putChannel('telegram', 'token'), apiErrorOf(422))
  // v0.6.5（审查 R4-2-P2-1）：键白名单——未知键 422，防 schema 污染与垃圾值膨胀
  assert.throws(() => api.putChannel('telegram', { port: 1 }), apiErrorOf(422))
  // JSON.parse 形态的 __proto__ 是真实自有键（对象字面量会改原型不建键）——保留键入口即拒
  assert.throws(() => api.putChannel('bark', JSON.parse('{"__proto__": "x"}')), apiErrorOf(422))
  assert.throws(() => api.putChannel('bark', { key: 'x'.repeat(9 * 1024) }), apiErrorOf(422)) // 值超 8KB
  assert.throws(() => api.putChannel('wechat', { token: 'w' }), apiErrorOf(422)) // 扫码专用，禁手工
  // 白名单字段（含公共端点键 timeoutMs）可写，落盘可原样读回
  assert.deepEqual(api.putChannel('telegram', { botToken: 't', chatId: 'c', timeoutMs: 5000 }), { type: 'telegram', saved: true, restartRequired: true })
  assert.deepEqual(store.get('telegram:account'), { botToken: 't', chatId: 'c', timeoutMs: 5000 })
  // 双向同域通道：入站字段表同在白名单（telegram.botToken 出入站共用）
  assert.deepEqual(api.putChannel('wxpusher', { appToken: 'a', uids: ['UID_1', 'UID_2'] }), { type: 'wxpusher', saved: true, restartRequired: true })
  assert.deepEqual(store.get('wxpusher:account'), { appToken: 'a', uids: ['UID_1', 'UID_2'] })
  const audit = api.getAudit()
  assert.deepEqual(audit.map((row) => row.action), ['putChannel', 'putChannel'])
  assert.deepEqual(audit[0].detail, { type: 'wxpusher' }) // 审计只记通道名，不落凭证
})

// ———————— G-14（W12）：出站配置视图热/投递冷 ————————

test('G-14：getChannels 出站行恒 restartRequired=true、入站行 false（UI 据此标「重启后生效」）', () => {
  const { api } = makeApi({ enabled: ['telegram'] })
  const rows = api.getChannels()
  const byType = (type, direction) => rows.find((row) => row.type === type && row.direction === direction)
  // 出站：全部渠道（含双域出站行）恒 true——投递层只在插件下次启动并入运行时
  for (const type of CHANNEL_TYPES) {
    assert.equal(byType(type, 'outbound').restartRequired, true, `${type} 出站行 restartRequired 必须 true`)
  }
  // 入站：恒 false——凭证保存即下次启动启用/重连，语义近似热
  for (const channel of INBOUND_CHANNELS) {
    assert.equal(byType(channel, 'inbound').restartRequired, false, `${channel} 入站行 restartRequired 必须 false`)
  }
})

test('G-14：putChannel 返回值带 restartRequired——出站 true、双域入站凭证域 false', () => {
  const { api } = makeApi()
  assert.deepEqual(api.putChannel('bark', { key: 'k' }), { type: 'bark', saved: true, restartRequired: true })
  assert.deepEqual(api.putChannel('feishu', { appId: 'a', appSecret: 's' }), { type: 'feishu', saved: true, restartRequired: false })
})

// ———————— testChannel / scanChannel ————————

test('testChannel：501（未注入 / 渠道未启用）与结果、参数透传', async () => {
  const disabled = makeApi({ enabled: ['telegram'] }) // channelTest 未注入
  await assert.rejects(() => disabled.api.testChannel('telegram'), apiErrorOf(501))

  const calls = []
  const { api } = makeApi({
    enabled: ['bark'],
    channelTest: async (type) => { calls.push(type); return { ok: true, channel: type } },
  })
  await assert.rejects(() => api.testChannel('telegram'), apiErrorOf(501)) // 不在 channelsEnabled()
  assert.deepEqual(await api.testChannel('bark'), { ok: true, channel: 'bark' })
  assert.deepEqual(calls, ['bark'])
})

test('scanChannel：501 固定文案（无 handler 的通道）与结果透传', async () => {
  const none = makeApi() // scanHandlers 未注入
  await assert.rejects(() => none.api.scanChannel('feishu'), (error) => (
    error instanceof ApiError && error.status === 501
    && error.message === '该通道暂不支持网页扫码（可用 scripts/channel-login.mjs CLI）'
  ))

  const { api } = makeApi({ scanHandlers: { feishu: async () => ({ qrContent: 'https://qr.example/x', done: false }) } })
  assert.deepEqual(await api.scanChannel('feishu'), { qrContent: 'https://qr.example/x', done: false })
  await assert.rejects(() => api.scanChannel('qq'), apiErrorOf(501)) // 有 handlers 表但无该通道
})

test('scanChannel：原型链成员（constructor/hasOwnProperty/__proto__）不当作 handler（v0.6.5 R4-2-P2-3）', async () => {
  const { api } = makeApi({ scanHandlers: { feishu: async () => ({ qrContent: 'qr', done: true }) } })
  // JSON body 反序列化出的任意字符串（含原型链成员名）只能命中自有键处理器
  for (const channel of ['constructor', 'hasOwnProperty', '__proto__', 'toString']) {
    await assert.rejects(() => api.scanChannel(channel), apiErrorOf(501))
  }
  assert.deepEqual(await api.scanChannel('feishu'), { qrContent: 'qr', done: true })
})

test('putBindings：整表批量落盘（每表一次 store.set）+ 保留键 422（v0.6.5 R4-2-P2-2/P2-4）', () => {
  let setCalls = 0
  const { api } = makeApi({
    state: { 'route:agents': { old: { quiet: true } } },
    storeOverrides: {
      set(key, value) { setCalls += 1; this.state[key] = JSON.parse(JSON.stringify(value)) },
    },
  })
  // 双表整表替换：2 次落盘（原逐键 = 旧键清除 + 新键逐写 ≈ 4 次）
  const result = api.putBindings({ agents: { proj: { channels: ['telegram'] } }, channels: { feishu: { defaultAgent: 'proj' } } })
  assert.deepEqual(result, {
    agents: { proj: { channels: ['telegram'] } },
    channels: { feishu: { defaultAgent: 'proj' } },
  })
  assert.equal(setCalls, 2, 'agents/channels 各一次整表写')
  // 保留键：赋值语义会触达原型链（router 整表重建 + store 合并写都会中招），入口即拒
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const table = {}
    Object.defineProperty(table, key, { value: { quiet: true }, enumerable: true })
    assert.throws(() => api.putBindings({ agents: table }), apiErrorOf(422))
  }
})

// ———————— 审计 ————————

test('审计：写操作追加 JSONL，getAudit 全量新在前，overview 同步可见', () => {
  const { api, stateDir } = makeApi({ state: { 'route:sessions': { 's-1': { workspace: 'p' } } } })
  api.putBindings({ agents: { proj: { quiet: true } } })
  api.patchSession('s-1', { quiet: true })
  api.putChannel('bark', { key: 'k' })

  const audit = api.getAudit()
  assert.deepEqual(audit.map((row) => row.action), ['putChannel', 'patchSession', 'putBindings']) // 新在前
  assert.ok(audit.every((row) => typeof row.time === 'string' && typeof row.action === 'string' && 'detail' in row))
  assert.deepEqual(api.overview().audit.map((row) => row.action), ['putChannel', 'patchSession', 'putBindings'])

  const raw = readFileSync(join(stateDir, AUDIT_FILE), 'utf8').trim().split('\n') // 文件内旧→新
  assert.equal(raw.length, 3)
  assert.equal(JSON.parse(raw[0]).action, 'putBindings')
  assert.equal(JSON.parse(raw[2]).action, 'putChannel')
})

test('审计轮转：超 1MB 转存 .1（只保一代），getAudit 并读两代时间线连续（v0.6.5 R4-2-P3-5）', () => {
  const { api, stateDir } = makeApi()
  const auditFile = join(stateDir, AUDIT_FILE)
  // 预置一个超限的旧代文件（1.2MB 合法 JSONL，最末一条可辨识）
  const filler = JSON.stringify({ time: '2026-08-16T00:00:00.000Z', action: 'filler', detail: { pad: 'x'.repeat(1024) } })
  const lines = Array.from({ length: 1200 }, () => filler) // ~1.2MB
  writeFileSync(auditFile, `${lines.join('\n')}\n`, 'utf8')
  // 下一次写操作触发轮转：旧文件整体转存 .1，主文件从新记录起步
  api.putChannel('bark', { key: 'k' })
  assert.equal(existsSync(`${auditFile}.1`), true, '超限文件转存为 .1')
  assert.ok(statSync(auditFile).size < 1024, '主文件只含新记录')
  const audit = api.getAudit()
  assert.equal(audit.length, 1200 + 1) // 两代并读全量可见
  assert.equal(audit[0].action, 'putChannel') // 新在前
  assert.equal(audit[audit.length - 1].action, 'filler') // 旧代最老记录在末尾
  // 再次超限时 .1 被覆盖（只保一代，总占用 ~2MB 封顶）
  writeFileSync(auditFile, `${lines.join('\n')}\n`, 'utf8')
  api.putChannel('bark', { key: 'k2' })
  const after = api.getAudit()
  assert.equal(after.length, 1200 + 1) // 上一代主文件被覆盖，不无限累积
  assert.equal(after[0].action, 'putChannel')
})

// ———————— store 抛错防御 ————————

test('store 抛错：写方法不崩（ApiError 500 / saved:false 降级），查询方法绝不抛', () => {
  const boom = () => { throw new Error('disk full') }
  const { api } = makeApi({
    registry: makeRegistry({ records: { 's-1': { workspace: 'p' } } }),
    storeOverrides: { get: boom, set: boom, keys: boom },
  })
  // 写方法：受控失败（router 内部吞掉 store 异常 → 返回 false → ApiError(500)）
  assert.throws(() => api.putBindings({ agents: { proj: { quiet: true } } }), apiErrorOf(500))
  assert.throws(() => api.patchSession('s-1', { quiet: true }), apiErrorOf(500))
  assert.deepEqual(api.putChannel('bark', { key: 'k' }), { type: 'bark', saved: false }) // false 降级
  // 查询方法：依赖抛错一律空数据降级
  assert.doesNotThrow(() => {
    api.overview()
    api.getBindings()
    api.getSessions()
    api.getChannels()
    api.getAudit()
  })
  assert.deepEqual(api.getBindings(), { agents: {}, channels: {} })
  assert.deepEqual(api.getSessions(), [])
})
