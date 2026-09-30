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