import test from 'node:test'
import assert from 'node:assert/strict'
import { createKeywordFilter, createGraceQueue } from '../src/rules.mjs'
import * as bell from '../src/adapters/bell.mjs'
import { pickSoundForLevel, buildDesktopNotification, shouldSuppressDesktop, CLIENT_OVERLAY_CONTRACT } from '../src/client/desktop-sound.mjs'

// ---------- createKeywordFilter ----------

test('keywords: 无配置全放行', () => {
  const filter = createKeywordFilter(undefined)
  assert.equal(filter.test('任意文本'), true)
  assert.equal(filter.why('任意文本'), undefined)
})

test('keywords: include 白名单——命中任一条才放行', () => {
  const filter = createKeywordFilter({ include: ['error', 'deploy'] })
  assert.equal(filter.test('部署失败'), false)
  assert.equal(filter.why('部署失败'), 'include:none')
  assert.equal(filter.test('deploy 完成'), true)
  assert.equal(filter.test('ERROR occurred'), true, '默认大小写不敏感')
})

test('keywords: exclude 黑名单优先于 include', () => {
  const filter = createKeywordFilter({ include: ['任务'], exclude: ['heartbeat'] })
  assert.equal(filter.test('任务完成'), true)
  assert.equal(filter.why('例行 heartbeat 任务完成'), 'exclude:heartbeat')
  assert.equal(filter.test('例行 heartbeat 任务完成'), false)
})

test('keywords: caseSensitive 精确匹配', () => {
  const filter = createKeywordFilter({ include: ['Error'], caseSensitive: true })
  assert.equal(filter.test('error occurred'), false)
  assert.equal(filter.test('Error occurred'), true)
})

test('keywords: regex 模式按正则匹配', () => {
  const filter = createKeywordFilter({ include: ['^✅|完成$'], regex: true })
  assert.equal(filter.test('✅ 任务完成'), true)
  assert.equal(filter.test('进行中'), false)
})

test('keywords: 非法正则降级字面量，不炸启动', () => {
  const filter = createKeywordFilter({ include: ['[unclosed'], exclude: ['(bad'], regex: true })
  assert.equal(filter.test('包含 [unclosed 的文本'), true)
  assert.equal(filter.test('(bad 文本'), false)
  // P1-2 错误可见性：降级条目必须上报（调用方据此 warn）——语义从「正则」变「子串」
  // 的静默变化是通知静默停止/漏拦的隐患，宁可漏拦不炸启动但要让用户看见。
  assert.deepEqual(filter.regexFallbacks, ['[unclosed', '(bad'], '非法正则条目逐一登记')
})

test('keywords: regexFallbacks 仅在 regex 模式且有条目时非空', () => {
  assert.deepEqual(createKeywordFilter({ include: ['[bad'], regex: false }).regexFallbacks, [], '非 regex 模式本来就走字面量，无降级可言')
  assert.deepEqual(createKeywordFilter({ include: ['^ok$'], regex: true }).regexFallbacks, [], '合法正则不登记')
  assert.deepEqual(createKeywordFilter({}).regexFallbacks, [], '空配置无降级')
})

test('keywords: 空串与非字符串条目被丢弃、重复去重', () => {
  const filter = createKeywordFilter({ include: ['  ', 'ok', 'ok', 42, null] })
  assert.equal(filter.test('everything ok'), true)
  assert.equal(filter.test('nothing'), false)
})

// ---------- createGraceQueue ----------

test('grace: seconds=0 调度即执行', () => {
  const fired = []
  const grace = createGraceQueue({ seconds: 0 })
  grace.schedule('a', () => fired.push('a'))
  assert.deepEqual(fired, ['a'])
  assert.equal(grace.pendingCount(), 0)
})

test('grace: 到期触发；activity 取消全部待发', async () => {
  const fired = []
  const grace = createGraceQueue({ seconds: 0.03 })
  grace.schedule('a', () => fired.push('a'))
  grace.schedule('b', () => fired.push('b'))
  assert.equal(grace.pendingCount(), 2)
  grace.activity() // 用户接管：全部取消
  assert.equal(grace.pendingCount(), 0)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(fired, [], 'activity 后不应再触发')
})

test('grace: 同 key 重复调度替换旧任务', async () => {
  const fired = []
  const grace = createGraceQueue({ seconds: 0.03 })
  grace.schedule('a', () => fired.push('first'))
  grace.schedule('a', () => fired.push('second'))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(fired, ['second'], '后到者赢（同会话新状态覆盖旧状态）')
})

test('grace: 无窗口到期正常触发', async () => {
  const fired = []
  const grace = createGraceQueue({ seconds: 0.03 })
  grace.schedule('a', () => fired.push('a'))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(fired, ['a'])
})

test('grace: flush 立即触发全部待发（退出送达），dispose 只清不触发', async () => {
  const fired = []
  const grace = createGraceQueue({ seconds: 10 })
  grace.schedule('a', () => fired.push('a'))
  grace.schedule('b', () => fired.push('b'))
  grace.flush()
  assert.deepEqual(fired, ['a', 'b'])
  assert.equal(grace.pendingCount(), 0)

  grace.schedule('c', () => fired.push('c'))
  grace.dispose()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(fired, ['a', 'b'], 'dispose 不触发')
})

// ---------- createGraceQueue 有界（v0.8.7 P1-7，宪法#4「状态必须有界」）----------
// 溢出语义 = 提前触发最旧待发打扰（绝不静默丢弃，宪法#3）；定时器全注入，零真等待。

/** 注入式定时器：手动 runAll，避免真实等待与竞态。 */
function fakeTimers() {
  const scheduled = new Map()
  let seq = 0
  return {
    setTimeoutFn: (fn) => { seq += 1; scheduled.set(seq, fn); return seq },
    clearTimeoutFn: (id) => { scheduled.delete(id) },
    runAll() { for (const [id, fn] of [...scheduled]) { scheduled.delete(id); fn() } },
    liveCount: () => scheduled.size,
  }
}

test('grace 有界：maxKeys=2 时第 3 个 key 入队即提前触发最旧（不丢通知），onOverflow 收到键与在途数', () => {
  const fired = []
  const overflow = []
  const timers = fakeTimers()
  const grace = createGraceQueue({
    seconds: 10,
    maxKeys: 2,
    onOverflow: (key, size) => overflow.push([key, size]),
    ...timers,
  })
  grace.schedule('a', () => fired.push('a'))
  grace.schedule('b', () => fired.push('b'))
  assert.deepEqual(fired, [], '未溢出前一条都不该提前送达')
  assert.equal(grace.pendingCount(), 2)
  grace.schedule('c', () => fired.push('c'))
  assert.deepEqual(fired, ['a'], '最旧一条被提前推送（宽限窗提前收口，不静默丢弃）')
  assert.deepEqual(overflow, [['a', 2]], 'onOverflow 报出被提前触发的键与当时在途数')
  assert.equal(grace.pendingCount(), 2, '在途数恒不超过上限')
  timers.runAll()
  assert.deepEqual(fired, ['a', 'b', 'c'], '全部任务最终都送达，零丢失')
})

test('grace 有界：正好 cap 个不触发；cap+1 只提前触发 1 个（不雪崩全清）', () => {
  const fired = []
  const timers = fakeTimers()
  const grace = createGraceQueue({ seconds: 10, maxKeys: 3, ...timers })
  for (const key of ['a', 'b', 'c']) grace.schedule(key, () => fired.push(key))
  assert.deepEqual(fired, [], '正好写满上限不触发')
  grace.schedule('d', () => fired.push('d'))
  assert.deepEqual(fired, ['a'], '只提前触发最旧 1 条，其余继续等窗口')
  assert.equal(grace.pendingCount(), 3)
})

test('grace 有界：同 key 重排不触发溢出（先 cancel 再判位，重排不是新增）', () => {
  const fired = []
  const overflow = []
  const timers = fakeTimers()
  const grace = createGraceQueue({ seconds: 10, maxKeys: 2, onOverflow: (k) => overflow.push(k), ...timers })
  grace.schedule('a', () => fired.push('a1'))
  grace.schedule('b', () => fired.push('b'))
  grace.schedule('a', () => fired.push('a2'))
  grace.schedule('a', () => fired.push('a3'))
  assert.deepEqual(fired, [], '同 key 反复重排永不撑破上限')
  assert.deepEqual(overflow, [])
  timers.runAll()
  assert.deepEqual(fired.sort(), ['a3', 'b'], '后到者赢的既有语义不变')
})

test('grace 有界：提前触发的 key 定时器已清，窗口到点不二次送达（防重复打扰）', () => {
  const fired = []
  const timers = fakeTimers()
  const grace = createGraceQueue({ seconds: 10, maxKeys: 1, ...timers })
  grace.schedule('a', () => fired.push('a'))
  grace.schedule('b', () => fired.push('b'))
  assert.deepEqual(fired, ['a'])
  assert.equal(timers.liveCount(), 1, '被提前触发的 a 的定时器必须已清（否则到点二次推送）')
  timers.runAll()
  assert.deepEqual(fired, ['a', 'b'], 'a 只送达一次')
})

test('grace 有界：onOverflow 抛错不阻止提前触发；提前触发的 task 抛错不外抛（宪法#7）', () => {
  const fired = []
  const timers = fakeTimers()
  const grace = createGraceQueue({
    seconds: 10,
    maxKeys: 1,
    onOverflow: () => { throw new Error('通报炸了') },
    ...timers,
  })
  grace.schedule('boom', () => { throw new Error('任务炸了') })
  assert.doesNotThrow(() => grace.schedule('next', () => fired.push('next')))
  assert.equal(grace.pendingCount(), 1, '异常不得让表卡死在超量状态')
  timers.runAll()
  assert.deepEqual(fired, ['next'])
})

test('grace 有界：maxKeys 三态——负数/1 钳到 1；0/NaN/未传回落 256', () => {
  for (const bad of [-3, 1]) {
    const fired = []
    const timers = fakeTimers()
    const grace = createGraceQueue({ seconds: 10, maxKeys: bad, ...timers })
    grace.schedule('a', () => fired.push('a'))
    grace.schedule('b', () => fired.push('b'))
    assert.deepEqual(fired, ['a'], `maxKeys=${bad} 应钳到 1`)
  }
  for (const bad of [0, NaN, undefined]) {
    const fired = []
    const timers = fakeTimers()
    const grace = createGraceQueue({ seconds: 10, maxKeys: bad, ...timers })
    for (let i = 0; i < 256; i += 1) grace.schedule(`k${i}`, () => fired.push(i))
    assert.deepEqual(fired, [], `maxKeys=${String(bad)} 应回落 256，写满不触发`)
    grace.schedule('k256', () => fired.push(256))
    assert.equal(fired.length, 1, '第 257 个才提前触发')
  }
})

test('grace 有界：256 默认上限压测——1000 个会话在途数恒 ≤256 且零丢失', () => {
  const fired = []
  const timers = fakeTimers()
  const grace = createGraceQueue({ seconds: 10, ...timers })
  for (let i = 0; i < 1000; i += 1) {
    grace.schedule(`s${i}`, () => fired.push(i))
    assert.ok(grace.pendingCount() <= 256, '任何时刻在途数不得越界')
  }
  assert.equal(fired.length, 1000 - 256, '提前送达 744 条')
  timers.runAll()
  assert.equal(fired.length, 1000, '合计零丢失（宪法#3：降级可以，丢通知不行）')
})

test('grace 有界：seconds=0 直通路径不受上限影响（调度即执行，不进 pending）', () => {
  const fired = []
  const grace = createGraceQueue({ seconds: 0, maxKeys: 1 })
  for (let i = 0; i < 5; i += 1) grace.schedule(`k${i}`, () => fired.push(i))
  assert.deepEqual(fired, [0, 1, 2, 3, 4])
  assert.equal(grace.pendingCount(), 0)
})

// ---------- bell 适配器 ----------

test('bell: resolve 钳制 count 1-5，缺省 1', () => {
  assert.deepEqual(bell.resolve({}), { count: 1 })
  assert.deepEqual(bell.resolve({ count: 3 }), { count: 3 })
  assert.deepEqual(bell.resolve({ count: 99 }), { count: 5 })
  assert.deepEqual(bell.resolve({ count: 0 }), { count: 1 })
})

test('bell: send 向 stdout 写 BEL，count 次连发', () => {
  const original = process.stdout.write.bind(process.stdout)
  const written = []
  process.stdout.write = (chunk) => { written.push(chunk); return true }
  try {
    bell.send({ count: 2 }, { title: 't', content: 'c' })
    assert.equal(written.length, 1, '单次 write 连发，避免转义序列交错')
    assert.equal(written[0], '\x07\x07')
  } finally {
    process.stdout.write = original
  }
})

test('bell: silent 消息不响铃（静默推送的本地等价物）', () => {
  const original = process.stdout.write.bind(process.stdout)
  const written = []
  process.stdout.write = (chunk) => { written.push(chunk); return true }
  try {
    bell.send({ count: 3 }, { title: 't', content: 'c', silent: true })
    assert.equal(written.length, 0)
  } finally {
    process.stdout.write = original
  }
})

test('bell: stdout 抛错不致命', () => {
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = () => { throw new Error('EPIPE') }
  try {
    bell.send({ count: 1 }, { title: 't', content: 'c' }) // 不应 throw
  } finally {
    process.stdout.write = original
  }
})

// ---------- client 半纯逻辑 ----------

test('client: pickSoundForLevel 分级音色，未知 level 回 passive', () => {
  assert.deepEqual(pickSoundForLevel('timeSensitive'), { sound: 'alert', requireManualDismiss: true })
  assert.deepEqual(pickSoundForLevel('critical'), { sound: 'alert', requireManualDismiss: true })
  assert.deepEqual(pickSoundForLevel('active'), { sound: 'chime', requireManualDismiss: false })
  assert.deepEqual(pickSoundForLevel('passive'), { sound: 'ping', requireManualDismiss: false })
  assert.deepEqual(pickSoundForLevel('whatever'), { sound: 'ping', requireManualDismiss: false })
})

test('client: buildDesktopNotification 用 tag 实现同会话替换', () => {
  const payload = buildDesktopNotification({ title: '✅ 任务完成', content: '详情', group: 'session-42' })
  assert.equal(payload.tag, 'session-42', '优先 group 作为替换键')
  const noGroup = buildDesktopNotification({ title: '✅ 任务完成', content: '详情' })
  assert.equal(noGroup.tag, '✅ 任务完成', '无 group 退标题')
  const empty = buildDesktopNotification({})
  assert.equal(empty.tag, 'dsh-notifier')
  assert.equal(empty.title, '')
  assert.equal(empty.body, '')
})

test('client: shouldSuppressDesktop out-of-view 抑制判定', () => {
  assert.equal(shouldSuppressDesktop({ activeSessionId: 's1', targetSessionId: 's1' }), true, '聚焦中')
  assert.equal(shouldSuppressDesktop({ visibleSessionIds: ['s1', 's2'], targetSessionId: 's2' }), true, '可见分屏')
  assert.equal(shouldSuppressDesktop({ activeSessionId: 's1', targetSessionId: 's3' }), false, '不在视野')
  assert.equal(shouldSuppressDesktop({ targetSessionId: undefined }), false, '无目标不抑制')
})

test('client: 契约快照不漂移（experimental 标记保留）', () => {
  assert.equal(CLIENT_OVERLAY_CONTRACT.kind, 'shell.overlay')
  assert.equal(CLIENT_OVERLAY_CONTRACT.experimental, true)
  assert.ok(CLIENT_OVERLAY_CONTRACT.capabilities.includes('out-of-view-suppression'))
})
