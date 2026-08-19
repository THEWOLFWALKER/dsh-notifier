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
