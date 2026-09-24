// dsh-notifier host/native-questions.mjs
// v0.10 宿主原生提问桥（任务书 3.2 Issue #3/#5）：把宿主 `ctx.userQuestions` 的
// `ask_user_question` 桥接到现有 `aq:` 账本与 Control Core，使原生提问、Web、手机
// 共用同一个首达结算闭环。
//
// 接缝选择（按宿主公开能力探测，单一能力检查、无并行双路径）：
//  - 首选 `registerProvider` provider seam（若未来宿主提供）；
//  - 缺失时回落 `user-questions/request` waterfall 拦截器（dsh 0.1.5-rc.x 真实公开
//    形态：dsh-user-questions 只暴露 ask()，web GUI 亦经该 waterfall 挂 answerer）。
//    拦截器 `{ prepend: true, global: true }` 注册：prepend 保证先于 GUI answerer
//    收到请求（双面同时活跃），global 绕过 scopeTarget 作用域过滤（同 #28 教训）。
//
// 职责边界（任务书建议的窄接口）：
//  - capabilities()  支持状态与模式，不含 sessionId/正文/token/凭证
//  - attach()        接入宿主原生问题源（provider 或 waterfall）
//  - pending()       当前待决原生问题（脱敏，供管理台）
//  - settle()        经 Control Core 首达结算（委托现有 questionBridge.adminSettle）
//  - snapshot()      管理台诊断
//  - dispose()       完整撤销（无监听、无迟到回调落账）
//
// 已知限制（宿主侧，见 docs/memory/risks.md）：waterfall 被本拦截器抢答后，宿主
// `ask()` 不 abort signal，GUI 远端卡片不会自动收起（orphan card）——修复属 DSH
// core（ask() settle 时 abort 链接 signal），插件侧如实降级并文档化。
//
// 红线：只使用公开 seam。不读私有字段、不覆盖未公开 singleton、不依赖插件加载顺序、
// 不 monkey patch 宿主内部方法。seam 不可用或已被占用时安全降级到 `unsupported`，
// 保留插件自有 `ask_user` fallback，绝不伪造「已桥接」。

import { detectQuestionsMode, readUserQuestions } from './capability.mjs'

const isRecord = (value) => typeof value === 'object' && value !== null

/**
 * 把原生 AskUserQuestionOption 归一为 aq 桥的选项标签；description 拼进上下文避免丢信息。
 * @returns {{ labels: string[], detail: string }}
 */
function normalizeOptions(options) {
  const labels = []
  const descriptions = []
  for (const option of Array.isArray(options) ? options : []) {
    if (option === null || typeof option !== 'object') continue
    const label = String(option.label ?? '')
    if (label !== '') labels.push(label)
    const description = String(option.description ?? '')
    if (description !== '') descriptions.push(description)
  }
  return { labels, detail: descriptions.join('\n') }
}

/**
 * 创建宿主原生提问桥。
 * @param {object} deps
 * @param {object} deps.ctx - cordis 上下文（含可选 ctx.userQuestions seam）
 * @param {ReturnType<typeof import('../questions/router.mjs').createQuestionBridge>} deps.questionBridge
 *   - 已装配的远程提问桥，承载 aq: 账本、推送、首达采纳与 askQuestions 循环
 * @param {object} [deps.logger]
 */
export function createNativeQuestionBridge(deps = {}) {
  const { ctx, questionBridge } = deps
  const logger = deps.logger ?? null
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/native-questions]', message) } catch { /* 日志失败绝不致命 */ }
  }

  let provider = null
  let disposeProvider = null
  let disposed = false
  let attachError = null // 注册失败码（如 DUPLICATE_PROVIDER），capabilities/snapshot 用
  let attachMode = null // 'provider' | 'waterfall' | null（capabilities.mode 用）

  /** deps.canDeliver：入站交互通道是否就绪（空表 = 无手机面，拦截器不截流）。 */
  const canDeliver = typeof deps.canDeliver === 'function' ? deps.canDeliver : () => true

  /**
   * 宿主经 ctx.userQuestions.ask() 调用的 provider.ask(request) 入口：
   * 把原生请求映射为 aq 桥 payload → await 首达结算 → 映射回 AskUserQuestionAnswer。
   * 任何一步异常只返回空答案（绝不让宿主提问被静默吞掉，也不编造答案）。
   * @param {object} [execOptions] - 透传给 askQuestions 的 execContext 附加项
   *   （waterfall 拦截器用它传 onOpen 精确引用回告；provider 路径不传）。
   */
  async function hostAsk(request, execOptions = null) {
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return { answers: [] }
    const normalized = questions.map((question) => {
      const options = normalizeOptions(question?.options)
      return {
        id: String(question?.id ?? ''),
        question: String(question?.question ?? ''),
        options,
        multiSelect: question?.multiSelect === true,
        detail: [
          String(question?.detail ?? ''),
          options.detail,
        ].filter((part) => part !== '').join('\n'),
      }
    })
    const payload = {
      questions: normalized.map((entry) => ({
        question: entry.question,
        options: entry.options.labels.map((label) => ({ label })),
        multiSelect: entry.multiSelect,
      })),
      context: normalized.map((entry) => entry.detail).filter((part) => part !== '').join('\n'),
      // 原生提问超时由 questionBridge 的默认策略兜底（宿主 signal 取消见 review 收口）。
    }
    let outcome
    try {
      outcome = await questionBridge.askQuestions(payload, { agent: request?.agent, ...(execOptions ?? {}) })
    } catch (error) {
      warn(`原生提问桥问询异常（返回未作答，绝不让宿主被吞）: ${error instanceof Error ? error.message : String(error)}`)
      return { answers: normalized.map((entry) => ({ id: entry.id, selected: [] })) }
    }
    const results = Array.isArray(outcome?.results) ? outcome.results : []
    const answers = normalized.map((entry, index) => {
      const result = results[index]
      if (result === undefined || result === null || result.answered !== true) {
        // 未作答/超时/跳过/终止/错误 → selected 空（保留「跳过项」语义，宿主自行处理）
        return { id: entry.id, selected: [] }
      }
      // 自定义文本作答（aq-text）→ custom；选项作答 → selected label 数组。
      if (typeof result.via === 'string' && result.via.endsWith(':text')) {
        const custom = Array.isArray(result.answers) ? String(result.answers[0] ?? '') : ''
        return { id: entry.id, selected: [], custom }
      }
      const selected = Array.isArray(result.answers) ? result.answers.map(String) : []
      return { id: entry.id, selected }
    })
    return { answers }
  }

  /** 支持状态与模式（无敏感数据）。 */
  function capabilities() {
    const seam = detectQuestionsMode(ctx)
    return {
      seam,
      mode: provider !== null && disposeProvider !== null
        ? (attachMode === 'waterfall' ? 'waterfall' : seam)
        : 'unsupported',
      attached: provider !== null && disposeProvider !== null,
      error: attachError,
    }
  }

  /**
   * `user-questions/request` waterfall 拦截器（宿主缺 registerProvider 时的接缝）。
   * 双面并发 + 首达结算：立即把问题推上 aq 桥（手机/管理台可见），与下游 GUI
   * answerer（next()）race，先答先算：
   *  - 手机/管理台先答 → 本侧答案上交宿主（下游成为输家，catch 兜底防未处理拒绝；
   *    GUI 卡片能否自动收起属宿主 ask() signal 语义，见模块头「已知限制」）。
   *  - GUI 先答 → 下游答案上交宿主；abort 拦截器范围取消信号——askQuestions 侧清
   *    延迟推卡（Stage 0→1 pushTimer）、停升级、abandon 等待（账本行终结），多问
   *    请求的后续问题不再开（router 循环头 aborted 检查）。绝不迟推卡。
   *  - 下游先 reject（GUI answerer 异常 / headless 宿主无 answerer 的 NO_PROVIDER）
   *    → 不判死整场 race：下游转为永不 settle，等手机/管理台作答兜底。
   *  - 空请求 / 无入站交互通道（canDeliver 假）→ 原样透传 next()，GUI-only 宿主
   *    行为与未装本插件时完全一致。
   * next() 至多调用一次（nextCalled 哨兵）；拦截器任何异常透传下游或返回空答案，
   * 绝不让宿主提问被静默吞掉。
   */
  function waterfallHandler(request, next) {
    let nextCalled = false
    const downstreamOnce = () => {
      nextCalled = true
      return Promise.resolve().then(() => next())
    }
    try {
      const questions = Array.isArray(request?.questions) ? request.questions : []
      if (questions.length === 0 || canDeliver() !== true) return downstreamOnce()
      // 拦截器范围取消信号：GUI 先答时 abort（收尾语义全部在 askQuestions 侧落地）。
      const controller = new AbortController()
      // hostAsk 全捕获（内部 catch → 空答案），此处再兜一层防御：绝不让 race 因本侧 reject。
      const telegramAnswer = Promise.resolve().then(() => hostAsk(request, { signal: controller.signal }))
        .catch(() => ({ answers: (Array.isArray(request?.questions) ? request.questions : [])
          .map((question) => ({ id: String(question?.id ?? ''), selected: [] })) }))
      const downstream = downstreamOnce()
      // 输家卫生（两向）：原始 downstream 的 rejection 在此消费，绝不未处理；
      // race 内的派生 promise 对 rejection 转「永不 settle」——下游失败（GUI 异常 /
      // headless NO_PROVIDER）不判死提问，手机/管理台仍可作答。
      downstream.catch(() => { /* race 输家，无需处理 */ })
      let downstreamWon = false
      return Promise.race([
        telegramAnswer,
        downstream.then(
          (value) => { downstreamWon = true; return value },
          () => new Promise(() => { /* 下游失败：悬置，等本侧答案 */ }),
        ),
      ]).then((winner) => {
        if (downstreamWon) {
          try { controller.abort() } catch { /* 已终结则忽略 */ }
        }
        return winner
      })
    } catch (error) {
      warn(`waterfall 拦截器异常: ${error instanceof Error ? error.message : String(error)}`)
      if (!nextCalled) return downstreamOnce()
      // next 已被调用后仍异常：返回空答案，绝不吞宿主提问。
      return Promise.resolve({ answers: [] })
    }
  }

  /**
   * 接入宿主原生问题源。失败（seam 缺失/被占用）时记录原因并安全降级。
   * @param {object} [subCtx] - 可选依赖子上下文（ctx.inject 回调的第一参数）：
   *   waterfall 监听器注册在 subCtx 上，随依赖服务的 fiber 生命周期自动撤销；
   *   服务被替换/重建后子插件重放时，attach 重挂到新 subCtx（旧监听已随旧
   *   fiber 释放，先撤本地句柄再重注册）。缺省回落插件根 ctx（旧宿主/直连路径）。
   * @returns {boolean} 是否成功 attach
   */
  function attach(subCtx = null) {
    if (disposed) return false
    // 重放安全：服务重建后 ctx.inject 回调再次进入时，旧监听已随旧 fiber 释放，
    // 本地句柄作废——先撤再重挂，绝不重复注册。
    if (disposeProvider !== null) {
      try { disposeProvider() } catch { /* 旧句柄已失效（fiber 已释放），忽略 */ }
      disposeProvider = null
      provider = null
    }
    // #27：防御读（ctx.get 非抛错优先，代理直读兜底）——探测绝不能炸装配。
    const userQuestions = readUserQuestions(ctx)
    if (!isRecord(userQuestions)) {
      attachError = 'no_userQuestions'
      return false
    }
    if (typeof userQuestions.registerProvider === 'function') {
      provider = { ask: hostAsk }
      try {
        disposeProvider = userQuestions.registerProvider(provider)
      } catch (error) {
        attachError = (error && (error.code ?? error.name)) || 'register_failed'
        provider = null
        disposeProvider = null
        warn(`原生提问 provider 注册失败（降级 unsupported）: ${attachError}`)
        return false
      }
      attachMode = 'provider'
      attachError = null // 重放成功：清掉上一次失败残留的错误码
      return true
    }
    // 宿主真实形态（dsh-user-questions 0.1.5-rc.x）：只有 ask()，无 registerProvider。
    // 回落 waterfall 拦截器；无 ctx.on 的宿主/桩保持原降级码。
    const registerCtx = isRecord(subCtx) && typeof subCtx.on === 'function' ? subCtx : ctx
    if (typeof registerCtx?.on !== 'function') {
      attachError = 'no_register_provider'
      return false
    }
    provider = { ask: hostAsk }
    try {
      disposeProvider = registerCtx.on('user-questions/request', waterfallHandler, { prepend: true, global: true })
    } catch (error) {
      attachError = (error && (error.code ?? error.name)) || 'waterfall_register_failed'
      provider = null
      disposeProvider = null
      warn(`waterfall 提问拦截器注册失败（降级 unsupported）: ${attachError}`)
      return false
    }
    attachMode = 'waterfall'
    attachError = null // 重放成功：清掉上一次失败残留的错误码
    return true
  }

  /** 当前待决原生问题（脱敏快照，标记来源 native；委托 questionBridge）。 */
  function pending() {
    if (typeof questionBridge?.adminPending !== 'function') return []
    try {
      return questionBridge.adminPending().map((row) => ({ ...row, source: 'native' }))
    } catch {
      return []
    }
  }

  /** 经 Control Core 首达结算后回宿主（委托 questionBridge.adminSettle）。 */
  function settle(input = {}) {
    if (typeof questionBridge?.adminSettle !== 'function') {
      return { ok: false, handled: false, reason: 'no_settle', message: '原生桥未装配结算入口' }
    }
    try {
      return questionBridge.adminSettle(input)
    } catch (error) {
      return { ok: false, handled: false, reason: 'settle_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 管理台诊断快照（无敏感数据）。 */
  function snapshot() {
    return capabilities()
  }

  /** 完整撤销 provider（幂等；撤销失败不致命）。 */
  function dispose() {
    disposed = true
    try { disposeProvider?.() } catch { /* 反注册失败不致命 */ }
    disposeProvider = null
    provider = null
  }

  return { capabilities, attach, pending, settle, snapshot, dispose }
}