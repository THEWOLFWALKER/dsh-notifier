// v0.3.2 测试：conversation 会话路由命令族（/agent [use|back]、/route、绑定挂钩、消歧回执）。
// 与 conversation.test.mjs 互补：那里是 v0.3.1 旧链（router/registry 缺省），这里聚焦
// router/registry 注入后的新命令族、台账挂钩维护与降级行为（设计稿 §3 / §0.5-4 / §0.5-5 / §4）。

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
/** 合并窗冲刷等待：多数用例用小窗口 + 等待；mergeWindowMs: 0 的立即投递有专门回归用例。 */
const FLUSH_MS = 60

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-route-')), 'state.json')
}

/** 假宿主 agent：带 header.cwd（workspaceOf 取末段），投递方法全部记入 calls。 */
function makeAgent(id, status = 'idle', cwd = `/tmp/proj/${id}`) {
  const calls = { followup: [], inject: [], steer: [], cancel: [] }
  return {
    id,
    status,
    header: { cwd },
    calls,
    followup: (msg) => calls.followup.push(msg),
    inject: (msg) => calls.inject.push(msg),
    steer: (msg) => calls.steer.push(msg),
    cancel: (cause) => calls.cancel.push(cause),
  }
}

/**
 * rig：真实 bus/store/router/registry + 假 ctx.agents + 回执 spy。
 *  - 命令不进合并窗（同步断言）；普通文本进小合并窗，用 flush(text) 发送并等待冲刷；
 *  - clock：可变毫秒时钟注入 registry（lastActiveAt 排序的确定性来源），advance() 推进；
 *  - registry 经 spy 包装（attach/detach/touch 记入 calls）后注入 conversation，行为仍是真实实现；
 *  - options.router / options.registry：undefined = 装配真实实例；null = 不装配（降级场景）；
 *    传对象 = 直接使用（抛错防御场景）。
 */
function makeRig(options = {}) {
  const { agents = [], channelTypes = () => ['telegram', 'bark'], clockStart = 1_000_000 } = options
  const store = createStore(tempPath())
  const bus = createInboundBus({ allowUsers: ['42'], store })
  const handlers = {}
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]))
  const ctx = {
    agents: {
      get: (id) => agentMap.get(id),
      list: () => [...agentMap.values()],
    },
    on: (event, handler) => {
      ;(handlers[event] ??= []).push(handler)
      return () => {
        handlers[event] = handlers[event].filter((h) => h !== handler)
      }
    },
  }
  let clockMs = clockStart
  const now = () => clockMs

  const router = options.router === null
    ? null
    : (options.router ?? createAgentRouter({ store, agentsList: () => ctx.agents.list() }))
  const calls = { attach: [], detach: [], touch: [] }
  const baseRegistry = options.registry === null
    ? null
    : (options.registry ?? createSessionRegistry({ ctx, store, now, touchWriteMs: 0, sweepEveryMs: 0 }))
  const registry = baseRegistry === null
    ? null
    : {
      ...baseRegistry,
      attachInbound: (sid, binding) => { calls.attach.push({ sid, binding }); return baseRegistry.attachInbound(sid, binding) },
      detachInbound: (sid, binding) => { calls.detach.push({ sid, binding }); return baseRegistry.detachInbound(sid, binding) },
      touch: (sid) => { calls.touch.push(sid); return baseRegistry.touch(sid) },
    }

  const replies = []
  const dispose = registerConversationRouter({
    ctx,
    bus,
    store,
    reply: (channel, chatId, text) => replies.push({ channel, chatId, text }),
    config: options.config ?? { mergeWindowMs: 20 },
    logger: null,
    router,
    registry,
    channelTypes,
  })
  const userSays = (text, { userId = '42' } = {}) =>
    bus.accept({ channel: 'telegram', userId, chatId: userId, messageId: `m${Math.random()}`, text })
  const flush = async (text) => { userSays(text); await sleep(FLUSH_MS) } // 文本：等合并窗冲刷后再断言
  const fire = (event, payload) => (handlers[event] ?? []).forEach((h) => h(payload))
  return {
    store, bus, handlers, replies, dispose, userSays, flush, fire, agentMap,
    router, registry, calls, advance: (ms = 1) => { clockMs += ms },
  }
}

/** 共用 sid：同一 workspace 共享前缀（前缀歧义用），跨 workspace 前缀唯一。 */
const ALPHA_1 = 'aaaaaaaa-0001-4aaa-8bbb-cccccccccccc'
const ALPHA_2 = 'aaaaaaaa-0002-4aaa-8bbb-dddddddddddd'
const BETA_1 = 'eeeeffff-0003-4aaa-8bbb-eeeeeeeeeeee'

test('/agent 列表：workspace 分组 + sid 8 位前缀 + 出站通道集合 + quiet 标记', () => {
  const alpha = makeAgent(ALPHA_1, 'running', '/home/u/proj/alpha')
  const beta = makeAgent(BETA_1, 'idle', '/home/u/proj/beta')
  const rig = makeRig({ agents: [alpha, beta] })
  rig.fire('agent/created', alpha)
  rig.fire('agent/created', beta)
  rig.router.setAgentBinding('alpha', { channels: ['telegram'], quiet: true })

  rig.userSays('/agent')
  const text = rig.replies.at(-1).text
  assert.match(text, /alpha \| aaaaaaaa \| running \| \[telegram\] \| quiet/)
  assert.match(text, /beta \| eeeeffff \| idle \| \[telegram, bark\] \| -/)
  assert.ok(!text.includes('-0001'), 'sid 只展示 8 位前缀，不落全 id')
  rig.dispose()
})

test('/agent use <workspace>：精确匹配 → 取最近活跃会话绑定并挂钩台账', async () => {
  const older = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const newer = makeAgent(ALPHA_2, 'idle', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [older, newer] })
  rig.fire('agent/created', older)
  rig.advance(100)
  rig.fire('agent/created', newer)
  rig.advance(50)
  rig.registry.touch(older.id) // older 反超为最近活跃

  rig.userSays('/agent use alpha')
  assert.equal(rig.store.get('bind:telegram:42'), older.id)
  assert.deepEqual(rig.calls.attach, [{ sid: older.id, binding: { channel: 'telegram', userId: '42' } }])
  assert.ok(rig.calls.touch.includes(older.id), '绑定成功后刷新活跃信号')
  const reply = rig.replies.at(-1).text
  assert.match(reply, new RegExp(`已绑定 alpha / ${older.id}`))
  assert.match(reply, /workspace=alpha/)
  // 后续文本投给被绑定的最近活跃者
  await rig.flush('在吗')
  assert.equal(older.calls.followup.length, 1)
  assert.equal(newer.calls.followup.length, 0)
  rig.dispose()
})

test('/agent use <完整 sid>：sessionId 精确匹配直接绑定', async () => {
  const alpha = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const beta = makeAgent(BETA_1, 'idle', '/home/u/proj/beta')
  const rig = makeRig({ agents: [alpha, beta] })
  rig.fire('agent/created', alpha)
  rig.fire('agent/created', beta)

  rig.userSays(`/agent use ${BETA_1}`)
  assert.equal(rig.store.get('bind:telegram:42'), BETA_1)
  assert.match(rig.replies.at(-1).text, /sessionId 精确匹配/)
  await rig.flush('你好')
  assert.equal(beta.calls.followup.length, 1)
  assert.equal(alpha.calls.followup.length, 0)
  rig.dispose()
})

test('/agent use <前缀>：唯一命中（≥4 位）绑定到该会话', () => {
  const alpha = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const beta = makeAgent(BETA_1, 'idle', '/home/u/proj/beta')
  const rig = makeRig({ agents: [alpha, beta] })
  rig.fire('agent/created', alpha)
  rig.fire('agent/created', beta)

  rig.userSays('/agent use eeee') // 只命中 BETA_1
  assert.equal(rig.store.get('bind:telegram:42'), BETA_1)
  assert.match(rig.replies.at(-1).text, /sid 前缀唯一命中/)
  rig.dispose()
})

test('/agent use 前缀多命中：列出候选 sid，不写绑定', () => {
  const a1 = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const a2 = makeAgent(ALPHA_2, 'idle', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [a1, a2] })
  rig.fire('agent/created', a1)
  rig.fire('agent/created', a2)

  rig.userSays('/agent use aaaaaaaa') // 两个 alpha 会话共享前缀
  const text = rig.replies.at(-1).text
  assert.match(text, /命中 2 个活跃会话/)
  assert.ok(text.includes(ALPHA_1) && text.includes(ALPHA_2), '候选列出完整 sid')
  assert.equal(rig.store.get('bind:telegram:42'), undefined, '歧义不落绑定')
  assert.equal(rig.calls.attach.length, 0)
  rig.dispose()
})

test('/agent use 零命中：报错并提示 /agent（含 <4 位前缀不可匹配）', () => {
  const alpha = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [alpha] })
  rig.fire('agent/created', alpha)

  rig.userSays('/agent use zzzz9999')
  assert.match(rig.replies.at(-1).text, /未匹配到会话 zzzz9999.*\/agent/)
  rig.userSays('/agent use aa') // 3 位前缀不参与匹配
  assert.match(rig.replies.at(-1).text, /未匹配到会话 aa/)
  assert.equal(rig.store.get('bind:telegram:42'), undefined)
  rig.dispose()
})

test('/agent back：清掉 bind 键并 detachInbound 旧挂钩', () => {
  const alpha = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [alpha] })
  rig.fire('agent/created', alpha)
  rig.userSays('/agent use alpha')
  assert.notEqual(rig.registry.getSession(ALPHA_1).inbound, undefined)

  rig.userSays('/agent back')
  assert.equal(rig.store.get('bind:telegram:42'), undefined)
  assert.deepEqual(rig.calls.detach, [{ sid: ALPHA_1, binding: { channel: 'telegram', userId: '42' } }])
  assert.equal(rig.registry.getSession(ALPHA_1).inbound, undefined, '台账挂钩被摘除')
  assert.match(rig.replies.at(-1).text, /已回到通道默认/)
  rig.dispose()
})

test('/bind 补 attachInbound + touch；/unbind 先读旧值再 detachInbound', () => {
  const alpha = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [alpha] })
  rig.fire('agent/created', alpha)

  rig.userSays(`/bind ${ALPHA_1}`)
  assert.equal(rig.store.get('bind:telegram:42'), ALPHA_1)
  assert.deepEqual(rig.calls.attach, [{ sid: ALPHA_1, binding: { channel: 'telegram', userId: '42' } }])
  assert.ok(rig.calls.touch.includes(ALPHA_1))

  rig.userSays('/unbind')
  assert.equal(rig.store.get('bind:telegram:42'), undefined)
  assert.deepEqual(rig.calls.detach, [{ sid: ALPHA_1, binding: { channel: 'telegram', userId: '42' } }])
  assert.equal(rig.registry.getSession(ALPHA_1).inbound, undefined)
  assert.match(rig.replies.at(-1).text, /已解绑/)
  rig.dispose()
})

test('文本投递成功后 registry.touch(目标会话)（活跃信号回流）', async () => {
  const alpha = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [alpha] })
  rig.fire('agent/created', alpha)
  assert.equal(rig.calls.touch.length, 0)

  await rig.flush('跑一下测试') // 单 agent：L3 唯一 agent 兜底命中
  assert.equal(alpha.calls.followup.length, 1)
  assert.deepEqual(rig.calls.touch, [ALPHA_1])
  rig.dispose()
})

test('通道默认 workspace 多活跃会话：投最近活跃 + 消歧回执文案', async () => {
  const older = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const newer = makeAgent(ALPHA_2, 'idle', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [older, newer] })
  rig.fire('agent/created', older)
  rig.advance(100)
  rig.fire('agent/created', newer) // newer 更晚活跃
  rig.router.setChannelDefault('telegram', 'alpha')

  await rig.flush('继续')
  assert.equal(newer.calls.followup.length, 1, '投 lastActiveAt 最近者')
  assert.equal(older.calls.followup.length, 0)
  const receipt = rig.replies.find((r) => r.text.includes('已投'))?.text
  assert.ok(receipt !== undefined)
  assert.equal(receipt, `已投 ${ALPHA_2}（该 workspace 有 2 个活跃会话，用 /agent use 或 /bind 精确指定）`)
  rig.dispose()
})

test('/route：输出含出站段（describe 逐层）与入站段（来源/目标/歧义/通道默认）', () => {
  const alpha = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const beta = makeAgent(BETA_1, 'idle', '/home/u/proj/beta')
  const rig = makeRig({ agents: [alpha, beta] })
  rig.fire('agent/created', alpha)
  rig.fire('agent/created', beta)
  rig.router.setChannelDefault('telegram', 'beta')
  rig.userSays('/agent use alpha') // 显式绑定优先于通道默认

  rig.userSays('/route')
  const text = rig.replies.at(-1).text
  assert.match(text, /【出站】/)
  assert.match(text, /【入站】/)
  assert.match(text, /L1 会话 diff/) // describe 逐层来源
  assert.match(text, /L4 全局渠道池 → \[telegram, bark\]/)
  assert.match(text, /来源：显式绑定（\/bind 或 \/agent use）/)
  assert.ok(text.includes(ALPHA_1))
  assert.match(text, /歧义：否/)
  assert.match(text, /通道默认 agent（telegram）：beta/)
  rig.dispose()
})

test('registry 未装配：/agent 降级为宿主 agent 列表并附降级说明', () => {
  const alpha = makeAgent(ALPHA_1, 'running', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [alpha], registry: null })
  rig.fire('agent/created', alpha)

  rig.userSays('/agent')
  const text = rig.replies.at(-1).text
  assert.match(text, /registry 未装配.*降级/)
  assert.match(text, /alpha \| aaaaaaaa \| running \| \[telegram, bark\] \| -/) // agents.list + workspaceOf 兜底
  rig.dispose()
})

test('router 未装配：/agent 与 /route 回降级提示，旧链（bind > latest）投递回归', async () => {
  const a1 = makeAgent('s1', 'idle', '/p/one')
  const a2 = makeAgent('s2', 'idle', '/p/two')
  const rig = makeRig({ agents: [a1, a2], router: null, registry: null })
  rig.fire('agent/created', a1)
  rig.fire('agent/created', a2) // latest = s2

  rig.userSays('/agent')
  assert.match(rig.replies.at(-1).text, /路由引擎未装配/)
  rig.userSays('/route')
  assert.match(rig.replies.at(-1).text, /路由引擎未装配/)

  await rig.flush('旧链默认') // 无 router：回落 v0.3.1 行为 → 最近活跃
  assert.equal(a2.calls.followup.length, 1)
  assert.equal(a1.calls.followup.length, 0)
  rig.userSays('/bind s1')
  await rig.flush('旧链显式绑定')
  assert.equal(a1.calls.followup.length, 1, '/bind 仍走 store 旧链生效')
  rig.dispose()
})

test('router 抛错：命令族与投递主线全部降级，绝不崩', async () => {
  const boom = () => { throw new Error('router boom') }
  const rig = makeRig({
    agents: [makeAgent('s1', 'idle', '/p/one')],
    registry: null,
    router: {
      resolveInbound: boom, resolveOutbound: boom, describe: boom, getChannelDefault: boom,
    },
  })
  const agent = rig.agentMap.get('s1')
  rig.fire('agent/created', agent)

  rig.userSays('/agent') // resolveOutbound 抛错 → 行内降级为「解析不可用」
  assert.match(rig.replies.at(-1).text, /解析不可用/)
  await rig.flush('扛住异常') // resolveInbound 抛错 → 回落旧链（latest）照常投递
  assert.equal(agent.calls.followup.length, 1)
  rig.dispose()
})

test('杂项：/agent use 缺参用法提示、未知子命令提示、back 无绑定回执、/route 无目标会话', () => {
  const rig = makeRig({ agents: [] }) // 无会话：入站解析无目标
  rig.userSays('/agent use')
  assert.match(rig.replies.at(-1).text, /用法：\/agent use/)
  rig.userSays('/agent show')
  assert.match(rig.replies.at(-1).text, /用法：\/agent/)
  rig.userSays('/agent back')
  assert.match(rig.replies.at(-1).text, /当前没有显式绑定/)
  rig.userSays('/route')
  const text = rig.replies.at(-1).text
  assert.match(text, /【出站】/)
  assert.match(text, /当前无目标会话/)
  assert.match(text, /目标：（无）/)
  assert.match(text, /通道默认 agent（telegram）：未配置/)
  rig.dispose()
})

test('mergeWindowMs: 0 = 关闭合并（README 契约回归）：每条消息立即同步投递，不等窗口', async () => {
  const agent = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  // rig 默认 20ms 合并窗；本用例显式传 0 —— v0.3.2 之前 `Number(0) || 1500` 会把 0 吞掉，
  // 导致「关闭合并」承诺失效（消息被并窗延迟 1.5s）。修复后 0 可达立即投递分支。
  const rig = makeRig({ agents: [agent], config: { mergeWindowMs: 0 } })
  rig.fire('agent/created', agent)
  rig.userSays('第一条')
  rig.userSays('第二条') // 0 窗口下不允许合并：两条各自成一条投递
  assert.equal(agent.calls.followup.length, 2, '两条消息应各自立即投递（无合并）')
  assert.equal(agent.calls.followup[0].content[0].text, '第一条')
  assert.equal(agent.calls.followup[1].content[0].text, '第二条')
  await sleep(FLUSH_MS) // 等满一个旧默认窗口，确认没有迟到的第三次投递
  assert.equal(agent.calls.followup.length, 2, '不应有窗口到期后的追加投递')
  rig.dispose()
})

// ---------------------------------------------------------------- v0.5 特性 C：/quiet /unquiet

test('/quiet <workspace>：写入会话级 quiet 覆盖，resolveOutbound 立即生效，回执带匹配来源', () => {
  const alpha = makeAgent(ALPHA_1, 'running', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [alpha] })
  rig.fire('agent/created', alpha)
  assert.equal(rig.router.resolveOutbound(alpha.id, 'alpha', ['telegram']).quiet, false)

  rig.userSays('/quiet alpha')
  const reply = rig.replies.at(-1).text
  assert.match(reply, /已静默 alpha \/ [0-9a-f-]+（workspace=alpha）的出站推送/)
  assert.match(reply, /远程审批与对话不受影响/)
  const resolved = rig.router.resolveOutbound(alpha.id, 'alpha', ['telegram'])
  assert.equal(resolved.quiet, true, '会话级 quiet 覆盖写入 route:sessions diff')
  rig.dispose()
})

test('/unquiet <sid>：显式 false 覆盖上游 agent 级静默（不回落），回执确认恢复', () => {
  const alpha = makeAgent(ALPHA_1, 'running', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [alpha] })
  rig.fire('agent/created', alpha)
  rig.router.setAgentBinding('alpha', { quiet: true }) // 上游（agent 级）已静默
  assert.equal(rig.router.resolveOutbound(alpha.id, 'alpha', ['telegram']).quiet, true)

  rig.userSays(`/unquiet ${alpha.id}`)
  const reply = rig.replies.at(-1).text
  assert.match(reply, /已恢复 alpha \/ [0-9a-f-]+（sessionId 精确匹配）的出站推送/)
  assert.equal(rig.router.resolveOutbound(alpha.id, 'alpha', ['telegram']).quiet, false, '会话级显式 false 压过 agent 级 true')
  rig.dispose()
})

test('/quiet 目标解析：缺参出用法、未匹配出提示、多命中前缀列候选', () => {
  const one = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const two = makeAgent(ALPHA_2, 'idle', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [one, two] })
  rig.fire('agent/created', one)
  rig.fire('agent/created', two)

  rig.userSays('/quiet')
  assert.match(rig.replies.at(-1).text, /用法：\/quiet <workspace 名/)
  rig.userSays('/quiet nosuch')
  assert.match(rig.replies.at(-1).text, /未匹配到会话 nosuch/)
  rig.userSays('/unquiet aaaaaaaa') // 8 位前缀同时命中 ALPHA_1/ALPHA_2
  const reply = rig.replies.at(-1).text
  assert.match(reply, /前缀 aaaaaaaa 命中 2 个活跃会话/)
  assert.ok(reply.includes(one.id) && reply.includes(two.id), '候选列出完整 sid 供精确指定')
  rig.dispose()
})

test('/quiet 降级：router 缺省时给出不可用提示（同 /route 惯例），不当普通文本投递', () => {
  const agent = makeAgent(ALPHA_1, 'idle', '/home/u/proj/alpha')
  const rig = makeRig({ agents: [agent], router: null })
  rig.fire('agent/created', agent)

  rig.userSays('/quiet alpha')
  assert.match(rig.replies.at(-1).text, /路由引擎未装配.*\/quiet 暂不可用/)
  rig.dispose()
})

test('/help 文案补全：/quiet /unquiet 两行与状态上报说明一行', () => {
  const rig = makeRig()
  rig.userSays('/help')
  const text = rig.replies.at(-1).text
  assert.match(text, /\/quiet <workspace\|sid> — 静默该会话的出站推送/)
  assert.match(text, /\/unquiet <workspace\|sid> — 恢复该会话的出站推送/)
  assert.match(text, /长任务自动心跳（默认 15min 起）与疑似卡住提醒（默认 10min 无事件）/)
  rig.dispose()
})
