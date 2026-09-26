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

import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 取证副本路径：.corrupt.<ts>.<pid>.<rand>。
 * 裸毫秒时间戳在快速机器上会同 ms 撞名——boot 取证与 save 自愈转存同一损坏现场时
 * 第二份覆盖第一份（CI ubuntu-latest 实测翻车，1544 中唯一红）。加随机后缀保证唯一。
 */
function corruptBackupPath(filePath) {
  return `${filePath}.corrupt.${Date.now()}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
}

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
  // v0.12.1（P2-07）：本实例启动时 state 文件存在但读不到的可观测标志。
  let bootReadFailed = false
  // v0.13（C11.5 / R3）：启动时 state 文件存在但语义损坏（坏 JSON / [] / null / 非法形状）
  // 的一等标志——旧实现只告警取证后 fail-open 成 {}，上层会把「不可信旧 state」误当新实例
  // （bootstrap owner / 重发 admin token / 空实例 migration）。损坏必须显式 fail-closed。
  let bootCorrupt = false

  // 启动载入：损坏/缺省 fail-open 到空态（无记忆好过误清空——审批丢失只导致超时回退）
  const loadBoot = () => {
    let raw
    try {
      if (!existsSync(filePath)) return {}
      // S-04（W12）：加载时权限自检——state.json 承载 admin token 哈希与各渠道
      // bot_token 等敏感凭证，写路径已保证新建即 0600，但旧版本/umask 异常/手工放宽
      // 留下的过宽 mode 不会被写路径纠正（chmod 只在新建与落盘时发生）。此处启动
      // 读文件前先查 mode：非 0600 → warn + chmod 收紧尝试；失败仅 warn 不阻塞启动
      // （文件系统级暴露面的缓解加固；加密/keychain 属超零依赖补丁线，见 TECHNICAL_DEBT）。
      try {
        const mode = statSync(filePath).mode & 0o777
        if (mode !== 0o600) {
          try {
            console.error('[dsh-notifier/store]', `state 文件权限过宽（${mode.toString(8)}，应为 600），尝试收紧: ${filePath}`)
            chmodSync(filePath, 0o600)
          } catch (chmodError) {
            console.error('[dsh-notifier/store]', `state 文件权限收紧失败（不阻塞启动）: ${chmodError instanceof Error ? chmodError.message : String(chmodError)}`)
          }
        }
      } catch { /* stat 失败（文件刚被移走等）：自检跳过，不阻塞 */ }
      raw = readFileSync(filePath, 'utf8')
    } catch {
      bootReadFailed = true
      return {} // 读失败（权限/占用等）：维持静默 fail-open，与损坏区分
    }
    try {
      // 空文件视作空态：writeFileSync 落盘必有内容，空串只可能是外部 touch/首次写中断——
      // 无记忆可丢失、无现场可取证，按损坏告警纯属噪音（对抗性 review 第 3 轮修正）
      if (raw.trim() === '') return {}
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      throw Object.assign(new Error('state 文件形状异常（合法 JSON 但非对象）'), { code: 'SHAPE' })
    } catch {
      // v0.13（C11.5 / R3）：损坏不再只是告警——置 bootCorrupt，使 stateful mutation fail-closed，
      // 上层（admin token / migration / owner bootstrap）据此拒绝把不可信旧 state 当新实例。
      // P1-2 错误可见性（2026-08-20，Trae1）：启动时损坏原先静默清零——绑定表/待审批/
      // 扫码凭证全部丢失且零日志，用户只见「绑定莫名失效」。对齐 v0.6.5 save 路径的
      // 取证惯例：现场 copy 为 .corrupt.<ts>（copy 而非 rename——boot 时他进程可能
      // 持有该文件，rename 会把它抽走；copy 无副作用）+ 告警。读侧仍 fail-open 供诊断，
      // 但写侧由 bootCorrupt 屏蔽（R3），绝不把不可信旧 state 覆盖成新实例。
      // 对抗性 review（资源耗尽角度）：save 路径取证走 rename 是 O(1)，copy 会完整
      // 复制——异常巨物（历史事故写出的 GB 级垃圾）会翻倍占盘。超过 8MB 只告警
      // 不取证（正常 state.json 为 KB 级；巨物现场保留在原位，事后可手工处理）。
      bootCorrupt = true
      let sizeBytes = -1
      try { sizeBytes = statSync(filePath).size } catch { /* stat 失败按未知处理 */ }
      const FORENSIC_COPY_MAX_BYTES = 8 * 1024 * 1024
      let preserved = false
      let skippedForSize = false
      if (sizeBytes >= 0 && sizeBytes > FORENSIC_COPY_MAX_BYTES) {
        skippedForSize = true
      } else {
        const backup = corruptBackupPath(filePath)
        try {
          copyFileSync(filePath, backup)
          preserved = true
        } catch { /* 取证 copy 失败不阻止 fail-open 起步 */ }
      }
      try {
        const detail = preserved
          ? `；现场已取证为 ${filePath}.corrupt.*，可手工排查恢复`
          : skippedForSize
            ? `；文件异常巨大（${sizeBytes} bytes），跳过取证复制以免占满磁盘，原始现场保留在原位`
            : '；取证转存失败（备份目录不可写？）'
        console.error('[dsh-notifier/store]', `state 文件启动时损坏，读侧按空状态起步、写侧已 fail-closed（绑定/待审批等记忆丢失，修复文件后方可写）: ${filePath}${detail}`)
      } catch { /* 控制台不可用不致命 */ }
      return {}
    }
  }

  /**
   * transaction 时刻的重读：区分「无文件」「读失败」与「解析失败」。
   * @returns {{ ok: true, value: object, missing?: boolean } | { ok: false, reason: 'read-failed'|'corrupt' }}
   */
  const tryLoad = () => {
    if (!existsSync(filePath)) return { ok: true, value: {}, missing: true }
    let raw
    try { raw = readFileSync(filePath, 'utf8') } catch { return { ok: false, reason: 'read-failed' } }
    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'corrupt' }
      }
      return { ok: true, value: parsed }
    } catch {
      return { ok: false, reason: 'corrupt' } // 半截 JSON/坏块：transaction 必须保留现场
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
  // + mtime>10s 视为持锁进程已死的陈锁可清 + 有界自旋（60 拍×4ms≈240ms）。
  // v0.13 起超时返回 STATE_BUSY，绝不再无锁写入。
  // v0.6.5 加固（审查 R4-1-P2-1/P2-2）：
  //  - 属主校验：抢到锁即在锁文件写入 pid:random，release 比对一致才删——
  //    持锁超 10s 的慢进程被陈锁回收后，绝不误删他人已重抢的新锁（经典 lockfile 竞态）；
  //  - 自旋内复查陈锁：每 8 拍 stat 一次，残锁到期当次 save 即恢复锁序，
  //    不必白等 240ms 降级裸写（降级写与持锁者的 load→rename 交错仍可能整文件丢写）；
  //  - 双轮等待：首轮超时后若锁仍新鲜（<10s，持锁者大概率活着），再等一轮；
  //    两轮 ≈480ms 仍持锁即 busy，不牺牲原子性换可用性。
  const lockPath = `${filePath}.lock`
  let warnedLockTimeout = false
  const isStaleLock = () => {
    try { return Date.now() - statSync(lockPath).mtimeMs > 10_000 } catch { return false }
  }
  // P1-3 跨进程状态压力审查（2026-08-23）：mtime>10s 的陈锁判据意味着「持锁进程崩溃
  // （kill -9/断电/OOM）后，残留锁最长 10s 内不算陈旧」——窗口内所有进程的每次 save 都
  // 白等两轮 ~480ms 再降级无锁写入（丢写保护失效），CLI↔宿主并发写可能静默丢键。
  // 修复：利用 v0.6.5 属主落章的 pid:random 格式做死亡探测——锁龄超过 500ms 宽限期
  // （防「刚创建就被读」与 pid 复用竞态）后 kill(pid,0)：ESRCH=确死，视同陈锁当场回收；
  // 存活（含 EPERM 他用户进程）与无法解析的外来锁内容一律返回 false，维持旧行为。
  // 方向保守：pid 被无关新进程复用只会让恢复退回 10s mtime 判据，绝不提前抢活锁。
  const LOCK_PID_PROBE_MIN_AGE_MS = 500
  const deadHolderLock = () => {
    try {
      const ageMs = Date.now() - statSync(lockPath).mtimeMs
      if (ageMs <= LOCK_PID_PROBE_MIN_AGE_MS) return false
      const pid = Number(readFileSync(lockPath, 'utf8').split(':')[0])
      if (!Number.isInteger(pid) || pid <= 0) return false // 外来/畸形锁内容：不做死亡推断
      try {
        process.kill(pid, 0)
        return false // 探测成功 = 持有者活着（慢/被调度延迟），继续等
      } catch (probeError) {
        return probeError.code === 'ESRCH' // 仅确死回收；EPERM 视同存活，不冒险
      }
    } catch {
      return false // stat/read 失败（锁刚被清等）：交给正常抢占流程
    }
  }
  const recoverableLock = () => isStaleLock() || deadHolderLock()

  const acquireLock = () => {
    try { mkdirSync(dirname(filePath), { recursive: true }) } catch { /* 目录已在/不可建：后续自然失败 */ }
    // 陈锁清理：持锁进程崩溃没释放时，mtime 判死（>10s）或属主 pid 探测确死（P1-3）当场回收
    if (recoverableLock()) {
      try { unlinkSync(lockPath) } catch { /* 竞态：他人已清/已抢，继续走抢占 */ }
    }
    const ownerId = `${process.pid}:${Math.random().toString(36).slice(2, 8)}`
    for (let round = 0; round < 2; round += 1) {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        let fd = -1
        try {
          fd = openSync(lockPath, 'wx')
          // 属主落章：release 时比对，锁被他人回收重抢后绝不误删（R4-1-P2-2）。
          // 落章失败时必须关闭并清理空锁，不能留下永不释放的 lockfile。
          const written = writeSync(fd, ownerId, 0, 'utf8')
          if (written !== Buffer.byteLength(ownerId, 'utf8')) throw new Error('lock owner write incomplete')
          return { ok: true, release: () => {
            try { closeSync(fd) } catch { /* fd 已关不致命 */ }
            try {
              if (readFileSync(lockPath, 'utf8') === ownerId) unlinkSync(lockPath)
            } catch { /* 锁已被回收：内容比对失败即放弃（锁已易主，不能删） */ }
          } }
        } catch {
          try { if (fd >= 0) closeSync(fd) } catch { /* cleanup best effort */ }
          try {
            if (readFileSync(lockPath, 'utf8') === '') unlinkSync(lockPath)
          } catch { /* 其他持有者/文件系统错误交给下一轮 */ }
          // 锁被占：自旋等待（首拍立即重试撞运气，之后 4ms 一拍；每 8 拍复查陈锁/死锁）
          if (attempt > 0) {
            syncSleep(4)
            if (attempt % 8 === 0 && recoverableLock()) {
              try { unlinkSync(lockPath) } catch { /* 他人已清/已抢：下一拍抢占 */ }
            }
          }
          continue
        }
      }
      // 首轮等满仍被占：锁若可判回收上面就会清，仍不可回收说明持锁者大概率活着——再等一轮
      if (round === 0 && recoverableLock()) {
        try { unlinkSync(lockPath) } catch { /* 他人已清/已抢 */ }
        continue
      }
    }
    if (!warnedLockTimeout) {
      warnedLockTimeout = true
      try { console.error('[dsh-notifier/store]', `写锁等待超时（${lockPath}），返回 STATE_BUSY`) } catch { /* 控制台不可用不致命 */ }
    }
    return { ok: false, code: 'STATE_BUSY', release: () => {} }
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

  const cloneState = (value) => {
    if (value === null || value === undefined || typeof value !== 'object') return value
    try { return JSON.parse(JSON.stringify(value)) } catch { return { ...value } }
  }

  /**
   * v0.13 transactional state commit.
   * The mutator only receives a detached draft. Disk and live memory are published
   * after the atomic rename; any lock/read/mutator/write failure leaves both unchanged.
   */
  const transact = (mutator) => {
    if (typeof mutator !== 'function') return { ok: false, committed: false, durable: false, code: 'BAD_MUTATOR' }
    // v0.13（C11.5 / R3）：boot 时 state 不可信（读失败 / 损坏）→ stateful mutation 一律
    // fail-closed，绝不把不可信旧 state 当空世界覆盖（含 save 路径的「转存现场 + 内存态重建」）。
    // 仅当磁盘已被修复成合法对象（显式 operator recovery / 修好文件）才清除标志、恢复写路径。
    if (bootReadFailed || bootCorrupt) {
      const reread = tryLoad()
      if (!reread.ok) {
        return { ok: false, committed: false, durable: false, code: bootReadFailed ? 'STATE_READ_FAILED' : 'STATE_CORRUPT' }
      }
      bootReadFailed = false
      bootCorrupt = false
    }
    const acquired = acquireLock()
    if (acquired.ok !== true) return { ok: false, committed: false, durable: false, code: acquired.code }
    let tmp = null
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      let disk = tryLoad()
      if (!disk.ok && disk.reason === 'read-failed') {
        return { ok: false, committed: false, durable: false, code: 'STATE_READ_FAILED' }
      }
      if (!disk.ok) {
        const backup = corruptBackupPath(filePath)
        try {
          renameSync(filePath, backup)
          console.error('[dsh-notifier/store]', `state 文件损坏，已转存现场为 ${backup} 并以内存态重建（副本可手工排查恢复）`)
        } catch (renameError) {
          if (!warnedCorrupt) {
            warnedCorrupt = true
            try { console.error('[dsh-notifier/store]', `state 文件损坏且转存失败（${renameError instanceof Error ? renameError.message : String(renameError)}），暂停写盘保留现场: ${filePath}`) } catch { /* 控制台不可用不致命 */ }
          }
          return { ok: false, committed: false, durable: false, code: 'STATE_CORRUPT' }
        }
        disk = { ok: true, value: state }
      }
      // 文件被外部删除时，保留本实例已知快照，避免一次 unrelated write 抹掉其他键。
      const base = disk.missing && Object.keys(state).length > 0 ? state : disk.value
      const draft = cloneState(base)
      const value = mutator(draft)
      tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
      writeFileSync(tmp, JSON.stringify(draft), { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch { /* Windows/受限环境无 chmod：尽力而为 */ }
      renameSync(tmp, filePath)
      tmp = null
      state = draft
      dirty.clear()
      lastKnownMtimeMs = mtimeOf()
      lastRefreshCheckMs = Date.now()
      return { ok: true, committed: true, durable: true, value }
    } catch (error) {
      if (tmp !== null) try { unlinkSync(tmp) } catch { /* temp cleanup best effort */ }
      if (!warnedSaveError) {
        warnedSaveError = true
        try { console.error('[dsh-notifier/store]', `state 事务写盘失败（内存与磁盘保持不变）: ${filePath}`) } catch { /* 控制台不可用不致命 */ }
      }
      return { ok: false, committed: false, durable: false, code: error?.code === 'STATE_BUSY' ? 'STATE_BUSY' : 'STATE_WRITE_FAILED', error }
    } finally {
      acquired.release()
    }
  }

  return {
    /**
     * v0.12.1（P2-07）/ v0.13（C11.5 / R3）：启动读取状态，区分三种一等状态。
     *  - ready：文件不存在/空文件（首次安装）或成功读到合法对象；
     *  - unavailable：文件存在但读不到（权限/占用等 I/O 失败）；
     *  - corrupt：文件存在但语义损坏（坏 JSON / [] / null / 非法形状）。
     * corrupt/unavailable 时 stateful mutation fail-closed，上层据此拒绝 bootstrap / 重发 token /
     * 空实例 migration，并对外报 storage degraded。
     */
    bootStatus() {
      return {
        status: bootReadFailed ? 'unavailable' : bootCorrupt ? 'corrupt' : 'ready',
        readFailed: bootReadFailed,
        corrupt: bootCorrupt,
      }
    },
    /**
     * Create an idempotent forensic copy before an application-level migration.
     * The copy is intentionally outside state.json so the migration transaction
     * can still be the single durable commit point for state changes.
     */
    backup(label = 'backup') {
      const safeLabel = String(label).replace(/[^a-zA-Z0-9._-]/g, '-') || 'backup'
      if (!existsSync(filePath)) return { ok: true, path: null, absent: true }
      try {
        const dir = dirname(filePath)
        const prefix = `${basename(filePath)}.${safeLabel}.`
        const existing = readdirSync(dir).find((name) => name.startsWith(prefix))
        if (existing !== undefined) return { ok: true, path: join(dir, existing), existing: true }
        const target = join(dir, `${prefix}${Date.now()}`)
        copyFileSync(filePath, target)
        try { chmodSync(target, 0o600) } catch { /* Windows/受限环境无 chmod：尽力而为 */ }
        return { ok: true, path: target, existing: false }
      } catch (error) {
        return { ok: false, path: null, error }
      }
    },
    get(key, fallback = undefined) {
      try { refreshIfChanged() } catch { /* 收敛失败：退回内存态 */ }
      const value = state[key]
      return value === undefined ? fallback : value
    },
    /** v0.13：跨 key 事务入口；mutator 只改 detached draft，成功后一次性发布。 */
    transact,
    set(key, value) {
      const result = transact((draft) => {
        draft[key] = cloneState(value)
        return true
      })
      return result.committed === true
    },
    delete(key) {
      try { refreshIfChanged() } catch { /* 收敛失败：退回内存态 */ }
      const existed = key in state
      if (existed) {
        transact((draft) => { delete draft[key]; return true })
      }
      // 返回语义保持 existed（R1：task-selection.mjs:133 依赖 store.delete(key) === true）。
      // 需要 durable 结论的调用方走 deleteDurable。
      return existed
    },
    /**
     * v0.12.1（P0-02）：delete 的 durable 版本——既有 delete() 的返回值表达的是
     * 「原 key 是否存在」，不表达「是否真正落盘」，调用方无法据此判断删除是否生效。
     * @returns {{ existed: boolean, durable: boolean }}
     */
    deleteDurable(key) {
      try { refreshIfChanged() } catch { /* 收敛失败：退回内存态 */ }
      const existed = key in state
      if (!existed) return { existed: false, durable: !isStorageUntrusted({ readFailed: bootReadFailed, corrupt: bootCorrupt }) }
      const result = transact((draft) => { delete draft[key]; return true })
      return { existed: true, durable: result.committed === true }
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
      const result = transact((draft) => {
        let removed = 0
        for (const key of Object.keys(draft)) {
          if (!key.startsWith(prefix)) continue
          if (isExpired(key, draft[key])) {
            delete draft[key]
            removed += 1
          }
        }
        return removed
      })
      return result.committed === true ? Number(result.value ?? 0) : 0
    },
  }
}

/**
 * v0.13（C11.5 / R3）：storage 是否不可信（启动读失败或语义损坏）的唯一判据。
 * 上层用它统一拒绝 bootstrap owner / 重发 admin token / 空实例 migration，并对外报 degraded。
 * 兼容只暴露 readFailed 的旧形状。
 */
export function isStorageUntrusted(status) {
  return status?.readFailed === true || status?.corrupt === true || (typeof status?.status === 'string' && status.status !== 'ready')
}

/**
 * v0.12.1：一致化 durable 写判据，供调用点在不关心错误分类、只关心成败时使用。
 * 显式 false 才是失败；undefined 是遗留 mock store 的合法返回值，必须当作成功（I9）。
 */
export function setDurable(store, key, value) {
  if (typeof store?.transact === 'function') {
    try {
      const result = store.transact((draft) => { draft[key] = value; return true })
      return result?.committed === true
    } catch {
      return false
    }
  }
  if (typeof store?.set !== 'function') return false
  try {
    return store.set(key, value) !== false
  } catch {
    return false
  }
}

/**
 * v0.13：跨键 durable transaction。没有真实 transact 能力时不伪造原子成功，
 * 让需要跨域一致性的 application service 明确失败，而不是退回多次单键写。
 */
export function transactDurable(store, mutator) {
  if (typeof store?.transact !== 'function' || typeof mutator !== 'function') {
    return { ok: false, committed: false, durable: false, code: 'TRANSACTION_UNAVAILABLE' }
  }
  try {
    const result = store.transact(mutator)
    return {
      ...(result ?? {}),
      ok: result?.committed === true,
      committed: result?.committed === true,
      durable: result?.durable === true,
    }
  } catch (error) {
    return { ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED', error }
  }
}

/**
 * v0.12.1：一致化 durable 删除，返回 { existed, durable }。
 * 真 store 有 deleteDurable 时优先使用；遗留 mock 只有 delete 时，沿用 existed 语义。
 */
export function deleteDurable(store, key) {
  if (typeof store?.transact === 'function') {
    try {
      const result = store.transact((draft) => {
        const existed = key in draft
        delete draft[key]
        return existed
      })
      return { existed: result?.committed === true && result?.value === true, durable: result?.committed === true }
    } catch {
      return { existed: false, durable: false }
    }
  }
  if (typeof store?.deleteDurable === 'function') {
    try {
      const result = store.deleteDurable(key)
      return { existed: result?.existed === true, durable: result?.durable === true }
    } catch {
      return { existed: false, durable: false }
    }
  }
  if (typeof store?.delete !== 'function') return { existed: false, durable: false }
  try {
    const existed = store.delete(key) === true
    // 遗留 mock 只有 existed 语义：调用成功即视为完成；无 key 删除是幂等成功。
    return { existed, durable: true }
  } catch {
    return { existed: false, durable: false }
  }
}
