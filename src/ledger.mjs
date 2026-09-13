// dsh-notifier ledger.mjs
// 通知账本（阶段 6）：每次广播本地落账（JSONL），支持启动期「昨日摘要」晨报。
// 军规：账本失败绝不影响推送——所有 IO best-effort，全程 try/catch 静默。
// 无竞品覆盖的 headless 核心场景：夜里挂机跑任务，第二天启动时收到
// 「昨晚 3 条通知：✅ x2、❌ x1」——不用翻手机通知流。

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
// lang 文案表：晨报正文取词；分类标记 zh/en 双语都匹配（与推送语言无关）
import { stringsOf } from './strings.mjs'

/** 标题 → 事件种类（intentToMessage 的标题前缀约定；含 titlePrefix 也能子串命中）。
 *  zh/en 双标记都匹配：分类与推送语言无关（lang:'en' 时英文 headline 也入正确桶）。 */
const KIND_PATTERNS = [
  ['digest', ['通知摘要', 'Notification digest']],
  ['completed', ['任务完成', 'Task complete']],
  ['error', ['任务出错', 'Task failed']],
  ['agentError', ['Agent 执行出错', 'Agent error']],
  ['blocked', ['任务被阻塞', 'Task blocked']],
  ['aborted', ['任务已中止', 'Task aborted']],
  ['maxTokens', ['达到 Token 上限', 'Output token limit reached']],
  ['interrupted', ['任务异常中断', 'Task interrupted']],
  ['approval', ['需要你批准', 'Approval needed']],
]

/** 从通知标题推断事件种类；未知回 'other'（用户/工具自定义通知）。 */
export function classifyTitle(title) {
  const value = typeof title === 'string' ? title : ''
  for (const [kind, markers] of KIND_PATTERNS) {
    for (const marker of markers) {
      if (value.includes(marker)) return kind
    }
  }
  return 'other'
}

/** 组装摘要正文（一行统计 + 失败渠道提示；strings 缺省 zh 文案表，既有调用方零感知）。 */
export function composeDigest(summary, strings = stringsOf()) {
  const { from, to, counts, failedDeliveries } = summary
  const d = strings.digest
  const lines = [d.windowLine(from, to, counts.total)]
  const parts = []
  if (counts.completed > 0) parts.push(d.completed(counts.completed))
  if (counts.error > 0) parts.push(d.error(counts.error))
  if (counts.agentError > 0) parts.push(d.agentError(counts.agentError))
  if (counts.blocked > 0) parts.push(d.blocked(counts.blocked))
  if (counts.aborted > 0) parts.push(d.aborted(counts.aborted))
  if (counts.maxTokens > 0) parts.push(d.maxTokens(counts.maxTokens))
  if (counts.interrupted > 0) parts.push(d.interrupted(counts.interrupted))
  if (counts.approval > 0) parts.push(d.approval(counts.approval))
  if (counts.other > 0) parts.push(d.other(counts.other))
  if (parts.length > 0) lines.push(parts.join(d.joiner))
  if (failedDeliveries > 0) lines.push(d.failedLine(failedDeliveries))
  if (counts.total === 0) return d.empty(from, to)
  return lines.join('\n')
}

/**
 * 创建通知账本。
 * @param {object} [options]
 * @param {string} options.dir - 落账目录（ledger.jsonl + ledger-state.json）。
 * @param {number} [options.maxEntries=500] - 账本上限；超 2 倍时重写保留最新 maxEntries 条。
 * @param {() => number} [options.now] - 可注入时钟（测试用）。
 */
export function createLedger(options = {}) {
  const dir = typeof options.dir === 'string' && options.dir !== '' ? options.dir : '.'
  const maxEntries = Math.max(50, Math.trunc(options.maxEntries ?? 500))
  const now = options.now ?? Date.now
  const file = `${dir}/ledger.jsonl`
  const stateFile = `${dir}/ledger-state.json`

  const ensureDir = () => {
    try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在或不可写：append 时自然暴露 */ }
  }

  /** 记一条广播（onSend 回调的直接落点）。任何失败静默——账本绝不拖累推送。 */
  function append(record) {
    try {
      ensureDir()
      const entry = {
        at: typeof record?.time === 'string' ? record.time : new Date(now()).toISOString(),
        kind: classifyTitle(record?.message?.title),
        level: record?.message?.level ?? undefined,
        title: typeof record?.message?.title === 'string' ? record?.message.title.slice(0, 200) : '',
        delivered: Array.isArray(record?.delivered) ? record.delivered : [],
        failed: Array.isArray(record?.failed) ? record.failed.map((item) => item?.channel ?? String(item)) : [],
        // v0.6 来源标注（设计稿 §5）：外部插件推送可审计；JSON.stringify 会省略 undefined，
        // 无 source 的旧行/本插件自身推送落盘形状逐字节不变。
        source: typeof record?.source?.name === 'string' && record.source.name !== '' ? record.source.name.slice(0, 64) : undefined,
      }
      appendFileSync(file, `${JSON.stringify(entry)}\n`)
      // v0.6.3：对齐 store 的 0600 军规（审查 R1 P1-3）——账本行含通知标题/错误摘要
      // （可能带任务路径与审批上下文），共享主机上不应其他账号可读。失败尽力而为。
      try { chmodSync(file, 0o600) } catch { /* Windows/受限环境无 chmod */ }
      maybePrune()
    } catch { /* 磁盘满/权限问题：静默，推送不受影响 */ }
  }

  /** 超过 2 倍上限时重写保留最新 maxEntries 条（摊销 O(n)，日常零开销）。 */
  function maybePrune() {
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
      if (lines.length <= maxEntries * 2) return
      const kept = lines.slice(-maxEntries)
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${kept.map((line) => `${line}\n`).join('')}`)
      try { chmodSync(tmp, 0o600) } catch { /* Windows/受限环境无 chmod */ }
      renameSync(tmp, file)
    } catch { /* 重写失败：下次再试，绝不致命 */ }
  }

  /** 读时间窗内的记录（解析失败的行跳过——账本容错优先于完整）。 */
  function read(fromMs, toMs) {
    try {
      if (!existsSync(file)) return []
      const lines = readFileSync(file, 'utf8').split('\n')
      const out = []
      for (const line of lines) {
        if (line.trim() === '') continue
        try {
          const entry = JSON.parse(line)
          const at = Date.parse(entry.at)
          if (!Number.isFinite(at)) continue
          if (at >= fromMs && at < toMs) out.push(entry)
        } catch { /* 脏行跳过 */ }
      }
      return out
    } catch {
      return []
    }
  }

  /** 汇总时间窗（digest 类自身不计入，避免「摘要的摘要」）。 */
  function summarize(fromMs, toMs, { fromLabel, toLabel } = {}) {
    const records = read(fromMs, toMs).filter((entry) => entry.kind !== 'digest')
    const counts = { total: records.length, completed: 0, error: 0, agentError: 0, blocked: 0, aborted: 0, maxTokens: 0, interrupted: 0, approval: 0, other: 0 }
    let failedDeliveries = 0
    for (const entry of records) {
      if (entry.kind in counts) counts[entry.kind] += 1
      else counts.other += 1
      failedDeliveries += Array.isArray(entry.failed) ? entry.failed.length : 0
    }
    return { counts, failedDeliveries, from: fromLabel ?? new Date(fromMs).toISOString(), to: toLabel ?? new Date(toMs).toISOString() }
  }

  /** 摘要去重标记：同一天只发一次晨报（重启不重发）。 */
  function markDigestDone(dateStr) {
    try {
      ensureDir()
      writeFileSync(stateFile, JSON.stringify({ lastDigestDate: dateStr }))
    } catch { /* 静默 */ }
  }
  function lastDigestDate() {
    try {
      if (!existsSync(stateFile)) return null
      return JSON.parse(readFileSync(stateFile, 'utf8')).lastDigestDate ?? null
    } catch {
      return null
    }
  }

  return { append, read, summarize, compose: composeDigest, markDigestDone, lastDigestDate, get file() { return file } }
}

/**
 * 计算昨日本地时间窗 [start, end)（晨报统计范围）。
 * @param {() => number} [now] - 可注入时钟。
 */
export function yesterdayWindow(now = Date.now) {
  const current = new Date(now())
  const startOfToday = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime()
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000
  const fmt = (ms) => {
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  return { fromMs: startOfYesterday, toMs: startOfToday, dateStr: fmt(startOfYesterday), fromLabel: fmt(startOfYesterday), toLabel: fmt(startOfToday) }
}
