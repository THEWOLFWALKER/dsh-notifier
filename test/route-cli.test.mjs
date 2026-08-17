// v0.3.2 测试：scripts/route.mjs 路由 CLI（show / set / default / test 四命令面）。
// 与 channel-login.test.mjs 同约定：import CLI 导出的可测函数（runRouteCli / parseArgs /
// buildContext），不 spawn 子进程；store 用真实 createStore + node:fs mkdtemp 临时目录，
// 测后清理。CLI 装配契约对照脚本头部注释：router.agentsList 注入 registry 近似活跃集。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parseArgs, buildContext, runRouteCli, USAGE } from '../scripts/route.mjs'
import { createStore } from '../src/inbound/store.mjs'

// 缺省路径隔离（R6 审查同源）：buildContext 无 --state 时走 defaultStateDir()，
// 会在真机 home 建 ~/.dsh/dsh-notifier/（污染用户目录）。整文件指向一次性空目录。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-notifier-route-home-'))

/** 完整 argv 形态（下标 2 起为命令，与 channel-login.mjs parseArgs 同约定）。 */
const argvOf = (...parts) => ['node', 'route.mjs', ...parts]

/** rig：临时 stateDir + 真实文件 store（t.after 里 cleanup）。 */
function makeRig() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-route-cli-'))
  const stateFile = join(dir, 'state.json')
  return { dir, stateFile, store: createStore(stateFile), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- usage / 参数解析（3）

test('usage：无参数 → 打印中文 usage，退出码 1（直接 node 运行安全）', () => {
  const result = runRouteCli(argvOf())
  assert.equal(result.code, 1)
  assert.equal(result.err, '')
  assert.ok(result.out.startsWith('用法：node scripts/route.mjs'))
  assert.match(result.out, /show \[key\]/)
  assert.match(result.out, /set <key> \[--channels a,b\]/)
  assert.match(result.out, /default <channel> <agentKey>/)
  assert.match(result.out, /test <sessionId>/)
})

test('usage：未知命令 → usage + 中文错误，退出码 1；--help 退出码 0', () => {
  const unknown = runRouteCli(argvOf('frobnicate'))
  assert.equal(unknown.code, 1)
  assert.match(unknown.err, /未知命令 "frobnicate"/)
  assert.match(unknown.out, /用法：/)
  const help = runRouteCli(argvOf('--help'))
  assert.equal(help.code, 0)
  assert.equal(help.out, USAGE)
})

test('parseArgs：位置参数 / 布尔开关 / --channels 空串与缺省可区分 / --state', () => {
  const args = parseArgs(argvOf('set', 'proj-a', '--channels', '', '--no-quiet', '--state', '/tmp/x'))
  assert.equal(args.command, 'set')
  assert.deepEqual(args.positionals, ['proj-a'])
  assert.equal(args.channels, '', '--channels "" 是显式空串（= 显式空集），不是「未提供」')
  assert.equal(args.quiet, false)
  assert.equal(args.state, '/tmp/x')
  const bare = parseArgs(argvOf('show'))
  assert.equal(bare.channels, undefined, '未给 --channels 时保持 undefined（字段级不动）')
  assert.equal(bare.quiet, undefined)
  assert.equal(bare.reset, false)
})

// ---------------------------------------------------------------- show（3）

test('show 空态：三张表均提示空，退出码 0，并注明活跃判定为注册表近似', (t) => {
  const rig = makeRig()
  t.after(rig.cleanup)
  const result = runRouteCli(argvOf('show'), { store: rig.store })
  assert.equal(result.code, 0)
  assert.equal(result.err, '')
  assert.match(result.out, /== agent 绑定（route:agents）==/)
  assert.match(result.out, /尚无 agent 绑定/)
  assert.match(result.out, /== 通道默认 agent（route:channels）==/)
  assert.match(result.out, /尚无通道默认 agent/)
  assert.match(result.out, /== 会话台账（route:sessions）==/)
  assert.match(result.out, /尚无会话记录/)
  assert.match(result.out, /活跃判定为注册表近似/)
})

test('show 有数据：三张表全量渲染（键/渠道/quiet、通道默认、sid 前缀 + ISO + disposed 标记）', (t) => {
  const rig = makeRig()
  t.after(rig.cleanup)
  rig.store.set('route:agents', { 'proj-a': { channels: ['telegram', 'bark'], quiet: true } })
  rig.store.set('route:channels', { telegram: { defaultAgent: 'proj-a' } })
  rig.store.set('route:sessions', {
    'aaaaaaaa-1111': { inherit: 'proj-a', workspace: 'proj-a', createdAt: 1, lastActiveAt: Date.UTC(2025, 0, 1) },
    'bbbbbbbb-2222': { inherit: 'proj-b', workspace: 'proj-b', createdAt: 1, lastActiveAt: Date.UTC(2025, 0, 2), disposedAt: Date.UTC(2025, 0, 3) },
  })

  const result = runRouteCli(argvOf('show'), { store: rig.store })
  assert.equal(result.code, 0)
  // route:agents
  assert.match(result.out, /proj-a  channels=\[telegram, bark\]  quiet=true/)
  // route:channels
  assert.match(result.out, /telegram → proj-a/)
  // 会话台账：sid 前缀 + workspace/inherit + lastActiveAt ISO + disposed 标记 + 活跃计数（近似）
  assert.match(result.out, /sid=aaaaaaaa…  workspace=proj-a  inherit=proj-a  lastActiveAt=2025-01-01T00:00:00\.000Z$/m)
  assert.match(result.out, /sid=bbbbbbbb… .*lastActiveAt=2025-01-02T00:00:00\.000Z  \[已 dispose\]/)
  assert.match(result.out, /共 2 条，其中约 1 条活跃/)
  // lastActiveAt 降序：bbbb（01-02）排在 aaaa（01-01）之前
  assert.ok(result.out.indexOf('bbbbbbbb') < result.out.indexOf('aaaaaaaa'))
  assert.match(result.out, /注册表近似/)
})

test('show 带 key：只显示该 agent 条目（其他键不出现在输出；无条目也有提示）', (t) => {
  const rig = makeRig()
  t.after(rig.cleanup)
  rig.store.set('route:agents', {
    'proj-a': { channels: ['bark'] },
    'proj-b': { quiet: true },
  })
  const result = runRouteCli(argvOf('show', 'proj-a'), { store: rig.store })
  assert.equal(result.code, 0)
  assert.match(result.out, /仅 key=proj-a/)
  assert.match(result.out, /channels=\[bark\]/)
  assert.doesNotMatch(result.out, /proj-b/)
  assert.doesNotMatch(result.out, /route:channels/) // 带 key 不再打印三张表全量

  const missing = runRouteCli(argvOf('show', 'nope'), { store: rig.store })
  assert.equal(missing.code, 0)
  assert.match(missing.out, /键 "nope" 无绑定条目/)
})

// ---------------------------------------------------------------- set（5）

test('set --channels + --quiet：写入成功，另开 store 从盘上读回字段级结果', (t) => {
  const rig = makeRig()
  t.after(rig.cleanup)
  const result = runRouteCli(argvOf('set', 'proj-a', '--channels', 'telegram,bark', '--quiet'), { store: rig.store })
  assert.equal(result.code, 0)
  assert.match(result.out, /已更新 agent 绑定：proj-a/)
  assert.match(result.out, /channels=\[telegram, bark\]  quiet=true/)
  // 盘上事实：模拟另一次 CLI 进程重新加载 state.json
  const reloaded = createStore(rig.stateFile)
  assert.deepEqual(reloaded.get('route:agents'), { 'proj-a': { channels: ['telegram', 'bark'], quiet: true } })
})

test('set --channels ""：显式空集落盘（该键出站全静默），区别于未设置字段', (t) => {
  const rig = makeRig()
  t.after(rig.cleanup)
  const result = runRouteCli(argvOf('set', 'proj-b', '--channels', ''), { store: rig.store })
  assert.equal(result.code, 0)
  assert.deepEqual(rig.store.get('route:agents'), { 'proj-b': { channels: [] } })
  assert.match(result.out, /显式空集=该键出站全静默/)
  // resolveOutbound 视角：显式空集命中 agent 条目层（不回落全局池）
  const show = runRouteCli(argvOf('show', 'proj-b'), { store: rig.store })
  assert.match(show.out, /channels=\[\]（显式空集=该键出站全静默）/)
})

test('set --reset：整条删除（回落全局渠道池）；条目不存在时安全无操作', (t) => {
  const rig = makeRig()
  t.after(rig.cleanup)
  runRouteCli(argvOf('set', 'proj-c', '--channels', 'bark'), { store: rig.store })
  const result = runRouteCli(argvOf('set', 'proj-c', '--reset'), { store: rig.store })
  assert.equal(result.code, 0)
  assert.match(result.out, /已删除 agent 绑定：proj-c/)
  assert.deepEqual(rig.store.get('route:agents'), {})
  const again = runRouteCli(argvOf('set', 'proj-c', '--reset'), { store: rig.store })
  assert.equal(again.code, 0)
  assert.match(again.out, /无绑定条目，无需删除/)
})

test('set 非法渠道类型（不在 CHANNEL_TYPES）：中文报错退出码 1，不落盘', (t) => {
  const rig = makeRig()
  t.after(rig.cleanup)
  const result = runRouteCli(argvOf('set', 'proj-a', '--channels', 'telegram,nope'), { store: rig.store })
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /非法渠道类型：nope/)
  assert.match(result.err, /（可用：telegram\//) // 提示里带全量可用类型
  assert.equal(rig.store.get('route:agents'), undefined, '校验失败绝不写半截数据')
})

test('set：setAgentBinding 的 TypeError 透传为中文错误退出码 1（key 全空白触发契约校验）', (t) => {
  const rig = makeRig()
  t.after(rig.cleanup)
  const result = runRouteCli(argvOf('set', '   ', '--quiet'), { store: rig.store })
  assert.equal(result.code, 1)
  assert.match(result.err, /参数错误（未写入）/)
  assert.match(result.err, /key 必须是非空字符串/)
  assert.equal(rig.store.get('route:agents'), undefined, '契约违规不落盘')
  // set 缺 key：用法级中文提示
  const noKey = runRouteCli(argvOf('set'), { store: rig.store })
  assert.equal(noKey.code, 1)
  assert.match(noKey.err, /set 用法：/)
})

// ---------------------------------------------------------------- default（1）

test('default：写通道默认 agent 与 --clear 清除；缺 agentKey 且未 --clear 时退出码 1', (t) => {
  const rig = makeRig()
  t.after(rig.cleanup)
  const write = runRouteCli(argvOf('default', 'telegram', 'proj-a'), { store: rig.store })
  assert.equal(write.code, 0)
  assert.match(write.out, /已设置通道默认 agent：telegram → proj-a/)
  assert.deepEqual(rig.store.get('route:channels'), { telegram: { defaultAgent: 'proj-a' } })

  const clear = runRouteCli(argvOf('default', 'telegram', '--clear'), { store: rig.store })
  assert.equal(clear.code, 0)
  assert.match(clear.out, /已清除通道默认 agent：telegram/)
  assert.deepEqual(rig.store.get('route:channels'), {})
  const clearAgain = runRouteCli(argvOf('default', 'telegram', '--clear'), { store: rig.store })
  assert.equal(clearAgain.code, 0)
  assert.match(clearAgain.out, /未配置默认 agent，无需清除/)

  const misuse = runRouteCli(argvOf('default', 'telegram'), { store: rig.store })
  assert.equal(misuse.code, 1)
  assert.match(misuse.err, /缺少 <agentKey>/)
})

// ---------------------------------------------------------------- test（1）

test('test：打印 describe 解析链（含解析结果行）；workspace 缺省取台账快照，--workspace/--global 可覆盖', (t) => {
  const rig = makeRig()
  t.after(rig.cleanup)
  rig.store.set('route:sessions', {
    'sid-11111111': { inherit: 'proj-a', workspace: 'proj-a', createdAt: 1, lastActiveAt: 2 },
  })
  rig.store.set('route:agents', { 'proj-a': { channels: ['bark'] } })

  const result = runRouteCli(argvOf('test', 'sid-11111111'), { store: rig.store })
  assert.equal(result.code, 0)
  assert.match(result.out, /出站路由解析 session=sid-11111111 workspace=proj-a/)
  assert.match(result.out, /L3 workspace\s+route:agents\[proj-a\] → channels=\[bark\]/)
  assert.match(result.out, /解析结果 channelTypes=\[bark\] quiet=false source=agent-workspace/)
  assert.match(result.out, /宿主运行时按已启用渠道过滤/, '--global 缺省时注明过滤语义')

  const override = runRouteCli(
    argvOf('test', 'sid-11111111', '--workspace', 'other', '--global', 'bark,ntfy'),
    { store: rig.store },
  )
  assert.equal(override.code, 0)
  assert.match(override.out, /workspace=other/)
  assert.match(override.out, /解析结果 channelTypes=\[bark, ntfy\] quiet=false source=global/)
  assert.doesNotMatch(override.out, /宿主运行时按已启用渠道过滤/, '--global 显式给出时不再注缺省说明')

  const noSession = runRouteCli(argvOf('test', 'sid-unknown'), { store: rig.store })
  assert.equal(noSession.code, 0)
  assert.match(noSession.out, /session=sid-unknown workspace=$/m) // 台账无记录 → 快照空串
  assert.match(noSession.out, /本次解析值：""/)
})

// ---------------------------------------------------------------- --state（1）

test('--state 自定义目录：runRouteCli 自建 store，state.json 落在指定目录', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-route-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const result = runRouteCli(argvOf('set', 'proj-x', '--channels', 'bark', '--state', dir))
  assert.equal(result.code, 0)
  assert.equal(existsSync(join(dir, 'state.json')), true)
  const reloaded = createStore(join(dir, 'state.json'))
  assert.deepEqual(reloaded.get('route:agents'), { 'proj-x': { channels: ['bark'] } })

  // buildContext 的目录解析契约：--state → <dir>/state.json；缺省 → defaultStateDir()
  const ctx = buildContext(argvOf('show', '--state', dir))
  assert.equal(ctx.stateFile, resolve(dir, 'state.json'))
  assert.equal(ctx.stateDir, dir)
  ctx.registry.dispose()
  const defaulted = buildContext(argvOf('show'))
  assert.equal(defaulted.stateFile, resolve(defaulted.stateDir, 'state.json'))
  defaulted.registry.dispose()
})
