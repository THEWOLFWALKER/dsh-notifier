// v0.9.4 测试（W10 / G-13、S-12、G-61~64、G-38/39/45、G-28）：配置校验与渠道枚举收敛。
// 全部走 resolve 层（不发网络请求；spec 渠道 resolve 是纯函数）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { ADAPTERS, resolveConfig, REMOTE_LOG_HARD_MAX_LINES, REMOTE_LOG_HARD_MAX_BYTES } from '../src/config.mjs'
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

test('G-65 wps-bot：显式 http: 拒绝（PR #34 review finding——key 明文传输风险，fail-closed 不静默升级）', () => {
  assert.throws(() => resolveOf('wps-bot')({ webhook: 'http://woa.wps.cn/api/v1/webhook/send?key=k' }), /只允许 https/, '新 webhook 显式 http 拒绝')
  assert.throws(() => resolveOf('wps-bot')({ webhookKey: 'a'.repeat(32), webhookHost: 'http://xz.wps.cn' }), /只允许 https/, 'legacy webhookHost 显式 http 拒绝')
  // https 三官方 host 防误伤回归
  assert.equal(resolveOf('wps-bot')({ webhook: 'https://woa.wps.cn/api/v1/webhook/send?key=k' }).webhook, 'https://woa.wps.cn/api/v1/webhook/send?key=k')
  assert.equal(resolveOf('wps-bot')({ webhook: 'https://xz.wps.cn/api/v1/webhook/send?key=k' }).webhook, 'https://xz.wps.cn/api/v1/webhook/send?key=k')
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

test('G-65 wps-bot：send 组装——markdown 走 {msgtype:"markdown", markdown:{text}}（PR #34 review finding 补精确断言）', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init.body ? String(init.body) : null })
    return { ok: true, status: 200, text: async () => '{"result":"ok"}' }
  }
  try {
    await ADAPTERS['wps-bot'].send(
      resolveOf('wps-bot')({ webhook: `https://woa.wps.cn/api/v1/webhook/send?key=${'a'.repeat(32)}`, msgtype: 'markdown' }),
      { title: 't', content: 'c' },
    )
    assert.equal(seen[0].url, `https://woa.wps.cn/api/v1/webhook/send?key=${'a'.repeat(32)}`)
    assert.deepEqual(JSON.parse(seen[0].body), { msgtype: 'markdown', markdown: { text: 't\n\nc' } }, 'markdown 用 joinPara 空行分段')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------- P1-A qmsg 3.0 迁移（v0.11）

/** qmsg 走 form-encoded；统一抓 (url, form 字段) 供精确断言。 */
async function captureQmsg(run) {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))) })
    return { ok: true, status: 200, text: async () => '{"success":true,"code":0,"message":"操作成功"}' }
  }
  try { await run(seen) } finally { globalThis.fetch = originalFetch }
}

test('P1-A qmsg：v3 endpoint + 单聊 body={msg}（仅 key 无目标语义→v3 默认单聊）', async () => {
  const resolved = resolveOf('qmsg')({ key: 'qmsg-key-001' })
  assert.equal(resolved.group, '', '缺省无群号')
  await captureQmsg(async (seen) => {
    await ADAPTERS.qmsg.send(resolved, { title: '构建完成', content: '全部用例通过' })
    assert.equal(seen[0].url, 'https://qmsg.zendee.cn/v3/send/qmsg-key-001')
    assert.deepEqual(seen[0].form, { msg: '构建完成\n全部用例通过' }, '单聊 body 只含 msg，不带旧的 qq/bot')
  })
})

test('P1-A qmsg：v3 群聊 body={msg,group}', async () => {
  const resolved = resolveOf('qmsg')({ key: 'qmsg-key-001', group: '10000' })
  await captureQmsg(async (seen) => {
    await ADAPTERS.qmsg.send(resolved, { title: '构建完成', content: '全部用例通过' })
    assert.equal(seen[0].url, 'https://qmsg.zendee.cn/v3/send/qmsg-key-001')
    assert.deepEqual(seen[0].form, { msg: '构建完成\n全部用例通过', group: '10000' })
  })
})

test('P1-A qmsg：key URL encode——特殊字符不逃逸出 path，type 不再是任意 URL path', async () => {
  const resolved = resolveOf('qmsg')({ key: 'k/../evil?a=b#c' })
  await captureQmsg(async (seen) => {
    await ADAPTERS.qmsg.send(resolved, { title: '', content: 'x' })
    assert.equal(seen[0].url, 'https://qmsg.zendee.cn/v3/send/k%2F..%2Fevil%3Fa%3Db%23c', 'path segment 整体编码')
  })
})

test('P1-A qmsg：legacy type=group+qq 无损迁移为 group（旧群配置不用重配）', () => {
  const migrated = resolveOf('qmsg')({ key: 'k', type: 'group', qq: '10000,10001' })
  assert.equal(migrated.group, '10000,10001')
  assert.equal(migrated.type, undefined, '旧 type 键不再进入 resolved 状态')
  assert.equal(migrated.qq, undefined)
  // 显式 group 优先于 legacy qq
  assert.equal(resolveOf('qmsg')({ key: 'k', type: 'group', qq: '10000', group: '20000' }).group, '20000')
})

test('P1-A qmsg：legacy 单聊语义（type=send / 裸 qq / bot / 未知 type）配置阶段显式拒绝', () => {
  const migration = /Qmsg 3\.0 不再支持/
  assert.throws(() => resolveOf('qmsg')({ key: 'k', type: 'send', qq: '10000' }), migration)
  assert.throws(() => resolveOf('qmsg')({ key: 'k', qq: '10000' }), migration, '裸 qq 旧默认即 send')
  assert.throws(() => resolveOf('qmsg')({ key: 'k', bot: '20000' }), migration)
  assert.throws(() => resolveOf('qmsg')({ key: 'k', type: 'weird' }), migration, '未知 type 不再是 URL path 白名单，而是迁移错误')
  assert.throws(() => resolveOf('qmsg')({ key: 'k', type: 'group' }), /需要 group/, 'type=group 无群号不静默降级为单聊')
  assert.throws(() => resolveOf('qmsg')({}), /key.*未填写/, 'key 仍必填')
  // YAML 里 QQ 号常被写成数字：按真假值判定会静默丢失目标语义，必须仍识别为 legacy。
  assert.equal(resolveOf('qmsg')({ key: 'k', type: 'group', qq: 10000 }).group, '10000', '数字群号也能无损迁移')
  assert.throws(() => resolveOf('qmsg')({ key: 'k', qq: 10000 }), migration, '数字裸 qq 同样拒绝，不静默变单聊')
})

test('P1-A qmsg：v3 失败描述取 message 字段（不再是 reason）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"success":false,"code":1,"message":"key 已失效"}' })
  try {
    await assert.rejects(
      () => ADAPTERS.qmsg.send(resolveOf('qmsg')({ key: 'k' }), { title: '', content: 'x' }),
      /key 已失效/,
    )
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

// ---------------------------------------------------------------- Commit20 remoteLog（/log）

test('Commit20 remoteLog：默认 enabled=false，maxLines/maxBytes 回落到 hard caps', () => {
  const rl = resolveConfig({}).remoteLog
  assert.equal(rl.enabled, false, '默认关（仅显式 true 才开）')
  assert.equal(rl.maxLines, REMOTE_LOG_HARD_MAX_LINES)
  assert.equal(rl.maxBytes, REMOTE_LOG_HARD_MAX_BYTES)
})

test('Commit20 remoteLog：enabled 仅显式 true 才开（truthy 非 true 一律关）', () => {
  assert.equal(resolveConfig({ remoteLog: { enabled: true } }).remoteLog.enabled, true)
  for (const value of [1, 'true', 'yes', {}, []]) {
    assert.equal(resolveConfig({ remoteLog: { enabled: value } }).remoteLog.enabled, false, `enabled=${String(value)} 应关`)
  }
})

test('Commit20 remoteLog：maxLines/maxBytes clamp 到 hard caps（用户不能放大 §11.5）', () => {
  const rl = resolveConfig({ remoteLog: { enabled: true, maxLines: 100000, maxBytes: 999999999 } }).remoteLog
  assert.equal(rl.maxLines, REMOTE_LOG_HARD_MAX_LINES)
  assert.equal(rl.maxBytes, REMOTE_LOG_HARD_MAX_BYTES)
})

test('Commit20 remoteLog：下界 clamp（maxLines≥1 / maxBytes≥256）', () => {
  const rl = resolveConfig({ remoteLog: { maxLines: 0, maxBytes: 0 } }).remoteLog
  assert.equal(rl.maxLines, 1)
  assert.equal(rl.maxBytes, 256)
  const neg = resolveConfig({ remoteLog: { maxLines: -5, maxBytes: -1 } }).remoteLog
  assert.equal(neg.maxLines, 1)
  assert.equal(neg.maxBytes, 256)
})

test('Commit20 remoteLog：非法值回落上限（安全配置非法值不宽松解释）', () => {
  for (const value of ['abc', null, undefined, {}, [], NaN, Infinity, true]) {
    const rl = resolveConfig({ remoteLog: { maxLines: value, maxBytes: value } }).remoteLog
    assert.equal(rl.maxLines, REMOTE_LOG_HARD_MAX_LINES, `maxLines=${String(value)} 应回落上限`)
    assert.equal(rl.maxBytes, REMOTE_LOG_HARD_MAX_BYTES, `maxBytes=${String(value)} 应回落上限`)
  }
})

test('Commit20 remoteLog：小数取整（trunc）', () => {
  const rl = resolveConfig({ remoteLog: { maxLines: 12.9, maxBytes: 1024.9 } }).remoteLog
  assert.equal(rl.maxLines, 12)
  assert.equal(rl.maxBytes, 1024)
})

test('Commit20 remoteLog：remoteLog 非对象形态（数组/字符串/null）一律回落默认', () => {
  for (const value of [[], 'on', null, 42]) {
    const rl = resolveConfig({ remoteLog: value }).remoteLog
    assert.equal(rl.enabled, false)
    assert.equal(rl.maxLines, REMOTE_LOG_HARD_MAX_LINES)
    assert.equal(rl.maxBytes, REMOTE_LOG_HARD_MAX_BYTES)
  }
})
