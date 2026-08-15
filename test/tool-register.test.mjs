import test from 'node:test'
import assert from 'node:assert/strict'
import { registerNotifyTool, registerNotifyTestTool, compileParameters, createRateLimiter } from '../src/tool-register.mjs'

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

// ---------- 阶段 6：限流 + notify_test ----------

test('createRateLimiter: 滑动窗口按分钟限流，0 = 不限', () => {
  let clock = 1_000_000
  const limiter = createRateLimiter({ limitPerMinute: 3, now: () => clock })
  clock += 1000; assert.equal(limiter.allow(), true)  // 命中 t0
  clock += 1000; assert.equal(limiter.allow(), true)  // 命中 t0+1s
  clock += 1000; assert.equal(limiter.allow(), true)  // 命中 t0+2s
  assert.equal(limiter.used(), 3)
  clock += 30_000
  assert.equal(limiter.allow(), false, '窗口内第 4 次超限')
  clock += 25_500 // t0+58.5s：三条都未满 60s，仍超限
  assert.equal(limiter.allow(), false)
  clock += 3000 // t0+61.5s：仅 t0 滑出（t0+1s 才 59.5s，未满 60s）→ 余 1 条
  assert.equal(limiter.allow(), true, '部分滑出后放行')
  assert.equal(limiter.used(), 3, '仅 t0 滑出，t0+1s/t0+2s 仍在窗内，加上新命中共 3 条')

  const unlimited = createRateLimiter({ limitPerMinute: 0 })
  for (let index = 0; index < 20; index += 1) assert.equal(unlimited.allow(), true)
})

test('notify 工具 execute: 超限返回 rateLimited 结果并渲染中文提示', async () => {
  const { ctx: tools, defs } = fakeTools()
  registerNotifyTool(tools, fakeNotifier(), { rateLimitPerMinute: 1 })
  const first = await defs[0].execute({ message: '第一条' })
  assert.equal(first.ok, true)
  const second = await defs[0].execute({ message: '第二条' })
  assert.equal(second.rateLimited, true)
  assert.equal(second.ok, false)
  const rendered = defs[0].output.render({}, second)
  assert.match(rendered[0].text, /已限流/)
  assert.match(rendered[0].text, /toolRateLimitPerMinute/)
})

test('notify 工具 execute: rateLimitPerMinute 0 = 不限流', async () => {
  const { ctx: tools, defs } = fakeTools()
  registerNotifyTool(tools, fakeNotifier(), { rateLimitPerMinute: 0 })
  for (let index = 0; index < 5; index += 1) {
    const result = await defs[0].execute({ message: `第 ${index} 条` })
    assert.equal(result.ok, true)
  }
})

test('registerNotifyTestTool 注册 notify_test 并广播自检消息', async () => {
  const { ctx: tools, defs } = fakeTools()
  const dispose = registerNotifyTestTool(tools, fakeNotifier({
    notifyAll: async (msg) => {
      assert.match(msg.title, /自检/)
      assert.ok(msg.content.includes('测试消息'))
      return { ok: true, delivered: ['webhook'], failed: [] }
    },
  }))
  assert.equal(defs[0].name, 'notify_test')
  assert.equal(typeof dispose, 'function')
  const result = await defs[0].execute({})
  assert.equal(result.ok, true)
  assert.deepEqual(result.delivered, ['webhook'])
})

test('registerNotifyTestTool: 指定渠道单发与无渠道跳过', async () => {
  const { ctx: tools, defs } = fakeTools()
  registerNotifyTestTool(tools, fakeNotifier({
    notify: async (channel, msg) => ({ ok: true, skipped: false, channel }),
  }))
  const single = await defs[0].execute({ channel: 'bark' })
  assert.equal(single.ok, true)
  assert.deepEqual(single.delivered, ['bark'])

  const { ctx: ctx2, defs: defs2 } = fakeTools()
  registerNotifyTestTool(ctx2, fakeNotifier({ channelCount: 0 }))
  const skipped = await defs2[0].execute({})
  assert.equal(skipped.skipped, true)
})

test('registerNotifyTestTool 在无 tools 服务时返回 null 不抛错', () => {
  assert.equal(registerNotifyTestTool({}, fakeNotifier()), null)
})

// ---------- 阶段 6 补充：notify_test 同样限流（防绕过 notify 限流刷渠道） ----------

test('notify_test 工具 execute: 超限返回 rateLimited，不能绕过 notify 限流刷渠道', async () => {
  const { ctx: tools, defs } = fakeTools()
  registerNotifyTestTool(tools, fakeNotifier(), { rateLimitPerMinute: 1 })
  const first = await defs[0].execute({})
  assert.equal(first.ok, true)
  assert.equal(first.rateLimited, undefined, '第一条正常发送')
  const second = await defs[0].execute({})
  assert.equal(second.rateLimited, true, '第二条被限流')
  assert.equal(second.ok, false)
  const rendered = defs[0].output.render({}, second)
  assert.match(rendered[0].text, /已限流/)
})

test('notify_test 工具 execute: rateLimitPerMinute 0 = 不限流', async () => {
  const { ctx: tools, defs } = fakeTools()
  registerNotifyTestTool(tools, fakeNotifier(), { rateLimitPerMinute: 0 })
  for (let index = 0; index < 5; index += 1) {
    const result = await defs[0].execute({})
    assert.equal(result.ok, true)
  }
})
