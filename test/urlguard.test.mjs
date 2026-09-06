// v0.9.3 测试（W9 / S-02）：_urlguard SSRF 闸矩阵 + 出站重定向拒绝。
// DNS 全部走注入 stub（不打真网）；fetch 走全局 stub（真实网络零依赖）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicHttpUrl, __setLookupForTests } from '../src/adapters/_urlguard.mjs'
import { postJson, NotifyError, ERROR_CODES } from '../src/adapters/_shared.mjs'
import * as webhook from '../src/adapters/webhook.mjs'
import { makeSpecAdapter } from '../src/adapters/_engine.mjs'

/** 期待抛 UNSAFE_TARGET 且文案含段名。 */
async function assertBlocked(promise, reasonPattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof NotifyError, `应抛 NotifyError，实际 ${error?.constructor?.name}`)
    assert.equal(error.code, ERROR_CODES.UNSAFE_TARGET)
    if (reasonPattern !== undefined) assert.match(error.message, reasonPattern)
    return true
  })
}

test('SSRF 矩阵：私网/保留 IPv4 字面量一律拒绝（127/10/172.16/192.168/169.254/0.0.0.0/100.64/组播/保留）', async () => {
  for (const url of [
    'http://127.0.0.1/webhook',
    'http://127.1.2.3/hook', // 127/8 整段
    'http://10.0.0.5/hook',
    'http://172.16.0.9/hook',
    'http://172.31.255.255/hook',
    'http://192.168.1.1/hook',
    'http://169.254.169.254/latest/meta-data', // 云元数据端点
    'http://0.0.0.0/hook',
    'http://100.64.0.1/hook', // CGNAT
    'http://224.0.0.1/hook', // 组播
    'http://240.0.0.1/hook', // 保留
    'https://192.0.2.1/hook', // TEST-NET-1
  ]) {
    await assertBlocked(assertPublicHttpUrl(url, { channel: 'webhook' }), /拒绝/)
  }
})

test('SSRF 矩阵：IPv6 环回/映射/ULA/链路本地拒绝，公网 v6 放行', async () => {
  await assertBlocked(assertPublicHttpUrl('http://[::1]/hook', { channel: 'webhook' }))
  await assertBlocked(assertPublicHttpUrl('http://[::ffff:127.0.0.1]/hook', { channel: 'webhook' }), /环回|映射/)
  await assertBlocked(assertPublicHttpUrl('http://[fe80::1]/hook', { channel: 'webhook' }))
  await assertBlocked(assertPublicHttpUrl('http://[fc00::1]/hook', { channel: 'webhook' }))
  await assertBlocked(assertPublicHttpUrl('http://[::]/hook', { channel: 'webhook' }))
  // 公网 v6（2001:4860::8888 = Google DNS）与 NAT64 公网映射放行
  await assertPublicHttpUrl('http://[2001:4860:4860::8888]/hook')
  await assertPublicHttpUrl('http://[64:ff9b::8.8.8.8]/hook')
})

test('SSRF 矩阵：公网 IPv4 字面量放行（不走 DNS）', async () => {
  let looked = false
  __setLookupForTests(async () => { looked = true; return [{ address: '8.8.8.8', family: 4 }] })
  try {
    await assertPublicHttpUrl('https://1.1.1.1/hook', { channel: 'webhook' })
    await assertPublicHttpUrl('http://93.184.216.34/', { channel: 'webhook' })
    assert.equal(looked, false, 'IP 字面量不应触发 DNS lookup')
  } finally {
    __setLookupForTests(null)
  }
})

test('SSRF 矩阵：域名解析到私网任一地址即拒绝（all:true 全地址校验，混合 A 记录也拦）', async () => {
  __setLookupForTests(async (host) => {
    if (host === 'mixed.example.com') {
      return [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]
    }
    return [{ address: '192.168.0.9', family: 4 }]
  })
  try {
    await assertBlocked(assertPublicHttpUrl('http://internal.example.com/hook', { channel: 'webhook' }), /私网/)
    await assertBlocked(assertPublicHttpUrl('http://mixed.example.com/hook', { channel: 'webhook' }), /私网/)
  } finally {
    __setLookupForTests(null)
  }
})

test('SSRF 矩阵：非常规四进制写法经 DNS 路径拦截（2130706433 → 127.0.0.1）', async () => {
  __setLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }])
  try {
    await assertBlocked(assertPublicHttpUrl('http://2130706433/hook', { channel: 'webhook' }), /环回/)
  } finally {
    __setLookupForTests(null)
  }
})

test('SSRF 矩阵：scheme 白名单（file:/ftp: 拒绝）；域名解析失败归一为 NETWORK_ERROR', async () => {
  await assertBlocked(assertPublicHttpUrl('file:///etc/passwd', { channel: 'webhook' }), /http\/https/)
  __setLookupForTests(async () => { throw new Error('ENOTFOUND no-such-host') })
  try {
    await assert.rejects(
      assertPublicHttpUrl('http://no-such-host.example/hook', { channel: 'webhook' }),
      (error) => error instanceof NotifyError && error.code === ERROR_CODES.NETWORK_ERROR,
    )
  } finally {
    __setLookupForTests(null)
  }
})

test('SSRF 矩阵：allowPrivate 放行私网（逃生口不触发 DNS）', async () => {
  let looked = false
  __setLookupForTests(async () => { looked = true; return [{ address: '127.0.0.1', family: 4 }] })
  try {
    await assertPublicHttpUrl('http://127.0.0.1:3000/hook', { allowPrivate: true, channel: 'webhook' })
    assert.equal(looked, false)
  } finally {
    __setLookupForTests(null)
  }
})

test('SSRF 矩阵：解析结果短 TTL 缓存（同域名第二次不再 lookup；被拒结果同样缓存）', async () => {
  let count = 0
  __setLookupForTests(async () => { count += 1; return [{ address: '10.1.2.3', family: 4 }] })
  try {
    await assertBlocked(assertPublicHttpUrl('http://cached.example.com/hook', { channel: 'webhook' }))
    await assertBlocked(assertPublicHttpUrl('http://cached.example.com/hook', { channel: 'webhook' }))
    assert.equal(count, 1, '第二次应命中缓存')
  } finally {
    __setLookupForTests(null)
  }
})

// ---------------------------------------------------------------- 重定向拒绝（_shared）

test('S-02：postJson 拒绝跟随 3xx（redirect:manual），Location 只进 detail 不进公开文案', async () => {
  const originalFetch = globalThis.fetch
  const inits = []
  globalThis.fetch = async (url, init) => {
    inits.push(init)
    return {
      ok: false,
      status: 302,
      headers: { get: (name) => (name === 'location' ? 'http://169.254.169.254/steal' : null) },
    }
  }
  try {
    await assert.rejects(postJson('http://sink.test/hook', {}, { channel: 'webhook' }), (error) => {
      assert.ok(error instanceof NotifyError)
      assert.equal(error.code, ERROR_CODES.HTTP_ERROR)
      assert.match(error.message, /302 重定向/)
      assert.ok(!error.message.includes('169.254'), '公开文案不得含重定向目标')
      assert.match(error.detail, /169\.254\.169\.254/, 'Location 进 detail（日志）')
      return true
    })
    assert.equal(inits[0].redirect, 'manual', 'fetch 必须显式 redirect:manual')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------- adapter / engine 集成

test('webhook adapter：resolve 默认 allowPrivateNetwork=false；发送私网 URL 被闸拦截；显式开启后放行', async () => {
  const resolved = webhook.resolve({ url: 'http://127.0.0.1:9/hook' })
  assert.equal(resolved.allowPrivateNetwork, false)
  await assertBlocked(webhook.send(resolved, { title: 't', content: 'c' }), /环回/)

  const allowed = webhook.resolve({ url: 'http://127.0.0.1:9/hook', allowPrivateNetwork: true })
  assert.equal(allowed.allowPrivateNetwork, true)
  const originalFetch = globalThis.fetch
  let hit = 0
  globalThis.fetch = async () => { hit += 1; return { ok: true, status: 200, json: async () => ({}) } }
  try {
    await webhook.send(allowed, { title: 't', content: 'c' })
    assert.equal(hit, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('engine spec 渠道：gotify（ssrfGuard:true）私网 server 拒绝；onebot（private-ok）默认 127.0.0.1 放行', async () => {
  const gotify = makeSpecAdapter('gotify', {
    label: 'Gotify',
    ssrfGuard: true,
    fields: { server: { required: true }, appToken: { required: true } },
    request: (cfg) => ({ url: `${cfg.server.replace(/\/+$/, '')}/message`, body: {} }),
    ok: () => true,
  })
  await assertBlocked(
    gotify.send(gotify.resolve({ server: 'http://10.0.0.5', appToken: 'T' }), { title: 't', content: 'c' }),
    /私网/,
  )

  const onebot = makeSpecAdapter('onebot', {
    label: 'QQ OneBot 11',
    ssrfGuard: 'private-ok',
    fields: { baseUrl: { required: true } },
    request: (cfg) => ({ url: `${cfg.baseUrl.replace(/\/+$/, '')}/send_msg`, body: {} }),
    ok: () => true,
  })
  const originalFetch = globalThis.fetch
  let hit = 0
  globalThis.fetch = async () => { hit += 1; return { ok: true, status: 200, json: async () => ({ retcode: 0 }) } }
  try {
    await onebot.send(onebot.resolve({ baseUrl: 'http://127.0.0.1:3000' }), { title: 't', content: 'c' })
    assert.equal(hit, 1, 'onebot 文档默认回环地址不被 SSRF 闸打断')
  } finally {
    globalThis.fetch = originalFetch
  }
})
