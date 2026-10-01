// dsh-notifier adapters/sender.mjs
// v0.15（T09）：provider **sender 契约**——受控 provider 迁移（T10/T11）的试点接缝。
//
// 背景：今天的出站路径直接调 `adapter.send(resolved, msg)`，成功即 `resolve undefined`、
// 失败即抛 `NotifyError`，投递证据（accepted vs confirmed）由调用方旁路推断。本模块把这条
// 隐含契约显式化，并**声明渠道的生命周期种类**，让 runtime 绝不会为一个没有常驻资源的渠道
// 伪造 `createRuntime`/`start`/`stop`/`candidate`/`dispose` 空方法（02 §生命周期与资源、
// T09 边界「没有常驻资源就不实现 start/stop/candidate lifecycle」）。
//
// sender 契约（stateless）只有两件真实动作：
//   validate(rawCfg) -> resolved      归一/校验后的输入（immutable 语义：send 不得改写它）
//   send(resolved, msg) -> evidence   `{ accepted, confirmed }` 两级投递证据
// 它**故意不导出** createRuntime/dispose——stateless 渠道没有任何跨调用资源需要持有。
// stateful 资源型渠道（T10：qq-bot/wecom-app 等）在同一形状上追加这些生命周期动词。
//
// 现有 adapter 已经满足契约里「纯」的那一半（resolve + send）。下面的 bridge 把它们接进来，
// **不改一个字节协议代码**：因此试点可以随时把某渠道切进/切出 sender 契约而行为不变
// （回退要求「只切该渠道 wrapper；旧 payload golden 一致」）。

import { isConfirmedReceipt } from '../delivery-evidence.mjs'

/** 渠道生命周期种类：stateless 每次调用自持输入；stateful 持有跨调用资源。 */
export const SENDER_LIFECYCLE = Object.freeze({
  STATELESS: 'stateless',
  STATEFUL: 'stateful',
})

/**
 * 定义一个 stateless sender。形状被冻结，且**只**含 validate/send 两个动作——
 * 不提供任何常驻资源动词。
 * @param {{ type: string, validate: (cfg: object) => object, send: (resolved: object, msg: object) => Promise<object> }} spec
 */
export function defineStatelessSender({ type, validate, send }) {
  if (typeof type !== 'string' || type.trim() === '') throw new TypeError('sender type is required')
  if (typeof validate !== 'function') throw new TypeError(`sender "${type}" requires validate()`)
  if (typeof send !== 'function') throw new TypeError(`sender "${type}" requires send()`)
  return Object.freeze({ type, lifecycle: SENDER_LIFECYCLE.STATELESS, validate, send })
}

/**
 * 把旧式 `{ type, resolve, send }` adapter 桥接为 stateless sender（协议代码零改动）。
 * 旧 send 的成功语义（resolve undefined 或回执对象）在此收敛为显式二级证据：
 *   - 只要 provider 接受了请求（send 未抛错）→ accepted
 *   - 仅当返回值带显式回执（`confirmed`/`receipt`）→ confirmed（delivery-evidence.mjs 权威）
 * 失败语义不变：原样抛出 NotifyError，由上层按 publicMessage/detail 分层处理。
 */
export function bridgeStatelessAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object') throw new TypeError('adapter is required')
  return defineStatelessSender({
    type: adapter.type,
    validate: (cfg) => adapter.resolve(cfg),
    send: async (resolved, msg) => {
      const receipt = await adapter.send(resolved, msg)
      return Object.freeze({ accepted: true, confirmed: isConfirmedReceipt(receipt) })
    },
  })
}

// ————————————————— T10：stateful（资源型）sender 契约 —————————————————
//
// 资源型渠道（qq-bot 的 token 管理器/限速门/msg_seq、wecom-app 的 token 管理器）持有**跨调用**
// 资源，不能被每次 validate 重新造一遍，也不能把资源写进配置投影。T10 把它们收进显式 runtime：
//
//   validate(rawCfg) -> resolved     纯归一，不持有资源
//   createRuntime(resolved) -> runtime
//     runtime: { start(), stop(), dispose(), send(msg) -> receipt }
//
// sender 本体的 `send(resolved, msg)` 走**每 resolved 单 owner** 的内部 runtime：
//   - 单 owner：同一 resolved 并发 send / createRuntime 只创建一个 runtime，start 只跑一次。
//   - epoch：retire() 后，旧 runtime 上在飞 send 的迟到结果被丢弃（CHANNEL_RETIRED），
//     绝不冒充一次成功投递去写 audit / 推进证据——「停用后旧 callback 不落地」。
//   - 有限 dispose：retire() 停一次、dispose 一次、从表里移除引用（可 GC，无定时器泄漏）。
// 资源仍由 adapter 持有于 live resolved（T08 分层：resolved=live 可变对象），故 stateless 渠道
// 绝不伪造这些动词，stateful 渠道也绝不把资源写进投影。

/**
 * 定义一个 stateful sender。契约形状冻结，且只含 validate/createRuntime/send/retire 四个动作。
 * @param {object} spec
 * @param {string} spec.type
 * @param {(cfg: object) => object} spec.validate
 * @param {(resolved: object) => { send: (msg: object) => Promise<unknown>, start?: Function, stop?: Function, dispose?: Function }} spec.createRuntime
 * @param {(resolved: object) => void} [spec.onRetire] - retire 后回调（adapter 释放资源）
 */
export function defineStatefulSender({ type, validate, createRuntime, onRetire = null }) {
  if (typeof type !== 'string' || type.trim() === '') throw new TypeError('sender type is required')
  if (typeof validate !== 'function') throw new TypeError(`stateful sender "${type}" requires validate()`)
  if (typeof createRuntime !== 'function') throw new TypeError(`stateful sender "${type}" requires createRuntime()`)

  // resolved -> slot。WeakMap：runtime 随 resolved 自然回收，绝不让配置对象成为长期根。
  const slots = new WeakMap()
  const retired = new WeakSet()
  const stats = { created: 0, retired: 0 }

  const invoke = (fn) => {
    if (typeof fn !== 'function') return undefined
    try { return fn() } catch { return undefined } // 生命周期动词失败不得把 retire 卡死
  }

  const acquire = (resolved) => {
    if (retired.has(resolved)) {
      const error = new Error(`sender "${type}" runtime 已被永久停用，旧 resolved 不得复活`)
      error.code = 'CHANNEL_RETIRED'
      error.noRetry = true
      throw error
    }
    const existing = slots.get(resolved)
    if (existing !== undefined && existing.closed !== true) return existing
    const runtime = createRuntime(resolved)
    if (runtime === null || typeof runtime !== 'object' || typeof runtime.send !== 'function') {
      throw new TypeError(`stateful sender "${type}" createRuntime() must return { send() }`)
    }
    const slot = { runtime, closed: false, epoch: stats.created + 1 }
    slots.set(resolved, slot)
    stats.created += 1
    invoke(() => runtime.start?.()) // 幂等；启动失败在首次 send 上可见
    return slot
  }

  const sender = {
    type,
    lifecycle: SENDER_LIFECYCLE.STATEFUL,
    validate: (cfg) => validate(cfg),
    /** 单 owner 取 runtime（同一 resolved 只创建一次；retire 后再次调用得到全新 epoch 的 runtime）。 */
    createRuntime: (resolved) => acquire(resolved).runtime,
    async send(resolved, msg) {
      const slot = acquire(resolved)
      const receipt = await slot.runtime.send(msg)
      // epoch 守卫：send 在飞期间被 retire 的 runtime，其结果一律作废（fail-closed，不重发）。
      if (slot.closed === true) {
        const error = new Error(`sender "${type}" runtime 已被停用，迟到结果作废（不重发）`)
        error.code = 'CHANNEL_RETIRED'
        error.noRetry = true
        throw error
      }
      return Object.freeze({ accepted: true, confirmed: isConfirmedReceipt(receipt) })
    },
    /** 停用某 resolved 的 runtime：epoch 作废 + stop/dispose 各一次 + 释放引用。幂等。 */
    retire(resolved) {
      const slot = slots.get(resolved)
      if (slot === undefined) return false
      slots.delete(resolved)
      retired.add(resolved)
      if (slot.closed === true) return false
      slot.closed = true
      invoke(() => slot.runtime.stop?.())
      invoke(() => slot.runtime.dispose?.())
      if (typeof onRetire === 'function') { try { onRetire(resolved) } catch { /* 释放失败不致命 */ } }
      stats.retired += 1
      return true
    },
  }
  // 诊断计数非枚举：契约形状只暴露 type/lifecycle/validate/createRuntime/send/retire。
  Object.defineProperty(sender, 'activeCount', {
    enumerable: false,
    get: () => stats.created - stats.retired,
  })
  return Object.freeze(sender)
}

/**
 * 把旧式 `{ type, resolve, send, disposeRuntime? }` adapter 桥接为 stateful sender（协议代码零改动）。
 * 资源仍由 adapter 惰性持有于 live resolved；runtime 只负责生命周期与 epoch，dispose 时调用
 * adapter.disposeRuntime(resolved) 释放 token 缓存等（有限 dispose）。
 */
export function bridgeStatefulAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object') throw new TypeError('adapter is required')
  return defineStatefulSender({
    type: adapter.type,
    validate: (cfg) => adapter.resolve(cfg),
    createRuntime: (resolved) => ({
      send: (msg) => adapter.send(resolved, msg),
      start() { /* 资源型渠道无独立启动动作：token 按需换取（P01 single-flight） */ },
      stop() { /* 无常驻连接；stop 只标记 epoch 作废 */ },
      dispose() { adapter.disposeRuntime?.(resolved) },
    }),
  })
}