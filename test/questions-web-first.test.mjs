// v0.10 Web-first 远程升级测试（任务书 3.3/11）：Stage 0（pending，Web 立即可见）
// → Stage 1（webFirstMs 后才推主绑定 IM）→ Stage 2（reminderMs 后备用目标提醒一次）。
// 红线：20s 前不远程、remoteEnabled=false 永不推 IM、终态（作答/超时）取消后续升级。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuestionBridge } from '../src/questions/router.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { resolveConfig } from '../src/config.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-wf-')), 'state.json')
}

const SINGLE = { question: '选一个部署环境', options: [{ label: '测试环境' }, { label: '生产环境' }] }

/** 精简提问桥测试台，config 完全可控（webFirstMs/reminderMs/remoteEnabled 均注入）。 */
function makeRig(config) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'test-secret' })
  const bus = createInboundBus({ allowUsers: ['42', '100'], store, vault })
  const notifier = { channels: ['telegram'], notifyAll: async () => ({ ok: true, delivered: [], skipped: [], failed: [] }) }
  const cards = []
  const texts = []
  const instances = [{
    cards,
    texts,
    raw: {
      channel: 'telegram',
      accountId: 'TG_APP',
      notifyTargets: () => [{ chatId: '100', userId: '100' }],
      async sendQuestionCard(payload) { cards.push(payload); return { messageId: cards.length } },
      async editResolved() {},
      async sendText(chatId, text) { texts.push({ chatId, text }); return true },
    },
  }]
  const bridge = createQuestionBridge({
    bus,
    vault,
    store,
    notifier,
    control: createControlEntry(),
    interactive: () => instances.map((item) => item.raw),
    config,
  })
  bridge.attach()
  return { store, vault, bus, cards, texts, bridge }
}

test('web first: no remote push before webFirstMs, push at stage 1', async () => {
  const rig = makeRig({ timeoutMs: 1200, webFirstMs: 90, escalation: { enabled: false } })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(35)
  assert.equal(rig.cards.length, 0, 'webFirstMs 前不得远程推卡（Stage 0 仅 Web 可见）')
  await sleep(140) // 总 ~175ms > 90ms
  assert.ok(rig.cards.length >= 1, 'webFirstMs 后推送主绑定 IM（Stage 1）')
  const result = await pending
  assert.equal(result.answered, false) // 无人作答 → 超时交还桌面
})

test('web first: remoteEnabled=false keeps pending web-visible without IM push', async () => {
  const rig = makeRig({ timeoutMs: 250, webFirstMs: 50, remoteEnabled: false, escalation: { enabled: false } })
  const result = await rig.bridge.askQuestions({ questions: [SINGLE] })
  assert.equal(result.answered, false)
  assert.equal(rig.cards.length, 0, 'remoteEnabled=false 永不推 IM')
})

test('web first: stage 2 reminder derives afterMs from reminderMs', async () => {
  const rig = makeRig({ timeoutMs: 3000, webFirstMs: 60, reminderMs: 260, escalation: { enabled: true } })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(40)
  assert.equal(rig.cards.length, 0, 'webFirstMs 前不推')
  await sleep(100) // 总 ~140ms > 60ms：卡已推
  assert.ok(rig.cards.length >= 1, 'Stage 1 已推主 IM')
  await sleep(220) // 总 ~360ms > reminderMs(260)：Stage 2 提醒（afterMs=200）已发
  assert.ok(rig.texts.length >= 1, 'Stage 2 备用目标提醒已发送一次')
  await pending
})

test('web first: settlement cancels pending stage 2 (no reminder after answer)', async () => {
  // 用户在 Stage 1 之后、Stage 2 之前作答 → escalation 被 cancelDelivery 停掉，不再提醒。
  const rig = makeRig({ timeoutMs: 3000, webFirstMs: 50, reminderMs: 400, escalation: { enabled: true } })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(80) // 卡已推（>50ms），Stage 2 未到（<400ms）
  assert.ok(rig.cards.length >= 1)
  // 模拟手机按钮作答（首达采纳）：直连 bus.settle 裁决该待决问题。
  const qKey = rig.store.keys('aq:')[0]
  rig.bus.settle(qKey, { kind: 'aq', idxs: [0] }, 'telegram:button', '42')
  const result = await pending
  assert.equal(result.answered, true)
  const textsAtAnswer = rig.texts.length
  await sleep(500) // 越过原 Stage 2 时点
  assert.equal(rig.texts.length, textsAtAnswer, '已作答后不得再发 Stage 2 提醒（定时器已取消）')
})

test('config: question defaults inject web-first 20s/60s remote-enabled', () => {
  const resolved = resolveConfig({})
  assert.equal(resolved.questions.webFirstMs, 20_000)
  assert.equal(resolved.questions.reminderMs, 60_000)
  assert.equal(resolved.questions.remoteEnabled, true)
  // 显式 0 关闭 Web-first（立即推），remoteEnable 可关
  const explicit = resolveConfig({ questions: { webFirstMs: 0, reminderMs: 0, remoteEnabled: false } })
  assert.equal(explicit.questions.webFirstMs, 0)
  assert.equal(explicit.questions.reminderMs, 0)
  assert.equal(explicit.questions.remoteEnabled, false)
})