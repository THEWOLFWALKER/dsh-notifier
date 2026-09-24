// v0.9.4 测试（W10 / G-13、S-12、G-61~64、G-38/39/45、G-28）：配置校验与渠道枚举收敛。
// 全部走 resolve 层（不发网络请求；spec 渠道 resolve 是纯函数）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { ADAPTERS } from '../src/config.mjs'
import { INBOUND_CHANNELS as REGISTRY } from '../src/inbound/channels-registry.mjs'
import { INBOUND_CHANNELS as FROM_ADMIN } from '../src/admin/api.mjs'
import { INBOUND_CHANNELS as FROM_MATRIX, INBOUND_CHANNEL_SET } from '../src/inbound/capability-matrix.mjs'

// S-02：urlguard DNS 恒公网夹具（postText 测试用 .test 假域名，不夹具会打真网）
import './helpers/urlguard-public.mjs'

const resolveOf = (type) => ADAPTERS[type].resolve

// ---------------------------------------------------------------- G-13 枚举收敛

test('G-13：渠道枚举单一事实来源——admin/api 与 capability-matrix 的 INBOUND_CHANNELS 同源同冻结', () => {
  assert.equal(FROM_ADMIN, REGISTRY, 'admin/api 转发导出的是同一个冻结数组实例（非拷贝）')
  assert.equal(FROM_MATRIX, REGISTRY, 'capability-matrix 同上')
  assert.deepEqual(REGISTRY, ['telegram', 'feishu', 'qq', 'wxpusher', 'wechat', 'dingtalk'])
  assert.ok(Object.isFrozen(REGISTRY), '清单冻结：运行时不可 push/splice 漂移')
  for (const ch of REGISTRY) assert.ok(INBOUND_CHANNEL_SET.has(ch))
})

// ---------------------------------------------------------------- G-61 数值字段双形态

test('G-61 onebot：userId/groupId 数字与数字字符串双形态等价归一', () => {
  const byNum = resolveOf('onebot')({ baseUrl: 'http://127.0.0.1:3000', userId: 123456789 })
  const byStr = resolveOf('onebot')({ baseUrl: 'http://127.0.0.1:3000', userId: '123456789' })
  assert.equal(byNum.userId, 123456789)
  assert.equal(byStr.userId, 123456789, '字符串形态归一为数字（不再被当未配置）')
  const group = resolveOf('onebot')({ baseUrl: 'http://127.0.0.1:3000', messageType: 'group', groupId: '998877' })
  assert.equal(group.groupId, 998877)
})

test('G-61 onebot：非数字 userId 不当 0 灌入——非法形态按未配置拒绝', () => {
  assert.throws(() => resolveOf('onebot')({ baseUrl: 'http://127.0.0.1:3000', userId: 'not-a-qq' }), /userId.*未填写/)
  assert.throws(() => resolveOf('onebot')({ baseUrl: 'http://127.0.0.1:3000', userId: '' }), /userId.*未填写/)
})

// ---------------------------------------------------------------- G-38 slack webhook 边界

test('G-38 slack：非 hooks.slack.com 域名的 webhook 显式拒绝（API token 不走本渠道）', () => {
  assert.throws(
    () => resolveOf('slack')({ webhook: 'https://slack.com/api/chat.postMessage' }),
    /hooks\.slack\.com/,
    'API 地址形态给出定向指引',
  )
  assert.throws(() => resolveOf('slack')({ webhook: 'https://evil.example.com/services/T00/B00/xxx' }), /hooks\.slack\.com/)
  const ok = resolveOf('slack')({ webhook: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX' })
  assert.equal(ok.webhook, 'https://hooks.slack.com/services/T000/B000/XXXXXXXX')
})

// ---------------------------------------------------------------- G-65 wps-bot webhook 单字段（v0.13.1：webhookKey+webhookHost 合并）

test('G-65 wps-bot：webhook 完整地址归一——origin+标准路径+?key= 重编码，其余 query 丢弃', () => {
  const ok = resolveOf('wps-bot')({ webhook: 'https://365.kdocs.cn/woa/api/v1/webhook/send?key=abc123&legacy=1' })
  assert.equal(ok.webhook, 'https://365.kdocs.cn/woa/api/v1/webhook/send?key=abc123', '/woa 前缀必须保留（协作新一代地址），旧 query 不得残留')
  const xz = resolveOf('wps-bot')({ webhook: 'https://xz.wps.cn/api/v1/webhook/send?key=k%2Bk' })
  assert.equal(xz.webhook, `https://xz.wps.cn/api/v1/webhook/send?key=${encodeURIComponent('k+k')}`, 'key 统一 urlencoded 回写')
})

test('G-65 wps-bot：裸域名（无 scheme）补 https://；纯 origin 补标准路径但缺 ?key= 拒绝', () => {
  const bare = resolveOf('wps-bot')({ webhook: '365.kdocs.cn/api/v1/webhook/send?key=a' })
  assert.equal(bare.webhook, 'https://365.kdocs.cn/api/v1/webhook/send?key=a')
  assert.throws(() => resolveOf('wps-bot')({ webhook: 'https://woa.wps.cn/api/v1/webhook/send' }), /缺少 \?key=/, '无 key 的地址拒绝（key 即全部认证）')
})

test('G-65 wps-bot：非官方域名 / 不可解析串 / 缺 key 显式拒绝（白名单三家：woa/xz/kdocs365）', () => {
  assert.throws(() => resolveOf('wps-bot')({ webhook: 'https://evil.example.com/hook?key=k' }), /只允许/)
  assert.throws(() => resolveOf('wps-bot')({ webhook: 'not a url' }), /只允许/)
  assert.throws(() => resolveOf('wps-bot')({ webhook: 'https://kdocs.cn/woa/api/v1/webhook/send?key=k' }), /只允许/, '裸 kdocs.cn 不在白名单（须 365.kdocs.cn）')
  assert.throws(() => resolveOf('wps-bot')({}), /webhook.*未填写/, 'webhook 必填')
})

test('G-65 wps-bot：存量兼容——旧双字段 webhookKey+webhookHost 在 preresolve 合成完整 webhook', () => {
  // 仅 webhookKey：走默认 woa.wps.cn + 标准路径
  const legacy = resolveOf('wps-bot')({ webhookKey: 'a'.repeat(32) })
  assert.equal(legacy.webhook, `https://woa.wps.cn/api/v1/webhook/send?key=${'a'.repeat(32)}`)
  // webhookHost 完整 URL（含旧 key query）：query 丢弃，key 取 webhookKey 字段
  const full = resolveOf('wps-bot')({
    webhookKey: 'a'.repeat(32),
    webhookHost: 'https://365.kdocs.cn/woa/api/v1/webhook/send?key=deadbeef00',
  })
  assert.equal(full.webhook, `https://365.kdocs.cn/woa/api/v1/webhook/send?key=${'a'.repeat(32)}`, '/woa 前缀保留，旧 query 不残留')
  // 裸域名补 scheme + 标准路径
  const bare = resolveOf('wps-bot')({ webhookKey: 'a'.repeat(32), webhookHost: '365.kdocs.cn' })
  assert.equal(bare.webhook, `https://365.kdocs.cn/api/v1/webhook/send?key=${'a'.repeat(32)}`)
  // 新旧并存：新 webhook 字段优先，旧字段整体忽略
  const both = resolveOf('wps-bot')({
    webhook: 'https://xz.wps.cn/api/v1/webhook/send?key=new',
    webhookKey: 'old'.padEnd(32, '0'),
    webhookHost: 'https://woa.wps.cn',
  })
  assert.equal(both.webhook, 'https://xz.wps.cn/api/v1/webhook/send?key=new')
  // 旧 webhookHost 非法：原样透传给 validate 给出「只允许」指引
  assert.throws(() => resolveOf('wps-bot')({ webhookKey: 'a'.repeat(32), webhookHost: 'https://evil.example.com/hook' }), /只允许/)
})

test('G-65 wps-bot：fixedOptions——timeoutMs/allowPrivateNetwork 引擎选项被忽略（用户拍板去掉）', () => {
  const resolved = resolveOf('wps-bot')({
    webhook: 'https://woa.wps.cn/api/v1/webhook/send?key=k',
    timeoutMs: 60000,
    allowPrivateNetwork: true,
  })
  assert.equal(resolved.timeoutMs, 10000, 'cfg.timeoutMs 不再生效，恒为默认 10000')
  assert.equal(resolved.allowPrivateNetwork, undefined, 'allowPrivateNetwork 恒不放行私网')
})

test('G-65 wps-bot：send 组装——最终 URL 即归一后的 webhook（365 /woa path + ?key=）', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init.body ? String(init.body) : null })
    return { ok: true, status: 200, text: async () => '{"result":"ok"}' }
  }
  try {
    await ADAPTERS['wps-bot'].send(
      resolveOf('wps-bot')({ webhook: `https://365.kdocs.cn/woa/api/v1/webhook/send?key=${'a'.repeat(32)}` }),
      { title: 't', content: 'c' },
    )
    assert.equal(seen[0].url, `https://365.kdocs.cn/woa/api/v1/webhook/send?key=${'a'.repeat(32)}`)
    assert.deepEqual(JSON.parse(seen[0].body), { msgtype: 'text', text: { content: 't\nc' } })
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------- G-62 pushplus 枚举统一

test('G-62 pushplus：template 与 channel 两个枚举同一待遇——非空非法抛错，空值走默认', () => {
  assert.throws(() => resolveOf('pushplus')({ token: 't', template: 'h5' }), /template 仅支持 html\/txt\/json\/markdown/)
  assert.equal(resolveOf('pushplus')({ token: 't' }).template, 'markdown', '空值默认 markdown')
  assert.equal(resolveOf('pushplus')({ token: 't', template: 'html' }).template, 'html')
  assert.throws(() => resolveOf('pushplus')({ token: 't', channel: 'sms' }), /channel 仅支持/)
})

// ---------------------------------------------------------------- G-39 discord 2000 上限

test('G-39 discord：content 超 2000 字符 fail-fast（建连前拒绝并报当前长度）', async () => {
  const send = ADAPTERS.discord.send ?? null
  assert.ok(typeof send === 'function', 'discord 是 spec 渠道，send 由引擎生成')
  await assert.rejects(
    () => send(
      resolveOf('discord')({ webhook: 'https://discord.com/api/webhooks/1/x' }),
      { title: 't', content: '长'.repeat(2100) },
    ),
    /超过 Discord 上限 2000 字符（当前 2\d{3}）/,
  )
})

// ---------------------------------------------------------------- G-63 webhook headers 归一

test('G-63 webhook：headers 数值/布尔转字符串，对象丢弃（fetch Headers 不再 TypeError）', () => {
  const warns = []
  const original = console.error
  console.error = (...args) => warns.push(args.join(' '))
  try {
    const resolved = resolveOf('webhook')({
      url: 'http://public-hook.test/hook',
      headers: { 'X-Port': 8080, 'X-Flag': true, 'X-Obj': { nested: 1 }, Authorization: 'Bearer abc' },
    })
    assert.equal(resolved.headers['X-Port'], '8080')
    assert.equal(resolved.headers['X-Flag'], 'true')
    assert.equal(resolved.headers['X-Obj'], undefined, '对象形态无文本语义，丢弃')
    assert.equal(resolved.headers.Authorization, 'Bearer abc')
    assert.ok(warns.some((line) => line.includes('X-Port') && line.includes('已转字符串')), '数值归一留痕')
    assert.ok(warns.some((line) => line.includes('X-Obj') && line.includes('已丢弃')), '丢弃留痕')
  } finally {
    console.error = original
  }
})

// ---------------------------------------------------------------- G-64 desktop sound 布尔

test('G-64 desktop：sound 布尔形态 true→always / false→never，非法值回落 auto', () => {
  assert.equal(resolveOf('desktop')({ sound: true }).sound, 'always')
  assert.equal(resolveOf('desktop')({ sound: false }).sound, 'never')
  assert.equal(resolveOf('desktop')({ sound: 'alway' }).sound, 'auto', '拼错回落默认不炸')
  assert.equal(resolveOf('desktop')({}).sound, 'auto')
})

// ---------------------------------------------------------------- G-45 postText content-type

test('G-45 postText：默认 content-type text/plain，调用方同名头可覆盖', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers)
    return { ok: true, status: 200, text: async () => '' }
  }
  try {
    const { postText } = await import('../src/adapters/_shared.mjs')
    await postText('http://public-text.test/t', 'hello', { channel: '测试' })
    await postText('http://public-text.test/t', 'hello', { headers: { 'content-type': 'application/json' }, channel: '测试' })
    assert.equal(seen[0]['content-type'], 'text/plain; charset=utf-8', '未指定时显式声明纯文本')
    assert.equal(seen[1]['content-type'], 'application/json', '调用方覆盖优先')
  } finally {
    globalThis.fetch = originalFetch
  }
})
