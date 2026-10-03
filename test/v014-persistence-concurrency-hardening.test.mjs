// v0.14（S13）持久化与并发加固：针对 v0.14 新 control paths 的失败注入与时序测试。
//
// 目标不是堆 happy-path 数量，而是把「每个函数都对、但顺序组合错」的边界钉死在契约里：
//   - v0.12/v0.13 state fixture → current（真实 store + 真实迁移）
//   - 迁移重复执行 / canonical + legacy 冲突
//   - state 读取失败 / state 损坏 / lock busy / 写盘失败（真实 store，fail-closed）
//   - 两个 writer 同文件（真实 store）+ 进程重启读回
//   - 多键事务失败（真实 store，两键都不落盘）
//   - 晚到的异步完成不得回退 revision / 覆盖更新的 canonical 状态
//   - dispose vs 挂起 Promise；epoch 变化 vs 陈旧 cursor
//
// 规则（05-testing-evidence-and-assumption-policy §4/§5）：真实 store path 与 mock 都要有；
// mock 不能作为 durability 的唯一证据——真实 store 用例覆盖真正的落盘/锁/损坏路径。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/inbound/store.mjs'
import { createChannelControlService } from '../src/control-plane/channels.mjs'
import { createNativeActions } from '../src/native/actions.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createInboundChannelConfigPort } from '../src/inbound/channel-config.mjs'
import { migrateCanonicalChannelConfig } from '../src/control-surface/channel-config-migration.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'

/** 独立临时 state.json（返回 {dir,file}）。 */
const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-hardening-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { dir, file }
}

/** 真实落盘必失败的 store：state.json 的父级是一个普通文件（真实 I/O 失败，非 mock）。 */
const blockingStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-hardening-block-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'i am a regular file')
  return createStore(join(blocker, 'state.json'))
}

/** 事务语义 mock store：第 failAt 次 transact 宣告失败（写盘/rename 失败注入）。 */
function failingTransactStore({ initial = {}, failAt = [] } = {}) {
  let memory = { ...initial }
  let calls = 0
  const failing = new Set(failAt)
  return {
    get: (key) => (key in memory ? memory[key] : undefined),
    keys: (prefix = '') => Object.keys(memory).filter((key) => key.startsWith(prefix)),
    transact(mutator) {
      calls += 1
      if (failing.has(calls)) return { ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' }
      const draft = JSON.parse(JSON.stringify(memory))
      const value = mutator(draft)
      memory = draft
      return { ok: true, committed: true, durable: true, value }
    },
    snapshot: () => JSON.parse(JSON.stringify(memory)),
  }
}

/** 真实 store + 共享服务 rig（出站 canonical + 入站凭证域）。 */
function rig(store) {
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const inboundConfig = createInboundChannelConfigPort({ store })
  const channelControl = createChannelControlService({ outboundConfig, inboundConfig })
  return { source, outboundConfig, inboundConfig, channelControl }
}

// ———————— 迁移：v0.12/v0.13 fixture → current ————————

test('S13 migration: v0.12/v0.13 legacy outbound fixture migrates to canonical once (real store)', () => {
  const { file } = tempState({
    'admin:channel:bark:outbound': { key: 'legacy-bark' },
    'admin:channel:webhook:outbound': { url: 'https://example.com/hook' },
    'unrelated:key': 'must-survive',
  })
  const store = createStore(file)

  const result = migrateCanonicalChannelConfig({ store, channelTypes: ['bark', 'webhook', 'feishu'], adminEnabled: true })
  assert.equal(result.ok, true)
  assert.equal(result.already, false)
  assert.deepEqual([...result.migrated].sort(), ['bark', 'webhook'])
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'legacy-bark' })
  assert.deepEqual(store.get('channel:webhook:outbound'), { url: 'https://example.com/hook' })
  assert.equal(store.get('admin:channel:bark:outbound'), undefined, 'legacy Admin outbound key retired')
  assert.equal(store.get('admin:channel:webhook:outbound'), undefined)
  assert.equal(store.get('unrelated:key'), 'must-survive', '无关键必须存活')
  assert.equal(store.get('state:schema-version'), 13)
  assert.equal(store.get('state:migration:v0.13').status, 'complete')
})

test('S13 migration: re-running on an already-migrated store is an idempotent no-op (real store)', () => {
  const { file } = tempState({ 'admin:channel:bark:outbound': { key: 'legacy-bark' } })
  const store = createStore(file)

  const first = migrateCanonicalChannelConfig({ store, channelTypes: ['bark'], adminEnabled: true })
  assert.equal(first.ok, true)
  assert.equal(first.already, false)
  const snapshotAfterFirst = store.get('state:migration:v0.13')

  const second = migrateCanonicalChannelConfig({ store, channelTypes: ['bark'], adminEnabled: true })
  assert.equal(second.ok, true)
  assert.equal(second.already, true, '第二次必须是 already，不重复迁移')
  assert.deepEqual(second.migrated, [])
  assert.deepEqual(store.get('state:migration:v0.13'), snapshotAfterFirst, 'marker 不被改写')
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'legacy-bark' })
})

test('S13 migration: canonical wins over legacy conflict — legacy never resurrected (real store)', () => {
  const { file } = tempState({
    'channel:bark:outbound': { key: 'canonical' },
    'admin:channel:bark:outbound': { key: 'legacy' },
  })
  const store = createStore(file)

  const result = migrateCanonicalChannelConfig({ store, channelTypes: ['bark'], adminEnabled: true })
  assert.equal(result.ok, true)
  assert.deepEqual(result.migrated, [], 'canonical 已存在则不迁移')
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'canonical' }, 'canonical 胜出')
  assert.equal(store.get('admin:channel:bark:outbound'), undefined, 'legacy 冲突键仍被退役')
})

// ———————— state 读取失败 / 损坏：fail-closed（真实 store）————————
// state.json 是一个目录 → readFileSync 抛 EISDIR → bootStatus=unavailable（真实 I/O 失败路径）。

test('S13 read failure (real store): migration refuses and shared writes fail closed, nothing published', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-hardening-readfail-'))
  const statePath = join(dir, 'state.json')
  mkdirSync(statePath) // 目录占位：读取必失败
  const store = createStore(statePath)
  assert.equal(store.bootStatus().status, 'unavailable')

  const { source, outboundConfig, channelControl } = rig(store)
  const migration = migrateCanonicalChannelConfig({ store, channelTypes: ['bark'], adminEnabled: true })
  assert.equal(migration.ok, false)
  assert.equal(migration.reason, 'state-untrusted')

  assert.throws(() => channelControl.saveOutbound('bark', { key: 'never' }), (error) => error?.code === 'storage-failed')
  assert.throws(() => channelControl.saveChannelAccount('telegram', { botToken: 'never' }), (error) => error?.code === 'storage-failed')
  assert.equal(store.get('channel:bark:outbound'), undefined)
  assert.equal(store.get('telegram:account'), undefined)
  assert.equal(source.has('bark'), false, '读取失败不得切换 live source')
  assert.deepEqual(outboundConfig.raw('bark'), {}, '读取失败时 canonical raw 为空，绝不回显幽灵配置')
})

test('S13 corrupt state (real store): migration refuses and shared writes fail closed, nothing published', () => {
  const { file } = tempState()
  writeFileSync(file, '{"broken": ') // 半截 JSON
  const store = createStore(file)
  assert.equal(store.bootStatus().status, 'corrupt')

  const { source, channelControl } = rig(store)
  assert.equal(migrateCanonicalChannelConfig({ store, channelTypes: ['bark'], adminEnabled: true }).reason, 'state-untrusted')
  assert.throws(() => channelControl.saveOutbound('bark', { key: 'never' }), (error) => error?.code === 'storage-failed')
  assert.throws(() => channelControl.saveChannelAccount('telegram', { botToken: 'never' }), (error) => error?.code === 'storage-failed')
  assert.equal(store.get('channel:bark:outbound'), undefined)
  assert.equal(source.has('bark'), false)
})

// ———————— lock busy：绝不无锁写入（真实 store）————————
// 一个「活着」的属主 pid + 新鲜 mtime 的锁文件，不可回收 → acquireLock 两轮自旋后 STATE_BUSY。

test('S13 lock busy (real store): write returns storage-failed and publishes nothing', () => {
  const { file } = tempState()
  const store = createStore(file)
  const lockPath = `${file}.lock`
  writeFileSync(lockPath, `${process.pid}:alive-holder`) // 当前进程存活；mtime 新鲜 → 不可回收

  const { source, outboundConfig, channelControl } = rig(store)
  assert.throws(() => channelControl.saveOutbound('bark', { key: 'never' }), (error) => error?.code === 'storage-failed')
  assert.throws(() => channelControl.saveChannelAccount('telegram', { botToken: 'never' }), (error) => error?.code === 'storage-failed')
  assert.equal(store.get('channel:bark:outbound'), undefined, '锁忙时不得写内存')
  assert.equal(store.get('telegram:account'), undefined)
  assert.equal(source.has('bark'), false)
  assert.deepEqual(outboundConfig.raw('bark'), {}, '锁忙时 canonical raw 为空，绝不回显幽灵配置')
})

// ———————— 写盘失败：真实 I/O 失败 + mock 注入 ————————

test('S13 write failure (real store): blocked state path fails closed, live source unchanged', () => {
  const store = blockingStore()
  const { source, channelControl } = rig(store)
  assert.throws(() => channelControl.saveOutbound('bark', { key: 'never' }), (error) => error?.code === 'storage-failed')
  assert.throws(() => channelControl.saveChannelAccount('wxpusher', { appToken: 'never' }), (error) => error?.code === 'storage-failed')
  assert.equal(store.get('channel:bark:outbound'), undefined)
  assert.equal(store.get('wxpusher:account'), undefined)
  assert.equal(source.has('bark'), false)
})

test('S13 write/rename failure (injected at the durable boundary): no publish, mock cannot fake success', () => {
  const store = failingTransactStore({ initial: { 'channel:bark:outbound': { key: 'old' } }, failAt: [1] })
  const source = createOutboundSource([{ type: 'bark', config: { key: 'old' } }])
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const channelControl = createChannelControlService({ outboundConfig })

  assert.throws(() => channelControl.saveOutbound('bark', { barkUrl: 'https://self.example' }), (error) => error?.code === 'storage-failed')
  assert.deepEqual(store.snapshot()['channel:bark:outbound'], { key: 'old' }, '提交失败后磁盘/内存都不变')
  assert.equal(source.has('bark'), true, '既有 live source 不被改动')
})

// ———————— 两个 writer + 进程重启 ————————

test('S13 two writers on one file (real store): distinct canonical keys both survive a restart', () => {
  const { file } = tempState()
  const a = rig(createStore(file))
  const b = rig(createStore(file))

  assert.equal(a.channelControl.saveOutbound('bark', { key: 'from-a' }).saved, true)
  assert.equal(b.channelControl.saveOutbound('pushplus', { token: 'from-b' }).saved, true)

  const restarted = createStore(file) // 进程重启：新实例从盘上读回
  assert.deepEqual(restarted.get('channel:bark:outbound'), { key: 'from-a' })
  assert.deepEqual(restarted.get('channel:pushplus:outbound'), { token: 'from-b' })
  assert.equal(restarted.get('state:schema-version'), undefined, '未跑迁移不得凭空写 schema 键')
})

// ———————— 多键事务失败：两键都不落盘（真实 store + router 单事务）————————
// state.json 是目录 → transact 读失败 → replaceBindings 两表都不得发布。

test('S13 multi-key transaction failure (real store): neither bindings table is published', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-hardening-multikey-'))
  const statePath = join(dir, 'state.json')
  mkdirSync(statePath)
  const store = createStore(statePath)
  const router = createAgentRouter({ store, agentsList: () => [] })

  const result = router.replaceBindings({
    agents: { 'agent-1': { channels: ['bark'] } },
    channels: { bark: { defaultAgent: 'agent-1' } },
  })
  assert.equal(result.ok, false, '任一键未落盘必须诚实失败')
  assert.equal(result.durable, false)
  assert.equal(store.get('route:agents', undefined), undefined)
  assert.equal(store.get('route:channels', undefined), undefined)
})

test('S13 multi-key transaction (real store): mutator throw publishes neither key, prior state intact', () => {
  const { file } = tempState({ keep: 'v1' })
  const store = createStore(file)

  const result = store.transact((draft) => {
    draft.alpha = 1
    draft.beta = 2
    throw new Error('mid-transaction failure')
  })
  assert.equal(result.committed, false)
  assert.equal(store.get('alpha'), undefined)
  assert.equal(store.get('beta'), undefined)
  assert.equal(store.get('keep'), 'v1', '事务失败不得改动既有键')
})

// ———————— 时序：晚到完成 / dispose / epoch 变化 ————————

function makeSurface({ revision, channelControl, activity, health }) {
  return createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    channelControl,
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    activity: activity ?? createSurfaceActivity(),
    health: health ?? createSurfaceHealth(),
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })
}

test('S13 late async completion: a slow channel test never regresses revision or clobbers a newer save', async () => {
  const { file } = tempState({ 'channel:bark:outbound': { key: 'k' } })
  const store = createStore(file)
  const source = createOutboundSource([{ type: 'bark', config: { key: 'k' } }])
  // v0.14（Stage F / P2-01）：出站保存的 revision/activity 唯一 owner 是 domain event
  // （OutboundConfigService 的 onChange/onAudit，装配层与生产一致接线）；surface 不再重复记账。
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const outboundConfig = createOutboundConfigService({
    store, yamlRows: new Map(), source, allowLegacy: false,
    onChange: (topic) => revision.touch(topic),
    onAudit: (topic, detail) => activity.record('configuration', topic, {
      channel: detail?.type,
      saved: detail?.saved === true,
      deleted: detail?.deleted === true,
      hotApplied: detail?.applied === true,
    }),
  })
  let releaseTest
  const channelControl = createChannelControlService({
    outboundConfig,
    channelTest: () => new Promise((resolve) => { releaseTest = () => resolve({ ok: true }) }),
  })
  // Stage 4（S402）：daily 通话面已无 channels.test/channels.save——改用 native 窄动作。
  const actions = createNativeActions({ channelControl, revision, activity, health: createSurfaceHealth() })

  const testPromise = actions.testChannel({ type: 'bark' }) // 在飞行中
  const revisionAtStart = revision.current().revision
  const saved = actions.saveChannel({ type: 'bark', patch: { barkUrl: 'https://self.example' } })
  assert.equal(saved.saved, true, '更新的写入必须在晚到的测试完成前落地')
  assert.ok(revision.current().revision > revisionAtStart, '更新的一代推进 revision')

  releaseTest() // 晚到完成
  const late = await testPromise
  assert.ok(late !== null && typeof late === 'object' && typeof late.kind === 'string', '晚到测试返回用户话术回执')
  assert.ok(revision.current().revision >= revisionAtStart, '晚到完成绝不回退 revision')
  assert.deepEqual(
    store.get('channel:bark:outbound'),
    { key: 'k', barkUrl: 'https://self.example' },
    '晚到的只读测试绝不覆盖更新的 canonical 写入',
  )
})

test('S13 dispose while a wait is pending: the pending Promise resolves as disposed, never hangs', async () => {
  const revision = createSurfaceRevision()
  const surface = makeSurface({ revision, channelControl: null })
  const pending = surface.call('surface.wait', { after: revision.current().revision, timeoutMs: 25_000 })
  revision.dispose()
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.value.topic, 'disposed')
})

test('S13 epoch change: a fresh process carries a new epoch, so a stale cursor cannot silently match', async () => {
  const oldEpoch = createSurfaceRevision({ epoch: 'epoch-old' })
  const restarted = createSurfaceRevision({ epoch: 'epoch-new' })
  assert.notEqual(oldEpoch.current().epoch, restarted.current().epoch)
  // 客户端仍持旧 epoch 的 cursor（revision 5）；重启进程 revision 从头开始，朴素比较 revision 会误判「无变化」。
  const surface = makeSurface({ revision: restarted, channelControl: null })
  const pending = surface.call('surface.wait', { after: 5, timeoutMs: 25_000 })
  restarted.touch('restart-boot') // 重启后首个事件唤醒 waiter
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.value.epoch, 'epoch-new', '响应必须携带新 epoch，客户端据此判定换代并重载')
  assert.notEqual(result.value.epoch, oldEpoch.current().epoch)
})