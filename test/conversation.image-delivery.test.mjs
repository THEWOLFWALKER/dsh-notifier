// v0.10 图片进入 DSH 会话（任务书提交6）集成测试。
// 覆盖：文本+图片双载投递（不丢图）、纯图占位（不把占位正文当真实文本交给模型）、
// 合并窗内图片随末条投递、受控下载失败回执（不阻断文字投递）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerConversationRouter } from '../src/inbound/conversation.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createSessionRegistry } from '../src/routing/session-registry.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const FLUSH_MS = 60
const SID = 'aaaaaaaa-0001-4aaa-8bbb-cccccccccccc'
const IMG_URL = 'https://media.example.test/a.png'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-img-')), 'state.json')
}

function makeAgent(id = SID, status = 'idle') {
  const calls = { followup: [], inject: [], steer: [], cancel: [] }
  return {
    id, status, header: { cwd: '/home/u/proj/alpha' }, calls,
    followup: (msg) => calls.followup.push(msg),
    inject: (msg) => calls.inject.push(msg),
    steer: (msg) => calls.steer.push(msg),
    cancel: (cause) => calls.cancel.push(cause),
  }
}

function makeRig({ agents = [], downloadImage } = {}) {
  const store = createStore(tempPath())
  const bus = createInboundBus({ allowUsers: ['42'], store })
  const handlers = {}
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  const ctx = {
    agents: { get: (id) => agentMap.get(id), list: () => [...agentMap.values()] },
    on: (event, handler) => { ;(handlers[event] ??= []).push(handler); return () => { handlers[event] = handlers[event].filter((h) => h !== handler) } },
  }
  const router = createAgentRouter({ store, agentsList: () => ctx.agents.list() })
  const registry = createSessionRegistry({ ctx, store, now: () => Date.now(), touchWriteMs: 0, sweepEveryMs: 0 })
  const replies = []
  const deps = {
    ctx, bus, store,
    reply: (channel, chatId, text) => replies.push({ channel, chatId, text }),
    config: { mergeWindowMs: FLUSH_MS },
    logger: null,
    router, registry,
    channelTypes: () => ['telegram'],
  }
  if (downloadImage !== undefined) deps.downloadImage = downloadImage
  const dispose = registerConversationRouter(deps)
  const userSays = (payload) => {
    const { userId = '42', chatId = userId, text = '', image } = payload
    bus.accept({ channel: 'telegram', userId, chatId, messageId: `m${Math.random()}`, text, ...(image === undefined ? {} : { image }) })
  }
  const flush = async (payload) => { userSays(payload); await sleep(FLUSH_MS + 10) }
  const fire = (event, p) => (handlers[event] ?? []).forEach((h) => h(p))
  return { store, bus, replies, dispose, userSays, flush, fire, agentMap }
}

test('文本+图片双载：agent 收到 text 块与 image_url 块（不因 text!==\'\' 丢图）', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)

  await rig.flush({ text: '看看这张图', image: { url: IMG_URL, width: 800 } })
  assert.equal(agent.calls.followup.length, 1)
  const content = agent.calls.followup[0].content
  assert.equal(content.length, 2)
  assert.deepEqual(content[0], { type: 'text', text: '看看这张图' })
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: IMG_URL } })
  rig.dispose()
})

test('纯图（无正文）：占位正文不落进视觉模型，只投 image_url 块', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)

  await rig.flush({ image: { url: IMG_URL } })
  assert.equal(agent.calls.followup.length, 1)
  const content = agent.calls.followup[0].content
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'image_url')
  // 占位正文 '[图片消息]' 不得作为 text 块交给模型
  assert.ok(content.every((block) => block.type !== 'text'), '纯图不得夹带占位 text 块')
  rig.dispose()
})

test('合并窗内图片随 text 投递一次（图取首条，不叠加）', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)

  rig.userSays({ text: '第一句', image: { url: IMG_URL } })
  rig.userSays({ text: '第二句' })
  await sleep(FLUSH_MS + 10)
  assert.equal(agent.calls.followup.length, 1, '合并窗内多片段只投一次')
  const content = agent.calls.followup[0].content
  const imageBlocks = content.filter((b) => b.type === 'image_url')
  assert.equal(imageBlocks.length, 1, '合并窗内图片只随一次（不叠加）')
  assert.match(content[0].text, /第一句\n第二句/)
  rig.dispose()
})

test('受控下载失败：只发失败回执，文字路径不阻断', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent], downloadImage: async () => null })
  rig.fire('agent/created', agent)

  await rig.flush({ text: '看看这张图', image: { url: IMG_URL } })
  await sleep(10) // best-effort 下载 promise 落定
  assert.equal(agent.calls.followup.length, 1, '下载失败不阻断文字投递')
  assert.ok(
    rig.replies.some((r) => r.text.includes('图片获取失败')),
    '下载失败要发失败回执',
  )
  rig.dispose()
})

test('受控下载成功：无失败回执', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent], downloadImage: async () => ({ url: IMG_URL, contentType: 'image/png', size: 1234 }) })
  rig.fire('agent/created', agent)

  await rig.flush({ text: '看看这张图', image: { url: IMG_URL } })
  await sleep(10)
  assert.equal(agent.calls.followup.length, 1)
  assert.ok(!rig.replies.some((r) => r.text.includes('图片获取失败')), '下载成功不误报失败')
  rig.dispose()
})