// v0.9.3 测试（W9 / S-07）：ask_user 自定义回答内容边界（questions/router.mjs）。
// 身份链（token/来源/Control Core）管「谁答的」，本套件管与身份正交的「答了什么」：
//  - sanitizeAnswerText：控制/零宽/bidi 字符过滤；\n\t\r 保留；码点计数（emoji=1）
//  - 上界 2000 码点：fail-closed 拒绝（绝不静默截断——半句话比没有更危险），问题保持待决
//  - 前置检查在 Control Core 之前回执（不白跑一轮裁决），settleText 内同闸兜底
//  - 含不可见字符的合法长度回答：过滤后正常落账

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuestionBridge, sanitizeAnswerText, ANSWER_MAX_CODEPOINTS } from '../src/questions/router.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-s07-')), 'state.json')
}

/** Control Core 联调台（与 questions.test.mjs 同款形状：正确 account 可作答）。 */
function makeRig({ channel = 'telegram', accountId = 'tg-acc', chatId = '900113', userId = 'u1' } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 's07-test-secret' })
  const bus = createInboundBus({ allowUsers: [userId], store, vault })
  const identity = createIdentity({ store, logger: null })
  identity.addBinding({ channel, userId })
  const texts = []
  const warns = []
  const raw = {
    channel,
    accountId,
    notifyTargets: () => [{ chatId, userId }],
    async sendQuestionCard() { return { messageId: 1 } },
    async editResolved() {},
    async sendText(_chatId, text) { texts.push({ chatId: _chatId, text }); return true },
  }
  const notifier = { channels: [channel], notifyAll: async () => ({ ok: true, delivered: [channel], skipped: [], failed: [] }) }
  const control = createControlEntry({ policy: { mode: 'personal', capabilities: { approve: true } }, identity, logger: null })
  const bridge = createQuestionBridge({
    bus, vault, store, notifier, identity, control,
    interactive: () => [raw],
    logger: { warn: (...args) => warns.push(args.join(' ')) },
    config: { timeoutMs: 300, escalation: { enabled: false } },
  })
  bridge.attach()
  return {
    store, vault, bus, identity, bridge, texts, warns,
    /** 以正确身份发一条自定义回答。 */
    answer: (text) => bus.accept({ channel, accountId, userId, chatId, chatType: 'private', messageId: `m-${Math.random()}`, text }),
  }
}

const SINGLE = { question: '选一个部署环境', options: [{ label: '测试环境' }, { label: '预发环境' }, { label: '生产环境' }] }

test('sanitizeAnswerText：控制/零宽/bidi 字符剥离，\\n\\t\\r 保留', () => {
  const { text, removed } = sanitizeAnswerText('答\u0000案\u200B是\u202EA\u202C生产\t环境\n第二行\r第三行')
  assert.equal(text, '答案是A生产\t环境\n第二行\r第三行')
  assert.equal(removed, 4, 'NUL + 零宽 + 两个 bidi 控制符共 4 个被剥离')
})

test('sanitizeAnswerText：码点计数（emoji/中文按人类感知计），非 UTF-16 单元', () => {
  const emoji = '🍅'.repeat(ANSWER_MAX_CODEPOINTS) // 2000 码点 = 4000 UTF-16 单元
  assert.equal(sanitizeAnswerText(emoji).tooLong, false, '2000 个 emoji（4000 UTF-16 单元）不超界')
  assert.equal(sanitizeAnswerText(`${emoji}🍅`).tooLong, true, '2001 个码点超界')
})

test('sanitizeAnswerText：null/undefined 归一为空文本', () => {
  assert.deepEqual(sanitizeAnswerText(undefined), { text: '', removed: 0, tooLong: false })
  assert.deepEqual(sanitizeAnswerText(null), { text: '', removed: 0, tooLong: false })
})

test('S-07 超长回答：前置拒绝 + 回执指引，问题保持待决，超时不代答', async () => {
  const rig = makeRig()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(20)
  const qKey = rig.store.keys('aq:')[0]
  rig.answer(`答：${'长'.repeat(2500)}`)
  assert.equal(rig.store.get(qKey).status, 'pending', '超长回答不得落账')
  assert.ok(rig.texts.some((entry) => /回答过长/.test(entry.text)), '回执指引「回答过长」')
  assert.ok(rig.texts.some((entry) => /2000/.test(entry.text) && /桌面端/.test(entry.text)), '指引含上限值与桌面端出路')
  const result = await pending
  assert.equal(result.answered, false, '超时永不代答（P2 红线不因拒绝路径破功）')
  rig.bridge.dispose()
})

test('S-07 边界值：恰好 2000 码点的回答正常结算', async () => {
  const rig = makeRig()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(20)
  const qKey = rig.store.keys('aq:')[0]
  const exact = '好'.repeat(ANSWER_MAX_CODEPOINTS)
  rig.answer(`答：${exact}`)
  const result = await pending
  assert.equal(result.answered, true, '边界值（2000 码点整）不触发拒绝')
  assert.equal(rig.store.get(qKey).status, 'resolved')
  assert.equal(rig.store.get(qKey).answers[0].length, ANSWER_MAX_CODEPOINTS)
  rig.bridge.dispose()
})

test('S-07 不可见字符：过滤后落账干净文本 + warn 留痕（注入载体剥离）', async () => {
  const rig = makeRig()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(20)
  const qKey = rig.store.keys('aq:')[0]
  rig.answer('答：生产\u200B\u202E环境')
  const result = await pending
  assert.equal(result.answered, true)
  assert.equal(rig.store.get(qKey).answers[0], '生产环境', '零宽/bidi 字符不得进 agent 会话')
  assert.ok(rig.warns.some((line) => line.includes('控制/零宽')), '剥离行为进 warn 日志')
  rig.bridge.dispose()
})
