// dsh-notifier redact.mjs
// S-05（CWE-200）出站片段脱敏：自动状态推送默认把宿主会话数据片段（最近输出摘录、
// 错误全文）发往第三方 IM。redaction: 'minimal'（默认，D2 决策）下对密钥形态打码；
// 'extended' 维持原文（用户显式选择，文档声明数据流向）。
// 打码目标是「形态」而非语义：sk-…/ghp_…/xox…-…/AKIA…/JWT/Bearer 头/32+ 连续十六进制/
// 40+ 连续 base64——这些形态在正常通知正文里几乎不出现，误伤率低；打码后保留前后文
// 可读性（替换为 ***）。notify 工具不经过本模块：那是用户/LLM 的显式推送动作，内容
// 边界属于调用者而非通道（限流与 500 字符上限已是既有缓解）。
//
// 纯函数模块：不 import 任何项目内文件，测试零夹具。

/**
 * 密钥形态 → 替换串。顺序即优先级（JWT 先于通用 base64，Bearer 先于长 token）。
 * 每条 [pattern, replacement]；pattern 必须 /g。
 */
const SECRET_PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '***'], // JWT（三段 base64url）
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}/g, '***'], // OpenAI/Anthropic 风格 key
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '***'], // GitHub token 家族
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***'], // GitHub fine-grained
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '***'], // Slack token 家族
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'], // AWS access key id
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer ***'], // 鉴权头残留
  [/\b[A-Fa-f0-9]{32,}\b/g, '***'], // 连续十六进制（API key / 摘要）
  [/[A-Za-z0-9+/]{40,}={0,2}/g, '***'], // 连续 base64（长 blob）
]

/**
 * 对文本做密钥形态打码（幂等：已打码文本再过一遍不变，*** 不满足任何 pattern）。
 * @param {string} text
 * @returns {string}
 */
export function maskSecrets(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * S-05 minimal 模式下自动通知摘录的默认上限（D2：80 字符；extended 维持 200/500）。
 * summaryMaxChars（默认 500）仍是总正文上限；本常量只钳「宿主会话数据片段」。
 */
export const MINIMAL_EXCERPT_CHARS = 80

/**
 * 解析 redaction 配置值：仅 'extended' 关闭脱敏，其余（含缺省/拼错）一律 minimal。
 * 拼错值静默回落 minimal 是刻意的：安全配置的非法值不配得到宽松解释。
 * @param {unknown} value
 * @returns {'minimal' | 'extended'}
 */
export function normalizeRedaction(value) {
  return value === 'extended' ? 'extended' : 'minimal'
}
