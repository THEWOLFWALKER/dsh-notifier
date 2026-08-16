// dsh-notifier test/desktop.test.mjs
// desktop 渠道对抗性测试：命令矩阵纯函数 + 注入防御 + IO 归一（注入 spawn 假体）。
// 红线断言：标题/正文含任意恶意字符也只是字面参数——args 数组结构上杜绝 shell 注入。

import test from 'node:test'
import assert from 'node:assert/strict'
import * as desktop from '../src/adapters/desktop.mjs'
import { NotifyError } from '../src/adapters/_shared.mjs'

const MSG = { title: '任务完成', content: 'agent 已结束', level: 'active' }

// ---------- resolve ----------

test('resolve: sound 钳制合法枚举，默认 auto', () => {
  assert.deepEqual(desktop.resolve({}), { sound: 'auto' })
  assert.deepEqual(desktop.resolve({ sound: 'always' }), { sound: 'always' })
  assert.deepEqual(desktop.resolve({ sound: 'never' }), { sound: 'never' })
  assert.deepEqual(desktop.resolve({ sound: 'ALWAYS' }), { sound: 'auto' })
  assert.deepEqual(desktop.resolve(null), { sound: 'auto' })
})

// ---------- buildDesktopCommand：三平台矩阵 ----------

test('darwin: osascript 脚本含转义标题正文，紧急级带提示音', () => {
  const cmd = desktop.buildDesktopCommand('darwin', { sound: 'auto' }, { ...MSG, level: 'timeSensitive' })
  assert.equal(cmd.file, 'osascript')
  assert.deepEqual(cmd.args, ['-e', 'display notification "agent 已结束" with title "任务完成" sound name "Ping"'])
})

test('darwin: auto 策略下普通级无声；never 一律无声', () => {
  const quiet = desktop.buildDesktopCommand('darwin', { sound: 'auto' }, MSG)
  assert.ok(!quiet.args[1].includes('sound name'))
  const never = desktop.buildDesktopCommand('darwin', { sound: 'never' }, { ...MSG, level: 'timeSensitive' })
  assert.ok(!never.args[1].includes('sound name'))
  const always = desktop.buildDesktopCommand('darwin', { sound: 'always' }, { ...MSG, level: 'passive' })
  assert.ok(always.args[1].includes('sound name'))
})

test('linux: urgency 按 level 映射，-- 终结符前置，应用名固定', () => {
  const cmd = desktop.buildDesktopCommand('linux', { sound: 'auto' }, MSG)
  assert.equal(cmd.file, 'notify-send')
  assert.deepEqual(cmd.args, ['-a', 'dsh-notifier', '-u', 'normal', '--', '任务完成', 'agent 已结束'])
  const urgent = desktop.buildDesktopCommand('linux', {}, { ...MSG, level: 'timeSensitive' })
  assert.equal(urgent.args[3], 'critical')
  const low = desktop.buildDesktopCommand('linux', {}, { ...MSG, level: 'passive' })
  assert.equal(low.args[3], 'low')
})

test('win32: 探测通过 → powershell 调 BurntToast，无声策略带 SuppressSound', () => {
  const cmd = desktop.buildDesktopCommand('win32', { sound: 'auto' }, MSG, true)
  // auto + active 级 = 无声 → SuppressSound
  assert.equal(cmd.file, 'powershell.exe')
  assert.equal(cmd.args[0], '-NoProfile')
  assert.ok(cmd.args[3].includes("New-BurntToastNotification -Text @('任务完成','agent 已结束') -SuppressSound"))
  const loud = desktop.buildDesktopCommand('win32', { sound: 'always' }, MSG, true)
  assert.ok(!loud.args[3].includes('-SuppressSound'))
})

test('win32: 探测未通过 → unsupported=burnttoast，提示含安装指引', () => {
  const cmd = desktop.buildDesktopCommand('win32', {}, MSG, false)
  assert.equal(cmd.unsupported, 'burnttoast')
  assert.ok(cmd.hint.includes('Install-Module'))
  assert.ok(cmd.hint.includes('BurntToast'))
})

test('未知平台 → unsupported；silent → unsupported=silent', () => {
  assert.ok(desktop.buildDesktopCommand('freebsd', {}, MSG).unsupported.includes('freebsd'))
  assert.equal(desktop.buildDesktopCommand('darwin', {}, { ...MSG, silent: true }).unsupported, 'silent')
})

// ---------- 对抗性：注入与内容边界 ----------

test('对抗: AppleScript 引号/分号注入被转义（脚本为精确字符串）', () => {
  const evil = { title: 'x"; display alert "pwn', content: 'a\\b', level: 'active' }
  const cmd = desktop.buildDesktopCommand('darwin', { sound: 'never' }, evil)
  assert.equal(
    cmd.args[1],
    'display notification "a\\\\b" with title "x\\"; display alert \\"pwn"',
  )
})

test('对抗: PowerShell 单引号注入被折叠成字面量', () => {
  const evil = { title: "'); Remove-Item -Recurse C:\\; ('", content: 'b', level: 'active' }
  const cmd = desktop.buildDesktopCommand('win32', { sound: 'always' }, evil, true)
  // 唯一的一次引号出现都被折叠为 ''，没有任何裸 ' 逃出字面量
  assert.ok(cmd.args[3].includes("''); Remove-Item -Recurse C:\\; (''"))
})

test('对抗: linux 标题以 - 开头仍为字面参数（-- 终结符之后）', () => {
  const cmd = desktop.buildDesktopCommand('linux', {}, { title: '-u critical', content: '-h', level: 'active' })
  const ddash = cmd.args.indexOf('--')
  assert.equal(cmd.args[ddash + 1], '-u critical')
  assert.equal(cmd.args[ddash + 2], '-h')
  // args 是数组且无 shell 字符串拼接——注入在结构上不可能
  assert.ok(Array.isArray(cmd.args))
})

test('对抗: 控制字符抹平、超长截断加省略号', () => {
  const cmd = desktop.buildDesktopCommand('linux', {}, { title: 'a\nb\tc\u0000d', content: 'x'.repeat(1000), level: 'active' })
  assert.equal(cmd.args[5], 'a b c d') // flatten 后
  assert.ok(cmd.args[6].length <= 500)
  assert.ok(cmd.args[6].endsWith('…'))
})

// ---------- send：IO 归一（注入 spawn 假体） ----------

/** 伪造 child_process 子进程：手动 _emit 触发事件。 */
function makeFakeChild() {
  const listeners = new Map()
  return {
    stderr: { on: (evt, cb) => listeners.set(`stderr:${evt}`, cb) },
    on: (evt, cb) => listeners.set(evt, cb),
    kill: () => {},
    _emit: (evt, ...args) => listeners.get(evt)?.(...args),
    _stderr: (text) => listeners.get('stderr:data')?.(text),
  }
}

test.afterEach(() => desktop._setSpawnImpl(null))

/** 钉死 process.platform（send 内部读它分发）——三平台 CI runner 行为必须一致。 */
async function withPlatform(platform, fn) {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

test('send: 成功路径 → spawn 一次且 file 来自构造器，close(0) 即 resolve', async () => {
  const calls = []
  let child
  desktop._setSpawnImpl((file, args) => {
    calls.push({ file, args })
    child = makeFakeChild()
    return child
  })
  const pending = desktop.send({ sound: 'auto' }, MSG)
  await Promise.resolve() // 微任务推进到 spawn 发起
  assert.ok(['osascript', 'notify-send', 'powershell.exe'].includes(child ? calls[0].file : calls[0]?.file))
  child._emit('close', 0)
  await assert.doesNotReject(pending)
  assert.equal(calls.length, 1)
})

test('send: 命令缺失（ENOENT）→ 中文 NotifyError NOT_CONFIGURED', async () => {
  desktop._setSpawnImpl(() => {
    const child = makeFakeChild()
    queueMicrotask(() => {
      const err = new Error('spawn notify-send ENOENT')
      err.code = 'ENOENT'
      child._emit('error', err)
    })
    return child
  })
  await assert.rejects(
    desktop.send({ sound: 'auto' }, MSG),
    (error) => error instanceof NotifyError && error.code === 'NOT_CONFIGURED' && error.message.includes('bell'),
  )
})

test('send: 非零退出码 → API_ERROR 且带 stderr 摘要', async () => {
  desktop._setSpawnImpl(() => {
    const child = makeFakeChild()
    queueMicrotask(() => {
      child._stderr('boom from stderr')
      child._emit('close', 1)
    })
    return child
  })
  await assert.rejects(
    desktop.send({ sound: 'auto' }, MSG),
    (error) => error instanceof NotifyError && error.code === 'API_ERROR' && error.message.includes('boom from stderr'),
  )
})

test('send: silent 消息不 spawn', async () => {
  let spawned = 0
  desktop._setSpawnImpl(() => { spawned += 1; return makeFakeChild() })
  await desktop.send({ sound: 'auto' }, { ...MSG, silent: true })
  assert.equal(spawned, 0)
})

test('send: 子进程超时 kill → TIMEOUT（mock timers 推进）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  desktop._setSpawnImpl(() => makeFakeChild()) // 永不 close = 卡死命令
  const pending = desktop.send({ sound: 'auto' }, MSG)
  const assertion = assert.rejects(pending, (error) => error instanceof NotifyError && error.code === 'TIMEOUT')
  t.mock.timers.tick(10_000)
  await assertion
})

test('send: win32 探测缓存——两次发送只探测一次', async () => {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  const children = []
  desktop._setSpawnImpl((file, args) => {
    const child = makeFakeChild()
    children.push({ file, args, child })
    return child
  })
  const isProbe = (c) => c.args.some((a) => String(a).includes('Get-Module'))
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
  try {
    const resolved = { sound: 'always' }
    const first = desktop.send(resolved, MSG)
    await flush() // 探测子进程已 spawn
    assert.equal(children.filter(isProbe).length, 1, '首次发送先探测 BurntToast')
    children[0].child._emit('close', 0) // 探测通过（模块存在）
    await flush() // 探测结果传播后才 spawn 真通知
    const notif1 = children.find((c) => !isProbe(c))
    assert.ok(notif1, '探测通过后真通知被 spawn')
    notif1.child._emit('close', 0)
    await assert.doesNotReject(first)

    const before = children.length
    const second = desktop.send(resolved, MSG)
    await flush()
    assert.equal(children.length, before + 1, '第二次只 spawn 一个子进程（缓存生效，不再探测）')
    assert.ok(!isProbe(children.at(-1)))
    children.at(-1).child._emit('close', 0)
    await assert.doesNotReject(second)
    assert.equal(children.filter(isProbe).length, 1, 'BurntToast 探测在 resolved 生命周期内只做一次')
  } finally {
    for (const entry of children) entry.child._emit('close', 0) // 清掉超时定时器，杜绝异步活动外泄
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
})

test('send: win32 探测失败折叠为 false → 抛安装指引而非探测异常', async () => {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  desktop._setSpawnImpl(() => {
    const child = makeFakeChild()
    queueMicrotask(() => child._emit('close', 1)) // 模块不存在
    return child
  })
  try {
    await assert.rejects(
      desktop.send({ sound: 'auto' }, MSG),
      (error) => error instanceof NotifyError && error.message.includes('Install-Module'),
    )
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
})
