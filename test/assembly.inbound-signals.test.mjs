// 维护批 3 阶段 3：入站通道 resolve/启用信号抽出模块的纯装配测试（模块边界直击）。
// resolveInboundSignals 从 apply() 原样搬出（行为零变的契约锚由 test/index.test.mjs、
// test/inbound.qq.test.mjs 等 apply() 级测试继续兜底）。覆盖这里 apply 级测不到的角度：
// tg 便捷回退链的每一种兜底次序、admin 关闭时 store 凭证零执行、双域 store 凭证启用信号、
// wxpusher 密径首铸落盘/复用、微信 wanted 信号只出不 resolve。

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveInboundSignals } from '../src/assembly/inbound-signals.mjs'

function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    get: (key) => (data.has(key) ? data.get(key) : undefined),
    set: (key, value) => data.set(key, value),
    raw: data,
  }
}

const RESOLVED_BARE = { channels: [] }

function call({ inboundRaw = {}, approvalRaw = {}, resolved = RESOLVED_BARE, store = fakeStore(), adminEnabled = false } = {}) {
  const warns = []
  const out = resolveInboundSignals({ inboundRaw, approvalRaw, resolved, store, adminEnabled, warn: (m) => warns.push(m) })
  return { ...out, warns }
}

test('空配置：allowUsers=[]，六信号全关，approvalWanted=false，零 warn', () => {
  const r = call()
  assert.deepEqual(r.allowUsers, [])
  assert.equal(r.inboundBotToken, '')
  assert.deepEqual(r.notifyChatIds, [])
  assert.equal(r.approvalWanted, false)
  assert.equal(r.feishuResolved, null)
  assert.equal(r.feishuOk, false)
  assert.equal(r.qqResolved, null)
  assert.equal(r.qqOk, false)
  assert.equal(r.dingtalkResolved, null)
  assert.equal(r.dingtalkOk, false)
  assert.equal(r.wxResolved, null)
  assert.equal(r.wxOk, false)
  assert.equal(r.wechatWanted, false)
  assert.deepEqual(r.wechatRaw, {})
  assert.equal(r.warns.length, 0)
})

test('allowUsers：trim + 去空串', () => {
  const r = call({ inboundRaw: { allowUsers: ['  a  ', ' b ', '', '   ', 42] } })
  assert.deepEqual(r.allowUsers, ['a', 'b', '42'])
})

test('tg 便捷回退链一：inbound 显式 > 出站渠道 > store 账号（botToken）；notifyChatIds 同链', () => {
  const store = fakeStore({ 'telegram:account': { botToken: 'store-bot', chatId: 'store-chat' } })
  const resolved = { channels: [{ type: 'telegram', config: { botToken: 'out-bot', chatId: 'out-chat' } }] }
  const r = call({ inboundRaw: { telegram: { botToken: '  in-bot  ', notifyChatIds: ['a', 'b'] } }, resolved, store, adminEnabled: true })
  assert.equal(r.inboundBotToken, 'in-bot', '显式优先（trim 后）')
  assert.deepEqual(r.notifyChatIds, ['a', 'b'])

  const r2 = call({ resolved, store: fakeStore(), adminEnabled: true })
  assert.equal(r2.inboundBotToken, 'out-bot', '无显式回落出站渠道')
  assert.deepEqual(r2.notifyChatIds, ['out-chat'])

  const r3 = call({ resolved: RESOLVED_BARE, store, adminEnabled: true })
  assert.equal(r3.inboundBotToken, 'store-bot', '无显式且无出站渠道 → 回落 store 账号')
  assert.deepEqual(r3.notifyChatIds, ['store-chat'])
})

test('tg 安全链尾：admin 关闭时 store 账号绝不接入 tg 回退（零执行）', () => {
  const store = fakeStore({ 'telegram:account': { botToken: 'leak' } })
  const r = call({ resolved: RESOLVED_BARE, store, adminEnabled: false })
  assert.equal(r.inboundBotToken, '')
  assert.deepEqual(r.notifyChatIds, [])
})

test('feishu/qq/dingtalk/wechat 启用信号：显式空对象即 wanted；admin 关 + store 账号 = 零执行', () => {
  // 显式空对象（扫码落盘承诺）：wanted=true，resolve 跑（无凭证 → 失败 warn + !ok，不炸）
  for (const key of ['feishu', 'qq', 'dingtalk']) {
    const r = call({ inboundRaw: { [key]: {} } })
    assert.equal(key === 'feishu' ? r.feishuOk : key === 'qq' ? r.qqOk : r.dingtalkOk, false)
    assert.ok(r.warns.some((w) => new RegExp(`inbound\\.${key} 跳过`).test(w)), `${key} 无凭证应 warn 跳过`)
  }
  const w = call({ inboundRaw: { wechat: {} } })
  assert.equal(w.wechatWanted, true, '显式空对象即 wanted（同 feishu 语义）')

  // admin 关闭 + store 账号：零执行——不 wanted、不 warn
  const store = fakeStore({ 'feishu:account': { appSecret: 's' }, 'qq:account': { appSecret: 's' }, 'dingtalk:account': { appSecret: 's' }, 'wechat:account': { secret: 's' } })
  const off = call({ store, adminEnabled: false })
  assert.equal(off.feishuResolved, null)
  assert.equal(off.qqResolved, null)
  assert.equal(off.dingtalkResolved, null)
  assert.equal(off.wechatWanted, false)
  assert.equal(off.warns.length, 0)

  // admin 开启 + store 账号：wanted（resolve 用 store 凭证跑；失败 warn 也正常）
  const on = call({ store, adminEnabled: true })
  assert.notEqual(on.feishuResolved, null)
  assert.notEqual(on.qqResolved, null)
  assert.notEqual(on.dingtalkResolved, null)
  assert.equal(on.wechatWanted, true, 'store 凭证即启用信号（含 wechat）')
  assert.deepEqual(on.wechatRaw, {}, 'wechat 仅出信号，resolve 由 apply 晚绑定')
})

test('wxpusher：显式 appToken → ok + 密径首铸落盘 store.set；已持久化路径则复用', () => {
  const store = fakeStore()
  const r = call({ inboundRaw: { wxpusher: { appToken: 'wx-tok' } }, store, adminEnabled: false })
  assert.equal(r.wxOk, true)
  assert.ok(r.wxResolved.config.webhookPath.startsWith('/') && r.wxResolved.config.webhookPath.length > 1)
  // 首铸落盘：密径持久化（不随机每次换，用户回调 URL 不失联）
  const persisted = store.raw.get('wxpusher:webhookPath')
  assert.equal(persisted, r.wxResolved.config.webhookPath, '首铸密径落盘 wxpusher:webhookPath')

  // 已持久化 → 复用，不重新生成不覆写
  const path = '/hook/abcdef0123456789abcdef0123456789'
  const store2 = fakeStore({ 'wxpusher:webhookPath': path })
  const r2 = call({ inboundRaw: { wxpusher: { appToken: 'wx-tok' } }, store: store2, adminEnabled: false })
  assert.equal(r2.wxOk, true)
  assert.equal(r2.wxResolved.config.webhookPath, path, '复用既有密径')
  assert.equal(store2.raw.get('wxpusher:webhookPath'), path, '已有密径不覆写')

  // 显式 webhookPath 是用户意志：直接用，不落盘不生成
  const store3 = fakeStore()
  const r3 = call({ inboundRaw: { wxpusher: { appToken: 'wx-tok', webhookPath: '/my-explicit-path' } }, store: store3, adminEnabled: false })
  assert.equal(r3.wxResolved.config.webhookPath, '/my-explicit-path')
  assert.equal(store3.raw.get('wxpusher:webhookPath'), undefined)
})

test('wxpusher store 凭证启用信号 + YAML 显式键覆盖 store（合并次序）', () => {
  const store = fakeStore({
    'wxpusher:account': { appToken: 'store-tok', webhookPath: '/store-path', accountId: 'store-account' },
  })
  const r = call({ store, adminEnabled: true })
  assert.equal(r.wxOk, true, 'admin 开启 + store 账号即启用')
  assert.equal(r.wxResolved.config.appToken, 'store-tok')
  assert.equal(r.wxResolved.config.accountId, 'store-account', 'store accountId 应进入入站 Control Core 来源绑定')

  const r2 = call({ inboundRaw: { wxpusher: { appToken: 'yaml-tok', accountId: 'yaml-account' } }, store, adminEnabled: true })
  assert.equal(r2.wxResolved.config.appToken, 'yaml-tok', 'YAML 显式键优先覆盖 store')
  assert.equal(r2.wxResolved.config.accountId, 'yaml-account', 'YAML 显式 accountId 应覆盖 store')
})

test('approvalWanted：mode answer/observe → true，其它/缺省 → false', () => {
  assert.equal(call({ approvalRaw: { mode: 'answer' } }).approvalWanted, true)
  assert.equal(call({ approvalRaw: { mode: 'observe' } }).approvalWanted, true)
  assert.equal(call({ approvalRaw: { mode: 'disabled' } }).approvalWanted, false)
  assert.equal(call({ approvalRaw: {} }).approvalWanted, false)
})
