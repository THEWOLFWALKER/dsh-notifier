// v0.3.3 测试：admin/scan（网页扫码流状态机，函数级无 HTTP 无网络）。
// 覆盖面：createScanHandlers 装配与注入点、轮询契约统一（绝不 throw 总测例 + 形状归一）、
// 阻塞式流机（qq/feishu：首调宽限、ok/非 ok 终态、终态取走复位重开、begin 异常吸收、迟到回调）、
// 钉钉步进式流机（WAITING/EXPIRED 自动刷新上限/SUCCESS 落盘形状/凭证缺失/FAIL/
// 结构性错误 fail-fast/瞬态重试/start 异常/store 抛错降级）。
// mock：全部经 createScanHandlers({ store, logger, timeoutMs, qqBegin, feishuBegin,
// dingtalkAuthFactory }) 注入点打桩，绝不触真实网络；store 用内存对象记录 set 调用；
// 阻塞式首调的 1500ms 二维码宽利用 t.mock.timers（只 mock setTimeout，微任务保持真实时序）
// 或让 onQr 在 begin 内同步回调，整个文件毫秒级跑完。
//
// 注意：原两处标注【疑似缺陷】的用例（begin 同步 throw / 迟到 onQr 污染）已在
// scan.mjs 以「同步异常归一终态 + generation 代次丢弃迟到回调」修复，此处为正向契约断言。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createScanHandlers } from '../src/admin/scan.mjs'

/** 阻塞式首调等待二维码到达的宽限毫秒（对齐 scan.mjs 的 FIRST_QR_WAIT_MS）。 */
const FIRST_QR_WAIT_MS = 1500

/** 内存 mock store：记录 set 调用形状（钉钉凭证落盘断言用）。 */
function makeStore() {
  const sets = []
  const store = { set: (key, value) => { sets.push([key, value]) } }
  return { store, sets }
}

/**
 * 钉钉 auth 步进 mock：脚本化 start/poll 结果序列（序列项为 Error 时 poll 抛出），
 * start 缺省补一个合法会话；calls 记录 poll 收到的 verificationCode 与 start 次数。
 */
function makeDingtalkAuth({ starts = [], polls = [] } = {}) {
  const calls = { startResults: [], poll: [] }
  let startIdx = 0
  let pollIdx = 0
  const auth = {
    start: async () => {
      const session = starts[startIdx] ?? { verificationCode: 'VC-default', qrUrl: 'https://qr.example/default' }
      startIdx += 1
      calls.startResults.push(session)
      return session
    },
    poll: async (code) => {
      calls.poll.push(code)
      const result = polls[pollIdx]
      pollIdx += 1
      if (result instanceof Error) throw result
      return result
    },
  }
  return { auth, calls }
}

/** 让事件循环走一拍（背景 Promise 落定传播用；用 setImmediate，不受 mock.timers 影响）。 */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** 形状校验：轮询契约的合法返回对象（qrContent 恒字符串、done 恒布尔）。 */
function assertPollShape(result) {
  assert.equal(typeof result.qrContent, 'string', 'qrContent 必须是字符串')
  assert.equal(typeof result.done, 'boolean', 'done 必须是布尔')
}

// ———————— 装配与注入点 ————————

test('装配：返回 qq/dingtalk/feishu 三个 handler，注入点接线正确（begin 收 onQr、工厂无参调用一次）', async () => {
  const beginArgs = { qq: null, feishu: null }
  let factoryCalls = 0
  let factoryArgCount = -1
  const { auth } = makeDingtalkAuth()
  const { store } = makeStore()
  const handlers = createScanHandlers({
    store,
    logger: { warn() {} },
    timeoutMs: 60_000,
    qqBegin: (onQr) => { beginArgs.qq = onQr; onQr('https://qr.example/qq'); return new Promise(() => {}) },
    feishuBegin: (onQr) => { beginArgs.feishu = onQr; onQr('https://qr.example/feishu'); return new Promise(() => {}) },
    dingtalkAuthFactory: (...args) => { factoryCalls += 1; factoryArgCount = args.length; return auth },
  })
  // handler 表形状：三个渠道各一个函数（admin/api 的 scanHandlers 消费形态）
  assert.deepEqual(Object.keys(handlers).sort(), ['dingtalk', 'feishu', 'qq'])
  assert.ok(['qq', 'dingtalk', 'feishu'].every((name) => typeof handlers[name] === 'function'))
  // 注入点：qq/feishu 各自独立成流，begin 收到的第一个参数是 onQr 回调函数
  assert.deepEqual(await handlers.qq(), { qrContent: 'https://qr.example/qq', done: false })
  assert.deepEqual(await handlers.feishu(), { qrContent: 'https://qr.example/feishu', done: false })
  assert.equal(typeof beginArgs.qq, 'function')
  assert.equal(typeof beginArgs.feishu, 'function')
  assert.notEqual(beginArgs.qq, beginArgs.feishu) // 两流互不共享回调
  // 钉钉：工厂在装配期即被调用一次（无参），产物即 handler 的 auth 实例
  assert.equal(factoryCalls, 1)
  assert.equal(factoryArgCount, 0)
  assert.deepEqual(await handlers.dingtalk(), { qrContent: 'https://qr.example/default', done: false })
})

// ———————— 轮询契约统一：绝不 throw 总测例 ————————

test('绝不 throw 总测例：begin 各种异常 resolve/reject 形状下，每次调用都返回形状合法对象', async () => {
  // 六种「坏形状」：rejected Error / rejected 裸字符串 / resolve null / resolve 字符串 /
  // resolve 非法 status 数字 / resolve 无 status 空对象——全部归一为中文 error 终态
  const shapes = [
    ['rejected Error', (onQr) => { onQr('https://qr.example/x'); return Promise.reject(new Error('SDK 内部崩溃')) }, 'SDK 内部崩溃'],
    ['rejected 裸字符串', (onQr) => { onQr('https://qr.example/x'); return Promise.reject('裸字符串异常') }, '裸字符串异常'],
    ['resolve null', (onQr) => { onQr('https://qr.example/x'); return Promise.resolve(null) }, '扫码流程异常终止'],
    ['resolve 字符串', (onQr) => { onQr('https://qr.example/x'); return Promise.resolve('ok') }, '扫码未完成（failed），请重新发起'],
    ['resolve 非法 status', (onQr) => { onQr('https://qr.example/x'); return Promise.resolve({ status: 42 }) }, '扫码未完成（42），请重新发起'],
    ['resolve 空对象', (onQr) => { onQr('https://qr.example/x'); return Promise.resolve({}) }, '扫码未完成（failed），请重新发起'],
  ]
  for (const [name, qqBegin, expectedError] of shapes) {
    const { qq } = createScanHandlers({ qqBegin })
    const first = await qq() // 首调：不 throw，二维码已到 → done:false
    assertPollShape(first)
    assert.deepEqual(first, { qrContent: 'https://qr.example/x', done: false }, `${name}：首调形状`)
    await settle() // 等背景 Promise 落定传播
    const terminal = await qq() // 次调：取终态，不 throw，归一为中文 error
    assertPollShape(terminal)
    assert.equal(terminal.done, true, `${name}：终态 done`)
    assert.equal(terminal.error, expectedError, `${name}：终态 error 文案`)
    assert.equal('saved' in terminal, false, `${name}：失败终态不带 saved`)
  }
})

// ———————— 阻塞式流机（qq/feishu，makeBlockingHandler） ————————

test('阻塞式首调：onQr 已回调则带出二维码 + done:false；running 期重复调用不重启流且二维码稳定', async () => {
  let beginCalls = 0
  const { qq } = createScanHandlers({
    qqBegin: (onQr) => {
      beginCalls += 1
      onQr('https://qr.example/qq-1') // SDK 典型行为：发起后立即推二维码
      return new Promise(() => {}) // 扫码中，长期 pending
    },
  })
  const first = await qq()
  assert.deepEqual(first, { qrContent: 'https://qr.example/qq-1', done: false })
  // running 期：UI 2s 轮询连打多次，都返回同一二维码且绝不重新发起 begin
  const second = await qq()
  const third = await qq()
  assert.deepEqual(second, { qrContent: 'https://qr.example/qq-1', done: false })
  assert.deepEqual(third, { qrContent: 'https://qr.example/qq-1', done: false })
  assert.equal(beginCalls, 1)
})

test('阻塞式首调：二维码宽限期内未到达 → 空串返回 done:false（不等死，UI 下轮自然取到）', async (t) => {
  // 只 mock setTimeout：Promise.race 的宽限分支由 tick 直接触发，微任务保持真实时序
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { feishu } = createScanHandlers({ feishuBegin: () => new Promise(() => {}) }) // 既不发码也不结束
  const pending = feishu() // 同步跑到 Promise.race，注册 1500ms 宽限定时器
  t.mock.timers.tick(FIRST_QR_WAIT_MS) // 宽限耗尽
  const result = await pending
  assert.deepEqual(result, { qrContent: '', done: false })
})

test('阻塞式 ok 终态：done:true + saved:true + 二维码保留；scan 层不写 store（凭证由 begin 侧自写）', async () => {
  const { store, sets } = makeStore()
  let settleBegin = null
  const { qq } = createScanHandlers({
    qqBegin: (onQr) => {
      onQr('https://qr.example/ok')
      return new Promise((resolve) => { settleBegin = resolve })
    },
  })
  assert.deepEqual(await qq(), { qrContent: 'https://qr.example/ok', done: false })
  settleBegin({ status: 'ok', appId: 'app-1' }) // qqScan 形态：ok 终态（凭证由其自写 qq:account）
  await settle()
  assert.deepEqual(await qq(), { qrContent: 'https://qr.example/ok', done: true, saved: true })
  assert.deepEqual(sets, []) // 契约：阻塞式凭证落盘归 qqScan/feishuRegister，scan 层绝不碰 store
})

test('阻塞式终态取走后复位：下次调用重开新流，可再完整走一轮到 saved:true', async () => {
  let round = 0
  let settleRound = null
  const { feishu } = createScanHandlers({
    feishuBegin: (onQr) => {
      round += 1
      onQr(`https://qr.example/round-${round}`)
      return new Promise((resolve) => { settleRound = resolve })
    },
  })
  // 第一轮：发起 → ok 终态取走
  assert.deepEqual(await feishu(), { qrContent: 'https://qr.example/round-1', done: false })
  settleRound({ status: 'ok' })
  await settle()
  assert.deepEqual(await feishu(), { qrContent: 'https://qr.example/round-1', done: true, saved: true })
  // 复位验证：下一次调用是新流（begin 第二次发起、新二维码），可再走一轮
  assert.deepEqual(await feishu(), { qrContent: 'https://qr.example/round-2', done: false })
  assert.equal(round, 2)
  settleRound({ status: 'ok' })
  await settle()
  assert.deepEqual(await feishu(), { qrContent: 'https://qr.example/round-2', done: true, saved: true })
})

test('阻塞式非 ok 终态：带 message 用原始文案，缺 message 用中文兜底（含状态名）', async () => {
  // timeout 带 message：error 透传原始文案
  let settleA = null
  const { qq } = createScanHandlers({
    qqBegin: (onQr) => { onQr('https://qr.example/timeout'); return new Promise((r) => { settleA = r }) },
  })
  await qq()
  settleA({ status: 'timeout', message: '二维码已过期，请重新发起' })
  await settle()
  assert.deepEqual(await qq(), { qrContent: 'https://qr.example/timeout', done: true, error: '二维码已过期，请重新发起' })
  // missing-sdk 缺 message：中文兜底文案包含状态名
  let settleB = null
  const { feishu } = createScanHandlers({
    feishuBegin: (onQr) => { onQr('https://qr.example/sdk'); return new Promise((r) => { settleB = r }) },
  })
  await feishu()
  settleB({ status: 'missing-sdk' })
  await settle()
  const result = await feishu()
  assert.equal(result.done, true)
  assert.equal(result.error, '扫码未完成（missing-sdk），请重新发起')
})

test('阻塞式 begin 返回 rejected Promise：终态 error 含异常消息，且不产生 unhandledRejection', async () => {
  let unhandled = 0
  const onUnhandled = () => { unhandled += 1 }
  process.on('unhandledRejection', onUnhandled)
  try {
    const { qq } = createScanHandlers({
      qqBegin: (onQr) => {
        onQr('https://qr.example/crash')
        return Promise.reject(new Error('网络连接中断'))
      },
    })
    const first = await qq() // 首调正常返回（背景 rejection 由流机吸收，绝不外泄）
    assert.deepEqual(first, { qrContent: 'https://qr.example/crash', done: false })
    await settle()
    await settle() // 留足事件循环拍数，若有未吸收 rejection 此处即被计为 unhandled
    const terminal = await qq()
    assert.deepEqual(terminal, { qrContent: 'https://qr.example/crash', done: true, error: '网络连接中断' })
    assert.equal(unhandled, 0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('阻塞式 begin 直接 throw：归一为 done:true + error 含异常消息（绝不 throw）', async () => {
  // 契约（scan.mjs 头注释与注入点语义）：任何 mock 异常形状下 handler 都返回形状合法对象，
  // 失败一律 done:true + error 含异常消息。此处覆盖两种「直接 throw」形状：
  //  1) begin 同步 throw；2) begin 返回非 Promise（undefined）。
  const { qq } = createScanHandlers({ qqBegin: () => { throw new Error('连接器初始化失败') } })
  const result = await qq()
  assert.equal(result.done, true, '同步 throw：应终态 done:true')
  assert.ok(result.error.includes('连接器初始化失败'), '同步 throw：error 应含异常消息')
  assert.equal(result.qrContent, '')
  const { feishu } = createScanHandlers({ feishuBegin: () => undefined })
  const resultB = await feishu()
  assert.equal(resultB.done, true, '返回非 Promise：应终态 done:true')
  assert.equal(typeof resultB.error, 'string', '返回非 Promise：应带 error')
})

test('阻塞式迟到回调：终态取走复位后旧流 onQr 再触发，不得污染新流（不崩 + 状态干净）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }) // 新流首调需吃满宽限，用 tick 免真实等待
  let fireOldQr = null
  let settleOld = null
  let round = 0
  const { qq } = createScanHandlers({
    qqBegin: (onQr) => {
      round += 1
      if (round === 1) {
        fireOldQr = onQr // 旧流的 onQr 句柄（模拟 SDK 在终态之后才补发的迟到回调）
        return new Promise((resolve) => { settleOld = resolve })
      }
      return new Promise(() => {}) // 新流：既不发码也不结束
    },
  })
  // 旧流：发起 → ok 终态取走（内部已复位）
  const first = qq()
  fireOldQr('https://qr.example/old')
  assert.deepEqual(await first, { qrContent: 'https://qr.example/old', done: false })
  settleOld({ status: 'ok' })
  await settle()
  assert.deepEqual(await qq(), { qrContent: 'https://qr.example/old', done: true, saved: true })
  // 迟到回调：不崩（当前实现满足——回调内部对空 resolve 句柄安全）
  assert.doesNotThrow(() => fireOldQr('https://qr.example/late'))
  // 不污染复位状态：新流在自身二维码到达前，不得携带旧流的迟到二维码
  const reopened = qq()
  t.mock.timers.tick(FIRST_QR_WAIT_MS)
  const result = await reopened
  assert.equal(result.done, false)
  assert.equal(result.qrContent, '', '复位后新流首调应从空二维码开始（迟到回调按代次丢弃）')
})

// ———————— 钉钉步进式流机（makeDingtalkHandler） ————————

test('钉钉基本流：首调带出 qrUrl + done:false，poll 收到 verificationCode，WAITING 继续且二维码稳定', async () => {
  const { auth, calls } = makeDingtalkAuth({
    starts: [{ verificationCode: 'VC-1', qrUrl: 'https://qr.example/dt-1' }],
    polls: [{ status: 'WAITING' }, { status: 'WAITING' }],
  })
  const { store } = makeStore()
  const { dingtalk } = createScanHandlers({ dingtalkAuthFactory: () => auth, store })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-1', done: false })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-1', done: false })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-1', done: false })
  assert.deepEqual(calls.poll, ['VC-1', 'VC-1']) // 轮询始终携带当前会话验证码
})

test('钉钉 EXPIRED：自动 begin() 刷新出新二维码（done:false 继续），刷新后可走到 SUCCESS', async () => {
  const { auth, calls } = makeDingtalkAuth({
    starts: [
      { verificationCode: 'VC-1', qrUrl: 'https://qr.example/dt-1' },
      { verificationCode: 'VC-2', qrUrl: 'https://qr.example/dt-2' },
    ],
    polls: [
      { status: 'EXPIRED' },
      { status: 'SUCCESS', credentials: { appKey: 'ak-1', appSecret: 'as-1' } },
    ],
  })
  const { store, sets } = makeStore()
  const { dingtalk } = createScanHandlers({ dingtalkAuthFactory: () => auth, store })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-1', done: false })
  // 过期 → 自动刷新：返回新会话二维码，流不终止
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-2', done: false })
  assert.equal(calls.startResults.length, 2)
  // 刷新后的会话可正常完成
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-2', done: true, saved: true })
  assert.equal(sets.length, 1)
})

test('钉钉连续过期上限：3 次自动刷新后第 4 次过期 → done:true + error；终态复位后可重开新会话', async () => {
  const starts = Array.from({ length: 5 }, (_, i) => ({ verificationCode: `VC-${i}`, qrUrl: `https://qr.example/dt-${i}` }))
  const polls = Array.from({ length: 4 }, () => ({ status: 'EXPIRED' }))
  const { auth, calls } = makeDingtalkAuth({ starts, polls })
  const { dingtalk } = createScanHandlers({ dingtalkAuthFactory: () => auth })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-0', done: false })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-1', done: false }) // 刷新 1
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-2', done: false }) // 刷新 2
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-3', done: false }) // 刷新 3（上限）
  // 第 4 次过期：超过刷新上限 → 终态失败，用户重新发起
  const terminal = await dingtalk()
  assert.equal(terminal.done, true)
  assert.equal(terminal.error, '二维码已连续过期 3 次，请重新发起扫码')
  assert.equal(calls.startResults.length, 4) // 首次 + 3 次刷新，第 4 次过期不再刷新
  // 终态取走后复位：restarts 归零，下次调用重开新会话
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt-4', done: false })
  assert.equal(calls.startResults.length, 5)
})

test('钉钉 SUCCESS：store.set("dingtalk:account", { appKey, appSecret, at: 数字 })，返回 saved:true', async () => {
  const { auth } = makeDingtalkAuth({
    starts: [{ verificationCode: 'VC-1', qrUrl: 'https://qr.example/dt' }],
    polls: [{ status: 'SUCCESS', credentials: { appKey: 'ak-9', appSecret: 'as-9' } }],
  })
  const { store, sets } = makeStore()
  const { dingtalk } = createScanHandlers({ dingtalkAuthFactory: () => auth, store })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt', done: false })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt', done: true, saved: true })
  // 落盘形状：键名与 CLI 同形，at 为数字时间戳
  assert.equal(sets.length, 1)
  const [key, value] = sets[0]
  assert.equal(key, 'dingtalk:account')
  assert.equal(value.appKey, 'ak-9')
  assert.equal(value.appSecret, 'as-9')
  assert.equal(typeof value.at, 'number')
  assert.deepEqual(Object.keys(value).sort(), ['appKey', 'appSecret', 'at'])
})

test('钉钉 SUCCESS 凭证缺失（缺 appKey / 缺 appSecret）：done:true + error，绝不落盘半截凭证', async () => {
  // 缺 appKey
  const missingKey = makeDingtalkAuth({
    starts: [{ verificationCode: 'VC', qrUrl: 'https://qr.example/dt' }],
    polls: [{ status: 'SUCCESS', credentials: { appSecret: 'as' } }],
  })
  const storeA = makeStore()
  const a = createScanHandlers({ dingtalkAuthFactory: () => missingKey.auth, store: storeA.store })
  await a.dingtalk()
  const resultA = await a.dingtalk()
  assert.equal(resultA.done, true)
  assert.equal(resultA.error, '授权成功但凭证不完整（appKey/appSecret 缺失），请重新发起')
  assert.deepEqual(storeA.sets, [])
  // 缺 appSecret（credentials 整体缺失同理）
  const missingSecret = makeDingtalkAuth({
    starts: [{ verificationCode: 'VC', qrUrl: 'https://qr.example/dt' }],
    polls: [{ status: 'SUCCESS' }],
  })
  const storeB = makeStore()
  const b = createScanHandlers({ dingtalkAuthFactory: () => missingSecret.auth, store: storeB.store })
  await b.dingtalk()
  const resultB = await b.dingtalk()
  assert.equal(resultB.done, true)
  assert.equal(resultB.error, '授权成功但凭证不完整（appKey/appSecret 缺失），请重新发起')
  assert.deepEqual(storeB.sets, [])
})

test('钉钉 FAIL：带服务端 error 透传文案；缺 error 用中文兜底', async () => {
  const withError = makeDingtalkAuth({
    starts: [{ verificationCode: 'VC', qrUrl: 'https://qr.example/dt' }],
    polls: [{ status: 'FAIL', error: '账号已被禁用' }],
  })
  const a = createScanHandlers({ dingtalkAuthFactory: () => withError.auth })
  await a.dingtalk()
  const resultA = await a.dingtalk()
  assert.equal(resultA.done, true)
  assert.equal(resultA.error, '钉钉授权失败：账号已被禁用。可在开放平台检查账号/组织状态后重试')
  const withoutError = makeDingtalkAuth({
    starts: [{ verificationCode: 'VC', qrUrl: 'https://qr.example/dt' }],
    polls: [{ status: 'FAIL' }],
  })
  const b = createScanHandlers({ dingtalkAuthFactory: () => withoutError.auth })
  await b.dingtalk()
  const resultB = await b.dingtalk()
  assert.equal(resultB.done, true)
  assert.equal(resultB.error, '钉钉授权失败：服务端返回失败。可在开放平台检查账号/组织状态后重试')
})

test('钉钉结构性错误 fail-fast：poll 抛 missing-field/incomplete-registration/api-error → 立即终态 error', async () => {
  for (const code of ['missing-field', 'incomplete-registration', 'api-error']) {
    const error = new Error('服务端业务错误')
    error.code = code
    const { auth } = makeDingtalkAuth({
      starts: [{ verificationCode: 'VC', qrUrl: 'https://qr.example/dt' }],
      polls: [error],
    })
    const { dingtalk } = createScanHandlers({ dingtalkAuthFactory: () => auth })
    assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt', done: false })
    const terminal = await dingtalk()
    assert.equal(terminal.done, true, `${code}：应 fail-fast 终态`)
    assert.equal(terminal.error, `钉钉授权流异常（${code}）：服务端业务错误`)
    assert.equal(terminal.qrContent, '')
  }
})

test('钉钉瞬态错误（poll 抛错无 code）：done:false 本轮作罢，下一轮重试后可 SUCCESS', async () => {
  const { auth, calls } = makeDingtalkAuth({
    starts: [{ verificationCode: 'VC', qrUrl: 'https://qr.example/dt' }],
    polls: [
      new Error('fetch failed'), // 网络瞬态：无 code
      { status: 'SUCCESS', credentials: { appKey: 'ak', appSecret: 'as' } },
    ],
  })
  const { store, sets } = makeStore()
  const { dingtalk } = createScanHandlers({ dingtalkAuthFactory: () => auth, store })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt', done: false })
  // 瞬态错误：流不终止、二维码保留，等待下一轮轮询重试
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt', done: false })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt', done: true, saved: true })
  assert.equal(calls.startResults.length, 1) // 瞬态不重开会话
  assert.equal(sets.length, 1)
})

test('钉钉 start 异常：缺 verificationCode / start 直接 throw → 都归一 done:true + error（不崩不卡流）', async () => {
  // start 返回缺 verificationCode：无法轮询 → 终态 error
  const broken = makeDingtalkAuth({ starts: [{ qrUrl: 'https://qr.example/dt' }], polls: [] })
  const a = createScanHandlers({ dingtalkAuthFactory: () => broken.auth })
  const resultA = await a.dingtalk()
  assert.equal(resultA.done, true)
  assert.equal(resultA.error, '钉钉授权会话缺少 verificationCode，无法轮询')
  // start 直接 throw（网络/DNS 层）→ 外层 catch 归一终态
  const throwing = { start: async () => { throw new Error('DNS 解析失败') }, poll: async () => ({ status: 'WAITING' }) }
  const b = createScanHandlers({ dingtalkAuthFactory: () => throwing })
  const resultB = await b.dingtalk()
  assert.equal(resultB.done, true)
  assert.equal(resultB.error, 'DNS 解析失败')
})

test('钉钉 store.set 抛错：done:true + error「凭证落盘失败」且 handler 不崩，logger.warn 留痕', async () => {
  const { auth } = makeDingtalkAuth({
    starts: [{ verificationCode: 'VC', qrUrl: 'https://qr.example/dt' }],
    polls: [{ status: 'SUCCESS', credentials: { appKey: 'ak', appSecret: 'as' } }],
  })
  const warns = []
  const store = { set: () => { throw new Error('disk full') } }
  const logger = { warn: (...args) => { warns.push(args) } }
  const { dingtalk } = createScanHandlers({ dingtalkAuthFactory: () => auth, store, logger })
  assert.deepEqual(await dingtalk(), { qrContent: 'https://qr.example/dt', done: false })
  const terminal = await dingtalk() // 落盘失败也绝不 throw
  assert.equal(terminal.done, true)
  assert.equal(terminal.error, '凭证落盘失败：disk full')
  assert.equal(warns.length, 1)
  assert.equal(warns[0][0], '[dsh-notifier/admin:scan]')
  assert.equal(warns[0][1], '钉钉凭证落盘失败: disk full')
})
