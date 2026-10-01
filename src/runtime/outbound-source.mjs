// dsh-notifier v0.12 — dynamic outbound runtime source.
// This module deliberately owns only the current resolved outbound channel set.
// Persistence, validation, UI and RPC belong elsewhere.
//
// v0.14（P0-01）：运行时源同时服务两类调用方，二者的可变性要求相反——
//   1) 传输路径（notify.mjs / RuntimeChannelManager）把 `config` 交给 adapter.send()。
//      部分 adapter 会在 resolved 对象上**合法惰性写**运行时状态（qq-bot 的
//      `_tokenManager`/`_rateGate`/`_msgSeq`、wecom-app 的 `_tokenManager`、desktop 的
//      `__burntToastProbe`），这些字段必须跨多次 send 保活（同一对象引用），冻结会
//      让发送在严格模式下直接 TypeError。
//   2) 外部观察方（Native 投影 / Support Report / resolved.channels 快照）只做只读展示，
//      绝不能通过改返回值污染内部真值。
// 旧实现对 resolved 做 JSON clone + deep-freeze 后交还给所有人，直接踩坏了第 1 类。
// 现在分层：
//   - 内部持有 **live runtime entry**（`{ type, config }`，config 即 adapter 私有运行时对象，
//     不 clone、不冻结）；只经 `live(type)` / `liveEntries()` 暴露给传输路径。
//   - `snapshot()` / `get(type)` 返回**冻结投影**（深拷贝 + deep-freeze）给外部观察方，
//     外部改动一律抛错且不影响内部真值。
// 这不是 QQ/WeCom 单点补丁：冻结/投影边界是全局契约，任何 adapter 的合法惰性写都成立。

// v0.15（Gate 2E）：冻结投影的 cycle guard——同一个对象在图中二次出现时不再下钻，
// 避免循环引用把 freezeDeep 打进无限递归（旧实现只靠 JSON clone，遇到环时根本不
// 走到这里；现在安全投影可能保留真实对象引用，必须自带守卫）。
function freezeDeep(value, seen = new WeakSet()) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    for (const child of Object.values(value)) freezeDeep(child, seen)
    Object.freeze(value)
  }
  return value
}

/**
 * v0.15（Gate 2E）**安全结构投影**：只在 JSON serialization 不可行（循环引用 / BigInt /
 * SDK 对象等）时使用的兜底。它不是 `clone()`——`clone()` 失败会原样返回 **live 运行时
 * 对象**，随后 `freezeDeep(live)` 会把 adapter 私有运行时对象冻死，下一次惰性缓存写入
 * 直接 TypeError（正是 P0-01 要消灭的 bug 换了个入口）。
 *
 * 规则：只复制 JSON-safe 的公开字段；`_` / `__` 前缀私有运行态整支跳过；函数 / symbol /
 * 不可序列化分支产出 `undefined`（丢弃）；环通过 `seen` 断链；**永远新建对象，绝不
 * 返回原引用**，因此随后的 freezeDeep 只会冻结投影副本。
 */
function safeProjection(value, seen) {
  if (value === null || value === undefined) return value === undefined ? undefined : null
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return value
  if (kind === 'bigint') return String(value)
  if (kind === 'function' || kind === 'symbol') return undefined
  if (kind !== 'object') return undefined
  if (seen.has(value)) return undefined // 环：断链丢弃该分支
  seen.add(value)
  let projected
  if (Array.isArray(value)) {
    projected = value.map((item) => safeProjection(item, seen))
  } else {
    projected = {}
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('_')) continue // adapter 私有运行时字段：绝不进投影
      const childProjected = safeProjection(child, seen)
      if (childProjected !== undefined) projected[key] = childProjected
    }
  }
  seen.delete(value)
  return projected
}

/**
 * 冻结投影用的深拷贝：既切断与内部真值的引用，又不携带 adapter 私有运行时字段。
 * adapter 的惰性缓存字段统一以 `_` / `__` 前缀命名（qq-bot 的 `_tokenManager`/`_rateGate`/
 * `_msgSeq`、wecom-app 的 `_tokenManager`、desktop 的 `__burntToastProbe`）——它们是
 * 运行态缓存（含 token 管理器等），绝不能出现在 Support Report / resolved.channels 等
 * 外部投影里。旧实现因为冻结写不进去，这些字段恰好恒为 undefined 被 JSON 丢弃；现在
 * live 对象会真实累积它们，故投影必须显式剔除。
 *
 * v0.15（Gate 2E）：JSON 路径失败时**绝不** freeze live 对象——退化为安全结构投影。
 */
function projectConfig(config) {
  try {
    const text = JSON.stringify(config, (key, value) => (key.startsWith('_') ? undefined : value))
    if (typeof text === 'string') return freezeDeep(JSON.parse(text))
  } catch { /* 循环引用 / 不可序列化：退化为安全结构投影（不是 clone） */ }
  return freezeDeep(safeProjection(config, new WeakSet()))
}

/**
 * 冻结投影：`{ type, config }` 的深拷贝副本并 deep-freeze。
 * 外部观察方拿到的是与内部真值无引用关系的快照，改动既不生效也不抛错穿透内部。
 */
function project(entry) {
  return Object.freeze({ type: entry.type, config: projectConfig(entry.config) })
}

/**
 * 内部 live entry：外层包装冻结（type 不可改），但 `config` 保持可变——adapter 私有
 * 运行时对象必须允许合法惰性缓存写入。
 */
function liveEntry(type, config) {
  return Object.freeze({ type, config })
}

/** 归一入口：只过滤形状，不 clone/不冻结 config（保留 adapter 运行时对象身份）。 */
function normalize(entries) {
  const map = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const type = typeof entry?.type === 'string' ? entry.type.trim() : ''
    if (type === '' || entry?.config === null || typeof entry?.config !== 'object' || Array.isArray(entry.config)) continue
    map.set(type, liveEntry(type, entry.config))
  }
  return map
}

export function createOutboundSource(initial = [], { onRetire = null } = {}) {
  let byType = normalize(initial)
  let version = 0
  const listeners = new Set()

  // v0.15（T10）：runtime 生命周期 owner。配置被移除/热替换时，旧 resolved 上的运行时资源
  // （qq-bot/wecom-app 的 token 管理器等）必须在**唯一权威处**释放——否则被丢弃的配置仍持有
  // 可用凭证、或在飞结果落地到已被替换的 runtime。stateless 渠道无 runtime，hook 由调用方
  // 按 sender 契约判定（未登记渠道 no-op）。
  const retire = (type, config) => {
    if (typeof onRetire !== 'function') return
    try { onRetire(type, config) } catch { /* 释放失败绝不影响 runtime 真值切换 */ }
  }

  const emit = (event) => {
    version += 1
    const payload = Object.freeze({ version, ...event })
    for (const listener of [...listeners]) {
      try { listener(payload) } catch { /* runtime state change must never fail because observers fail */ }
    }
    return payload
  }

  const api = {
    /** 冻结投影数组（外部观察方专用；内部真值不被引用共享）。 */
    snapshot() {
      return [...byType.values()].map(project)
    },

    /** live runtime entry 数组（传输路径专用；config 可变，adapter 可惰性缓存）。 */
    liveEntries() {
      return [...byType.values()]
    },

    /** 单个 live runtime entry（传输路径专用）；不存在返回 null。 */
    live(type) {
      return byType.get(String(type ?? '').trim()) ?? null
    },

    types() {
      return [...byType.keys()]
    },

    has(type) {
      return byType.has(String(type ?? '').trim())
    },

    /** 冻结投影（外部观察方专用）；不存在返回 null。 */
    get(type) {
      const entry = byType.get(String(type ?? '').trim())
      return entry === undefined ? null : project(entry)
    },

    replace(type, config) {
      const key = typeof type === 'string' ? type.trim() : ''
      if (key === '' || config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new TypeError('replace(type, config) requires a non-empty type and object config')
      }
      const previous = byType.get(key)
      const next = new Map(byType)
      next.set(key, liveEntry(key, config))
      byType = next
      if (previous !== undefined && previous.config !== config) retire(key, previous.config)
      emit({ topic: 'replace', type: key })
      return api.live(key)
    },

    remove(type) {
      const key = typeof type === 'string' ? type.trim() : ''
      if (key === '' || !byType.has(key)) return false
      const previous = byType.get(key)
      const next = new Map(byType)
      next.delete(key)
      byType = next
      retire(key, previous.config)
      emit({ topic: 'remove', type: key })
      return true
    },

    replaceAll(entries) {
      const previous = byType
      byType = normalize(entries)
      for (const [key, entry] of previous) {
        const kept = byType.get(key)
        if (kept === undefined || kept.config !== entry.config) retire(key, entry.config)
      }
      emit({ topic: 'replace-all', type: null })
      return api.snapshot()
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    get version() {
      return version
    },
  }

  return api
}