// dsh-notifier inbound/store.mjs
// 极简 JSON 文件持久化（零依赖）：pending 审批表、去重表、轮询 cursor 重启可恢复。
// 原子写：先写临时文件再 rename；文件权限 0600（v0.3.0 起存微信 iLink bot_token 等凭证）；
// 单键读写；启动时文件损坏回退空状态（fail-open 到「无记忆」，
// 但审批裁决状态丢失只会导致超时回退桌面，不会误批准——静默永不批准）。
//
// v0.6.4 并发军规（第二轮审查 R2-P1-2/R2-P2-2/R2-P2-3）：
//  - 跨进程写锁：save() 的 load→merge→write→rename 全程持同目录锁文件（openSync 'wx'
//    抢锁 + mtime 陈旧检测 + 有界自旋 + 超时强写降级），CLI 与宿主撞车不再整文件丢写；
//  - 读收敛：get() 节流检查文件 mtime（≥500ms 一次 stat），发现他进程写过即重载
//    （dirty 键以内存为准）——CLI 的 route:* 写入对运行中宿主秒级可见。
// v0.6.5 损坏自愈（第四轮审查 R4-1-P2-3，替代 v0.6.4 的「损坏中止」）：
//  - save() 重读撞上解析失败时，把现场转存为 .corrupt.<ts>（取证保留，保护不降级），
//    再以内存全量快照重建写路径——中止会让 dirty 无限积压、CLI↔宿主共享永久断裂；
//  - 只有启动 load() 保留 fail-open（无记忆好过误清空）。

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** DSH 数据目录：$DSH_HOME（宿主约定）回退 ~/.dsh。 */
export function defaultStateDir() {
  const home = process.env.DSH_HOME
    ?? (process.env.HOME || process.env.USERPROFILE ? `${process.env.HOME || process.env.USERPROFILE}/.dsh` : null)
  return home !== null ? `${home}/dsh-notifier` : '.dsh-notifier'
}

/** 同步微睡（锁竞争自旋用；主线程 Atomics.wait 合法且仅罕见竞争路径触达）。 */
const syncSleep = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 极老运行时：退化为忙等一拍 */ }
}

/**
 * 创建键值 store。
 * @param {string} filePath - JSON 文件路径（目录自动创建）
 */
export function createStore(filePath) {
  // 启动载入：损坏/缺省 fail-open 到空态（无记忆好过误清空——审批丢失只导致超时回退）
  const loadBoot = () => {
    try {
      if (!existsSync(filePath)) return {}
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      return (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * save 时刻的重读：区分「无文件/空」与「解析失败」。
   * @returns {{ ok: true, value: object } | { ok: false, reason: 'corrupt' }}
   */
  const tryLoad = () => {
    try {
      if (!existsSync(filePath)) return { ok: true, value: {} }
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: true, value: {} } // 形状异常按空文件处理（非损坏，是「从未写过有效内容」）
      }
      return { ok: true, value: parsed }
    } catch {
      return { ok: false, reason: 'corrupt' } // 半截 JSON/坏块：save 必须中止，绝不覆写
    }
  }

  let state = loadBoot()
  // v0.6.5（审查 R4-1-P3-2）：基线直接取启动时刻的 mtime——原 -1 哨兵会把
  // 「boot 之后、首次 get 之前」他进程的写入吞为基线（500ms 节流内撞上则永久不可见）。
  const mtimeOf = () => {
    try { return statSync(filePath).mtimeMs } catch { return -1 }
  }
  let lastKnownMtimeMs = mtimeOf()
  let lastRefreshCheckMs = 0

  // v0.6.3 脏键追踪（审查 R3 P1-1）：CLI（route/channel-login/wechat-login）与运行中
  // 宿主各持一份内存快照同写一个文件，原「整快照覆写」会互相抹掉对方的键
  // （admin:token-hash 被抹 = 已知 token 失效）。改为写时重读文件、只落本实例动过的
  // 键（键级合并），并在写回后让内存收敛到合并结果（顺带吃到别人的更新）。
  const dirty = new Set()

  // ---- v0.6.4 跨进程写锁（R2-P1-2）：唯一 tmp 只解决了 ENOENT，没解决两进程
  // load→rename 区间交错的 last-writer-wins 整文件丢写。锁文件抢占（'wx' 独占创建）
  // + mtime>10s 视为持锁进程已死的陈锁可清 + 有界自旋（60 拍×4ms≈240ms）+ 超时强写
  // 降级（保底不丢可用性，退回 v0.6.3 行为并 warn）。锁内完成 load→merge→write→rename。
  // v0.6.5 加固（审查 R4-1-P2-1/P2-2）：
  //  - 属主校验：抢到锁即在锁文件写入 pid:random，release 比对一致才删——
  //    持锁超 10s 的慢进程被陈锁回收后，绝不误删他人已重抢的新锁（经典 lockfile 竞态）；
  //  - 自旋内复查陈锁：每 8 拍 stat 一次，残锁到期当次 save 即恢复锁序，
  //    不必白等 240ms 降级裸写（降级写与持锁者的 load→rename 交错仍可能整文件丢写）；
  //  - 双轮等待：首轮超时后若锁仍新鲜（<10s，持锁者大概率活着），再等一轮，
  //    两轮 ≈480ms 仍持锁才降级——把降级裸写压到「持锁进程挂死/极慢盘」的罕见分支。
  const lockPath = `${filePath}.lock`
  let warnedLockTimeout = false
  const isStaleLock = () => {
    try { return Date.now() - statSync(lockPath).mtimeMs > 10_000 } catch { return false }
  }
  const acquireLock = () => {
    try { mkdirSync(dirname(filePath), { recursive: true }) } catch { /* 目录已在/不可建：后续自然失败 */ }
    // 陈锁清理：持锁进程崩溃没释放时，按 mtime 判死回收
    if (isStaleLock()) {
      try { unlinkSync(lockPath) } catch { /* 竞态：他人已清/已抢，继续走抢占 */ }
    }
    const ownerId = `${process.pid}:${Math.random().toString(36).slice(2, 8)}`
    for (let round = 0; round < 2; round += 1) {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        let fd = -1
        try {
          fd = openSync(lockPath, 'wx')
          // 属主落章：release 时比对，锁被他人回收重抢后绝不误删（R4-1-P2-2）
          try { writeSync(fd, ownerId, 0, 'utf8') } catch { /* 写不进章：释放退化为旧语义，仅保护降级 */ }
          return () => {
            try { closeSync(fd) } catch { /* fd 已关不致命 */ }
            try {
              if (readFileSync(lockPath, 'utf8') === ownerId) unlinkSync(lockPath)
            } catch { /* 锁已被回收：内容比对失败即放弃（锁已易主，不能删） */ }
          }
        } catch {
          // 锁被占：自旋等待（首拍立即重试撞运气，之后 4ms 一拍；每 8 拍复查陈锁）
          if (attempt > 0) {
            syncSleep(4)
            if (attempt % 8 === 0 && isStaleLock()) {
              try { unlinkSync(lockPath) } catch { /* 他人已清/已抢：下一拍抢占 */ }
            }
          }
          continue
        }
      }
      // 首轮等满仍被占：锁若已陈旧上面就会清，仍新鲜说明持锁者活着——再等一轮
      if (round === 0 && isStaleLock()) {
        try { unlinkSync(lockPath) } catch { /* 他人已清/已抢 */ }
        continue
      }
    }
    if (!warnedLockTimeout) {
      warnedLockTimeout = true
      try { console.error('[dsh-notifier/store]', `写锁等待超时（${lockPath}），降级无锁写入`) } catch { /* 控制台不可用不致命 */ }
    }
    return () => {} // 两轮超时强写：降级为 v0.6.3 的无锁行为（比永远写不进强；窗口毫秒级）
  }

  let warnedSaveError = false
  let warnedCorrupt = false

  // ---- v0.6.4 读收敛（R2-P2-3）：他进程（CLI）的写入对运行中宿主可见。
  // get() 节流 stat（至多 500ms 一次），mtime 变化即重载（dirty 键内存优先）。
  const refreshIfChanged = () => {
    const nowMs = Date.now()
    if (nowMs - lastRefreshCheckMs < 500) return
    lastRefreshCheckMs = nowMs
    const current = mtimeOf()
    if (current === lastKnownMtimeMs || current === -1) return
    const disk = tryLoad()
    if (!disk.ok) return // 损坏：不吞内存态，等 save 路径去处理与告警
    const merged = { ...disk.value }
    for (const key of dirty) {
      if (key in state) merged[key] = state[key]
      else delete merged[key]
    }
    state = merged
    lastKnownMtimeMs = current
  }

  const save = () => {
    const release = acquireLock()
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      let disk = tryLoad()
      if (!disk.ok) {
        // v0.6.5 损坏自愈（审查 R4-1-P2-3，替代 v0.6.4 的「中止保现场」）：
        // 中止会让 dirty 无限积压、CLI↔宿主共享永久断裂（外部不修复就永远写不进）。
        // 自愈 = 现场转存为 .corrupt.<ts>（取证可手工恢复，保护等级不降）后，
        // 以内存全量 + dirty 重建写路径。半截 JSON 本就解析不出任何键，
        // 重建丢失的只有「损坏文件里已不可读的内容」，且已留副本。
        const backup = `${filePath}.corrupt.${Date.now()}`
        try {
          renameSync(filePath, backup)
          console.error('[dsh-notifier/store]', `state 文件损坏，已转存现场为 ${backup} 并以内存态重建（副本可手工排查恢复）`)
        } catch (renameError) {
          // 转存失败（如备份不可写）：退回 v0.6.4 中止语义，保留 dirty 待外部修复
          if (!warnedCorrupt) {
            warnedCorrupt = true
            try { console.error('[dsh-notifier/store]', `state 文件损坏且转存失败（${renameError instanceof Error ? renameError.message : String(renameError)}），暂停写盘保留现场: ${filePath}`) } catch { /* 控制台不可用不致命 */ }
          }
          return
        }
        // 现场已转存：磁盘不可读，最大可用快照就是本实例内存全量（boot 载入 + 此后更新；
        // 他进程 boot 后的写入本就读不出来——副本里留了取证）。绝不能从 {} 起步：
        // 那会把本实例 boot 载入的非脏键（凭证/路由）一并抹掉。
        disk = { ok: true, value: state }
      }
      // 唯一 tmp：多进程共用固定 .tmp 路径时 write/rename 交错会 ENOENT 丢写
      const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
      const merged = { ...disk.value }
      for (const key of dirty) {
        if (key in state) merged[key] = state[key]
        else delete merged[key]
      }
      // v0.6.5（审查 R4-1-P3-6）：创建即 0600——chmod 前的 umask 窗口里凭证对他账号可读
      writeFileSync(tmp, JSON.stringify(merged), { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch { /* Windows/受限环境无 chmod：尽力而为 */ }
      renameSync(tmp, filePath)
      state = merged
      dirty.clear()
      lastKnownMtimeMs = mtimeOf()
      lastRefreshCheckMs = Date.now()
    } catch {
      // 磁盘失败不致命：内存态继续工作（重启后丢失）；dirty 保留下次再试
      if (!warnedSaveError) {
        warnedSaveError = true
        try { console.error('[dsh-notifier/store]', `state 写盘失败（内存态继续，重启后丢失）: ${filePath}`) } catch { /* 控制台不可用不致命 */ }
      }
    } finally {
      release()
    }
  }

  return {
    get(key, fallback = undefined) {
      try { refreshIfChanged() } catch { /* 收敛失败：退回内存态 */ }
      const value = state[key]
      return value === undefined ? fallback : value
    },
    set(key, value) {
      state[key] = value
      dirty.add(key)
      save()
    },
    delete(key) {
      const existed = key in state
      delete state[key]
      if (existed) {
        dirty.add(key)
        save()
      }
      return existed
    },
    keys(prefix = '') {
      try { refreshIfChanged() } catch { /* 收敛失败：退回内存态 */ }
      return Object.keys(state).filter((key) => key.startsWith(prefix))
    },
    size() {
      return Object.keys(state).length
    },
    /** 清理超期的键（如去重窗口），返回清理数量（v0.6.3 走脏键合并，单次落盘）。 */
    sweepPrefix(prefix, isExpired) {
      let removed = 0
      for (const key of Object.keys(state)) {
        if (!key.startsWith(prefix)) continue
        if (isExpired(key, state[key])) {
          delete state[key]
          dirty.add(key)
          removed += 1
        }
      }
      if (removed > 0) save()
      return removed
    },
  }
}
