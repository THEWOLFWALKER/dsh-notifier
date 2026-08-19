// dsh-notifier status/turn-tracker.mjs
// v0.5 状态上报线的纯逻辑核心：跟踪每个会话 turn 的运行时长与事件活跃度，
// 产出两类信号——长任务心跳（onHeartbeat）与疑似卡住（onStall）。
// 军规（对齐 rules.mjs 的 createGraceQueue/createTrailingDebounce 模式）：
// 纯逻辑 + 可注入时钟/定时器 + 全防御永不外抛；回调异常在回调点吞掉。
//
// 生命周期与活跃判定：
//  - turn/start 建档（upsert 重置计时）；turn/end 清档——turn 生命周期外不跟踪
//    （independent 于 events intent 过滤：即使 events.turnEnd 关闭，清档仍发生）
//  - 一切其它事件刷新 lastEventAt 并重置「本静默期已报卡住」——user/* 例外：
//    用户打字 ≠ agent 进展，不刷新（否则长任务里用户隔几分钟看一眼就永远不报卡住）
//  - 未知事件类型按活跃处理：宁可少报卡住，不可误报（新宿主事件词汇向后兼容）
//  - 心跳：建档后 firstAfterMs 首跳，此后每 everyMs 一跳（按 turn 总时长，持续跳动）
//  - 卡住：lastEventAt + afterMs 触发；每个静默期只报一次，下次活跃后重装可再报
// 防泄漏：MAX_TRACKED 上限淘汰最旧 + agent/disposed 清档 + turn/end 清档 + dispose 清档。

const MAX_TRACKED = 32

/** 数值军规：下限钳制（默认 60s，杜绝误配小值刷屏；测试可注入更小 minMs），非法值回落默认。 */
function msOfClamped(minMs) {
  return (value, fallback) => Math.max(minMs, Number(value) || fallback)
}

/**
 * 创建 turn 跟踪器。
 * @param {object} [options]
 * @param {{ firstAfterMs?: number, everyMs?: number } | null} [options.heartbeat]
 *   心跳配置；null/非对象 = 不装心跳定时器。
 * @param {{ afterMs?: number } | null} [options.stall]
 *   卡住判定配置；null/非对象 = 不装卡住定时器。
 * @param {(session: object, info: object) => void} [options.onHeartbeat]
 * @param {(session: object, info: object) => void} [options.onStall]
 *   info = { sessionId, startedAt, lastEventAt, elapsedMs, idleMs }。
 * @param {number} [options.minMs=60000] 数值钳制下限（默认 60s；测试注入更小值）。
 * @param {() => number} [options.now] 可注入时钟（测试用）。
 * @param {Function} [options.setTimeoutFn] 可注入定时器（测试用）。
 * @param {Function} [options.clearTimeoutFn] 可注入定时器（测试用）。
 */
export function createTurnTracker(options = {}) {
  const heartbeatOn = options.heartbeat !== null && typeof options.heartbeat === 'object'
  const stallOn = options.stall !== null && typeof options.stall === 'object'
  const minMs = typeof options.minMs === 'number' && Number.isFinite(options.minMs)
    ? Math.max(0, Math.trunc(options.minMs))
    : 60_000
  const msOf = msOfClamped(minMs)
  const firstAfterMs = heartbeatOn ? msOf(options.heartbeat.firstAfterMs, 900_000) : 0
  const everyMs = heartbeatOn ? msOf(options.heartbeat.everyMs, firstAfterMs) : 0
  const stallAfterMs = stallOn ? msOf(options.stall.afterMs, 600_000) : 0
  const onHeartbeat = typeof options.onHeartbeat === 'function' ? options.onHeartbeat : () => {}
  const onStall = typeof options.onStall === 'function' ? options.onStall : () => {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout?.bind(globalThis)
  const clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout?.bind(globalThis)

  /** sessionId -> { sessionId, startedAt, lastEventAt, heartbeats, heartbeatTimer, stallTimer, stallFired } */
  const tracked = new Map()

  const infoOf = (entry) => {
    const at = now()
    return {
      sessionId: entry.sessionId,
      startedAt: entry.startedAt,
      lastEventAt: entry.lastEventAt,
      elapsedMs: Math.max(0, at - entry.startedAt),
      idleMs: Math.max(0, at - entry.lastEventAt),
    }
  }

  const cancelTimer = (entry, field) => {
    if (entry[field] === null) return
    try { clearTimeoutFn(entry[field]) } catch { /* 定时器清理失败不致命 */ }
    entry[field] = null
  }

  const drop = (sessionId) => {
    const entry = tracked.get(sessionId)
    if (entry === undefined) return
    cancelTimer(entry, 'heartbeatTimer')
    cancelTimer(entry, 'stallTimer')
    tracked.delete(sessionId)
  }

  // 心跳定时器链：首跳 firstAfterMs，此后每跳 everyMs；drop 后旧定时器触发时自检退出。
  // v0.6.3：回调统一用 entry.session（observe 每次事件刷新）——原实现闭包冻结 turn/start
  // 时刻的 session 引用，宿主逐事件传新快照时「最近输出」摘录恒为上一轮（审查 R3 P1-2）。
  const armHeartbeat = (entry) => {
    if (!heartbeatOn || setTimeoutFn === undefined) return
    cancelTimer(entry, 'heartbeatTimer')
    const delay = entry.heartbeats === 0 ? firstAfterMs : everyMs
    entry.heartbeatTimer = setTimeoutFn(() => {
      entry.heartbeatTimer = null
      if (!tracked.has(entry.sessionId)) return
      entry.heartbeats += 1
      try { onHeartbeat(entry.session, infoOf(entry)) } catch { /* 回调异常绝不外抛 */ }
      armHeartbeat(entry) // 下一跳
    }, delay)
  }

  // 卡住定时器：lastEventAt + afterMs；每个静默期只报一次（触发后不重装，
  // 下次活跃事件经 observe 重置 stallFired 后重装）。
  const armStall = (entry) => {
    if (!stallOn || setTimeoutFn === undefined) return
    cancelTimer(entry, 'stallTimer')
    entry.stallTimer = setTimeoutFn(() => {
      entry.stallTimer = null
      if (!tracked.has(entry.sessionId)) return
      if (entry.stallFired) return
      entry.stallFired = true
      try { onStall(entry.session, infoOf(entry)) } catch { /* 回调异常绝不外抛 */ }
    }, Math.max(0, entry.lastEventAt + stallAfterMs - now()))
  }

  // 建档前腾位：超限时淘汰 lastEventAt 最旧者（同 id upsert 时旧档先清，净效果正确）
  const evictOldest = () => {
    if (tracked.size < MAX_TRACKED) return
    let oldestKey = null
    let oldestAt = Infinity
    for (const [id, entry] of tracked) {
      if (entry.lastEventAt < oldestAt) {
        oldestAt = entry.lastEventAt
        oldestKey = id
      }
    }
    if (oldestKey !== null) drop(oldestKey)
  }

  return {
    /** 喂入一条 session 事件（firehose 最前端调用；全防御，任何输入不抛）。 */
    observe(session, event) {
      try {
        if (session === null || session === undefined || event === null || event === undefined) return
        const sessionId = typeof session.id === 'string' ? session.id : ''
        if (sessionId === '') return
        const type = typeof event.type === 'string' ? event.type : ''
        if (type === 'turn/end') {
          drop(sessionId)
          return
        }
        if (type === 'turn/start') {
          if (tracked.has(sessionId)) drop(sessionId)
          evictOldest()
          const entry = {
            sessionId,
            session, // v0.6.3：随事件刷新（见下），心跳/卡住回调统一取此引用
            startedAt: now(),
            lastEventAt: now(),
            heartbeats: 0,
            heartbeatTimer: null,
            stallTimer: null,
            stallFired: false,
          }
          tracked.set(sessionId, entry)
          armHeartbeat(entry)
          armStall(entry)
          return
        }
        // 其余事件：user/* 不算 agent 进展（不刷新）；未知类型按活跃处理（宁漏报不误报）
        if (type.startsWith('user/')) return
        const entry = tracked.get(sessionId)
        if (entry === undefined) return // 未建档（无 turn/start 的存量会话）：不追既往
        entry.lastEventAt = now()
        entry.stallFired = false
        entry.session = session // v0.6.3：宿主逐事件传新快照时，摘录/回调看到的永远是最新
        armStall(entry)
      } catch { /* tracker 任何异常绝不外抛 */ }
    },

    /** agent/disposed：清该会话档（装配层接线；无档时无害空转）。 */
    observeAgentDisposed(agent) {
      try {
        const sessionId = typeof agent?.id === 'string' ? agent.id : ''
        if (sessionId !== '') drop(sessionId)
      } catch { /* 同上 */ }
    },

    trackedCount() {
      return tracked.size
    },

    /** 清全部档与定时器（event-listener teardown 调用）。 */
    dispose() {
      for (const sessionId of [...tracked.keys()]) drop(sessionId)
    },
  }
}
