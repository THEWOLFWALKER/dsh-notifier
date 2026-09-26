// v0.11 #36 同一条消息携带图片 + 文件（durable image/file block）集成测试。
// 覆盖：text+file、image+file 顺序保持、单项过渡形状不重复、纯文件占位剥离、
// 部分失败不阻断其余、纯附件全失败绝不塞空消息、缺 attachment service 降级、文件名去路径。
// 契约依据：官方 deepseek-harness V4 UserMessage —— file 块为
// { type:'file', attachment: FileAttachmentRef }；AttachmentStore.saveFile({ data, name? })。
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
const FILE_URL = 'https://media.example.test/doc.pdf'
const PNG_BYTES = { data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png', size: 4 }
const PDF_BYTES = { data: new Uint8Array([37, 80, 68, 70]), mediaType: 'application/pdf', size: 4 }

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-att-')), 'state.json')
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

function makeRig({ agents = [], downloadImageBytes, downloadFileBytes, attachments, logger = null } = {}) {
  const store = createStore(tempPath())
  const bus = createInboundBus({ allowUsers: ['42'], store })
  const handlers = {}
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  const saved = { images: [], files: [] }
  const ctx = {
    agents: { get: (id) => agentMap.get(id), list: () => [...agentMap.values()] },
    // attachment service 桩：saveImage/saveFile 均返回带 attachmentId 的 durable ref（可断言）。
    attachments: attachments === undefined
      ? {
        saveImage: async ({ data, mediaType, name }) => {
          saved.images.push({ data, mediaType, name })
          return { attachmentId: `img-${saved.images.length}`, mediaType, ...(name ? { name } : {}) }
        },
        saveFile: async ({ data, name }) => {
          saved.files.push({ data, name })
          return { attachmentId: `file-${saved.files.length}`, ...(name ? { name } : {}) }
        },
      }
      : attachments,
    on: (event, handler) => { ;(handlers[event] ??= []).push(handler); return () => { handlers[event] = handlers[event].filter((h) => h !== handler) } },
  }
  const router = createAgentRouter({ store, agentsList: () => ctx.agents.list() })
  const registry = createSessionRegistry({ ctx, store, now: () => Date.now(), touchWriteMs: 0, sweepEveryMs: 0 })
  const replies = []
  const deps = {
    ctx, bus, store,
    reply: (channel, chatId, text) => replies.push({ channel, chatId, text }),
    config: { mergeWindowMs: FLUSH_MS },
    logger,
    router, registry,
    channelTypes: () => ['telegram'],
    downloadImageBytes: downloadImageBytes ?? (async () => PNG_BYTES),
    downloadFileBytes: downloadFileBytes ?? (async () => PDF_BYTES),
  }
  const dispose = registerConversationRouter(deps)
  const userSays = (payload) => {
    const { userId = '42', chatId = userId, text = '', image, file, attachments: list } = payload
    bus.accept({
      channel: 'telegram', userId, chatId, messageId: `m${Math.random()}`, text,
      ...(image === undefined ? {} : { image }),
      ...(file === undefined ? {} : { file }),
      ...(list === undefined ? {} : { attachments: list }),
    })
  }
  const flush = async (payload) => { userSays(payload); await sleep(FLUSH_MS + 10) }
  const fire = (event, p) => (handlers[event] ?? []).forEach((h) => h(p))
  return { store, bus, replies, dispose, userSays, flush, fire, agentMap, saved }
}

test('#36 文本 + 文件：agent 收到 text 块与 durable file 块', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)

  await rig.flush({ text: '请查收', file: { name: 'doc.pdf', url: FILE_URL, size: 1024 } })
  assert.equal(agent.calls.followup.length, 1)
  const msg = agent.calls.followup[0]
  assert.equal(msg.source.kind, 'dsh-notifier')
  assert.deepEqual(msg.content[0], { type: 'text', text: '请查收' })
  assert.equal(msg.content[1].type, 'file')
  assert.equal(msg.content[1].attachment.attachmentId, 'file-1')
  // 远程 URL 绝不进 UserMessage（红线 2.4）
  assert.ok(!JSON.stringify(msg.content).includes(FILE_URL), '不得把远程 URL 塞进 Session')
  rig.dispose()
})

test('#36 图片 + 文件同条：块顺序保持入站顺序，且不重复图片', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)

  await rig.flush({
    text: '两件都看看',
    // 规范形状 attachments[] + 过渡期单项 image 同时出现（QQ 网关实际会两处都填）
    image: { url: IMG_URL, width: 800 },
    attachments: [
      { kind: 'image', image: { url: IMG_URL, width: 800 } },
      { kind: 'file', file: { name: 'doc.pdf', url: FILE_URL, size: 1024 } },
    ],
  })
  assert.equal(agent.calls.followup.length, 1)
  const content = agent.calls.followup[0].content
  assert.deepEqual(content.map((block) => block.type), ['text', 'image', 'file'])
  assert.equal(content[1].attachment.attachmentId, 'img-1')
  assert.equal(content[2].attachment.attachmentId, 'file-1')
  assert.equal(rig.saved.images.length, 1, '同图不得因两处声明重复 admission')
  rig.dispose()
})

test('C10：附件聚合预算按下载后的实际字节限制为 16MiB', async () => {
  const agent = makeAgent()
  const chunkSize = 3 * 1024 * 1024
  const rig = makeRig({
    agents: [agent],
    downloadFileBytes: async () => ({
      data: new Uint8Array(chunkSize), mediaType: 'application/octet-stream', size: chunkSize,
    }),
  })
  rig.fire('agent/created', agent)
  await rig.flush({
    text: '批量附件',
    attachments: Array.from({ length: 6 }, (_, index) => ({
      kind: 'file', file: { name: `f${index}.bin`, url: `https://media.example.test/f${index}.bin` },
    })),
  })
  assert.equal(rig.saved.files.length, 5, '第六个会令实际总量超过 16MiB，不能 admission')
  assert.equal(agent.calls.followup[0].content.filter((block) => block.type === 'file').length, 5)
  assert.ok(rig.replies.some((entry) => /文件/.test(entry.text)))
  rig.dispose()
})

test('#36 纯文件（无正文）：占位正文不落进模型，只投 durable file 块', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)

  await rig.flush({ text: '[文件消息]', file: { name: 'doc.pdf', url: FILE_URL } })
  assert.equal(agent.calls.followup.length, 1)
  const msg = agent.calls.followup[0]
  assert.deepEqual(msg.content.map((block) => block.type), ['file'])
  assert.equal(msg.source.summary, '(附件消息)')
  rig.dispose()
})

test('#36 部分失败：文件失败仍投文本 + 文件失败回执，其余附件照投', async () => {
  const agent = makeAgent()
  const rig = makeRig({
    agents: [agent],
    downloadFileBytes: async () => null,
  })
  rig.fire('agent/created', agent)

  await rig.flush({
    text: '看看',
    image: { url: IMG_URL },
    attachments: [
      { kind: 'image', image: { url: IMG_URL } },
      { kind: 'file', file: { name: 'doc.pdf', url: FILE_URL } },
    ],
  })
  await sleep(10)
  assert.equal(agent.calls.followup.length, 1, '文件失败不阻断文本投递')
  const content = agent.calls.followup[0].content
  assert.deepEqual(content.map((block) => block.type), ['text', 'image'])
  assert.ok(rig.replies.some((r) => r.text.includes('文件获取失败')), '文件失败要发文件专属回执')
  rig.dispose()
})

test('#36 图 + 文件全失败（带正文）：混合失败回执，正文照投', async () => {
  const agent = makeAgent()
  const rig = makeRig({
    agents: [agent],
    downloadImageBytes: async () => null,
    downloadFileBytes: async () => null,
  })
  rig.fire('agent/created', agent)

  await rig.flush({
    text: '看看',
    attachments: [
      { kind: 'image', image: { url: IMG_URL } },
      { kind: 'file', file: { name: 'doc.pdf', url: FILE_URL } },
    ],
  })
  await sleep(10)
  assert.deepEqual(agent.calls.followup[0].content.map((b) => b.type), ['text'])
  assert.ok(rig.replies.some((r) => r.text.includes('附件获取失败')), '混合失败要发附件回执')
  rig.dispose()
})

test('#36 纯文件全失败：绝不塞空消息，只发失败回执', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent], downloadFileBytes: async () => null })
  rig.fire('agent/created', agent)

  await rig.flush({ text: '[文件消息]', file: { name: 'doc.pdf', url: FILE_URL } })
  await sleep(10)
  assert.equal(agent.calls.followup.length, 0, '纯附件失败不得构造空 UserMessage')
  assert.ok(rig.replies.some((r) => r.text.includes('文件获取失败')))
  rig.dispose()
})

test('#36 缺 attachment service：附件不可用降级为「正文照投 + 失败回执」', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent], attachments: null })
  rig.fire('agent/created', agent)

  await rig.flush({ text: '看看', file: { name: 'doc.pdf', url: FILE_URL } })
  await sleep(10)
  assert.equal(agent.calls.followup.length, 1, '无 attachments 服务不影响文本投递')
  assert.deepEqual(agent.calls.followup[0].content.map((b) => b.type), ['text'])
  assert.ok(rig.replies.some((r) => r.text.includes('文件获取失败')))
  rig.dispose()
})

test('#36 旧宿主缺 saveFile：文件 fail-closed，给出明确中英文能力诊断且告警去重', async () => {
  const agent = makeAgent()
  const warnings = []
  const rig = makeRig({
    agents: [agent],
    attachments: { saveImage: async () => ({ attachmentId: 'img-1' }) },
    logger: { warn: (_scope, message) => warnings.push(message) },
  })
  rig.fire('agent/created', agent)

  await rig.flush({ text: '看看', file: { name: 'doc.pdf', url: FILE_URL } })
  await rig.flush({ text: '再看一次', file: { name: 'doc-2.pdf', url: FILE_URL } })
  assert.equal(agent.calls.followup.length, 2)
  assert.deepEqual(agent.calls.followup[0].content.map((block) => block.type), ['text'])
  assert.ok(rig.replies.filter((r) => r.text.includes('宿主不支持文件入站存储')).length >= 2)
  assert.equal(warnings.filter((message) => message.includes('缺少 attachments.saveFile')).length, 1)
  rig.dispose()
})

test('#36 文件名去路径/控制字符后才交给 saveFile（附件名是不可信输入）', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)

  await rig.flush({ text: '看附件', file: { name: '../../../etc/passwd', url: FILE_URL } })
  assert.equal(rig.saved.files.length, 1)
  assert.equal(rig.saved.files[0].name, 'passwd', '路径分量必须剥离')
  rig.dispose()
})
