// dsh-notifier questions/router.mjs
// v0.8 远程提问桥（issue #3/#5，规划书《选项卡通知》M1）：
// agent 调用 ask_user 工具 → 问题与选项推到手机（飞书选项卡片 / Telegram 按钮 /
// 无按钮通道编号回复）→ 用户作答 → 答案作为工具结果回传给 agent。
//
// 设计原则（规划书 P1–P7，全部复用审批桥接栈既有设施）：
//  - P1 双端并存首达采纳：bus.settle 天然键值泛化，谁先答谁赢，后到者 already-resolved
//  - P2 超时永不代答：超时 answered=false，静默交还桌面，绝不编造默认答案
//  - P3 选项集封闭：只接受提问时声明过的选项（下标越界/伪造负载一律拒绝）
//  - P4 卡片为主、编号兜底：选项卡片是主交互；编号文案只发卡片未送达的渠道
//    （无按钮通道 / 卡片投递失败 / 多选暂无卡片形态）。发错编号不作废问题：
//    回执提示 + 重发选项，保持待决可再答
//  - P5 裁决后终态化：作答/超时后卡片 patch 终态（去按钮、显结果）
//  - P7 回调载荷永不携带选项文本：aq:<qKey>:<optIdx>:<token>（下标引用）
//
// 账本：store 键空间 'aq:'（与审批 'ap:' 隔离），行 = {
//   question, options: [label], multiSelect, status: 'pending'|'resolved',
//   pushedTo: [{channel, chatId, userId, messageId, kind:'aq'}], createdAt,
//   hintChannels?: string[]（SEC-2：广播过编号话术的渠道，编号降级的 intended 兜底凭据，
//     缺省/旧行 = 不兜底从严）, decision?: 'answered'|'timeout'|'error',
//   answers?: [label]（重复点击回显用）
// }
// 军规：任何异常只丢当次提问（工具返回明确失败对象），绝不弄崩宿主。

import { randomBytes } from 'node:crypto'
import { normalizeInbound } from '../inbound/_contract.mjs'
import { guardTargets } from '../inbound/target-guard.mjs'
import { createEscalationChain } from '../approval/escalation.mjs'
import { createRateLimiter, compileParameters } from '../tool-register.mjs'

const KEY_PREFIX = 'aq:'

const DISPLAY_NAMES = {
  telegram: 'Telegram',
  feishu: '飞书',
  qq: 'QQ',
  wxpusher: 'WxPusher',
  wechat: '微信',
  dingtalk: '钉钉',
}

// 升级链默认节奏（与审批一致：30s / 60s 各再提醒一轮）
const DEFAULT_ESCALATION_STAGES = [
  { afterMs: 30_000, level: 'timeSensitive', note: '提问仍在等待作答' },
  { afterMs: 60_000, level: 'timeSensitive', note: '提问仍在等待作答（第 2 次提醒）' },
]

/** 组装编号回复文案（P4：按钮渠道也保留——卡片发送失败时文字路径仍在）。 */
function numberedHint(options, multiSelect) {
  const lines = options.map((label, idx) => `${idx + 1}. ${label}`)
  const how = multiSelect ? '回复编号（多选逗号分隔，如 1,3）' : '回复编号'
  return `${lines.join('\n')}\n（${how}）`
}

/**
 * 创建远程提问桥。
 * @param {object} deps
 * @param {ReturnType<typeof import('../inbound/bus.mjs').createInboundBus>} deps.bus
 * @param {ReturnType<typeof import('../inbound/tokens.mjs').createTokenVault>} deps.vault
 * @param {import('../inbound/store.mjs').store} deps.store
 * @param {object} deps.notifier - createNotifier 实例（广播编号文案用）
 * @param {() => object[]} deps.interactive - 交互通道实例列表（惰性 getter，装配期后解引用）
 * @param {object} [deps.logger]
 * @param {{ timeoutMs?: number, escalation?: { enabled?: boolean, stages?: object[] } }} [deps.config]
 */
export function createQuestionBridge(deps) {
  const { bus, vault, store, notifier } = deps
  const logger = deps.logger ?? null
  const config = deps.config ?? {}
  const defaultTimeoutMs = Math.max(1000, Number(config.timeoutMs) || 300000)
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/questions]', message) } catch { /* 日志失败绝不致命 */ }
  }

  const escalationCfg = (config.escalation !== null && typeof config.escalation === 'object') ? config.escalation : {}
  const escalationStages = Array.isArray(escalationCfg.stages) && escalationCfg.stages.length > 0
    ? escalationCfg.stages
    : DEFAULT_ESCALATION_STAGES
  const escalation = createEscalationChain({
    stages: escalationCfg.enabled === false ? [] : escalationStages,
    logger,
  })

  const ledger = {
    add(key, row) {
      store.set(key, { ...row, status: 'pending', createdAt: Date.now() })
    },
    get(key) {
      return store.get(key)
    },
    resolve(key, decision, extra = {}) {
      const row = store.get(key)
      if (row === undefined) return false
      store.set(key, { ...row, ...extra, status: 'resolved', decision, resolvedAt: Date.now() })
      return true
    },
    terminate(key, extra = {}) {
      const row = store.get(key)
      if (row === undefined || row.status !== 'pending') return false
      store.set(key, { ...row, ...extra, status: 'resolved', decision: 'terminated', resolvedAt: Date.now() })
      return true
    },
    /**
     * 最近一条待决提问（编号回复降级）。匹配优先级：
     *  1) exact 推送过该 (channel,userId)；
     *  2) onChannel 该 channel 推送过且 userId 一致；
     *  3) hint 该 channel 收到过本问题的编号话术（=aq 行 hintChannels 含该渠道）——
     *     替代旧 `any` 无条件兜底（SEC-2 / C-2 / BUG-11：关死「既没送卡、又没广播编号
     *     话术的渠道裸数字越权仲裁」的面）。无卡片渠道的合法编号作答由 hint 接住。
     */
    latestPendingFor(channel, userId) {
      let exact = null
      let onChannel = null
      let hint = null
      for (const key of store.keys(KEY_PREFIX)) {
        const row = store.get(key)
        if (row?.status !== 'pending') continue
        const pushed = Array.isArray(row.pushedTo) ? row.pushedTo : []
        if (pushed.some((target) => target.channel === channel)) {
          if (pushed.some((target) => target.channel === channel && String(target.userId) === String(userId))) {
            if (exact === null || row.createdAt > exact.row.createdAt) exact = { key, row }
            if (onChannel === null || row.createdAt > onChannel.row.createdAt) onChannel = { key, row }
          }
        }
        if (hint === null && isHintedChannel(row, channel)) hint = { key, row }
      }
      return exact ?? onChannel ?? hint
    },
  }

  /** SEC-2：该渠道是否被本问题「广播过编号话术」（=aq 行 hintChannels）。无该字段的旧行不兜底（从严，fail-closed）。 */
  function isHintedChannel(row, channel) {
    if (Array.isArray(row.hintChannels)) return row.hintChannels.includes(channel)
    return false
  }

  /** 交互通道列表（归一 + 防御；getter 失败按空处理）。 */
  function interactiveEntries() {
    try {
      const raw = typeof deps.interactive === 'function' ? deps.interactive() : []
      return (Array.isArray(raw) ? raw : [])
        .map((entry) => normalizeInbound(entry))
        .filter((entry) => entry !== null && entry.channel !== '')
    } catch {
      return []
    }
  }

  /** 推一个问题：选项卡片为主（单选按钮），编号文案只发卡片未送达的渠道（兜底）。 */
  async function pushQuestion(qKey, token, question, allowChats = null) {
    const title = `提问：${String(question.question).slice(0, 60)}`
    const context = String(question.context ?? '').trim()
    const content = [
      context !== '' ? context : 'agent 需要你做一个选择',
      question.multiSelect === true ? '（多选）' : '（单选）',
    ].join('\n')
    const options = question.options.map((option) => option.label)
    const isMulti = question.multiSelect === true
    const pushedTo = []
    const deliveredTypes = new Set() // 卡片已送达的通道类型：这些渠道不再重复教编号
    const persistPushed = () => {
      try {
        const row = ledger.get(qKey)
        if (row !== undefined) store.set(qKey, { ...row, pushedTo: [...pushedTo] })
      } catch { /* 增量落账失败不致命，末尾整体落账兜底 */ }
    }
    for (const inbound of interactiveEntries()) {
      const { kept } = guardTargets(inbound.channel, inbound.notifyTargets(), warn)
      for (const target of kept) {
        // 多选暂无卡片形态（飞书表单回调未实测，规划书风险项）：通道返回 null → 编号兜底
        const card = await inbound.sendQuestionCard({
          chatId: target.chatId,
          title,
          content,
          qKey,
          token,
          options,
          multiSelect: isMulti,
        })
        if (card !== null) {
          pushedTo.push({ channel: inbound.channel, chatId: target.chatId, userId: target.userId, messageId: card.messageId, kind: 'aq' })
          if (allowChats !== null) {
            let chatSet = allowChats.get(inbound.channel)
            if (chatSet === undefined) {
              chatSet = new Set()
              allowChats.set(inbound.channel, chatSet)
            }
            chatSet.add(String(target.chatId))
          }
          deliveredTypes.add(inbound.channel)
          persistPushed()
        }
      }
    }
    // 编号文案只发卡片未送达的渠道（P4 文字路径兜底）：卡片已到手的用户不再收
    // 一条冗余的「回复编号」广播——选项卡是主交互，编号是无卡片/投递失败时的降级。
    const allTypes = Array.isArray(notifier?.channels) ? notifier.channels : []
    const textTypes = allTypes.filter((type) => !deliveredTypes.has(type))
    if (textTypes.length > 0) {
      await notifier.notifyAll({
        title,
        content: `${content}\n\n${numberedHint(options, isMulti)}`,
        level: 'timeSensitive',
      }, { channelTypes: textTypes }).catch(() => {})
    }
    // SEC-2：把一号话术广播过的渠道一并返回，供 askQuestions 落账为 aq 行的 hintChannels。
    // hintChannels 按「本应广播的 textTypes」记录（不因 notifyAll 失败而丢失）——即使编号
    // 文案发送失败，行上仍记该渠道，编号兜底反而更稳（降级链不断，见 22-plan-sec2 E4/E5）。
    return { pushedTo, hintChannels: textTypes }
  }

  /** 把送达过的卡片全部改成终态（超时/已答；editTarget 按 pushedTo 行的 kind 选卡片形态）。 */
  async function markResolved(pushedTo, text) {
    const byChannel = new Map(interactiveEntries().map((entry) => [entry.channel, entry]))
    for (const target of pushedTo ?? []) {
      const inbound = byChannel.get(target.channel)
      if (inbound === undefined) continue
      await inbound.editTarget(target, text)
    }
  }

  /** 下标集校验与去重（P3 封闭集）：越界/重复归一/单选多项一律 null。返回去重后的下标数组。 */
  function resolveIdxs(row, optIdxes) {
    if (!Array.isArray(optIdxes) || optIdxes.length === 0) return null
    if (row.multiSelect !== true && optIdxes.length !== 1) return null
    const seen = new Set()
    const idxs = []
    for (const rawIdx of optIdxes) {
      const idx = Number(rawIdx)
      if (!Number.isInteger(idx) || idx < 0 || idx >= row.options.length) return null
      if (seen.has(idx)) continue // 容忍重复（卡片表单可能回带重复值），去重即可
      seen.add(idx)
      idxs.push(idx)
    }
    return idxs
  }

  /** 统一裁决入口（token 路径）。返回 { ok, message, answers? }。 */
  function decide({ qKey, optIdx, values, token, via = 'unknown', userId = '(unknown)', chatId = undefined }) {
    const row = ledger.get(qKey)
    if (row === undefined || row.status !== 'pending') {
      return { ok: false, message: '该提问已回答或已过期' }
    }
    const verdict = vault.verify(token)
    if (!verdict.ok) {
      return { ok: false, message: `作答被拒绝（${verdict.reason === 'expired' ? '已过期' : '校验失败'}）` }
    }
    if (verdict.key !== qKey) return { ok: false, message: '作答被拒绝（问题不匹配）' }
    if (chatId !== undefined && chatId !== null && String(chatId) !== '') {
      const pushedTo = Array.isArray(row.pushedTo) ? row.pushedTo : []
      // v0.8.3 SEC-1：来源会话校验把通道一并纳入——only 比对 chatId 不够，跨通道
      // 同 chatId（如不同渠道恰好同值）要视为不同来源，避免误命中。
      const clickVia = String(via ?? '').split(':')[0]
      if (!pushedTo.some((target) => String(target?.channel ?? '') === clickVia && String(target?.chatId ?? '') === String(chatId))) {
        return { ok: false, message: '请到原会话操作' }
      }
    }
    const optIdxes = optIdx === 'm' ? values : [optIdx]
    return settle(qKey, row, optIdxes, via, userId)
  }

  /** 可信裁决（编号回复：白名单已由 bus.accept 建立，跳 token，仍受首达采纳约束）。 */
  function decideTrusted({ qKey, optIdxes, via = 'unknown', userId = '(unknown)' }) {
    const row = ledger.get(qKey)
    if (row === undefined || row.status !== 'pending') {
      return { ok: false, message: '该提问已回答或已过期' }
    }
    return settle(qKey, row, optIdxes, via, userId)
  }

  function settle(qKey, row, optIdxes, via, userId) {
    const idxs = resolveIdxs(row, optIdxes)
    if (idxs === null) {
      return { ok: false, message: '无效选项（只接受提问时给出的编号）' }
    }
    const verdict = bus.settle(qKey, { kind: 'aq', idxs }, via, userId)
    if (!verdict.ok) return { ok: false, message: '该提问已被作答（首达采纳）' }
    const labels = idxs.map((idx) => row.options[idx])
    ledger.resolve(qKey, 'answered', { answers: labels, via: String(via), userId: String(userId) })
    warn(`${qKey} 作答：${labels.join('、')}（via ${via}）`)
    return { ok: true, message: `✅ 已作答：${labels.join('、')}`, answers: labels }
  }

  /**
   * 编号回复兜底（P4）：白名单用户回复 '2' / '1,3'（中英文逗号均可）作答最近一条待决提问。
   * 发错了不作废——无效编号：消费该消息（不进对话路由）+ 回执提示 + 把选项重发一遍，
   * 问题保持待决，用户直接再答即可；有效作答后回执确认。
   * 消费语义与审批一致：返回 true = bus 停止扇出（不进对话路由）。
   * 注意：审批的编号处理器先注册（'1'/'2' 且有待决审批时审批优先消费）。
   */
  function handleNumberedReply(envelope) {
    const text = String(envelope.text ?? '').trim()
    if (!/^\d{1,2}([,，]\d{1,2})*$/.test(text)) return false
    const nums = text.split(/[,，]/).map(Number)
    if (nums.length === 0) return false
    const pending = ledger.latestPendingFor(envelope.channel, envelope.userId)
    if (pending === null) return false
    const row = pending.row
    const max = row.options.length
    const sendFeedback = (message) => {
      const inbound = interactiveEntries().find((entry) => entry.channel === envelope.channel)
      if (inbound !== undefined) void inbound.sendText(envelope.chatId, message)
    }
    const optIdxes = nums.map((num) => num - 1) // 展示 1 基 → 存储 0 基
    const outOfRange = optIdxes.some((idx) => idx < 0 || idx >= max)
    const wrongMultiplicity = row.multiSelect !== true && nums.length !== 1
    if (outOfRange || wrongMultiplicity) {
      const why = wrongMultiplicity
        ? '本题是单选，请只回复一个编号'
        : `编号需在 1-${max} 之间${row.multiSelect === true ? '，多选用逗号分隔（如 1,3）' : ''}`
      sendFeedback(`❓ ${why}\n${numberedHint(row.options, row.multiSelect === true)}`)
      return true // 发错了可以再发：问题保持待决，上面的选项已重发
    }
    const verdict = decideTrusted({
      qKey: pending.key,
      optIdxes,
      via: `${envelope.channel}:reply`,
      userId: envelope.userId,
    })
    if (verdict.ok === true) {
      sendFeedback(`✅ 已作答：${(verdict.answers ?? []).join('、')}`)
      return true
    }
    // 罕见竞态（作答瞬间恰好超时）：回执说明，同样消费避免把裸编号漏进对话路由
    sendFeedback(verdict.message ?? '该提问已回答或已过期')
    return true
  }

  let disposeMessage = null
  let disposed = false

  /**
   * 挂载编号回复处理器。必须在审批路由注册之后调用（bus.onMessage 插入序 =
   * 消费优先级：审批 '1'/'2' 先于提问编号，避免歧义时提问抢走审批回复）。
   */
  function attach() {
    if (disposeMessage !== null || disposed) return
    disposeMessage = bus.onMessage(handleNumberedReply)
  }

  /**
   * 执行一次远程提问（ask_user 工具核心；多问逐问推送、逐问独立作答）。
   * @param {{ questions: { question: string, options: { label: string }[], multiSelect?: boolean }[],
   *           timeoutMs?: number, context?: string }} payload
   * @returns {Promise<{ ok: boolean, answered: boolean, results: object[], reason?: string }>}
   */
  async function askQuestions(payload, execContext = {}) {
    const questions = Array.isArray(payload?.questions) ? payload.questions : []
    const timeoutMs = Math.max(1000, Number(payload?.timeoutMs) || defaultTimeoutMs)
    if (questions.length === 0) return { ok: false, answered: false, results: [], reason: 'questions 不能为空' }
    const results = []
    let allAnswered = true
    const agentId = execContext?.agent?.id ?? execContext?.agent?.session?.id ?? execContext?.session?.id ?? null
    for (const question of questions) {
      if (disposed) {
        results.push({ question: String(question?.question ?? ''), answered: false, reason: 'stopped' })
        allAnswered = false
        continue
      }
      const qKey = `${KEY_PREFIX}${randomBytes(4).toString('hex')}`
      let outcome = null
      try {
        const token = vault.mint(qKey)
        ledger.add(qKey, {
          question: String(question.question ?? ''),
          options: question.options.map((option) => String(option.label)),
          multiSelect: question.multiSelect === true,
          context: String(payload?.context ?? ''),
          agentId: agentId !== null && String(agentId) !== '' ? String(agentId) : null,
          pushedTo: [],
        })
        // waiter 预注册先于推卡（v0.6.3 审批时序同款：早到作答不被丢）。
        // AUTH-1：wait 登记允许会话范围（allowChats）；pushQuestion 每送达一张卡片即
        // 把它对应的 chatId 并入 allowChats（空目标 = 空 Map，不放行任意 chat）。
        const allowChats = new Map()
        const waitPromise = bus.wait(qKey, timeoutMs, {
          agentId: agentId !== null ? String(agentId) : '',
          onAbandon: () => { try { ledger.terminate(qKey) } catch { } },
          allowChats,
        })
        const { pushedTo, hintChannels } = await pushQuestion(qKey, token, question, allowChats)
        const row = ledger.get(qKey)
        if (row !== undefined) store.set(qKey, { ...row, pushedTo, hintChannels })
        const startedAt = Date.now()
        escalation.start(qKey, (_key, stage) => {
          notifier.notifyAll({
            title: `提问仍在等待作答：${String(question.question ?? '').slice(0, 40)}`,
            content: `${stage.note ?? '仍在等待作答'}（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s）。请点击选项卡片按钮作答；无卡片渠道可回复选项编号。`,
            level: stage.level ?? 'timeSensitive',
          }).catch(() => {})
        })
        outcome = await waitPromise
        escalation.stop(qKey)
        const rowAfterWait = ledger.get(qKey)
        if (rowAfterWait?.decision === 'terminated') {
          await markResolved(rowAfterWait?.pushedTo ?? pushedTo ?? [], '⏹ 已终止：agent 会话已结束，提问取消')
          results.push({ question: String(question.question ?? ''), answered: false, reason: 'terminated' })
          allAnswered = false
          continue
        }
      } catch (error) {
        warn(`提问推送/等待异常（交还桌面语义）: ${error instanceof Error ? error.message : String(error)}`)
        try { escalation.stop(qKey) } catch { /* 清理不致命 */ }
        try { bus.abandon(qKey) } catch { /* 清理不致命 */ }
        try { ledger.resolve(qKey, 'error') } catch { /* 账本失败不致命 */ }
        outcome = { __error: true }
      }
      if (outcome === null) {
        // P2 超时永不代答：唯一产物是 answered=false
        ledger.resolve(qKey, 'timeout')
        await markResolved(ledger.get(qKey)?.pushedTo ?? [], '⏱ 超时未作答：已交还桌面（按钮失效）')
        results.push({ question: String(question.question ?? ''), answered: false })
        allAnswered = false
        continue
      }
      if (outcome.__error === true) {
        results.push({ question: String(question.question ?? ''), answered: false, reason: 'error' })
        allAnswered = false
        continue
      }
      // outcome = bus.wait 的裁决信封 { decision: settle 载荷 {kind:'aq', idxs}, via, userId }
      const row = ledger.get(qKey)
      const idxs = Array.isArray(outcome?.decision?.idxs) ? outcome.decision.idxs : []
      const answers = idxs.map((idx) => row?.options?.[idx]).filter((label) => label !== undefined)
      await markResolved(row?.pushedTo ?? [], `✅ 已作答：${answers.join('、')}（来源 ${outcome?.via ?? 'unknown'}）`)
      results.push({ question: String(question.question ?? ''), answered: true, answers, via: outcome?.via })
    }
    return { ok: true, answered: allAnswered, results }
  }

  function dispose() {
    disposed = true
    try { disposeMessage?.() } catch { /* 反注册失败不致命 */ }
    disposeMessage = null
    escalation.dispose()
  }

  return { askQuestions, decide, decideTrusted, attach, dispose }
}

/** 校验并归一 ask_user 工具参数；违规返回 { ok:false, reason }。 */
export function validateAskArgs(rawArgs, { minTimeoutMs = 30_000, maxTimeoutMs = 30 * 60_000, defaultTimeoutMs = 300_000 } = {}) {
  const args = rawArgs ?? {}
  const questionsRaw = Array.isArray(args.questions) ? args.questions : null
  if (questionsRaw === null || questionsRaw.length === 0 || questionsRaw.length > 4) {
    return { ok: false, reason: 'questions 必须是 1 到 4 个问题的数组' }
  }
  const questions = []
  for (const item of questionsRaw) {
    const question = String(item?.question ?? '').trim()
    if (question === '' || question.length > 600) {
      return { ok: false, reason: '每个问题的 question 必须是 1-600 字符' }
    }
    const optionsRaw = Array.isArray(item?.options) ? item.options : null
    if (optionsRaw === null || optionsRaw.length < 2 || optionsRaw.length > 5) {
      return { ok: false, reason: `问题「${question.slice(0, 20)}」的 options 必须是 2 到 5 项` }
    }
    const options = []
    for (const option of optionsRaw) {
      const label = String(option?.label ?? '').trim()
      if (label === '' || label.length > 60) {
        return { ok: false, reason: `问题「${question.slice(0, 20)}」的选项 label 必须是 1-60 字符` }
      }
      options.push({ label })
    }
    questions.push({ question, options, multiSelect: item?.multiSelect === true })
  }
  const timeoutRaw = Number(args.timeoutMs)
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.min(maxTimeoutMs, Math.max(minTimeoutMs, Math.trunc(timeoutRaw)))
    : defaultTimeoutMs
  const context = String(args.context ?? '').slice(0, 300)
  return { ok: true, questions, timeoutMs, context }
}

/**
 * 注册 ask_user 工具（v0.8 远程提问）。
 * @param ctx - cordis 上下文（ctx.tools；宿主没有 tools 服务时静默跳过）
 * @param {ReturnType<typeof createQuestionBridge>} bridge
 * @param {{ rateLimitPerMinute?: number, defaultTimeoutMs?: number }} [options]
 */
export function registerAskUserTool(ctx, bridge, options = {}) {
  if (ctx?.tools?.register === undefined) {
    // 宿主没有 tools 服务时静默跳过工具注册，绝不弄崩启动（与 notify 工具同规矩）
    return null
  }
  const limiter = createRateLimiter({ limitPerMinute: options.rateLimitPerMinute ?? 6 })
  return ctx.tools.register({
    name: 'ask_user',
    description: '向用户提出选择题并等待作答（推送到用户手机：飞书选项卡片 / Telegram 按钮 / 其他渠道回复编号）。适合方案抉择、环境选择等需要用户拍板的分叉决策；用户装了 dsh-notifier 手机桥接时优先用本工具而不是 ask_user_question。超时不会代答——用户未作答时返回 answered=false，请改用桌面确认或调整方案继续。',
    parameters: compileParameters({
      questions: {
        type: 'array',
        required: true,
        description: '1-4 个问题，每项 { question: 问题正文, options: [{ label: 选项 }](2-5 项), multiSelect?: 是否多选（默认 false） }',
      },
      timeoutMs: { type: 'number', description: '作答时限毫秒（默认 300000，范围 30s-30min）；超时不代答' },
      context: { type: 'string', description: '为什么问（卡片引言，可选，300 字内）' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          answered: { type: 'boolean' },
          results: { type: 'array', items: { type: 'object' } },
        },
        additionalProperties: true,
      },
      render: (_args, value) => {
        if (value.rateLimited === true) {
          return [{ type: 'text', text: `已限流：ask_user 每分钟调用已达上限（${value.rateLimit ?? ''} 次/分钟）。请稍后再试，或改用一次提问合并多个问题。` }]
        }
        if (value.ok !== true) {
          return [{ type: 'text', text: `提问未发出：${value.reason ?? '参数无效'}。请检查 questions 结构（1-4 问，每问 2-5 个选项）。` }]
        }
        if (value.answered !== true) {
          const lines = (value.results ?? []).map((item, idx) =>
            `${idx + 1}. ${item.question} → ${item.answered === true ? `已答：${(item.answers ?? []).join('、')}` : '未作答'}`)
          return [{ type: 'text', text: `用户未在时限内完成全部作答（超时不代答）：\n${lines.join('\n')}\n请改用桌面确认、缩小问题范围，或基于默认方案继续并说明假设。` }]
        }
        const lines = (value.results ?? []).map((item, idx) =>
          `${idx + 1}. ${item.question} → ${(item.answers ?? []).join('、')}`)
        return [{ type: 'text', text: `用户已作答：\n${lines.join('\n')}` }]
      },
    },
    async execute(rawArgs, execContext) {
      if (!limiter.allow()) {
        return { ok: false, rateLimited: true, rateLimit: limiter.limit, answered: false, results: [] }
      }
      const validated = validateAskArgs(rawArgs, { defaultTimeoutMs: options.defaultTimeoutMs })
      if (!validated.ok) {
        return { ok: false, answered: false, results: [], reason: validated.reason }
      }
      try {
        return await bridge.askQuestions(validated, execContext)
      } catch (error) {
        return { ok: false, answered: false, results: [], reason: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
