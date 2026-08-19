// 阶段 5 测试：inbound/conversation（followup/inject/steer、合并窗、命令集、绑定）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerConversationRouter } from '../src/inbound/conversation.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createStore } from '../src/inbound/store.mjs'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-conv-')), 'state.json')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeAgent(id, status = 'idle') {
  const calls = { followup: [], inject: [], steer: [], cancel: [] }
  return {
    id,
    status,
    calls,
    followup: (msg) => calls.followup.push(msg),
    inject: (msg) => calls.inject.push(msg),
    steer: (msg) => calls.steer.push(msg),
    cancel: (cause) => calls.cancel.push(cause),
  }
}

/** rig：真实 bus/store + 假 ctx.agents + 回执 spy。 */
function makeRig({ agents = [], mergeWindowMs = 30, status, roots } = {}) {
  const store = createStore(tempPath())
  const bus = createInboundBus({ allowUsers: ['42'], store })
  const handlers = {}
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]))
  const ctx = {
    agents: {
      get: (id) => agentMap.get(id),
      list: () => [...agentMap.values()],
      ...(roots !== undefined ? { roots: () => roots } : {}),
    },
    on: (event, handler) => {
      ;(handlers[event] ??= []).push(handler)
      return () => {
        handlers[event] = handlers[event].filter((h) => h !== handler)
      }
    },
  }
  const replies = []
  const dispose = registerConversationRouter({
    ctx,
    bus,
    store,
    reply: (channel, chatId, text) => replies.push({ channel, chatId, text }),
    config: { mergeWindowMs },
    logger: null,
  })
  const userSays = (text, { userId = '42', messageId } = {}) =>
    bus.accept({ channel: 'telegram', userId, chatId: userId, messageId: messageId ?? `m${Math.random()}`, text })
  const fire = (event, payload) => (handlers[event] ?? []).forEach((h) => h(payload))
  return { store, bus, handlers, replies, dispose, userSays, fire, agentMap }
}

test('会话路由：空闲 agent + 普通文本 → followup（plugin 来源消息）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)
  rig.userSays('再加一步：把结果写到 docs')
  await sleep(60) // 合并窗
  assert.equal(agent.calls.followup.length, 1)
  const msg = agent.calls.followup[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'plugin')
  assert.equal(msg.source.plugin, 'dsh-notifier')
  assert.deepEqual(msg.content, [{ type: 'text', text: '再加一步：把结果写到 docs' }])
  assert.ok(typeof msg.id === 'string' && msg.id.length > 0)
  rig.dispose()
})

test('会话路由：忙碌 agent + 普通文本 → inject（排队不打断）', async () => {
  const agent = makeAgent('s1', 'running')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)
  rig.userSays('补充：注意边界情况')
  await sleep(60)
  assert.equal(agent.calls.inject.length, 1)
  assert.equal(agent.calls.inject[0].content[0].text, '补充：注意边界情况')
  assert.equal(agent.calls.followup.length, 0)
  rig.dispose()
})

test('会话路由：! 前缀 → steer（忙碌时纠偏，前缀被剥掉）', async () => {
  const agent = makeAgent('s1', 'running')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)
  rig.userSays('!不对，用 python 别用 bash')
  await sleep(60)
  assert.equal(agent.calls.steer.length, 1)
  assert.equal(agent.calls.steer[0].content[0].text, '不对，用 python 别用 bash')
  assert.equal(agent.calls.inject.length, 0)
  rig.dispose()
})

test('会话路由：只有 ! 的空文本被忽略', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)
  rig.userSays('!')
  await sleep(60)
  assert.equal(agent.calls.followup.length, 0)
  assert.equal(agent.calls.steer.length, 0)
  rig.dispose()
})

test('会话路由：合并窗内多条消息合并为一条投递', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], mergeWindowMs: 40 })
  rig.fire('agent/created', agent)
  rig.userSays('第一部分')
  await sleep(10)
  rig.userSays('第二部分')
  await sleep(10)
  rig.userSays('第三部分')
  await sleep(80) // 窗口关闭
  assert.equal(agent.calls.followup.length, 1)
  assert.equal(agent.calls.followup[0].content[0].text, '第一部分\n第二部分\n第三部分')
  rig.dispose()
})

test('会话路由：.. 终止符立即冲刷（不等窗口）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], mergeWindowMs: 2000 })
  rig.fire('agent/created', agent)
  rig.userSays('打完了')
  await sleep(20)
  rig.userSays('发吧..')
  await sleep(20)
  assert.equal(agent.calls.followup.length, 1)
  assert.equal(agent.calls.followup[0].content[0].text, '打完了\n发吧')
  rig.dispose()
})

test('会话路由：!! 终止符立即冲刷并按 steer 投递', async () => {
  const agent = makeAgent('s1', 'running')
  const rig = makeRig({ agents: [agent], mergeWindowMs: 2000 })
  rig.fire('agent/created', agent)
  rig.userSays('改需求')
  await sleep(20)
  rig.userSays('现在就改!!')
  await sleep(20)
  assert.equal(agent.calls.steer.length, 1)
  assert.equal(agent.calls.steer[0].content[0].text, '改需求\n现在就改')
  rig.dispose()
})

test('命令集：/help 与 /status 回执', async () => {
  const agent = makeAgent('s1', 'running')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)
  rig.userSays('/help')
  await sleep(20)
  assert.ok(rig.replies.some((r) => /命令集/.test(r.text) && /\/bind/.test(r.text)))
  rig.userSays('/status')
  await sleep(20)
  const status = rig.replies.find((r) => /目标：/.test(r.text))
  assert.ok(status !== undefined)
  assert.match(status.text, /s1/)
  assert.match(status.text, /running/)
  assert.equal(agent.calls.followup.length, 0) // 命令不进会话流
  rig.dispose()
})

test('命令集：/bind 绑定后消息投给指定会话；无效 id 回执提示', async () => {
  const s1 = makeAgent('s1', 'idle')
  const s2 = makeAgent('s2', 'idle')
  const rig = makeRig({ agents: [s1, s2] })
  rig.fire('agent/created', s1) // 默认 s1
  rig.userSays('/bind s2')
  await sleep(20)
  assert.ok(rig.replies.some((r) => /已绑定 s2/.test(r.text)))
  rig.userSays('你好')
  await sleep(60)
  assert.equal(s2.calls.followup.length, 1)
  assert.equal(s1.calls.followup.length, 0)
  // 绑定持久化（store）
  assert.equal(rig.store.get('bind:telegram:42'), 's2')

  rig.userSays('/bind nope')
  await sleep(20)
  assert.ok(rig.replies.some((r) => /不存在/.test(r.text)))
  rig.dispose()
})

test('命令集：/unbind 回到默认（最近活跃会话）', async () => {
  const s1 = makeAgent('s1', 'idle')
  const s2 = makeAgent('s2', 'idle')
  const rig = makeRig({ agents: [s1, s2] })
  rig.fire('agent/created', s1)
  rig.userSays('/bind s2')
  await sleep(20)
  rig.userSays('/unbind')
  await sleep(20)
  assert.ok(rig.replies.some((r) => /已解绑/.test(r.text)))
  rig.userSays('默认给谁')
  await sleep(60)
  assert.equal(s1.calls.followup.length, 1) // 回到最近活跃 s1
  rig.dispose()
})

test('命令集：/stop 调 agent.cancel', async () => {
  const agent = makeAgent('s1', 'running')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)
  rig.userSays('/stop')
  await sleep(20)
  assert.deepEqual(agent.calls.cancel, ['remote-stop'])
  assert.ok(rig.replies.some((r) => /已请求取消/.test(r.text)))
  rig.dispose()
})

test('命令集：未知 /xxx 命令当普通文本投递（不吞消息）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)
  rig.userSays('/etc/passwd 看看这个')
  await sleep(60)
  assert.equal(agent.calls.followup.length, 1)
  assert.equal(agent.calls.followup[0].content[0].text, '/etc/passwd 看看这个')
  rig.dispose()
})

test('无活跃会话时回执提示（不投递不抛错）', async () => {
  const rig = makeRig({ agents: [] })
  rig.userSays('有人吗')
  await sleep(60)
  assert.equal(rig.replies.length, 1)
  assert.match(rig.replies[0].text, /没有活跃会话/)
  rig.dispose()
})

test('绑定会话消失时回执提示（agent 已退出）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)
  rig.userSays('/bind s1')
  await sleep(20)
  rig.agentMap.delete('s1') // agent 退出
  rig.userSays('还在吗')
  await sleep(60)
  assert.ok(rig.replies.some((r) => /不存在或已退出/.test(r.text)))
  rig.dispose()
})

test('agent/disposed 清掉默认目标（最近活跃）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)
  rig.fire('agent/disposed', agent)
  rig.userSays('有人吗')
  await sleep(60)
  assert.ok(rig.replies.some((r) => /没有活跃会话/.test(r.text)))
  rig.dispose()
})

test('dispose 后消息不再投递、无悬挂计时器', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], mergeWindowMs: 50 })
  rig.fire('agent/created', agent)
  rig.dispose()
  rig.userSays('晚到的消息')
  await sleep(80)
  assert.equal(agent.calls.followup.length, 0)
  assert.equal(agent.calls.inject.length, 0)
})

// ———————— v0.7.3 GitHub issue #4 Bug1 回归 ————————

// DSH 的 agent/created | agent/disposed 事件签名是 (payload: { agent })，
// 旧代码 agent?.id 恒 undefined → latestSessionId 永不赋值，
// 未 /bind 用户文本全部「没有活跃会话」被拒投（命令能回、文本全丢）。
test('agent/created 载荷形态 { agent } 必须解包（#4）：文本正常投递到最新根 agent', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', { agent }) // DSH 真实事件签名
  rig.userSays('跑一下测试')
  await sleep(60)
  assert.equal(agent.calls.followup.length, 1, '载荷形态 { agent } 不得被忽略')
  rig.dispose()
})

test('agent/disposed 载荷形态 { agent } 同样解包（#4）：默认目标被清理', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', { agent })
  rig.fire('agent/disposed', { agent })
  rig.userSays('有人吗')
  await sleep(60)
  assert.ok(rig.replies.some((r) => /没有活跃会话/.test(r.text)))
  rig.dispose()
})

// 后台 subagent 同样触发 agent/created；宿主暴露 ctx.agents.roots() 时只追踪根 agent。
test('subagent 不劫持默认投递目标（#4）：roots() 存在时被过滤', async () => {
  const root = makeAgent('root-1', 'idle')
  const subagent = makeAgent('sub-1', 'running')
  const rig = makeRig({ agents: [root, subagent], roots: [root] })
  rig.fire('agent/created', { agent: root })
  rig.fire('agent/created', { agent: subagent }) // 后台 subagent 晚到：不得覆盖 root-1
  rig.userSays('继续')
  await sleep(60)
  assert.equal(root.calls.followup.length, 1, '根 agent 仍是默认投递目标')
  assert.equal(subagent.calls.followup.length, 0, 'subagent 不得接收用户文本')
  rig.dispose()
})

// 老宿主没有 ctx.agents.roots()：退化为全量追踪（解包修复仍生效，不因缺 API 崩溃）。
test('老宿主无 roots() API：全量追踪降级（#4），不抛错', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent] }) // ctx.agents 无 roots
  rig.fire('agent/created', { agent })
  rig.userSays('继续')
  await sleep(60)
  assert.equal(agent.calls.followup.length, 1)
  rig.dispose()
})
