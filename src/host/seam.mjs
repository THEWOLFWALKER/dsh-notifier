// dsh-notifier host/seam.mjs
// v0.15（T13）官方 Host seam：**唯一**集中读取宿主服务、描述宿主能力、并管理 Cordis
// 可选依赖生命周期的模块。装配层（index.mjs）、宿主原生提问桥与诊断快照都经此取用，
// 不再各自散落 `ctx.get(...)` / `ctx.inject(...)` / 版本比较。
//
// 三条不变量：
//  1. 读取绝不抛错、绝不谎报：服务缺失/代理抛错/无 get 一律按「无服务」处理（fail-closed）。
//  2. 能力由**运行时探测**（seam 是否存在）与**声明表**（版本差异）共同给出；声明表只描述
//     版本间的*已知差异*，探测结果永远优先——宿主实际暴露什么就报什么。
//  3. 生命周期集中：late inject（服务晚出现）、replacement（服务被重建）与 dispose（插件
//     卸载）由 createHostLifetime 统一登记/释放，旧监听随子 fiber 退出，绝不重复注册。
//
// 版本差异（0.1.7 ↔ 0.2 的 timed/continued）：
//  - `timed`：宿主 `ask()` 支持**有界等待**——等待结束后宿主问题可能仍在待决（Host 仍
//    pending），插件不得据此误判为取消。
//  - `continued`：宿主支持**迟到答复**——有界等待结束后，迟到的作答仍可被投递/结算。
//  这两个语义是「host question lifecycle」的一部分（T15 消费），仅在此声明并经原样透出；
//  未列版本一律回落保守描述（全关）——此时由插件自有超时口径主导，不做迟到答复假设。
//
// 红线：只使用公开 seam。不读私有字段、不 monkey patch、不因缺能力阻断通知与其他通道。

import { detectHostVersion, detectQuestionsMode } from './capability.mjs'

const isRecord = (value) => typeof value === 'object' && value !== null

/**
 * 声明式宿主提问能力表（按发布版本）。
 *
 * 来源/证据（不臆造宿主源码）：
 *  - `waterfall` 是 DSH 0.1.7-rc.* 线**实测**的正式 seam（`UserQuestionService.ask()`
 *    → `ctx.waterfall('user-questions/request', …)`，见 docs/compatibility-matrix.md 的
 *    S14 审计，fixture-covered）。alpha.* 线未取得该 seam 证据，保守标 false。
 *  - `provider`（registerProvider）仅 future/legacy feature probe。
 *  - `timed` / `continued` 是较新宿主的问题生命周期语义；0.1.7 全线为 false，
 *    发布版 `0.2.0-rc.2`（npm `next` dist-tag，T01 研究）为 true，但 `verified:false`
 *    （尚无 fixture）——**不是**支持声明，只用于能力协商。
 *  - 表未列的版本 → `CONSERVATIVE_QUESTION_CAPABILITY`（fail-closed）。
 *
 * 注意：表只给「版本间差异」；`hostQuestionFeatures().seam` 始终是**运行时探测**结果，
 * 表绝不覆盖运行中的真实宿主暴露面。
 */
export const HOST_QUESTION_CAPABILITY = Object.freeze({
  // —— 0.1.7 线：声明支持的 peer（docs/compatibility-matrix.md auditedHosts）——
  '0.1.7-alpha.1': Object.freeze({ waterfall: false, provider: false, timed: false, continued: false, verified: false }),
  '0.1.7-alpha.2': Object.freeze({ waterfall: false, provider: false, timed: false, continued: false, verified: false }),
  '0.1.7-rc.1': Object.freeze({ waterfall: true, provider: false, timed: false, continued: false, verified: true }),
  '0.1.7-rc.2': Object.freeze({ waterfall: true, provider: false, timed: false, continued: false, verified: true }),
  // —— 前向线：发布版 next（0.2.0-rc.2）；仅能力协商，非支持声明 ——
  '0.2.0-rc.2': Object.freeze({ waterfall: true, provider: false, timed: true, continued: true, verified: false }),
})

/** 未列版本的保守描述：不假设任何版本差异能力（fail-closed）。 */
export const CONSERVATIVE_QUESTION_CAPABILITY = Object.freeze({
  waterfall: false,
  provider: false,
  timed: false,
  continued: false,
  verified: false,
})

/**
 * 防御读取任一宿主服务（cordis ctx 代理对未 inject 的服务直读会抛错）。
 * 与既有 `readUserQuestions` / `readAttachments` 同口径：优先非抛错 `ctx.get(name, false)`，
 * 无 get 的宿主/测试桩回落直读属性并吞掉代理抛错（按「无服务」处理）。
 * @returns {object|null} 服务对象，或 null（缺失/不可读）。
 */
export function readHostService(ctx, name) {
  if (typeof name !== 'string' || name === '') return null
  try {
    if (typeof ctx?.get === 'function') {
      const service = ctx.get(name, false)
      return service === undefined || service === null ? null : service
    }
  } catch { /* get 异常按无服务处理，不致命 */ }
  try {
    const service = ctx?.[name]
    return service === undefined || service === null ? null : service
  } catch { return null }
}

/**
 * 宿主提问 seam 能力（运行时探测 + 版本声明）。
 * @param {object} [ctx] - cordis 上下文
 * @returns {{ version: string, known: boolean, verified: boolean, seam: string,
 *   supported: boolean, waterfall: boolean, provider: boolean, timed: boolean, continued: boolean }}
 *   - `seam` 永远来自**运行时探测**（provider-chain | native-event | unsupported）
 *   - `supported` = seam 存在；unsupported 时 timed/continued 一律 false（不假设）
 *   - `known` = 版本在声明表内；`verified` = 该行有 fixture 证据
 */
export function hostQuestionFeatures(ctx) {
  const version = detectHostVersion(ctx)
  const seam = detectQuestionsMode(ctx)
  const declared = Object.prototype.hasOwnProperty.call(HOST_QUESTION_CAPABILITY, version)
    ? HOST_QUESTION_CAPABILITY[version]
    : null
  const caps = declared ?? CONSERVATIVE_QUESTION_CAPABILITY
  const supported = seam !== 'unsupported'
  return {
    version,
    known: declared !== null,
    verified: caps.verified === true,
    seam,
    supported,
    // 运行时未暴露 seam → 任何版本差异能力都不成立（fail-closed，绝不谎报可用）。
    waterfall: supported && caps.waterfall === true,
    provider: supported && caps.provider === true,
    timed: supported && caps.timed === true,
    continued: supported && caps.continued === true,
  }
}

/**
 * 集中管理插件对宿主可选依赖的 Cordis 生命周期。装配层用它替代裸 `ctx.inject`：
 *  - late inject：依赖服务晚出现时回调触发（cordis 语义），插件此时才 attach。
 *  - replacement：依赖服务被重建 → 旧子 fiber 释放（旧监听随之退出）后回调**重放**；
 *    调用方 attach 必须幂等（先撤本地句柄再重挂），本封装保证重放仍只经同一入口。
 *  - dispose：插件卸载时释放全部登记，幂等、绝不抛错。
 *
 * 无 `ctx.inject` 的宿主/测试桩 → 立即以根 ctx 直连 attach（局部降级，绝不阻断装配）。
 *
 * @param {object} ctx - cordis 上下文
 * @param {{ warn?: (message: string) => void }} [deps]
 * @returns {{ inject: (names: string[], attach: (subCtx: object) => void, options?: object) => boolean,
 *   dispose: () => void, disposed: boolean }}
 */
export function createHostLifetime(ctx, deps = {}) {
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}
  const report = (message) => { try { warn(message) } catch { /* 诊断绝不致命 */ } }
  const registrations = []
  let disposed = false

  const runAttach = (attach, subCtx, label) => {
    try { attach(subCtx) } catch (error) {
      report(`host seam attach 失败（${label}）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const inject = (names, attach, options = {}) => {
    const list = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name !== '') : []
    const label = typeof options.label === 'string' && options.label !== '' ? options.label : list.join(',')
    if (disposed) return false
    // 无可选依赖 API（老宿主/测试桩）：直连根 ctx，局部降级而非阻断装配。
    if (typeof ctx?.inject !== 'function') {
      runAttach(attach, ctx, label)
      return false
    }
    try {
      // cordis：子插件回调第一参数 = 可选依赖子上下文；随依赖服务 fiber 生命周期撤销/重放。
      // 本封装只登记撤销句柄，不改变 attach 的幂等契约（由调用方保证）。
      const disposeInject = ctx.inject(list, (subCtx) => { if (!disposed) runAttach(attach, subCtx, label) })
      if (typeof disposeInject === 'function') registrations.push(disposeInject)
    } catch (error) {
      report(`host seam inject 失败（${label}）: ${error instanceof Error ? error.message : String(error)}`)
      runAttach(attach, ctx, label) // fail-open：回落直连，绝不弄崩装配
      return false
    }
    return true
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const disposeInject of registrations.splice(0)) {
      try { disposeInject() } catch { /* 反注册失败不致命 */ }
    }
  }

  return {
    inject,
    dispose,
    get disposed() { return disposed },
  }
}

/**
 * 聚合的宿主 seam 门面：装配层/诊断只需持有它，不再直接触摸 ctx 上的宿主服务。
 * 只读、无副作用（dispose 除外）；所有方法缺失时返回 null/false，绝不抛错。
 * @param {object} ctx
 * @param {{ warn?: (message: string) => void }} [deps]
 */
export function createHostSeam(ctx, deps = {}) {
  const lifetime = createHostLifetime(ctx, deps)
  return {
    version: () => detectHostVersion(ctx),
    questionFeatures: () => hostQuestionFeatures(ctx),
    questions: () => readHostService(ctx, 'userQuestions'),
    attachments: () => readHostService(ctx, 'attachments'),
    agents: () => readHostService(ctx, 'agents'),
    connection: () => readHostService(ctx, 'connection'),
    webServer: () => readHostService(ctx, 'webServer'),
    inject: lifetime.inject,
    dispose: lifetime.dispose,
    get disposed() { return lifetime.disposed },
  }
}