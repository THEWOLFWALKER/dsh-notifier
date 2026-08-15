// 阶段 3.2 测试：inbound/_dingtalk-auth（钉钉设备授权流协议层，dsh-im MIT 移植）。
// fetch 全 mock（脚本化 init/begin/poll 序列），零联网。
// 覆盖：start 两次 POST 精确形状、start 各失败归类（http-error/invalid-json/missing-field）、
// poll 四态归一（含凭证蛇形转驼峰）、poll 失败归类（api-error/network-error/timeout）、
// baseUrl 域名白名单、安全军规（所有错误路径不泄漏凭证值）、fetchImpl 缺省回落引用相等。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTH_ERROR_CODES,
  DINGTALK_BASE_URL,
  createDingtalkAuth,
  validateDingtalkBaseUrl,
} from '../src/inbound/_dingtalk-auth.mjs'

const BASE = DINGTALK_BASE_URL // https://oapi.dingtalk.com

/**
 * 脚本化 fetch：按序出队（对象 → Response；函数 → 自定义行为/抛错），记录全部调用形状。
 * 队列耗尽即抛错——任何"未预期的额外请求"都会让测试失败。
 */
function makeFetch(script = []) {
  const calls = []
  const queue = [...script]
  const fetchImpl = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: { ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    }
    calls.push(record)
    const next = queue.shift()
    if (next === undefined) throw new Error('测试脚本队列耗尽（出现了未预期的额外请求）')
    if (typeof next === 'function') return next(record)
    const { status = 200, body = {}, text } = next
    if (text !== undefined) {
      return new Response(text, { status, headers: { 'content-type': 'text/plain' } })
    }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

/** 断言 reject 并捕获错误对象（供后续 code/消息断言复用）。 */
async function captureReject(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('预期抛错但正常返回了')
}

// ---------------------------------------------------------------- start 成功

test('start 成功：init→begin 两次 POST 的 URL/方法/头/载荷精确形状；返回冻结三字段', async () => {
  const { fetchImpl, calls } = makeFetch([
    { body: { result: { verification_code: 'VC_1', expire_in: 300 } } },
    { body: { result: { qr_code_url: 'https://qr.dingtalk.com/action/qr?vc=VC_1', expire_in: 240 } } },
  ])
  const auth = createDingtalkAuth({ fetchImpl })
  const started = await auth.start()

  assert.equal(calls.length, 2, '恰好两次请求（init + begin），无多余轮询')
  const [initCall, beginCall] = calls

  assert.equal(initCall.url, `${BASE}/app/registration/init`)
  assert.equal(initCall.method, 'POST')
  assert.equal(initCall.headers['content-type'], 'application/json')
  assert.deepEqual(initCall.body, { registration_type: 2, template_types: [2] }, 'init 载荷精确形状（无多余字段）')
  assert.ok(initCall.signal instanceof AbortSignal, '每请求都带 AbortSignal 超时信号')

  assert.equal(beginCall.url, `${BASE}/app/registration/begin`)
  assert.equal(beginCall.method, 'POST')
  assert.equal(beginCall.headers['content-type'], 'application/json')
  assert.deepEqual(beginCall.body, { verification_code: 'VC_1' }, 'begin 只回显 verification_code')

  assert.deepEqual(started, {
    verificationCode: 'VC_1',
    qrUrl: 'https://qr.dingtalk.com/action/qr?vc=VC_1',
    expireIn: 240,
  }, 'expireIn 取 begin 响应优先（更贴近二维码真实有效期）')
  assert.ok(Object.isFrozen(started), 'start() 返回冻结对象')
})

test('start init 与 begin 均缺 expire_in 时 expireIn 回落 0', async () => {
  const { fetchImpl } = makeFetch([
    { body: { result: { verification_code: 'VC_2' } } },
    { body: { result: { qr_code_url: 'https://qr.dingtalk.com/x' } } },
  ])
  const auth = createDingtalkAuth({ fetchImpl })
  const started = await auth.start()
  assert.equal(started.expireIn, 0)
  assert.equal(started.verificationCode, 'VC_2')
})

// ---------------------------------------------------------------- start 失败归类

test('start init HTTP 非 2xx → http-error（带 httpStatus）', async () => {
  const { fetchImpl } = makeFetch([{ status: 502, body: { errcode: 502, errmsg: 'bad gateway' } }])
  const auth = createDingtalkAuth({ fetchImpl })
  const error = await captureReject(auth.start())
  assert.equal(error.code, 'http-error')
  assert.equal(error.httpStatus, 502)
  assert.match(error.message, /HTTP 502/)
})

test('start init 响应非 JSON（2xx HTML 网关页）→ invalid-json', async () => {
  const { fetchImpl } = makeFetch([{ status: 200, text: '<html>gateway maintenance</html>' }])
  const auth = createDingtalkAuth({ fetchImpl })
  const error = await captureReject(auth.start())
  assert.equal(error.code, 'invalid-json')
  assert.match(error.message, /非 JSON/)
})

test('start init result 缺 verification_code → missing-field（只报字段名不带值）', async () => {
  const { fetchImpl } = makeFetch([{ body: { result: { expire_in: 300 } } }])
  const auth = createDingtalkAuth({ fetchImpl })
  const error = await captureReject(auth.start())
  assert.equal(error.code, 'missing-field')
  assert.match(error.message, /verification_code/)
  assert.equal(error.endpoint, '/app/registration/init')
})

test('start 串联：init 成功后 begin HTTP 非 2xx → http-error', async () => {
  const { fetchImpl, calls } = makeFetch([
    { body: { result: { verification_code: 'VC_3', expire_in: 300 } } },
    { status: 403, body: { errcode: 403, errmsg: 'forbidden' } },
  ])
  const auth = createDingtalkAuth({ fetchImpl })
  const error = await captureReject(auth.start())
  assert.equal(error.code, 'http-error')
  assert.equal(error.httpStatus, 403)
  assert.equal(calls.length, 2, 'init 已发出且成功，失败点在 begin')
})

test('start begin result 缺 qr_code_url → missing-field', async () => {
  const { fetchImpl } = makeFetch([
    { body: { result: { verification_code: 'VC_4', expire_in: 300 } } },
    { body: { result: { expire_in: 300 } } },
  ])
  const auth = createDingtalkAuth({ fetchImpl })
  const error = await captureReject(auth.start())
  assert.equal(error.code, 'missing-field')
  assert.match(error.message, /qr_code_url/)
  assert.equal(error.endpoint, '/app/registration/begin')
})

// ---------------------------------------------------------------- poll 四态

test('poll WAITING：小写归一大写、查询串 URL 编码、无 credentials/error 字段', async () => {
  const { fetchImpl, calls } = makeFetch([{ body: { result: { status: 'waiting' } } }])
  const auth = createDingtalkAuth({ fetchImpl })
  const verdict = await auth.poll('VC 9&x=1')
  assert.equal(calls[0].url, `${BASE}/app/registration/poll?verification_code=VC%209%26x%3D1`)
  assert.equal(calls[0].method, 'GET')
  assert.deepEqual(verdict, { status: 'WAITING' })
  assert.equal(verdict.credentials, undefined)
  assert.equal(verdict.error, undefined)
})

test('poll SUCCESS：app_key/app_secret 蛇形转驼峰；GET 不带 body；结果与凭证均冻结', async () => {
  const { fetchImpl, calls } = makeFetch([
    { body: { result: { status: 'success', app_key: 'ding0abc', app_secret: 'SEC_OK' } } },
  ])
  const auth = createDingtalkAuth({ fetchImpl })
  const verdict = await auth.poll('VC_9')
  assert.equal(calls[0].url, `${BASE}/app/registration/poll?verification_code=VC_9`)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].body, undefined, 'GET 无 body')
  assert.equal(calls[0].headers['content-type'], undefined, 'GET 不需要 content-type')
  assert.deepEqual(verdict, { status: 'SUCCESS', credentials: { appKey: 'ding0abc', appSecret: 'SEC_OK' } })
  assert.ok(Object.isFrozen(verdict) && Object.isFrozen(verdict.credentials))
})

test('poll FAIL：status=FAIL + 服务端 fail_reason 文案透传', async () => {
  const { fetchImpl } = makeFetch([{ body: { result: { status: 'FAIL', fail_reason: '用户在手机端拒绝了授权' } } }])
  const auth = createDingtalkAuth({ fetchImpl })
  const verdict = await auth.poll('VC_F')
  assert.deepEqual(verdict, { status: 'FAIL', error: '用户在手机端拒绝了授权' })
  assert.equal(verdict.credentials, undefined)
})

test('poll EXPIRED：无服务端文案时给默认中文过期提示', async () => {
  const { fetchImpl } = makeFetch([{ body: { result: { status: 'expired' } } }])
  const auth = createDingtalkAuth({ fetchImpl })
  const verdict = await auth.poll('VC_E')
  assert.equal(verdict.status, 'EXPIRED')
  assert.match(verdict.error, /过期/)
  assert.equal(verdict.credentials, undefined)
})

// ---------------------------------------------------------------- poll 失败归类

test('poll 服务端 errcode≠0（HTTP 200）→ api-error（带 errcode 与 errmsg）', async () => {
  const { fetchImpl } = makeFetch([{ body: { errcode: 90001, errmsg: 'flow control' } }])
  const auth = createDingtalkAuth({ fetchImpl })
  const error = await captureReject(auth.poll('VC_5'))
  assert.equal(error.code, 'api-error')
  assert.equal(error.errcode, 90001)
  assert.match(error.message, /90001/)
  assert.match(error.message, /flow control/)
})

test('poll 网络异常（fetch reject TypeError）→ network-error', async () => {
  const { fetchImpl } = makeFetch([() => { throw new TypeError('fetch failed') }])
  const auth = createDingtalkAuth({ fetchImpl })
  const error = await captureReject(auth.poll('VC_N'))
  assert.equal(error.code, 'network-error')
  assert.match(error.message, /fetch failed/)
})

test('poll 超时注入：AbortError/TimeoutError 都归类 timeout；请求确带 AbortSignal', async () => {
  // AbortError（signal 被 abort 的标准形态）
  const abortRig = makeFetch([(call) => {
    assert.ok(call.signal instanceof AbortSignal, '超时必须经 AbortSignal.timeout 注入')
    throw new DOMException('This operation was aborted', 'AbortError')
  }])
  const abortAuth = createDingtalkAuth({ fetchImpl: abortRig.fetchImpl, timeoutMs: 50 })
  const abortError = await captureReject(abortAuth.poll('VC_T1'))
  assert.equal(abortError.code, 'timeout')
  assert.match(abortError.message, /超时/)
  assert.match(abortError.message, /50ms/)

  // TimeoutError（AbortSignal.timeout 到期的原生形态）
  const timeoutRig = makeFetch([() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  }])
  const timeoutAuth = createDingtalkAuth({ fetchImpl: timeoutRig.fetchImpl, timeoutMs: 100 })
  const timeoutError = await captureReject(timeoutAuth.poll('VC_T2'))
  assert.equal(timeoutError.code, 'timeout', 'TimeoutError 与 AbortError 同归 timeout')
})

test('poll SUCCESS 但 app_secret 缺失 → incomplete-registration（不回显已到手的 app_key）', async () => {
  const { fetchImpl } = makeFetch([{ body: { result: { status: 'SUCCESS', app_key: 'dingHALF' } } }])
  const auth = createDingtalkAuth({ fetchImpl })
  const error = await captureReject(auth.poll('VC_H'))
  assert.equal(error.code, 'incomplete-registration')
  assert.match(error.message, /app_key\/app_secret/)
  assert.ok(!error.message.includes('dingHALF'), '半截凭证值绝不进错误消息')
})

test('poll 漏传/空 verificationCode → missing-field 且零联网', async () => {
  const { fetchImpl, calls } = makeFetch([])
  const auth = createDingtalkAuth({ fetchImpl })
  const noArg = await captureReject(auth.poll())
  assert.equal(noArg.code, 'missing-field')
  const emptyArg = await captureReject(auth.poll(''))
  assert.equal(emptyArg.code, 'missing-field')
  assert.equal(calls.length, 0, '参数缺陷在校验期拦截，不发出任何请求')
})

// ---------------------------------------------------------------- baseUrl 安全校验

test('baseUrl 校验：http:// 拒、非 dingtalk 域拒、仿冒域拒、裸域/子域/尾斜杠归一放行', () => {
  const { fetchImpl } = makeFetch([])
  const expectInvalid = (baseUrl) => {
    assert.throws(
      () => createDingtalkAuth({ fetchImpl, baseUrl }),
      (error) => error.code === 'invalid-base-url',
      `应拒绝 ${baseUrl}`,
    )
  }
  expectInvalid('http://oapi.dingtalk.com')            // 明文 http：拒
  expectInvalid('https://evil.com')                    // 无关域名：拒
  expectInvalid('https://oapi.dingtalk.com.evil.com')  // 子域后缀仿冒：拒
  expectInvalid('https://evil-dingtalk.com')           // 连字符仿冒（非 .dingtalk.com 结尾）：拒
  assert.throws(() => validateDingtalkBaseUrl('not a url'), (e) => e.code === 'invalid-base-url')

  // 放行 + 归一
  assert.equal(validateDingtalkBaseUrl('https://oapi.dingtalk.com/'), 'https://oapi.dingtalk.com', '去尾斜杠')
  assert.equal(validateDingtalkBaseUrl('https://dingtalk.com'), 'https://dingtalk.com', '裸域等于 dingtalk.com 放行')
  assert.equal(validateDingtalkBaseUrl('https://OAPI.DingTalk.com'), 'https://oapi.dingtalk.com', 'host 大小写归一')
  assert.equal(createDingtalkAuth({ fetchImpl, baseUrl: 'https://api.dingtalk.com' }).baseUrl, 'https://api.dingtalk.com')
  assert.equal(validateDingtalkBaseUrl('https://dingtalk.com:8080/x'), 'https://dingtalk.com:8080/x', '合法域 + 端口/路径放行（域名判定只看 hostname）')
})

// ---------------------------------------------------------------- 安全军规

test('安全军规：全部错误路径不泄漏凭证值（含非 2xx 响应体回显脱敏）；错误码恰七类', async () => {
  const LEAK_SECRET = 'SEC_DO_NOT_LEAK'
  const LEAK_KEY = 'dingKEY_DO_NOT_LEAK'
  const errors = []

  // http-error：网关在错误体里回显凭证字段 → 摘录必须先脱敏
  errors.push(await captureReject(createDingtalkAuth({
    fetchImpl: makeFetch([{ status: 500, body: { errmsg: 'internal error', app_key: LEAK_KEY, app_secret: LEAK_SECRET } }]).fetchImpl,
  }).start()))
  // http-error：凭证藏在嵌套对象里 → 递归脱敏也要掩到（v0.3.1 review 修复回归锚）
  errors.push(await captureReject(createDingtalkAuth({
    fetchImpl: makeFetch([{ status: 500, body: { error: { detail: 'bad', app_secret: LEAK_SECRET, nested: [{ token: LEAK_SECRET }] } } }]).fetchImpl,
  }).start()))
  // http-error：非 JSON 错误体夹带凭证字符串 → 无法脱敏则整体省略
  errors.push(await captureReject(createDingtalkAuth({
    fetchImpl: makeFetch([{ status: 500, text: `oops ${LEAK_SECRET}` }]).fetchImpl,
  }).start()))
  // api-error：业务错误载荷里夹带凭证 → 消息只取 errcode/errmsg
  errors.push(await captureReject(createDingtalkAuth({
    fetchImpl: makeFetch([{ body: { errcode: 7, errmsg: 'denied', result: { app_secret: LEAK_SECRET } } }]).fetchImpl,
  }).poll('VC_S1')))
  // missing-field：result 缺 verification_code 但带 app_secret → 只报字段名
  errors.push(await captureReject(createDingtalkAuth({
    fetchImpl: makeFetch([{ body: { result: { expire_in: 300, app_secret: LEAK_SECRET } } }]).fetchImpl,
  }).start()))
  // incomplete-registration：只拿到一半凭证 → 不回显已到手值
  errors.push(await captureReject(createDingtalkAuth({
    fetchImpl: makeFetch([{ body: { result: { status: 'SUCCESS', app_key: LEAK_KEY } } }]).fetchImpl,
  }).poll('VC_S2')))
  // invalid-json / network-error / timeout
  errors.push(await captureReject(createDingtalkAuth({
    fetchImpl: makeFetch([{ status: 200, text: `<html>${LEAK_SECRET}</html>` }]).fetchImpl,
  }).start()))
  // network-error：传输层异常消息本身不含凭证（凭证只可能出现在响应体，而响应体从不进网络错消息）
  errors.push(await captureReject(createDingtalkAuth({
    fetchImpl: makeFetch([() => { throw new TypeError('fetch failed') }]).fetchImpl,
  }).poll('VC_S3')))
  errors.push(await captureReject(createDingtalkAuth({
    fetchImpl: makeFetch([() => { throw new DOMException('aborted', 'AbortError') }]).fetchImpl,
  }).poll('VC_S4')))

  const codes = new Set(errors.map((error) => error.code))
  for (const code of AUTH_ERROR_CODES) {
    assert.ok(codes.has(code), `安全用例应覆盖错误码 ${code}`)
  }
  for (const error of errors) {
    // JSON.stringify(error) 只含可枚举自有属性；再补 message/code/endpoint 等诊断面
    const dump = JSON.stringify({ message: error.message, code: error.code, endpoint: error.endpoint, httpStatus: error.httpStatus, errcode: error.errcode })
    assert.ok(!JSON.stringify(error).includes(LEAK_SECRET), `JSON.stringify(error) 泄漏 secret（code=${error.code}）`)
    assert.ok(!JSON.stringify(error).includes(LEAK_KEY), `JSON.stringify(error) 泄漏 app_key（code=${error.code}）`)
    assert.ok(!dump.includes(LEAK_SECRET), `错误消息/属性泄漏 secret（code=${error.code}）：${dump}`)
    assert.ok(!dump.includes(LEAK_KEY), `错误消息/属性泄漏 app_key（code=${error.code}）：${dump}`)
  }
  assert.deepEqual([...AUTH_ERROR_CODES], [
    'timeout', 'http-error', 'invalid-json', 'api-error',
    'network-error', 'missing-field', 'incomplete-registration',
  ], '错误码七类清单恰好这些，不多不少')
})

// ---------------------------------------------------------------- 默认参数回落

test('默认参数回落：不传 fetchImpl 时引用相等（=== globalThis.fetch，不重绑）', () => {
  const auth = createDingtalkAuth({})
  assert.equal(auth.fetchImpl, globalThis.fetch, '缺省回落 globalThis.fetch 且保持引用相等')
  assert.equal(auth.baseUrl, 'https://oapi.dingtalk.com')
  assert.equal(auth.timeoutMs, 10000)
  assert.equal(typeof auth.start, 'function')
  assert.equal(typeof auth.poll, 'function')

  const noop = async () => new Response('{}')
  const injected = createDingtalkAuth({ fetchImpl: noop })
  assert.equal(injected.fetchImpl, noop, '显式注入优先于缺省回落')
})
