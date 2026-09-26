// v0.13（C11.5 / R6 + R7）回归：desired config 与 runtime truth 分层收口。
//
// R6（inbound）：旧实现把「persisted 配置（configured/enabled）」直接当成「运行时已生效
//   （active）」——`configured=true -> active=true`，且入站行 `restartRequired:false` 谎称
//   已生效。入站凭证只在下次启动才并入 transport，故必须分层：
//     configured（desired）≠ active（runtime，取不到即 false）≠ restartPending。
//
// R7（outbound delete）：desired delete 已提交后，运行时 remove/replace 抛错不得被说成
//   「配置提交失败」，更不得回滚 desired。分层返回 deleted=true/applied=false/
//   runtimeState=failed/applyMode=restart-pending。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createInboundChannelConfigPort } from '../src/inbound/channel-config.mjs'
import { createInboundChannelRegistry } from '../src/assembly/inbound-channels.mjs'
import { createChannelProjection } from '../src/control-surface/channels.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'

const CANONICAL_BARK = 'channel:bark:outbound'

/** 最小 store：支持读与事务（transactDetached-draft 语义），用于 rows() 与 durable 删除。 */
function memoryStore(initial = {}) {
  let memory = { ...initial }
  return {
    get: (key) => (key in memory ? memory[key] : undefined),
    keys: (prefix = '') => Object.keys(memory).filter((key) => key.startsWith(prefix)),
    transact(mutator) {
      const draft = JSON.parse(JSON.stringify(memory))
      const value = mutator(draft)
      memory = draft
      return { ok: true, committed: true, durable: true, value }
    },
    snapshot: () => JSON.parse(JSON.stringify(memory)),
  }
}

const rowOf = (rows, type) => rows.find((row) => row.type === type)

test('R6：入站 configured=true 绝不推 active=true——无 runtime 时 active=false/restartPending=true', () => {
  const store = memoryStore({ 'feishu:account': { appId: 'a', appSecret: 's' } })
  const port = createInboundChannelConfigPort({ store })

  const feishu = rowOf(port.rows(), 'feishu')
  assert.equal(feishu.configured, true, '有凭证 → desired configured=true')
  assert.equal(feishu.active, false, '拿不到真实 lifecycle 时 active 必须 false，不得冒充在线')
  assert.equal(feishu.restartPending, true, '已配置但运行时未跟上 → restartPending=true')
  assert.equal(feishu.applyMode, 'restart')
  assert.equal(feishu.restartRequired, true, '入站只在下次启动建立 transport → 必须提示重启')

  const qq = rowOf(port.rows(), 'qq')
  assert.equal(qq.configured, false)
  assert.equal(qq.active, false)
  assert.equal(qq.restartPending, false, '未配置就谈不上 restartPending')
})

test('R6：runtime 注入后 active 才跟随真实 lifecycle（在线/离线两个方向）', () => {
  const store = memoryStore({ 'feishu:account': { appId: 'a', appSecret: 's' } })
  let state = { state: 'connected', active: true, restartPending: false }
  const port = createInboundChannelConfigPort({ store, runtime: () => state })

  assert.equal(rowOf(port.rows(), 'feishu').active, true, 'runtime 在线 → active=true')
  assert.equal(rowOf(port.rows(), 'feishu').restartPending, false)

  state = { state: 'stopped', active: false, restartPending: true }
  assert.equal(rowOf(port.rows(), 'feishu').active, false, 'runtime 掉线 → active 必须回落 false')
  assert.equal(rowOf(port.rows(), 'feishu').restartPending, true)
})

test('R6：runtime 查询抛错必须 fail-closed 成未在线，绝不外泄异常', () => {
  const store = memoryStore({ 'feishu:account': { appId: 'a' } })
  const port = createInboundChannelConfigPort({ store, runtime: () => { throw new Error('probe exploded') } })
  const feishu = rowOf(port.rows(), 'feishu')
  assert.equal(feishu.active, false)
  assert.equal(feishu.restartPending, true)
})

test('R6：Native 投影 control.active 取运行时真值，不再取 persisted enabled', () => {
  const store = memoryStore({ 'feishu:account': { appId: 'a', appSecret: 's' } })
  const offline = createInboundChannelConfigPort({ store })
  const projection = createChannelProjection({
    inboundConfig: offline,
    adminApi: { getChannels: () => offline.rows() },
  })
  const row = rowOf(projection.list(), 'feishu')
  assert.equal(row.control.configured, true)
  assert.equal(row.control.active, false, 'configured 不得推成 active')
  assert.equal(row.control.applyMode, 'restart')
  assert.equal(row.control.restartPending, true)

  const online = createInboundChannelConfigPort({ store, runtime: () => ({ state: 'online', active: true, restartPending: false }) })
  const onlineProjection = createChannelProjection({
    inboundConfig: online,
    adminApi: { getChannels: () => online.rows() },
  })
  assert.equal(rowOf(onlineProjection.list(), 'feishu').control.active, true)
})

test('R6：inbound registry runtimeOf 只在 start() 成功后才报在线，end 后回落 stopped', async () => {
  const registry = createInboundChannelRegistry({
    inboundBotToken: 'tok',
    bus: {}, vault: {}, store: memoryStore(), identity: {}, control: {},
    factories: {
      telegram: () => ({ start() {}, stop() {}, clientState: () => 'connected' }),
    },
    warn: () => {},
  })
  assert.equal(registry.runtimeOf('telegram').active, true, 'start 成功 + clientState=connected → active')
  assert.equal(registry.runtimeOf('qq').active, false, '未装配的通道必须 stopped，不得 configured 推 active')
  assert.equal(registry.runtimeOf('qq').restartPending, true)
  assert.deepEqual(
    registry.runtimeSnapshot().map((row) => row.type),
    ['telegram'],
    '快照只含真正启动的 transport',
  )

  await registry.dispose()
  assert.equal(registry.runtimeOf('telegram').active, false, 'stop 后必须回落 stopped')
})

test('R7：删除已落盘但运行时 remove 抛错 → deleted=true/applied=false，不回滚 desired', () => {
  const store = memoryStore({ [CANONICAL_BARK]: { endpoint: 'https://api.day.app/old' } })
  const base = createOutboundSource([{ type: 'bark', config: { endpoint: 'https://api.day.app/old' } }])
  const source = { ...base, remove: () => { throw new Error('runtime remove exploded') } }
  const config = createOutboundConfigService({ store, yamlRows: new Map(), source, adminEnabled: false, allowLegacy: false })

  const result = config.remove('bark')

  assert.equal(result.deleted, true, 'desired delete 已提交')
  assert.equal(result.applied, false, '运行时未跟上不得说成已生效')
  assert.equal(result.applyMode, 'restart-pending')
  assert.equal(result.runtimeState, 'failed')
  assert.equal(
    Object.prototype.hasOwnProperty.call(store.snapshot(), CANONICAL_BARK),
    false,
    'desired delete 已提交，运行时失败绝不能回滚 desired（否则重启后配置复活）',
  )
  assert.equal(config.describe('bark').runtime.state, 'failed', '运行时真值标记为 failed')
})

test('R7：运行时 remove 成功时维持原语义（deleted/applied=true, hot）', () => {
  const store = memoryStore({ [CANONICAL_BARK]: { endpoint: 'https://api.day.app/old' } })
  const source = createOutboundSource([{ type: 'bark', config: { endpoint: 'https://api.day.app/old' } }])
  const config = createOutboundConfigService({ store, yamlRows: new Map(), source, adminEnabled: false, allowLegacy: false })

  const result = config.remove('bark')
  assert.equal(result.deleted, true)
  assert.equal(result.applied, true)
  assert.equal(result.applyMode, 'hot')
  assert.equal(source.has('bark'), false)
})