// dsh-notifier extensions/cloudflare-tunnel/src/supervisor.mjs
// T25（可选 Cloudflare Tunnel）— 自有 cloudflared 子进程监督器（R01/R02/R05）。
//
// 生命周期不变量：
//  R01 single-flight：并发 `start()` 合并为**同一** spawn（共享同一 promise），不重复 spawn；
//     启动慢/崩溃有 `startDeadlineMs` 截止，超时后只清理**自有**子进程并 fail，不残留半启动态。
//  R02 epoch 隔离 + 不复活：每次 stop / dispose 递增 `epoch`；迟到的 exit/error 回调只属于旧 epoch
//     时一律丢弃，绝不让旧进程回调把新实例打回 running 或触发复活；最多一个 reconnect timer；
//     stop 后清 timer、清自有 PID，永不因旧回调「复活」；stop 打断「启动中」时会显式 settle 单飞行
//     promise，绝不悬挂（不泄漏）。
//  R05 not-configured：缺 binary / spawn 失败如实报 failed/not-configured，从不下载执行。
//
// 「自有进程」定义：本监督器本次 spawn 返回的 child 所属 PID。绝不 `kill` 同名的全局进程
// （不按名字杀进程）；stop 只对当前 child.kill()（先 SIGTERM，超时 SIGKILL）。
//
// 日志脱敏：stdout/stderr 只有经 redact 后才进入 `status().recentLog`（有界），原始输出绝不
// 进入状态快照 / 支持报告。

import { redactCloudflaredOutput, boundLogLines } from './redact.mjs'

const DEFAULT_START_DEADLINE_MS = 30000
const DEFAULT_DRAIN_DEADLINE_MS = 5000
const DEFAULT_MAX_RECONNECT_MS = 30000
const DEFAULT_MAX_LOG_LINES = 20

/**
 * @param {object} options
 * @param {(config:object)=>object} options.spawn - 返回 child（EventEmitter，含 pid/kill/stdout/stderr）
 * @param {()=>number} [options.now]
 * @param {(fn:()=>void, ms:number)=>*} [options.setTimeout]
 * @param {(handle:*)=>void} [options.clearTimeout]
 * @param {(text:string)=>string} [options.redact]
 * @param {number} [options.startDeadlineMs]
 * @param {number} [options.drainDeadlineMs]
 * @param {number} [options.maxReconnectMs]
 * @param {number} [options.maxLogLines]
 */
export function createTunnelSupervisor(options = {}) {
  const spawnImpl = typeof options.spawn === 'function' ? options.spawn : null
  const st = typeof options.setTimeout === 'function' ? options.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const ct = typeof options.clearTimeout === 'function' ? options.clearTimeout : (h) => clearTimeout(h)
  const redact = typeof options.redact === 'function' ? options.redact : redactCloudflaredOutput

  const startDeadlineMs = Number(options.startDeadlineMs) || DEFAULT_START_DEADLINE_MS
  const drainDeadlineMs = Number(options.drainDeadlineMs) || DEFAULT_DRAIN_DEADLINE_MS
  const maxReconnectMs = Number(options.maxReconnectMs) || DEFAULT_MAX_RECONNECT_MS
  const maxLogLines = Number(options.maxLogLines) || DEFAULT_MAX_LOG_LINES

  let state = 'idle' // idle | starting | running | stopping | stopped | failed
  let epoch = 0
  let child = null
  let startDeadlineTimer = null
  let drainTimer = null
  let reconnectTimer = null
  let restartCount = 0
  let lastError = null
  let recentLog = []
  let inflightStart = null // { promise, reject }
  let lastConfig = null

  const settleError = (error) => { lastError = String(error?.message ?? error) }

  const clearReconnect = () => { if (reconnectTimer !== null) { ct(reconnectTimer); reconnectTimer = null } }
  const clearStartDeadline = () => { if (startDeadlineTimer !== null) { ct(startDeadlineTimer); startDeadlineTimer = null } }
  const clearDrain = () => { if (drainTimer !== null) { ct(drainTimer); drainTimer = null } }

  const captureLog = (chunk) => {
    if (chunk === undefined || chunk === null || chunk === '') return
    recentLog = boundLogLines([...recentLog, redact(String(chunk))], maxLogLines)
  }

  const killProc = (proc, signal = 'SIGTERM') => {
    try { if (proc && typeof proc.kill === 'function') proc.kill(signal) } catch { /* 不致命 */ }
  }

  const scheduleReconnect = () => {
    clearReconnect()
    if (state !== 'failed') return
    const backoff = Math.min(maxReconnectMs, 1000 * Math.pow(2, Math.min(restartCount, 5)))
    reconnectTimer = st(() => {
      reconnectTimer = null
      if (state === 'failed' && lastConfig !== null) void start(lastConfig)
    }, backoff)
  }

  const flushInflight = (error) => {
    const rec = inflightStart
    inflightStart = null
    if (rec && typeof rec.reject === 'function') rec.reject(error)
  }

  /**
   * 真正 spawn 一次。返回 { promise, reject }：promise 在 `starting → running` 时 resolve，
   * 在 spawn 失败 / 启动超时 / 提前退出 / stop 打断时 reject；reject 暴露给 stop 以便打断
   * 启动中不悬挂。
   */
  const doStart = (config) => {
    if (spawnImpl === null) {
      const error = Object.assign(new Error('cloudflared 二进制不可用（未安装或未配置）'), { code: 'not-configured' })
      settleError(error)
      state = 'failed'
      return { promise: Promise.reject(error), reject: null }
    }

    let proc
    try {
      proc = spawnImpl(config)
    } catch (throwable) {
      const error = Object.assign(new Error(String(throwable?.message ?? throwable)), { code: 'spawn-failed' })
      settleError(error)
      state = 'failed'
      return { promise: Promise.reject(error), reject: null }
    }

    const currentEpoch = epoch
    let rejectFn = null
    const promise = new Promise((resolve, reject) => {
      rejectFn = reject
      let settled = false
      child = proc
      state = 'starting'
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearStartDeadline()
        if (error) reject(error)
        else resolve(value)
      }

      if (proc && typeof proc.on === 'function') {
        proc.on('error', (error) => {
          if (currentEpoch !== epoch || child !== proc) return // 旧回调（R02）
          settleError(error)
          if (state === 'starting') {
            state = 'failed'
            child = null
            finish(Object.assign(new Error(String(error?.message ?? error)), { code: 'spawn-failed' }))
          } else {
            state = 'failed'
            child = null
            scheduleReconnect()
          }
        })
        proc.on('exit', (code, signal) => {
          if (currentEpoch !== epoch || child !== proc) return // 旧 epoch：丢弃（R02）
          clearStartDeadline()
          child = null
          if (state === 'stopping') { state = 'stopped'; return }
          if (state === 'starting') {
            state = 'failed'
            finish(Object.assign(new Error(`进程启动前退出 (code=${code}, signal=${signal})`), { code: 'early-exit' }))
            return
          }
          restartCount += 1
          settleError(new Error(`进程退出 (code=${code}, signal=${signal})`))
          state = 'failed'
          scheduleReconnect()
        })
      }
      if (proc && proc.stdout && typeof proc.stdout.on === 'function') proc.stdout.on('data', captureLog)
      if (proc && proc.stderr && typeof proc.stderr.on === 'function') proc.stderr.on('data', captureLog)

      // R01：启动截止。到点仍未 running → 清理自有进程并 fail。
      startDeadlineTimer = st(() => {
        startDeadlineTimer = null
        if (state !== 'starting' || settled) return
        settleError(new Error('启动超时'))
        killProc(child, 'SIGKILL')
        state = 'failed'
        child = null
        finish(Object.assign(new Error('启动超时'), { code: 'start-timeout' }))
      }, startDeadlineMs)

      // 子进程成功 spawn → 视为 running。
      if (proc && typeof proc.once === 'function') {
        proc.once('spawn', () => {
          if (currentEpoch !== epoch || child !== proc || settled) return
          state = 'running'
          finish(null, { ok: true, status: 'running', pid: proc.pid, epoch: currentEpoch })
        })
      }
    })
    return { promise, reject: rejectFn }
  }

  const start = (config) => {
    if (state === 'running') return Promise.resolve({ ok: true, status: 'running', alreadyRunning: true })
    if (state === 'starting' && inflightStart) return inflightStart.promise // R01 单飞行
    lastConfig = config
    epoch += 1
    const { promise, reject } = doStart(config)
    inflightStart = { promise, reject }
    const clearInflight = () => { if (inflightStart && inflightStart.promise === promise) inflightStart = null }
    promise.then(clearInflight, clearInflight)
    return promise
  }

  const stop = () => {
    clearReconnect()
    clearStartDeadline()
    if (state === 'idle' || state === 'stopped') return Promise.resolve({ ok: true, status: 'stopped' })
    epoch += 1 // R02：立刻作废所有旧回调
    const stopEpoch = epoch
    const current = child
    child = null
    if (state === 'starting') {
      // 打断「启动中」：显式 settle 单飞行 promise，绝不悬挂（R02 不泄漏）。
      flushInflight(Object.assign(new Error('启动中被停止'), { code: 'stopped' }))
    }
    if (current === null) {
      state = 'stopped'
      return Promise.resolve({ ok: true, status: 'stopped' })
    }
    state = 'stopping'
    killProc(current, 'SIGTERM')
    return new Promise((resolve) => {
      let done = false
      const finishStop = (forced) => {
        if (done) return
        done = true
        clearDrain()
        if (epoch === stopEpoch && child === null) state = 'stopped'
        resolve({ ok: true, status: epoch === stopEpoch && child === null ? 'stopped' : state, forced })
      }
      drainTimer = st(() => {
        drainTimer = null
        finishStop(true) // 先置 stopped，再强杀自有进程（R02 drain 截止）
        killProc(current, 'SIGKILL')
      }, drainDeadlineMs)
      if (current && typeof current.once === 'function') current.once('exit', () => finishStop(false))
      else finishStop(false)
    })
  }

  const status = () => ({
    status: state,
    pid: child && typeof child.pid === 'number' ? child.pid : null,
    epoch,
    restartCount,
    lastError: lastError === null ? null : redact(String(lastError)),
    recentLog: recentLog.slice(),
  })

  const dispose = () => {
    lastConfig = null
    clearReconnect()
    // dispose 是终态：即便从未启动（idle）也必须如实报 stopped，不能被 stop() 的 idle 短路留在 idle。
    if (state === 'idle' || state === 'stopped') state = 'stopped'
    // stop() synchronously invalidates epoch, settles an in-flight start, and SIGTERMs the owned child.
    // The returned promise completes drain/SIGKILL; callers may await it but safety does not depend on awaiting.
    return stop().finally(() => {
      clearReconnect()
      clearStartDeadline()
      if (state === 'stopped') clearDrain()
    })
  }

  return { start, stop, status, dispose }
}