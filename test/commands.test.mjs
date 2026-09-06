// W3 命令解析矩阵（G-06/G-65）：注册面 parseCommand 的 @ 后缀、全角斜杠与附言契约。
// 矩阵逐形态断言：/cmd@botname、／cmd（全角）、/help 附言、非命令形态，以及
// bus 级 /pair@bot / ／pair 的真实核销链路（identity + pairing 全真件）。
// /stop 形态（G-04）与 /agent use（G-33）在 conversation*.test.mjs；裸编号形态
// （G-52/G-43）在 questions.test.mjs；渠道入站剥离在 inbound.*.test.mjs。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCommand, stripCommandMention, stripLeadingMention } from '../src/inbound/commands.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createPairing } from '../src/inbound/pairing.mjs'
import { createStore } from '../src/inbound/store.mjs'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-cmd-')), 'state.json')
}

const quiet = { warn() {}, debug() {} }

/** bus 级 rig：真实 identity/pairing/store + bus（注册面命令拦截链全真件）。 */
function makeRig() {
  const store = createStore(tempPath())
  const identity = createIdentity({ store, logger: quiet })
  const pairing = createPairing({ store, logger: quiet })
  const bus = createInboundBus({ identity, pairing, store, logger: quiet })
  const fellThrough = []
  bus.onMessage((envelope) => { fellThrough.push(envelope.text); return false })
  const accept = (text) => bus.accept({
    channel: 'telegram', userId: '42', chatId: '42', chatType: 'private',
    messageId: `m${Math.random()}`, text,
  })
  return { store, identity, pairing, bus, fellThrough, accept }
}

// ---------------------------------------------------------------- parseCommand 矩阵

test('G-06：/cmd@botname —— 命令词 @ 后缀贪心剥除，args 不含 @ 残片', () => {
  assert.deepEqual(parseCommand('/pair@bot code'), { name: 'pair', args: ['code'], raw: '/pair@bot code' })
  // 含点号/下划线的 botname（贪心 /@.+$/ 覆盖，不会只剥到第一个点）
  assert.deepEqual(parseCommand('/pair@My.Notifier_Bot code 备注'), { name: 'pair', args: ['code', '备注'], raw: '/pair@My.Notifier_Bot code 备注' })
  // 中文 bot 名（飞书还原语义产出的形态）同样剥除
  assert.equal(parseCommand('/pair@张三 code').name, 'pair')
  // 无参命令带后缀
  assert.deepEqual(parseCommand('/whoami@bot'), { name: 'whoami', args: [], raw: '/whoami@bot' })
  // 大小写归一不受 @ 剥除影响
  assert.equal(parseCommand('/PAIR@Bot code').name, 'pair')
  // 只有 @ 后缀（'/@bot'）剥完为空 → 非命令
  assert.equal(parseCommand('/@bot'), null)
})

test('G-06：@ 只在命令词上剥——正文里的 @ 与首 token 含路径的形态不误伤', () => {
  // 命令词之后的 args 原样保留（@ 残片只可能出现在命令词上）
  assert.deepEqual(parseCommand('/pair code @张三').args, ['code', '@张三'])
  // 首个 token 含 '/'（路径形态）：@ 后缀同样被贪心剥掉，但结果不是注册面命令，
  // bus 不消费、落回对话路由（既有语义不变）
  assert.equal(parseCommand('/etc/passwd@host x').name, 'etc/passwd')
  // 非斜杠开头 / 空文本 → 非命令
  assert.equal(parseCommand('@bot /pair code'), null)
  assert.equal(parseCommand(''), null)
  assert.equal(parseCommand(null), null)
})

test('G-65：全角斜杠 ／cmd 仅规范化首字符，等价 /cmd', () => {
  assert.deepEqual(parseCommand('／pair code'), { name: 'pair', args: ['code'], raw: '/pair code' })
  assert.equal(parseCommand('／whoami').name, 'whoami')
  // 句中全角斜杠是正文，不规范化（非斜杠开头 → 非命令）
  assert.equal(parseCommand('看这个／pair'), null)
  // 仅首字符：'／／pair' 只变第一个
  assert.equal(parseCommand('／／pair').name, '／pair')
})

test('G-65：/help 附言——解析成功不吞附言，附言留在 args 内交给处理器', () => {
  const parsed = parseCommand('/help 附言')
  assert.equal(parsed.name, 'help')
  assert.deepEqual(parsed.args, ['附言'], '附言必须原样进 args（解析成功 ≠ 整条只剩命令词）')
  assert.deepEqual(parseCommand('/pair code 备注').args, ['code', '备注'])
  // 多段附言保持分词形态（处理器自行 join）
  assert.deepEqual(parseCommand('/pair code 我的 备注').args, ['code', '我的', '备注'])
})

// ---------------------------------------------------------------- bus 级核销链路

test('G-06 bus 级：/pair@bot <码> 真实核销——码面不含 @ 残片，绑定成功', () => {
  const rig = makeRig()
  const minted = rig.pairing.mint({ origin: 'admin', mintedBy: 'boss' })
  const result = rig.accept(`/pair@MyNotifierBot ${minted.code}`)
  assert.equal(result.ok, true)
  assert.match(result.reply, /配对成功/)
  assert.equal(rig.identity.allows('telegram', '42'), true, '码面被干净地当作 args[0] 核销')
  assert.deepEqual(rig.fellThrough, [], '注册面命令被消费，不落回对话路由')
})

test('G-65 bus 级：／pair <码> 等价 /pair（全角斜杠不再漏进对话路由）', () => {
  const rig = makeRig()
  const minted = rig.pairing.mint({ origin: 'admin', mintedBy: 'boss' })
  const result = rig.accept(`／pair ${minted.code}`)
  assert.equal(result.ok, true)
  assert.match(result.reply, /配对成功/)
  assert.equal(rig.identity.allows('telegram', '42'), true)
  assert.deepEqual(rig.fellThrough, [], '全角命令在注册面被消费（旧行为：parseCommand 返回 null 漏进对话路由）')
})

test('G-65 bus 级：引导态 ／help 等价 /help（引导回执可达）', () => {
  const rig = makeRig()
  const result = rig.accept('／help')
  assert.equal(result.ok, true)
  assert.match(result.reply, /引导模式/)
})

test('矩阵边界：/stopwatch 不是 /stop；非注册面斜杠消息落回对话路由', () => {
  const rig = makeRig()
  // /stopwatch 解析为独立命令名（不因前缀撞车被当成 stop）
  assert.equal(parseCommand('/stopwatch').name, 'stopwatch')
  assert.notEqual(parseCommand('/stopwatch').name, 'stop')
  // 绑定成员发非注册面命令：bus 不消费，落回扇出（由会话路由按普通文本处理）
  rig.identity.addBinding({ channel: 'telegram', userId: '42' })
  const result = rig.accept('/stopwatch')
  assert.equal(result.reply, undefined)
  assert.deepEqual(rig.fellThrough, ['/stopwatch'], '未知命令落回扇出（由会话路由按普通文本处理）')
})

// ------------------------------------------------- adapter 入站 @ 剥离（G-06 配套）

test('stripCommandMention：TG 群聊命令词 @ 后缀剥除矩阵', () => {
  assert.equal(stripCommandMention('/pair@MyNotifierBot ABCD-1234'), '/pair ABCD-1234', '码面不含 @ 残片')
  assert.equal(stripCommandMention('/status@My.Notifier_Bot'), '/status', '含点号 botname 贪心剥除')
  assert.equal(stripCommandMention('/pair@张三 code'), '/pair code', '中文 bot 名')
  assert.equal(stripCommandMention('  /stop@bot  '), '/stop', '首尾空白一并归一')
  // 不该剥的形态
  assert.equal(stripCommandMention('/status'), '/status')
  assert.equal(stripCommandMention('看这个 /etc/passwd@host 一下'), '看这个 /etc/passwd@host 一下', '正文里的 @ 不动')
  assert.equal(stripCommandMention('/@bot code'), '/@bot code', '命令词剥完为空 → 保留原文交 parseCommand 判非命令')
  assert.equal(stripCommandMention(''), '')
  assert.equal(stripCommandMention(null), '')
  // 与 parseCommand 的命令名一致性：剥后同名
  assert.equal(parseCommand(stripCommandMention('/pair@bot code')).name, 'pair')
})

test('stripLeadingMention：钉钉行首 @提及剥除矩阵', () => {
  assert.equal(stripLeadingMention('@我的机器人 /status 跑一下'), '/status 跑一下')
  assert.equal(stripLeadingMention('@机器人 /pair@bot ABCD-1234'), '/pair@bot ABCD-1234', '命令词后缀由 stripCommandMention 二次处理')
  assert.equal(stripLeadingMention('@我的机器人'), '', '纯提及无正文 → 空串（调用方按空消息处理）')
  assert.equal(stripLeadingMention('  @机器人  你好'), '你好', '前导空白容忍')
  // 不该剥的形态
  assert.equal(stripLeadingMention('帮我看下 @同事 的排期'), '帮我看下 @同事 的排期', '正文中间的 @ 不动')
  assert.equal(stripLeadingMention('@ 大家好'), '@ 大家好', "'@' 后紧跟空白（无名字）不是提及")
  assert.equal(stripLeadingMention('普通文本'), '普通文本')
  assert.equal(stripLeadingMention(''), '')
  // 已知取舍：整条单个 '@词'（无任何空白）按纯提及剥空——行首 @词 本就无法与提及区分
  assert.equal(stripLeadingMention('@x/y是个路径'), '')
})
