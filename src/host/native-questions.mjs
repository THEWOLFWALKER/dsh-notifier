// dsh-notifier host/native-questions.mjs
// v0.10 宿主原生提问桥（任务书 3.2 Issue #3/#5）：把宿主 `ctx.userQuestions` 的
// `ask_user_question` 经唯一的公开 seam（`registerProvider`）桥接到现有 `aq:` 账本与
// Control Core，使原生提问、Web、手机共用同一个首达结算闭环。
//
// 职责边界（任务书建议的窄接口）：
//  - capabilities()  支持状态与模式，不含 sessionId/正文/token/凭证
//  - attach()        注册 provider 接入宿主原生问题源
//  - pending()       当前待决原生问题（脱敏，供管理台）
//  - settle()        经 Control Core 首达结算（委托现有 questionBridge.adminSettle）
//  - snapshot()      管理台诊断
//  - dispose()       完整撤销 provider（无监听、无迟到回调落账）
//
// 红线：只使用公开 seam。不读私有字段、不覆盖未公开 singleton、不依赖插件加载顺序、
// 不 monkey patch 宿主内部方法。seam 不可用或已被占用时安全降级到 `unsupported`，
// 保留插件自有 `ask_user` fallback，绝不伪造「已桥接」。

import { detectQuestionsMode } from './capability.mjs'

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

  /**
   * 宿主经 ctx.userQuestions.ask() 调用的 provider.ask(request) 入口：
   * 把原生请求映射为 aq 桥 payload → await 首达结算 → 映射回 AskUserQuestionAnswer。
   * 任何一步异常只返回空答案（绝不让宿主提问被静默吞掉，也不编造答案）。
   */
  async function hostAsk(request) {
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
      outcome = await questionBridge.askQuestions(payload, { agent: request?.agent })
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
      mode: provider !== null && disposeProvider !== null ? seam : 'unsupported',
      attached: provider !== null && disposeProvider !== null,
      error: attachError,
    }
  }

  /**
   * 接入宿主原生问题源：注册 provider。失败（seam 缺失/被占用）时记录原因并安全降级。
   * @returns {boolean} 是否成功 attach
   */
  function attach() {
    if (disposed) return false
    if (disposeProvider !== null) return true
    const userQuestions = ctx?.userQuestions
    if (!isRecord(userQuestions)) {
      attachError = 'no_userQuestions'
      return false
    }
    if (typeof userQuestions.registerProvider !== 'function') {
      attachError = 'no_register_provider'
      return false
    }
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