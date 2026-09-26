// v0.13（C11.5 / R5）测试：交互终态清理 durable-first。
// 契约：live 超时/错误/终止已发生，但 durable 终态写入失败时——
//   · 绝不伪装成已落盘的终态；
//   · 行被标记 `uncertain`（isPending 为假），重启/编号回复/自动重跑都不再当 live pending；
//   · 若连恢复标记也失败，返回 ok=false/uncertain=false，上层必须告警。
// 覆盖：ledger 原子收口、questions 超时/错误、approval 超时、actions 终态。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInteractionLedger } from '../src/interaction/ledger.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createActionDispatcher } from '../src/actions.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createQuestionBridge } from '../src/questions/router.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { registerApprovalHandler } from '../src/approval/router.mjs'

function tempPath(prefix) {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'state.json')
}

/** 内存 store 双：支持 transact 契约（detached draft + 原子提交）。 */
function memoryStore(initial = {}) {
  let state = { ...initial }
  const store = {
    get: (key, fallback) => (key in state ? state[key] : fallback),
    set: (key, value) => { state = { ...state, [key]: value }; return true },
    delete: (key) => { if (!(key in state)) return false; const next = { ...state }; delete next[key]; state = next; return true },
    keys: (prefix = '') => Object.keys(state).filter((key) => key.startsWith(prefix)),
    entries: () => Object.entries(state),
    transact: (mutator) => {
      const draft = { ...state }
      const value = mutator(draft)
      state = draft
      return { ok: true, committed: true, durable: true, value }
    },
    snapshot: () => ({ ...state }),
    failAll: false,
  }
  return store
}

/** 让「写某键为某终态值」的事务失败一次，其余写入照常（模拟定向磁盘故障）。
 * field 默认 'decision'（approval/questions）；actions 用例传 'outcome'。 */
function sabotageWrite(store, { keyPrefix, decision, field = 'decision' }) {
  const original = store.transact
  store.transact = (mutator) => {
    const result = original((draft) => {
      const out = mutator(draft)
      for (const [k, v] of Object.entries(draft)) {
        if (k.startsWith(keyPrefix) && v !== null && typeof v === 'object' && v[field] === decision) {
          throw new Error(`sabotage: persist ${decision} for ${k}`)
        }
      }
      return out
    })
    return result
  }
}

// ---------------------------------------------------------------- ledger 原子收口

test('R5：ledger.settle——durable 成功返回 ok；落盘失败标记 uncertain 且行不再是 pending', () => {
  const store = memoryStore({ 'aq:1': { status: 'pending', decision: undefined } })
  const ledger = createInteractionLedger({ keyPrefix: 'aq:', store })

  const ok = ledger.settle('aq:1', 'timeout')
  assert.equal(ok.ok, true)
  assert.equal(store.get('aq:1').decision, 'timeout')
  assert.equal(ledger.isPending(store.get('aq:1')), false)

  const store2 = memoryStore({ 'aq:2': { status: 'pending' } })
  sabotageWrite(store2, { keyPrefix: 'aq:', decision: 'timeout' })
  const ledger2 = createInteractionLedger({ keyPrefix: 'aq:', store: store2 })
  const failed = ledger2.settle('aq:2', 'timeout')
  assert.equal(failed.ok, false, 'durable 终态未落盘 → 不得报成功')
  assert.equal(failed.uncertain, true, '应尽力写恢复标记')
  const row = store2.get('aq:2')
  assert.equal(row.status, 'uncertain')
  assert.equal(row.decision, 'uncertain')
  assert.equal(ledger2.isPending(row), false, 'uncertain 行绝不再当 live pending')
})

test('R5：ledger.settle——连恢复标记也失败时返回 ok=false/uncertain=false', () => {
  const store = memoryStore({ 'aq:3': { status: 'pending' } })
  store.transact = () => ({ ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' })
  const ledger = createInteractionLedger({ keyPrefix: 'aq:', store })
  const result = ledger.settle('aq:3', 'timeout')
  assert.equal(result.ok, false)
  assert.equal(result.uncertain, false)
  assert.equal(ledger.isPending(store.get('aq:3')), true, '写盘全失败时行保持 pending（上层必须告警）')
})

test('R5：ledger.settle——已终态/缺失行不二次写（幂等）', () => {
  const store = memoryStore({ 'aq:4': { status: 'resolved', decision: 'answered' } })
  const ledger = createInteractionLedger({ keyPrefix: 'aq:', store })
  const again = ledger.settle('aq:4', 'timeout')
  assert.equal(again.ok, true)
  assert.equal(again.reason, 'already-resolved')
  assert.equal(store.get('aq:4').decision, 'answered', '不得覆写既有终态')
  assert.equal(ledger.settle('aq:missing', 'timeout').reason, 'missing')
})

// ---------------------------------------------------------------- questions

const SINGLE = { question: '选一个部署环境', options: [{ label: '测试环境' }, { label: '生产环境' }] }

function makeQuestionRig(path) {
  const store = createStore(path)
  const vault = createTokenVault({ secret: 'r5-secret' })
  const bus = createInboundBus({ allowUsers: ['42'], store, vault })
  const identity = createIdentity({ store, logger: null })
  const notifier = { channels: [], notifyAll: async () => ({ ok: true, accepted: [], confirmed: [], delivered: [], skipped: [], failed: [] }) }
  const bridge = createQuestionBridge({
    bus,
    vault,
    store,
    notifier,
    identity,
    control: createControlEntry({ policy: { mode: 'personal', capabilities: { approve: true } }, identity, logger: null }),
    interactive: () => [],
    config: { timeoutMs: 1000, remoteEnabled: false, escalation: { enabled: false } },
  })
  bridge.attach()
  return { store, bus, vault, bridge }
}

test('R5：问题超时终态落盘失败 → 标记 uncertain，重启后不再是待决', async () => {
  const path = tempPath('dsh-notifier-r5q-')
  const rig = makeQuestionRig(path)
  sabotageWrite(rig.store, { keyPrefix: 'aq:', decision: 'timeout' })

  const result = await rig.bridge.askQuestions({ questions: [SINGLE], timeoutMs: 1000 })
  assert.equal(result.answered, false)
  assert.equal(result.results[0].uncertain, true, '超时终态未落盘必须在结果里可见')

  const keys = rig.store.keys('aq:')
  assert.equal(keys.length, 1)
  const row = rig.store.get(keys[0])
  assert.equal(row.status, 'uncertain', '落盘失败的超时不得伪装成 resolved')
  assert.equal(row.decision, 'uncertain')

  // 重启：用同一文件新建桥，uncertain 行不得再出现在待决列表。
  const restarted = makeQuestionRig(path)
  assert.deepEqual(restarted.bridge.adminPending(), [], 'uncertain 行重启后不得作为正常 live pending 出现')
})

test('R5：问题抛错终态落盘失败 → 标记 uncertain', async () => {
  const rig = makeQuestionRig(tempPath('dsh-notifier-r5qe-'))
  // 让 bus.wait 抛错（推送/等待异常 → error 分支）
  rig.bus.wait = () => Promise.reject(new Error('bus transport down'))
  sabotageWrite(rig.store, { keyPrefix: 'aq:', decision: 'error' })

  const result = await rig.bridge.askQuestions({ questions: [SINGLE], timeoutMs: 1000 })
  assert.equal(result.answered, false)
  assert.equal(result.results[0].reason, 'error')
  assert.equal(result.results[0].uncertain, true)
  const keys = rig.store.keys('aq:')
  assert.equal(rig.store.get(keys[0]).status, 'uncertain')
})

// ---------------------------------------------------------------- approval

function makeApprovalRig(path) {
  const store = createStore(path)
  const vault = createTokenVault({ secret: 'r5-approval' })
  const bus = createInboundBus({ allowUsers: ['u1'], store, vault })
  const handlers = {}
  const ctx = { on: (event, handler) => { handlers[event] = handler; return () => { delete handlers[event] } } }
  const notifier = { notifyAll: async () => ({ ok: true, accepted: [], confirmed: [], delivered: [], skipped: [], failed: [] }) }
  const interactive = [{
    channel: 'telegram',
    accountId: 'TG_APP',
    notifyTargets: () => [{ chatId: '10001', userId: 'u1' }],
    async sendApprovalCard() { return { messageId: 'm1' } },
    async editResolved() {},
    async sendText() { return true },
  }]
  const dispose = registerApprovalHandler({
    ctx, notifier, bus, vault, store,
    interactive,
    control: createControlEntry(),
    approvalConfig: { mode: 'answer', timeoutMs: 300 },
  })
  const handle = (request = { toolName: 'bash', callId: 'call-1' }) => handlers['approval/request'](request, () => 'desktop')
  return { store, bus, vault, handle, dispose, handlers }
}

test('R5：审批超时终态落盘失败 → 标记 uncertain，重启扫描不再补发失效告知', async () => {
  const path = tempPath('dsh-notifier-r5a-')
  const rig = makeApprovalRig(path)
  sabotageWrite(rig.store, { keyPrefix: 'ap:', decision: 'timeout' })
  const decision = await rig.handle()
  assert.equal(decision, 'desktop', '静默永不批准，交还桌面')

  const keys = rig.store.keys('ap:')
  assert.equal(keys.length, 1)
  const row = rig.store.get(keys[0])
  assert.equal(row.status, 'uncertain', '落盘失败的超时不得伪装成 resolved/timeout')
  assert.equal(row.decision, 'uncertain')

  // 重启：新装配启动扫描只处理 pending 行；uncertain 行不得被当作僵尸补发。
  const restarted = makeApprovalRig(path)
  const pending = restarted.store.keys('ap:').filter((k) => restarted.store.get(k)?.status === 'pending')
  assert.deepEqual(pending, [], 'uncertain 行重启后不再作为 live pending')
})

// ---------------------------------------------------------------- actions

test('R5：动作终态落盘失败 → 审计 terminal-persist-failed，handler 只执行一次，重启不重跑', () => {
  const store = memoryStore()
  const vault = createTokenVault({ secret: 'r5-act' })
  const logs = []
  const dispatcher = createActionDispatcher({ vault, store, logger: { warn: (p, m) => logs.push(`${p} ${m}`) } })
  let runs = 0
  dispatcher.register('turn/cancel', () => { runs += 1; return { ok: true } })

  const card = dispatcher.mintAction('turn/cancel', { sessionId: 'a' })
  assert.ok(card !== null)
  // 只让终局 resolve（outcome 'done'）失败，claim 照常成功。
  sabotageWrite(store, { keyPrefix: 'act:', decision: 'done', field: 'outcome' })

  const click = dispatcher.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '10001' })
  assert.equal(click.ok, true)
  assert.equal(runs, 1, 'handler 只执行一次')
  assert.ok(logs.some((line) => /terminal-persist-failed/.test(line)), '终局落盘失败必须审计')

  const row = store.get(card.key)
  assert.equal(row.status, 'claimed', '终局未落盘 → 行保持 claimed（重启按 uncertain，不自动重跑）')

  // 重启：新 dispatcher 看到 claimed 只报告 uncertain，绝不重跑 handler。
  const restarted = createActionDispatcher({ vault, store, logger: { warn() {} } })
  restarted.register('turn/cancel', () => { runs += 1; return { ok: true } })
  const again = restarted.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '10001' })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'uncertain')
  assert.equal(runs, 1, '重启后绝不自动重执行')
})