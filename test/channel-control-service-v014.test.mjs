import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChannelControlService } from '../src/control-plane/channels.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createInboundChannelConfigPort } from '../src/inbound/channel-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'
import { createAdminApi } from '../src/admin/api.mjs'
import { createStore } from '../src/inbound/store.mjs'

const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-channel-control-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { dir, file }
}

/** 真实落盘必失败的 store：state.json 的父级是一个普通文件。 */
const failingStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-channel-control-fail-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'i am a regular file')
  return createStore(join(blocker, 'state.json'))
}

test('S01: Native 与 Admin 共用同一 ChannelControlService，写入同一 canonical 事实', async () => {
  const { file } = tempState()
  const store = createStore(file)
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const channelControl = createChannelControlService({ outboundConfig })

  const revision = createSurfaceRevision()
  const surface = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    channelControl,
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    activity: createSurfaceActivity(),
    health: createSurfaceHealth(),
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })
  const admin = createAdminApi({ store, outboundConfig, channelControl, channelsEnabled: () => source.types() })

  // Native 先写，Admin 后写：两者都落在同一个 canonical 键上，没有第二套事实。
  const native = await surface.call('channels.save', { type: 'bark', direction: 'outbound', patch: { key: 'from-native' } })
  assert.equal(native.ok, true)
  assert.equal(native.value.saved, true)
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'from-native' })
  assert.equal(store.get('admin:channel:bark:outbound'), undefined, 'canonical 写入绝不双写 legacy 键')

  const adminResult = admin.putOutboundChannel('bark', { key: 'from-admin' })
  assert.equal(adminResult.saved, true)
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'from-admin' })
  assert.deepEqual(outboundConfig.raw('bark'), { key: 'from-admin' })

  // 交替写入不产生 stale 覆盖：再回写 Native 仍是单键字段级合并（barkUrl 与 key 并存）。
  const again = await surface.call('channels.save', { type: 'bark', direction: 'outbound', patch: { barkUrl: 'https://self.example' } })
  assert.equal(again.ok, true)
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'from-admin', barkUrl: 'https://self.example' })
  revision.dispose()
})

test('S01: 真实落盘失败时 desired 与 runtime 都不变，绝不假报成功', async () => {
  const store = failingStore()
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const channelControl = createChannelControlService({ outboundConfig })

  assert.throws(() => channelControl.saveOutbound('bark', { key: 'must-not-persist' }), (error) => error?.code === 'storage-failed')
  assert.equal(store.get('channel:bark:outbound'), undefined, '未落盘不得写内存')
  assert.equal(source.has('bark'), false, '持久化失败不得切换 live source')
})

test('S01: 落盘成功但 runtime apply 失败 → desired 已提交、applied=false、restart-pending', () => {
  const { file } = tempState()
  const store = createStore(file)
  const source = {
    version: 0,
    has: () => false,
    replace() { throw new Error('runtime unavailable') },
    remove() {},
  }
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const channelControl = createChannelControlService({ outboundConfig })

  const result = channelControl.saveOutbound('bark', { key: 'durable' })
  assert.equal(result.saved, true)
  assert.equal(result.applied, false)
  assert.equal(result.applyMode, 'restart-pending')
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'durable' }, 'desired 必须已落盘')
})

test('S01: canonical 与 legacy 冲突时 canonical 胜出', () => {
  const { file } = tempState({
    'admin:channel:bark:outbound': { key: 'legacy' },
    'channel:bark:outbound': { key: 'canonical' },
  })
  const store = createStore(file)
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({
    store, yamlRows: new Map(), source, adminEnabled: true, allowLegacy: true,
  })
  assert.deepEqual(outboundConfig.raw('bark'), { key: 'canonical' })
})

test('S01: 入站写入经共享 service 收敛到同一 canonical 端口；落盘失败抛 storage-failed', async () => {
  const { file } = tempState()
  const store = createStore(file)
  const inboundConfig = createInboundChannelConfigPort({ store })
  const channelControl = createChannelControlService({ inboundConfig })

  const saved = await channelControl.saveInbound('telegram', { botToken: 'tok' })
  assert.equal(saved.saved, true)
  assert.deepEqual(store.get('telegram:account'), { botToken: 'tok' })

  const failing = createChannelControlService({ inboundConfig: createInboundChannelConfigPort({ store: failingStore() }) })
  await assert.rejects(() => failing.saveInbound('telegram', { botToken: 'tok' }), (error) => error?.code === 'storage-failed')
})

test('S01: test 编排只读 canonical raw；未配置时报 not-configured', async () => {
  const { file } = tempState({ 'channel:bark:outbound': { key: 'canonical' } })
  const store = createStore(file)
  const source = createOutboundSource([{ type: 'bark', config: { key: 'canonical' } }])
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const seen = []
  const channelControl = createChannelControlService({
    outboundConfig,
    channelTest: async (type, raw) => { seen.push({ type, raw }); return { ok: true, confirmed: true } },
  })

  const result = await channelControl.testOutbound('bark')
  assert.equal(result.confirmed, true)
  assert.deepEqual(seen, [{ type: 'bark', raw: { key: 'canonical' } }])

  await assert.rejects(() => channelControl.testOutbound('slack'), (error) => error?.code === 'not-configured')
})

// ———————— S12：Advanced Console 收敛到共享服务（无第二写入域 / 无 stale 覆盖）—————————

test('S12: 凭证域合并写在同一事务内读-改-写——stale 快照下的并发兄弟字段不被覆盖（TOCTOU 回归）', () => {
  // 模拟读路径持有过期快照（port 构造时的 get），只有事务内重读才看到最新磁盘态。
  // 旧实现用 get() 读-改-写：并发写入的 accountId 会被静默抹掉；修复后必须保留。
  const live = { 'wxpusher:account': { accountId: 'me' } }
  const store = {
    get: () => ({}), // 过期快照：永远看不到并发写入的 accountId
    transact: (mutator) => {
      const draft = JSON.parse(JSON.stringify(live))
      const value = mutator(draft)
      for (const key of Object.keys(live)) delete live[key]
      Object.assign(live, draft)
      return { ok: true, committed: true, durable: true, value }
    },
  }
  const inboundConfig = createInboundChannelConfigPort({ store })
  const channelControl = createChannelControlService({ inboundConfig })

  const result = channelControl.saveChannelAccount('wxpusher', { appToken: 'A' })
  assert.equal(result.saved, true)
  assert.deepEqual(
    live['wxpusher:account'],
    { accountId: 'me', appToken: 'A' },
    '事务内读-改-写必须保留并发写入的兄弟字段，绝不整键覆盖',
  )
})

test('S12: Admin putChannel 与共享入站端口写同一 <type>:account 事实；admin 缺位不影响 canonical state', () => {
  const { file } = tempState()
  const store = createStore(file)
  const inboundConfig = createInboundChannelConfigPort({ store })
  const channelControl = createChannelControlService({ inboundConfig })

  // Admin 未装配：共享服务先写，canonical state 立即可读（recovery 不依赖 Native/Admin 生命周期）。
  const native = channelControl.saveChannelAccount('telegram', { botToken: 'native-tok' })
  assert.equal(native.saved, true)
  assert.deepEqual(store.get('telegram:account'), { botToken: 'native-tok' })
  assert.equal(inboundConfig.rows().find((row) => row.type === 'telegram').configured, true)

  // 后建 Admin 复用同一 store/channelControl：读到并写回同一事实，不产生第二套状态语义。
  const admin = createAdminApi({ store, channelControl, channelsEnabled: () => [] })
  const result = admin.putChannel('telegram', { botToken: 'admin-tok' })
  assert.equal(result.saved, true)
  assert.deepEqual(store.get('telegram:account'), { botToken: 'admin-tok' })
  assert.equal(store.get('admin:channel:telegram:outbound'), undefined, 'Admin 不制造第二写入域')
})

test('S12: admin disabled 只关闭 legacy 读回，不改变 canonical 事实（共享服务仍读写同一键）', () => {
  const { file } = tempState({ 'channel:bark:outbound': { key: 'canonical' } })
  const store = createStore(file)
  const source = createOutboundSource([{ type: 'bark', config: { key: 'canonical' } }])
  // adminEnabled=false：仅影响 legacy 键读取，canonical 事实不受影响。
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, adminEnabled: false, allowLegacy: false })
  const channelControl = createChannelControlService({ outboundConfig })

  assert.deepEqual(outboundConfig.raw('bark'), { key: 'canonical' }, 'admin 关闭不影响 canonical 读')
  const saved = channelControl.saveOutbound('bark', { barkUrl: 'https://self.example' })
  assert.equal(saved.saved, true)
  assert.deepEqual(
    store.get('channel:bark:outbound'),
    { key: 'canonical', barkUrl: 'https://self.example' },
    'admin 关闭不影响 canonical 的事务化字段级合并写',
  )
})