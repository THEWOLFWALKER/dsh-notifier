import test from 'node:test'
import assert from 'node:assert/strict'
import { registerNotifyTool, compileParameters } from '../src/tool-register.mjs'

function fakeTools() {
  const defs = []
  const ctx = {
    tools: { register(def) { defs.push(def); return () => {} } },
  }
  return { ctx, defs }
}

function fakeNotifier(overrides = {}) {
  return {
    notify: async (channel, msg) => ({ ok: true, skipped: false, channel, error: undefined }),
    notifyAll: async (msg) => ({ ok: true, delivered: ['webhook'], failed: [] }),
    channelCount: 1,
    channels: ['webhook'],
    ...overrides,
  }
}

test('compileParameters 产出原生 JSON Schema（含 required）', () => {
  const schema = compileParameters({
    message: { type: 'string', required: true, description: '正文' },
    title: { type: 'string', description: '标题' },
    channel: { type: 'string', description: '渠道' },
  })
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['message'])
  assert.equal(schema.properties.message.type, 'string')
  assert.equal(schema.properties.channel.description, '渠道')
  assert.equal(schema.properties.title.required, undefined)
})

test('registerNotifyTool 注册名为 notify 的工具', () => {
  const { ctx: tools, defs } = fakeTools()
  const dispose = registerNotifyTool(tools, fakeNotifier())
  assert.equal(defs.length, 1)
  assert.equal(defs[0].name, 'notify')
  assert.equal(typeof dispose, 'function')
})

test('notify 工具 execute: message 必填校验', async () => {
  const { ctx: tools, defs } = fakeTools()
  registerNotifyTool(tools, fakeNotifier())
  await assert.rejects(() => defs[0].execute({}), /message 不能为空/)
  await assert.rejects(() => defs[0].execute({ message: '   ' }), /message 不能为空/)
})

test('notify 工具 execute: 无渠道时返回 skipped 结果', async () => {
  const { ctx: tools, defs } = fakeTools()
  registerNotifyTool(tools, fakeNotifier({ channelCount: 0 }))
  const result = await defs[0].execute({ message: 'hi' })
  assert.equal(result.skipped, true)
  assert.equal(result.ok, false)
})

test('notify 工具 execute: 指定渠道单发', async () => {
  const { ctx: tools, defs } = fakeTools()
  let called
  registerNotifyTool(tools, fakeNotifier({
    notify: async (channel, msg) => {
      called = { channel, msg }
      return { ok: true, skipped: false, channel, error: undefined }
    },
  }))
  const result = await defs[0].execute({ message: 'hi', channel: 'webhook', title: 'T' })
  assert.equal(result.delivered[0], 'webhook')
  assert.equal(called.channel, 'webhook')
  assert.equal(called.msg.title, 'T')
  assert.equal(called.msg.content, 'hi')
})

test('notify 工具 execute: 指定渠道未配置 -> skipped', async () => {
  const { ctx: tools, defs } = fakeTools()
  registerNotifyTool(tools, fakeNotifier({
    notify: async () => ({ ok: false, skipped: true, channel: 'telegram', error: undefined }),
  }))
  const result = await defs[0].execute({ message: 'hi', channel: 'telegram' })
  assert.equal(result.skipped, true)
  assert.equal(result.channel, 'telegram')
})

test('notify 工具 execute: 指定渠道失败 -> failed 列表', async () => {
  const { ctx: tools, defs } = fakeTools()
  registerNotifyTool(tools, fakeNotifier({
    notify: async () => ({ ok: false, skipped: false, channel: 'webhook', error: new Error('HTTP 500') }),
  }))
  const result = await defs[0].execute({ message: 'hi', channel: 'webhook' })
  assert.equal(result.ok, false)
  assert.equal(result.failed[0].error, 'HTTP 500')
})

test('notify 工具 execute: 省略 channel 广播', async () => {
  const { ctx: tools, defs } = fakeTools()
  let broadcastMsg
  registerNotifyTool(tools, fakeNotifier({
    notifyAll: async (msg) => {
      broadcastMsg = msg
      return { ok: true, delivered: ['webhook', 'bark'], failed: [] }
    },
  }))
  const result = await defs[0].execute({ message: 'hi' })
  assert.deepEqual(result.delivered, ['webhook', 'bark'])
  assert.equal(broadcastMsg.content, 'hi')
})

test('registerNotifyTool 在无 tools 服务时返回 null 不抛错', () => {
  const dispose = registerNotifyTool({}, fakeNotifier())
  assert.equal(dispose, null)
})
