// 批次 4：微信 iLink provider slice（协议归一 + 账号命名空间 + 失败隔离）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WECHAT_ILINK_CAPABILITIES,
  normalizeQrStatus,
  normalizeUpdateBatch,
  normalizeInboundMessage,
  boundedCursor,
  createWechatIlinkInbound,
} from '../../src/channels/wechat-ilink/index.mjs'

function storeOf(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    get: (key, fallback) => map.has(key) ? map.get(key) : fallback,
    set: (key, value) => map.set(key, value),
    delete: (key) => map.delete(key),
    keys: (prefix = '') => [...map.keys()].filter((key) => key.startsWith(prefix)),
    map,
  }
}

const config = { accountId: 'ACC_A', token: 'TOKEN_A', baseUrl: 'https://ilink.test', notifyUsers: [] }

test('iLink capability evidence stays contract-tested/declared; never real-device-verified', () => {
  assert.equal(WECHAT_ILINK_CAPABILITIES.qrLogin, 'contract-tested')
  assert.equal(WECHAT_ILINK_CAPABILITIES.imageReceive, 'contract-tested')
  assert.equal(WECHAT_ILINK_CAPABILITIES.imageSend, 'declared')
  assert.equal(WECHAT_ILINK_CAPABILITIES.realDeviceVerified, false)
})

test('QR expiry is explicit and actionable; unknown status fails closed', () => {
  assert.deepEqual(normalizeQrStatus({ status: 'expired' }), {
    state: 'expired', message: '微信二维码已过期，请重新扫码',
  })
  assert.equal(normalizeQrStatus({ status: 'future-provider-state' }).state, 'error')
  assert.match(normalizeQrStatus({ status: 'future-provider-state' }).message, /重新扫码/)
})

test('QR status matrix: wait/scaned/redirect/confirmed/expired all normalized; unknown fails closed with rescan guidance', () => {
  assert.deepEqual(normalizeQrStatus({ status: 'wait', qrcode_img_content: 'LITEAPP' }), {
    state: 'wait', qrContent: 'LITEAPP',
  })
  assert.deepEqual(normalizeQrStatus({ status: 'scaned', qrcode_img_content: 'URL' }), {
    state: 'scaned', qrContent: 'URL',
  })
  const redirect = normalizeQrStatus({ status: 'scaned_but_redirect', redirect_host: 'node-1' })
  assert.equal(redirect.state, 'redirect')
  assert.equal(redirect.host, 'node-1')
  assert.match(redirect.message, /node-1/)
  const redirectNoHost = normalizeQrStatus({ status: 'scaned_but_redirect' })
  assert.equal(redirectNoHost.state, 'redirect')
  assert.match(redirectNoHost.message, /重新扫码/)
  const confirmed = normalizeQrStatus({
    status: 'confirmed', ilink_user_id: 'ACC_B', bot_token: 'T_B', baseurl: 'https://ilink.test/',
  })
  assert.equal(confirmed.state, 'confirmed')
  assert.equal(confirmed.accountId, 'ACC_B')
  assert.equal(confirmed.botToken, 'T_B')
  assert.equal(confirmed.baseUrl, 'https://ilink.test')
  assert.equal(normalizeQrStatus({ status: 'success' }).state, 'confirmed', 'success 别名')
  assert.equal(normalizeQrStatus({ status: 'timeout' }).state, 'expired', 'timeout 别名')
  assert.equal(normalizeQrStatus({ status: 'expired' }).state, 'expired')
  // 未知/缺 status 一律 fail-closed 且给「重新扫码」指引
  assert.equal(normalizeQrStatus({ status: 'future-provider-state' }).state, 'error')
  assert.match(normalizeQrStatus({ status: 'future-provider-state' }).message, /重新扫码/)
  assert.equal(normalizeQrStatus(null).state, 'error')
  assert.equal(normalizeQrStatus([1, 2]).state, 'error', '非对象响应 fail-closed')
})

test('cursor is bounded and malformed cursor does not replace a usable cursor', () => {
  assert.equal(boundedCursor('ok'), 'ok')
  assert.equal(boundedCursor('x'.repeat(4097)), '')
  const batch = normalizeUpdateBatch({ ret: 0, get_updates_buf: 'x'.repeat(4097), msgs: [] }, { accountId: 'ACC_A' })
  assert.equal(batch.ok, true)
  assert.equal(batch.cursor, '')
  assert.equal(batch.cursorRejected, true)
})

test('unknown fields never enter the control envelope; known text/image are isolated', () => {
  const text = normalizeInboundMessage({
    from_user_id: 'USER_A', message_id: 'M1', context_token: 'CTX1',
    injected_control: { approve: true },
    item_list: [{ type: 1, text_item: { text: 'hello' } }, { type: 999, payload: { approve: true } }],
  }, { accountId: 'ACC_A' })
  assert.equal(text.text, 'hello')
  assert.equal(text.injected_control, undefined)
  assert.equal(text.payload, undefined)

  const image = normalizeInboundMessage({
    from_user_id: 'USER_A', message_id: 'M2',
    item_list: [{ type: 2, image_item: { media_id: 'media-1' } }],
  }, { accountId: 'ACC_A' })
  assert.equal(image.kind, 'image')
  assert.equal(image.text, '[图片消息]')
  assert.equal(image.image.mediaId, 'media-1')
  assert.equal(normalizeInboundMessage({
    from_user_id: 'USER_A', message_id: 'M3', item_list: [{ type: 2, image_item: {} }],
  }, { accountId: 'ACC_A' }), null, '无 URL 或 mediaId 的图片不能进入 Control Core')
})

test('new provider state is account-scoped and image download failure cannot block text', async () => {
  const store = storeOf()
  const accepted = []
  let downloadCall = null
  const bus = {
    accept: (envelope) => { accepted.push(envelope); return { ok: true } },
  }
  let updateOnce = true
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('getupdates')) {
      if (updateOnce) {
        updateOnce = false
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'CURSOR_A', msgs: [{
          from_user_id: 'USER_A', message_id: 'M3', context_token: 'CTX_A',
          item_list: [{ type: 1, text_item: { text: '控制命令' } }, { type: 2, image_item: { media_id: 'media-2' } }],
        }] }), { status: 200 })
      }
      return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    if (init.signal) return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  }
  const inbound = createWechatIlinkInbound({
    config, store, bus, fetchImpl, sleep: async () => {},
    mediaAdapter: {
      downloadInboundImage: async (...args) => {
        downloadCall = args
        throw new Error('download unavailable')
      },
    },
  })
  inbound.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await inbound.stop()
  assert.equal(store.get('wechat:ACC_A:sync_buf'), 'CURSOR_A')
  assert.equal(store.get('wechat:ACC_A:ctx:USER_A'), 'CTX_A')
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].text, '控制命令')
  assert.equal(accepted[0].image.mediaId, 'media-2')
  assert.equal(accepted[0].contextToken, undefined, 'context_token 只留在 transport state，不得进入 Control Core')
  assert.equal(downloadCall[0].text, '控制命令', '混合文本图片也在控制路径后才尽力下载')
  assert.equal(downloadCall[1].maxBytes, 5 * 1024 * 1024)
  assert.equal(downloadCall[1].timeoutMs, 10000)
  assert.ok(downloadCall[1].signal instanceof AbortSignal)
  assert.equal(inbound.status().accountId, 'ACC_A')
})

test('account-scoping: new provider writes only wechat:ACC_A:* keys, never global wechat:*', () => {
  const store = storeOf()
  const accepted = []
  let updateOnce = true
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('getupdates')) {
      if (updateOnce) {
        updateOnce = false
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'CURSOR_A', msgs: [{
          from_user_id: 'USER_A', message_id: 'M1', context_token: 'CTX_A',
          item_list: [{ type: 1, text_item: { text: 'hi' } }],
        }] }), { status: 200 })
      }
      return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  }
  const inbound = createWechatIlinkInbound({
    config, store, bus: { accept: (e) => { accepted.push(e); return { ok: true } } },
    fetchImpl, sleep: async () => {},
  })
  inbound.start()
  return new Promise((resolve) => setTimeout(resolve, 10)).then(async () => {
    await inbound.stop()
    assert.equal(store.get('wechat:ACC_A:sync_buf'), 'CURSOR_A')
    assert.equal(store.get('wechat:ACC_A:ctx:USER_A'), 'CTX_A')
    const keys = [...store.map.keys()]
    assert.equal(keys.some((key) => key === 'wechat:sync_buf'), false, '全局游标键不得写入')
    assert.equal(keys.some((key) => key === 'wechat:ctx:USER_A'), false, '全局 ctx 键不得写入')
    assert.equal(accepted[0].contextToken, undefined, 'context_token 不进入 Control Core')
  })
})

test('at-least-once: a handler throw on a control command retains the old cursor; re-poll retries it and never double-executes the already-consumed message', async () => {
  const store = storeOf()
  const executed = [] // 真正被执行（投递到处理器）的消息
  const seen = new Map() // messageId -> 该 id 被交付次数（含失败的那次）
  const bus = {
    accept(envelope) {
      const id = envelope.messageId
      const n = (seen.get(id) ?? 0) + 1
      seen.set(id, n)
      // CTRL 首投失败（模拟一条应执行的控制命令未被接受）；重投成功
      if (id === 'wx:ACC_A:CTRL' && n === 1) throw new Error('control accept transient failure')
      // 去重：已执行过的不再执行（模拟 bus 按 messageId 去重）
      if (executed.includes(id)) return { ok: false, reason: 'duplicate' }
      executed.push(id)
      return { ok: true }
    },
  }
  const sent = []
  const lines = []
  const logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('getupdates')) {
      const body = init.body ? JSON.parse(init.body) : {}
      sent.push(String(body.get_updates_buf ?? ''))
      if (sent.length === 1 || sent.length === 2) {
        // provider 从同一光标返回同一整批（含一条已接受 + 一条未接受的控制命令）
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'BUF_C', msgs: [
          { from_user_id: 'USER_A', message_id: 'OK', item_list: [{ type: 1, text_item: { text: 'approved' } }] },
          { from_user_id: 'USER_A', message_id: 'CTRL', context_token: 'CTX_A', item_list: [{ type: 1, text_item: { text: '批准 1' } }] },
        ] }), { status: 200 })
      }
      if (sent.length === 3) {
        // provider 以空批确认游标已推进到 BUF_D；此后挂起（模拟真实 35s 长轮询，避免紧循环饿死定时器）
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'BUF_D', msgs: [] }), { status: 200 })
      }
      // 游标已稳：挂起等待 stop() 打断（同 account-scoping 测试），与真实长轮询节奏一致
      return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  }
  const inbound = createWechatIlinkInbound({ config, store, bus, logger, fetchImpl, sleep: async () => {} })
  inbound.start()
  await new Promise((resolve) => setTimeout(resolve, 15))
  await inbound.stop()
  assert.deepEqual(executed, ['wx:ACC_A:OK', 'wx:ACC_A:CTRL'], 'OK 与 CTRL 各执行恰好一次')
  assert.equal(seen.get('wx:ACC_A:OK'), 2, 'OK 被交付两次但只执行一次（bus 去重）')
  assert.equal(seen.get('wx:ACC_A:CTRL'), 2, 'CTRL 首投失败 + 重投成功')
  assert.equal(sent[1], '', "首投失败后游标保留为旧值（空），不推进到 BUF_C")
  assert.equal(sent[2], 'BUF_C', '重投成功后才推进到 BUF_C')
  assert.equal(store.get('wechat:ACC_A:sync_buf'), 'BUF_D', '最终游标持久化到最新值')
  assert.ok(lines.some((line) => line.includes('本批游标不推进')), '保留游标必须出声（宪法#3）')
})

test('overlong/illegal cursor never replaces the last usable cursor at the poll level', async () => {
  const store = storeOf({ 'wechat:ACC_A:sync_buf': 'GOOD_CURSOR' })
  const accepted = []
  const sent = []
  const lines = []
  const logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('getupdates')) {
      const body = init.body ? JSON.parse(init.body) : {}
      sent.push(String(body.get_updates_buf ?? ''))
      if (sent.length === 1) {
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'X'.repeat(4097), msgs: [
          { from_user_id: 'USER_A', message_id: 'M1', item_list: [{ type: 1, text_item: { text: 'hi' } }] },
        ] }), { status: 200 })
      }
      if (sent.length === 2) {
        // 拿到合法新游标后推进到 NEXT；之后挂起模拟长轮询
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'NEXT', msgs: [] }), { status: 200 })
      }
      return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  }
  const inbound = createWechatIlinkInbound({ config, store, bus: { accept: (e) => { accepted.push(e); return { ok: true } } }, logger, fetchImpl, sleep: async () => {} })
  inbound.start()
  await new Promise((resolve) => setTimeout(resolve, 15))
  await inbound.stop()
  assert.equal(accepted.length, 1, '非法游标不影响本批消息本身入站')
  assert.equal(sent[1], 'GOOD_CURSOR', '下一轮沿用上一可用游标（GOOD_CURSOR），绝不换成 4097 的非法值')
  assert.equal(store.get('wechat:ACC_A:sync_buf'), 'NEXT', '拿到合法新游标后才推进')
  assert.ok(lines.some((line) => line.includes('已拒收并保留旧游标')), '拒收必须出声')
})

test('reconnect/backoff is bounded: sleeps stay within [retryDelayMs, backoffDelayMs] and reset after a backoff', async () => {
  const sleeps = []
  let polls = 0
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('getupdates')) {
      polls += 1
      if (polls <= 5) return new Response(JSON.stringify({ ret: -1, errmsg: 'boom' }), { status: 200 })
      if (polls === 6) return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'OK', msgs: [] }), { status: 200 })
      // 恢复成功、游标稳固后挂起：模拟真实 35s 长轮询，避免紧循环饿死定时器
      return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  }
  const bounded = { ...config, retryDelayMs: 1000, backoffDelayMs: 5000 }
  const inbound = createWechatIlinkInbound({ config: bounded, store: storeOf(), bus: { accept: () => ({ ok: true }) }, fetchImpl, sleep: async (ms) => { sleeps.push(ms) } })
  inbound.start()
  await new Promise((resolve) => setTimeout(resolve, 15))
  await inbound.stop()
  assert.deepEqual(sleeps, [1000, 1000, 5000, 1000, 1000], '退避有界：<3 快重试，≥3 复位后再快重试，永不超过 backoffDelayMs')
  assert.ok(sleeps.every((ms) => ms <= 5000), '任何重连等待都不超过退避上限')
})

test('session expiry: clears account-scoped state and reports qr-required', async () => {
  const store = storeOf({
    'wechat:ACC_A:sync_buf': 'OLD',
    'wechat:ACC_A:ctx:USER_A': 'CTX',
    'wechat:ACC_A:account': { accountId: 'ACC_A' },
    'wechat:account': { accountId: 'ACC_A' }, // 全局登录凭证（登录 CLI 落盘）也应一并清
  })
  const fetchImpl = async (url) => {
    if (String(url).includes('getupdates')) return new Response(JSON.stringify({ ret: -14, errmsg: 'session expired' }), { status: 200 })
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  }
  const inbound = createWechatIlinkInbound({ config, store, bus: { accept: () => ({ ok: true }) }, fetchImpl, sleep: async () => {} })
  inbound.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(inbound.status().state, 'qr-required', '会话过期后状态必须上报 qr-required')
  assert.equal(inbound.status().qrRequired, true)
  assert.equal(store.get('wechat:ACC_A:sync_buf'), undefined, '账户级游标已清')
  assert.equal(store.get('wechat:ACC_A:ctx:USER_A'), undefined, '账户级 ctx 已清')
  assert.equal(store.get('wechat:ACC_A:account'), undefined, '账户级凭证已清')
  assert.equal(store.get('wechat:account'), undefined, '全局登录凭证已清')
  await inbound.stop()
})

test('image download oversize never blocks text delivery', async () => {
  const store = storeOf()
  const accepted = []
  const lines = []
  const logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
  let updateOnce = true
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('getupdates')) {
      if (updateOnce) {
        updateOnce = false
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'C1', msgs: [{
          from_user_id: 'USER_A', message_id: 'M1',
          item_list: [{ type: 1, text_item: { text: '文字' } }, { type: 2, image_item: { media_id: 'media-1' } }],
        }] }), { status: 200 })
      }
      return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  }
  const inbound = createWechatIlinkInbound({
    config, store, bus: { accept: (e) => { accepted.push(e); return { ok: true } } }, logger, fetchImpl, sleep: async () => {},
    mediaAdapter: { downloadInboundImage: async () => ({ size: 999_999_999 }) },
  })
  inbound.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await inbound.stop()
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].text, '文字', '超限图片绝不阻断文字投递')
  assert.ok(lines.some((line) => line.includes('超过上限')), '超限丢弃必须出声')
})

test('image download timeout never blocks text delivery', async () => {
  const store = storeOf()
  const accepted = []
  const lines = []
  const logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
  let updateOnce = true
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('getupdates')) {
      if (updateOnce) {
        updateOnce = false
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'C2', msgs: [{
          from_user_id: 'USER_A', message_id: 'M2',
          item_list: [{ type: 1, text_item: { text: '文字就绪' } }, { type: 2, image_item: { media_id: 'media-2' } }],
        }] }), { status: 200 })
      }
      return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  }
  const inbound = createWechatIlinkInbound({
    config, imageDownloadTimeoutMs: 1000, // 顶层 option，非 config 子键（见 legacy-core clampInt 读取路径）
    store, bus: { accept: (e) => { accepted.push(e); return { ok: true } } }, logger, fetchImpl, sleep: async () => {},
    mediaAdapter: { downloadInboundImage: () => new Promise(() => {}) }, // 永不返回 → 触发超时
  })
  inbound.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(accepted.length, 1, '图片下载未返回时文字/控制命令已先行投递')
  assert.equal(accepted[0].text, '文字就绪')
  await new Promise((resolve) => setTimeout(resolve, 1200)) // 等插入的 1000ms 下载超时触发
  assert.ok(lines.some((line) => line.includes('图片下载超时')), '超时告警必须出声')
  await inbound.stop()
})

test('G-03: outbound chunking is codepoint-safe — astral emoji/ZWJ never split into lone surrogates', async () => {
  // 孤立代理项探测器（实现无关）：高代理后无低代理 / 低代理前无高代理
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  const store = storeOf()
  const sentTexts = []
  // 13 码点（含星体平面 🀄/𝕏 与 ZWJ 序列 🏳️‍🌈=4 码点）：chunkSize=4 时旧码元切片
  // 会在第 4 码元处切开代理对（首块退化为 'a🀄b'+孤立高代理）
  const reply = 'a🀄b𝕏c🀄d🏳️‍🌈e𝕏'
  let updateOnce = true
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('getupdates')) {
      if (updateOnce) {
        updateOnce = false
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'CURSOR_CP', msgs: [{
          from_user_id: 'USER_A', message_id: 'M_CP',
          item_list: [{ type: 1, text_item: { text: '跑一下测试' } }],
        }] }), { status: 200 })
      }
      return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    if (String(url).includes('sendmessage')) {
      sentTexts.push(String(JSON.parse(init.body).msg.item_list[0].text_item.text))
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  }
  const inbound = createWechatIlinkInbound({
    config: { ...config, chunkSize: 4 },
    store,
    bus: { accept: () => ({ reply }) },
    fetchImpl,
    sleep: async () => {},
  })
  inbound.start()
  await new Promise((resolve) => setTimeout(resolve, 15))
  await inbound.stop()
  assert.equal(sentTexts.length, 4, '13 码点按 4 码点/块应切 4 块')
  assert.equal(sentTexts[0], 'a🀄b𝕏', '首块必须按码点切（码元切片会得到 \'a🀄b\'+孤立代理项）')
  assert.equal(sentTexts.join(''), reply, '块拼接无损（跨块 emoji 不丢字）')
  for (const [index, text] of sentTexts.entries()) {
    assert.equal(LONE_SURROGATE.test(text), false, `第 ${index + 1} 块含孤立代理项: ${JSON.stringify(text)}`)
    assert.ok(Array.from(text).length <= 4, `第 ${index + 1} 块超码点预算`)
  }
})
