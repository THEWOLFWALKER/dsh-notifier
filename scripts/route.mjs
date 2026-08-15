#!/usr/bin/env node
// dsh-notifier scripts/route.mjs
// v0.3.2 路由 CLI（设计稿 §7）：route:agents / route:channels / route:sessions 三张表的
// 查看与写入 + 出站解析链排障。结构与 scripts/channel-login.mjs 同约定：导出可测函数
// （parseArgs / buildContext / runRouteCli）+ main 入口（import.meta.url 守卫——本文件会被
// test/route-cli.test.mjs import，直接 `node scripts/route.mjs` 无参数打印中文 usage 退出码 1）。
//
// 装配（设计稿 §0.5-2 / §3）：
//   store    = createStore(<stateDir>/state.json)，--state 可覆盖，缺省 defaultStateDir()
//   registry = createSessionRegistry({ store })——CLI 无宿主 ctx，activeSessions 回落
//              「注册表未 dispose 记录」；结束时 dispose() 释放
//   router   = createAgentRouter({ store, agentsList: registry.activeSessions 近似 })
//              宿主未运行时活跃判定是注册表近似，输出里注明。

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createStore, defaultStateDir } from '../src/inbound/store.mjs'
import { CHANNEL_TYPES } from '../src/config.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createSessionRegistry } from '../src/routing/session-registry.mjs'

export const USAGE = `用法：node scripts/route.mjs <命令> [参数] [--state <state目录>]

命令：
  show [key]                    查看路由三张表：agent 绑定 / 通道默认 agent / 会话台账
                                （带 key 时只显示该 agent 条目）
  set <key> [--channels a,b] [--quiet|--no-quiet] [--reset]
                                写 agent 绑定（key = workspace 名或精确 agentId，字段级更新：
                                只改出现的字段，未给的不动）
                                  --channels a,b      出站渠道集合（逗号分隔）；
                                                      '' = 显式空集 = 该键出站全静默
                                  --quiet / --no-quiet 静音开关（true 只静音出站推送，仍写账本）
                                  --reset             删除整条绑定（出站回落全局渠道池）
  default <channel> <agentKey>  设置通道默认 agent（入站默认去向；channel = 通道类型，
                                agentKey = workspace 名或精确 agentId）
  default <channel> --clear     清除通道默认 agent
  test <sessionId> [--workspace <name>] [--global a,b,c]
                                打印出站解析链（L1 会话 diff → L2 精确条目 → L3 workspace
                                → L4 全局池）；workspace 缺省取会话台账快照，
                                --global 缺省为全量渠道类型，宿主运行时按已启用渠道过滤

通用：
  --state <state目录>           state 目录（默认 $DSH_HOME/dsh-notifier，与插件一致）
  --help                        显示本帮助

退出码：0 成功；1 参数/配置错误`

/** 取「普通对象」：null/数组/标量视为无条目（与 agent-router 同规则，state 手工编辑防御）。 */
function plainObjectOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

/** 逗号分隔串 → trim 去空数组（不去重——去重交给 setAgentBinding 归一）。 */
function splitList(raw) {
  return String(raw ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')
}

/** 毫秒时间戳 → ISO 字符串；缺失/非法返回 '(未知)'。 */
function isoOf(value) {
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '(未知)'
}

/** sid 前缀展示（默认前 8 字符，过短原样），保持输出可读。 */
function sidPrefix(id, length = 8) {
  return id.length > length ? `${id.slice(0, length)}…` : id
}

/** agent 绑定条目 → 单行可读文本。 */
function formatEntry(entry) {
  const channels = Array.isArray(entry.channels)
    ? `channels=[${entry.channels.join(', ')}]${entry.channels.length === 0 ? '（显式空集=该键出站全静默）' : ''}`
    : 'channels=(未设置→回落全局渠道池)'
  const quiet = entry.quiet === undefined ? 'quiet=(未设置→false)' : `quiet=${entry.quiet}`
  return `${channels}  ${quiet}`
}

/**
 * CLI 参数解析（argv 含 node 与脚本路径，从下标 2 起，与 channel-login.mjs 同约定）。
 * 字段级语义：channels/workspace/global 的 undefined = 未提供；--channels '' = 显式空串
 * （set 语义为显式空集，test/workspace 的 '' 视同未提供，由命令层各自解释）。
 */
export function parseArgs(argv = []) {
  const args = {
    command: '',
    positionals: [],
    state: '',
    channels: undefined,
    quiet: undefined,
    reset: false,
    clear: false,
    workspace: undefined,
    global: undefined,
    help: false,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--state') args.state = argv[++i] ?? ''
    else if (arg === '--channels') args.channels = argv[++i] ?? ''
    else if (arg === '--quiet') args.quiet = true
    else if (arg === '--no-quiet') args.quiet = false
    else if (arg === '--reset') args.reset = true
    else if (arg === '--clear') args.clear = true
    else if (arg === '--workspace') args.workspace = argv[++i] ?? ''
    else if (arg === '--global') args.global = argv[++i] ?? ''
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (!arg.startsWith('--') && arg !== '') {
      if (args.command === '') args.command = arg
      else args.positionals.push(arg)
    }
  }
  return args
}

/**
 * 组装 CLI 上下文：store（注入优先，否则 <stateDir>/state.json）+ registry + router。
 * router.agentsList 注入 registry 近似活跃集——宿主未运行时的活跃判定是注册表近似
 * （无 ctx 时 activeSessions 回落台账未 dispose 记录），show 输出注明。
 */
export function buildContext(argv = [], { store, channelTypes = CHANNEL_TYPES } = {}) {
  const args = parseArgs(argv)
  const stateDir = args.state !== '' ? args.state : defaultStateDir()
  const stateFile = resolve(stateDir, 'state.json')
  const theStore = store ?? createStore(stateFile)
  const registry = createSessionRegistry({ store: theStore })
  const router = createAgentRouter({
    store: theStore,
    agentsList: () => registry.activeSessions().map((id) => ({ id })),
  })
  return { args, channelTypes, stateDir, stateFile, store: theStore, registry, router }
}

// ---------------------------------------------------------------- 命令实现

function cmdShow(ctx, log) {
  const { args, router, registry, store } = ctx
  const key = args.positionals[0]

  if (key !== undefined) {
    log(`== agent 绑定（route:agents，仅 key=${key}）==`)
    const entry = router.getAgentBinding(key)
    log(entry === null ? `  （键 "${key}" 无绑定条目）` : `  ${key}  ${formatEntry(entry)}`)
    return 0
  }

  const keys = router.listAgentKeys()
  log('== agent 绑定（route:agents）==')
  if (keys.length === 0) log('  （尚无 agent 绑定；出站回落全局渠道池）')
  for (const agentKey of keys) log(`  ${agentKey}  ${formatEntry(router.getAgentBinding(agentKey) ?? {})}`)

  log('== 通道默认 agent（route:channels）==')
  const defaults = Object.entries(plainObjectOf(store.get('route:channels')) ?? {})
    .map(([channel, entry]) => [channel, plainObjectOf(entry)?.defaultAgent])
    .filter(([, agent]) => typeof agent === 'string' && agent !== '')
  if (defaults.length === 0) log('  （尚无通道默认 agent；入站按 bind > 唯一 agent > 最近活跃兜底）')
  for (const [channel, agent] of defaults) log(`  ${channel} → ${agent}`)

  log('== 会话台账（route:sessions）==')
  const sessions = Object.entries(plainObjectOf(store.get('route:sessions')) ?? {})
    .sort(([, a], [, b]) => Number(b?.lastActiveAt ?? 0) - Number(a?.lastActiveAt ?? 0))
  if (sessions.length === 0) log('  （尚无会话记录）')
  else log(`  共 ${sessions.length} 条，其中约 ${registry.activeSessions().length} 条活跃`)
  for (const [sid, record] of sessions) {
    const info = plainObjectOf(record) ?? {}
    const disposed = info.disposedAt !== undefined ? '  [已 dispose]' : ''
    log(`  sid=${sidPrefix(sid)}  workspace=${info.workspace || '(未知)'}  inherit=${info.inherit || '(未设置)'}`
      + `  lastActiveAt=${isoOf(info.lastActiveAt)}${disposed}`)
  }
  log('注：宿主未运行，活跃判定为注册表近似（台账中未 dispose 的记录），与宿主 ctx.agents.list() 可能不一致。')
  return 0
}

/** setter 的 TypeError 是调用方契约违规：转中文错误 + 退出码 1（不落盘）；其他异常原样上抛。 */
function handleSetterError(error, fail) {
  if (error instanceof TypeError) {
    fail(`参数错误（未写入）：${error.message}`)
    return 1
  }
  throw error
}

function cmdSet(ctx, log, fail) {
  const { args, router, channelTypes } = ctx
  const key = args.positionals[0]
  if (key === undefined) {
    fail('set 用法：node scripts/route.mjs set <key> [--channels a,b] [--quiet|--no-quiet] [--reset]')
    return 1
  }
  if (args.reset) {
    let removed = false
    try {
      removed = router.deleteAgentBinding(key)
    } catch (error) {
      return handleSetterError(error, fail)
    }
    log(removed ? `已删除 agent 绑定：${key}（出站回落全局渠道池）` : `键 "${key}" 无绑定条目，无需删除`)
    return 0
  }

  const patch = {}
  if (args.channels !== undefined) {
    const types = splitList(args.channels)
    const invalid = types.filter((type) => !channelTypes.includes(type))
    if (invalid.length > 0) {
      fail(`非法渠道类型：${invalid.join('、')}（可用：${channelTypes.join('/')}）`)
      return 1
    }
    patch.channels = types
  }
  if (args.quiet !== undefined) patch.quiet = args.quiet
  if (Object.keys(patch).length === 0) {
    fail('没有可写入的变更：至少给一个 --channels / --quiet / --no-quiet / --reset')
    return 1
  }

  try {
    if (!router.setAgentBinding(key, patch)) {
      fail('写入失败：state.json 持久化异常（检查目录权限/磁盘状态）')
      return 1
    }
  } catch (error) {
    return handleSetterError(error, fail)
  }
  log(`已更新 agent 绑定：${key}  ${formatEntry(router.getAgentBinding(key) ?? {})}`)
  return 0
}

function cmdDefault(ctx, log, fail) {
  const { args, router } = ctx
  const channel = args.positionals[0]
  const agentKey = args.positionals[1]
  if (channel === undefined) {
    fail('default 用法：node scripts/route.mjs default <channel> <agentKey> | default <channel> --clear')
    return 1
  }
  if (args.clear) {
    let cleared = false
    try {
      cleared = router.clearChannelDefault(channel)
    } catch (error) {
      return handleSetterError(error, fail)
    }
    log(cleared ? `已清除通道默认 agent：${channel}` : `通道 "${channel}" 未配置默认 agent，无需清除`)
    return 0
  }
  if (agentKey === undefined) {
    fail('default 缺少 <agentKey>（要清除请改用 --clear）')
    return 1
  }
  try {
    if (!router.setChannelDefault(channel, agentKey)) {
      fail('写入失败：state.json 持久化异常（检查目录权限/磁盘状态）')
      return 1
    }
  } catch (error) {
    return handleSetterError(error, fail)
  }
  log(`已设置通道默认 agent：${channel} → ${agentKey}`)
  return 0
}

function cmdTest(ctx, log, fail) {
  const { args, router, registry, channelTypes } = ctx
  const sessionId = args.positionals[0]
  if (sessionId === undefined) {
    fail('test 用法：node scripts/route.mjs test <sessionId> [--workspace <name>] [--global a,b,c]')
    return 1
  }
  const workspaceGiven = typeof args.workspace === 'string' && args.workspace !== ''
  const workspace = workspaceGiven ? args.workspace : registry.getSession(sessionId)?.workspace ?? ''
  const globalGiven = typeof args.global === 'string' && args.global !== ''
  const globalTypes = globalGiven ? splitList(args.global) : [...channelTypes]

  for (const line of router.describe(sessionId, workspace, globalTypes).split('\n')) log(line)
  if (!globalGiven) log('注：--global 缺省为全量渠道类型（CHANNEL_TYPES），宿主运行时按已启用渠道过滤。')
  if (!workspaceGiven) log(`注：workspace 缺省取会话台账快照（本次解析值：${JSON.stringify(workspace)}）。`)
  return 0
}

// ---------------------------------------------------------------- 分发与入口

function dispatch(ctx) {
  const out = []
  const err = []
  const log = (line = '') => out.push(line)
  const fail = (line = '') => err.push(line)
  const { command, help } = ctx.args

  if (help || command === '') {
    out.push(...USAGE.split('\n'))
    return { code: command === '' && !help ? 1 : 0, out: out.join('\n'), err: '' }
  }

  let code = 0
  if (command === 'show') code = cmdShow(ctx, log)
  else if (command === 'set') code = cmdSet(ctx, log, fail)
  else if (command === 'default') code = cmdDefault(ctx, log, fail)
  else if (command === 'test') code = cmdTest(ctx, log, fail)
  else {
    out.push(...USAGE.split('\n'))
    fail(`未知命令 "${command}"（可用：show / set / default / test）`)
    code = 1
  }
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/**
 * 执行一次 CLI 调用（可测入口）：解析 argv → 组装上下文 → 分发命令 → 释放 registry。
 * @param {string[]} argv - 完整 argv（含 node 与脚本路径，同 process.argv 形态）
 * @param {object} [options] - { store?: 注入 store（测试用），channelTypes?: 渠道白名单 }
 * @returns {{ code: number, out: string, err: string }} 退出码与 stdout/stderr 文本
 */
export function runRouteCli(argv = [], options = {}) {
  const ctx = buildContext(argv, options)
  try {
    return dispatch(ctx)
  } finally {
    ctx.registry.dispose()
  }
}

function main() {
  const { code, out, err } = runRouteCli(process.argv)
  if (out !== '') console.log(out)
  if (err !== '') console.error(err)
  return code
}

// 直接运行守卫：被 test 文件 import 时不执行 main；无参数直接运行打印 usage 退出码 1。
// CLI 全同步（store 读写均为 sync），main 同步返回退出码，无需 Promise 链。
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    process.exit(main())
  } catch (error) {
    console.error(`route CLI 异常退出：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  }
}
