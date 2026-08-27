// 维护批 3 阶段 1：出站凭证 overlay 抽出模块的纯装配测试（模块边界直击）。
// composeOutboundChannels/accountOf 从 apply() 原样搬出（行为零变的契约锚由
// test/admin-wiring.test.mjs 的 5 例 apply() 级 overlay 测试继续兜底）。
// 约定：channels 条目是已 resolve 的 {type, config}；yamlRows 行是 YAML 原始行（含 type 字段）。
// 覆盖这里 apply 级测不到的角度：admin 关闭透传引用同一性（数组级）、双域永不过 overlay、
// mergedRowOf 优先级、防御读取（数组/标量/损坏 store）、resolve 失败降级 warn。

import test from 'node:test'
import assert from 'node:assert/strict'
import { composeOutboundChannels, accountOf, DUAL_INBOUND_DOMAIN_TYPES } from '../src/assembly/outbound.mjs'
import { CHANNEL_TYPES } from '../src/config.mjs'

/** store 桩：Map 兜底。 */
function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial))
  return { get: (key) => data.get(key) }
}

// YAML 原始行（resolve 前，含 type 字段）
const YAML_WEBHOOK = { type: 'webhook', url: 'http://yaml/hook', timeoutMs: 9000 }
const YAML_BARK = { type: 'bark', key: 'yaml-key', timeoutMs: 7000 }
// 已 resolve 的 channels 条目（照 apply() resolved.channels 形状）
const CH_WEBHOOK = { type: 'webhook', config: { method: 'POST', url: 'http://yaml/hook' } }
const CH_BARK_YAML = { type: 'bark', config: { endpoint: 'https://api.day.app/yaml-key', timeoutMs: 7000 } }
const CH_FEISHU = { type: 'feishu', config: { webhook: 'https://open.feishu.cn/hook/yaml' } }
const CH_DINGTALK = { type: 'dingtalk', config: { webhook: 'https://oapi.dingtalk.com/yaml' } }

test('模块契约：accountOf 防御读取——非普通对象一律无账号（含损坏/crash）', () => {
  const good = fakeStore({ 'bark:account': { key: 'k' } })
  assert.deepEqual(accountOf(good, 'bark:account'), { key: 'k' })
  assert.equal(accountOf(good, 'missing:account'), null)
  assert.equal(accountOf(fakeStore({ 'x:account': [1, 2] }), 'x:account'), null, '数组不算账号')
  assert.equal(accountOf(fakeStore({ 'x:account': 'scalar' }), 'x:account'), null, '标量不算账号')
  assert.equal(accountOf(fakeStore({ 'x:account': null }), 'x:account'), null)
  const brokenStore = { get: () => { throw new Error('store corrupt') } }
  assert.equal(accountOf(brokenStore, 'x:account'), null, 'store 抛错不炸装配')
})

test('admin 关闭 → channels 透传引用同一性，merge 零执行；testRawConfigOf 回落 YAML 行', () => {
  const channelsIn = [CH_WEBHOOK, CH_BARK_YAML]
  const yamlRows = new Map([['webhook', YAML_WEBHOOK], ['bark', YAML_BARK]])
  const { channels, testRawConfigOf } = composeOutboundChannels({
    channels: channelsIn,
    yamlRows,
    store: fakeStore({ 'bark:account': { key: 'store-key' } }), // admin 关 → 必须忽略
    adminEnabled: false,
    warn: () => { throw new Error('admin 关不得 warn') },
  })
  assert.equal(channels, channelsIn, '数组引用同一性（assembly 零动）')
  assert.deepEqual(channels, channelsIn)
  assert.deepEqual(testRawConfigOf('bark'), { key: 'yaml-key', timeoutMs: 7000 }, '无 merged 行回落 YAML（且丢 type 字段）')
  assert.deepEqual(testRawConfigOf('webhook'), { url: 'http://yaml/hook', timeoutMs: 9000 })
  assert.equal(testRawConfigOf('nope'), null)
})

test('admin 开启 + store 账号 → store 字段覆盖同名 YAML 字段、YAML 独有字段保留、只读 store', () => {
  const warns = []
  const yamlRows = new Map([['bark', YAML_BARK]])
  const { channels, testRawConfigOf } = composeOutboundChannels({
    channels: [CH_BARK_YAML],
    yamlRows,
    store: fakeStore({ 'bark:account': { key: 'store-key' } }),
    adminEnabled: true,
    warn: (msg) => warns.push(msg),
  })
  assert.deepEqual(channels.map((entry) => entry.type), ['bark'])
  assert.equal(channels[0].config.endpoint, 'https://api.day.app/store-key', 'store.key 覆盖 YAML.key')
  assert.equal(channels[0].config.timeoutMs, 7000, 'YAML 独有字段保留')
  assert.deepEqual(testRawConfigOf('bark'), { key: 'store-key', timeoutMs: 7000 }, 'merged 行优先且去掉 type 字段')
  assert.equal(warns.length, 0)
})

test('resolve 失败：YAML 条目原样保留 + warn；store-only 且凭证不完整 → 跳过 + warn', () => {
  const warns = []
  const yamlRows = new Map([['bark', YAML_BARK]])
  const { channels } = composeOutboundChannels({
    channels: [CH_BARK_YAML],
    yamlRows,
    store: fakeStore({ 'bark:account': { key: '' } }), // 空 key → merged resolve 失败
    adminEnabled: true,
    warn: (msg) => warns.push(msg),
  })
  assert.equal(channels.length, 1)
  assert.equal(channels[0].config.endpoint, 'https://api.day.app/yaml-key', '失败后 YAML 原样保留')
  assert.ok(warns.some((w) => /沿用 YAML 配置/.test(w)))

  const warns2 = []
  const { channels: ch2 } = composeOutboundChannels({
    channels: [CH_WEBHOOK],
    yamlRows: new Map([['webhook', YAML_WEBHOOK]]),
    store: fakeStore({ 'bark:account': { device: 'x' } }), // 无 key、无 YAML 兜底
    adminEnabled: true,
    warn: (msg) => warns2.push(msg),
  })
  assert.equal(ch2.find((entry) => entry.type === 'bark'), undefined, 'store-only 凭证不完整 → 暂不启用')
  assert.ok(warns2.some((w) => /bark.*跳过（state 凭证不完整）/.test(w)))
})

test('双域类型（feishu/dingtalk）永不过 overlay：入站账号不得混入出站（即使 admin 开启）', () => {
  const warns = []
  const yamlRows = new Map([
    ['feishu', { type: 'feishu', webhook: 'https://open.feishu.cn/hook/yaml' }],
    ['dingtalk', { type: 'dingtalk', webhook: 'https://oapi.dingtalk.com/yaml' }],
  ])
  const channelsIn = [CH_FEISHU, CH_DINGTALK]
  const { channels } = composeOutboundChannels({
    channels: channelsIn,
    yamlRows,
    store: fakeStore({
      'feishu:account': { appSecret: 'leak' },
      'dingtalk:account': { appSecret: 'leak' },
    }),
    adminEnabled: true,
    warn: (msg) => warns.push(msg),
  })
  assert.ok(DUAL_INBOUND_DOMAIN_TYPES.has('feishu') && DUAL_INBOUND_DOMAIN_TYPES.has('dingtalk'))
  assert.deepEqual(channels, channelsIn, '双域原样透传')
  for (const ch of channels) {
    assert.equal(ch.config.appSecret, undefined, `${ch.type} 入站凭证不得混入出站 config`)
  }
  assert.equal(warns.length, 0, '双域不应触发出站回退 warn')
})

test('overlay 只扫 CHANNEL_TYPES 全量非双域，且与 DUAL_INBOUND_DOMAIN_TYPES 互补', () => {
  const overlap = CHANNEL_TYPES.filter((type) => DUAL_INBOUND_DOMAIN_TYPES.has(type))
  assert.deepEqual(overlap.sort(), ['dingtalk', 'feishu'], '双域都登记在 CHANNEL_TYPES 且被 overlay 跳过')
})

test('store-only 新类型追加尾部、旧类型依序保持首见顺序（Map 去重）', () => {
  const yamlRows = new Map([['bark', YAML_BARK]])
  const { channels } = composeOutboundChannels({
    channels: [CH_WEBHOOK, CH_BARK_YAML],
    yamlRows,
    store: fakeStore({ 'bark:account': { key: 'store-key' } }),
    adminEnabled: true,
    warn: () => {},
  })
  assert.deepEqual(channels.map((entry) => entry.type), ['webhook', 'bark'])
  assert.equal(channels[1].config.endpoint, 'https://api.day.app/store-key', 'bark 被 merged 版本替换')
})