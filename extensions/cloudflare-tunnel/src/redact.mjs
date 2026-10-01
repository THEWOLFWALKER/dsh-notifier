// dsh-notifier extensions/cloudflare-tunnel/src/redact.mjs
// T25（可选 Cloudflare Tunnel）— cloudflared 输出脱敏。
//
// cloudflared 的 stderr/stdout 会回显连接凭据：`--token <T>`、`TUNNEL_TOKEN=<T>`、
// Cloudflare Access JWT、`eyJ…` 三段 base64url、以及各种 `sk-…`/长十六进制/长 base64。
// 本模块在把进程输出投影进「状态 / 日志」之前先打码，保证状态快照与支持报告**零明文 secret**。
// 打码目标是「形态」而非语义（与 `src/redact.mjs` 同口径）：正常日志文本误伤率低，已打码
// 幂等。
//
// 纯函数模块：不 import 任何项目内文件、不发起任何 I/O，测试零夹具。

const SECRET_PATTERNS = [
  // cloudflared / Cloudflare Access 专属形态（先于通用形态，保证整串 token 被整体替换）
  [/(?:--token[=\s]|TUNNEL_TOKEN[=\s]+)[A-Za-z0-9._~+/=-]{8,}/gi, '***'],
  [/\b(?:CF_ACCESS|ACCESS)_TOKEN[=\s]+[A-Za-z0-9._~+/=-]{8,}/gi, '***'],
  // JWT（三段 base64url，Access 鉴权常见）
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '***'],
  // 常见 key 家族
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***'],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}/g, '***'],
  // 连续十六进制 / 长 base64（API key / 证书指纹等）
  [/\b[A-Fa-f0-9]{32,}\b/g, '***'],
  [/[A-Za-z0-9+/]{40,}={0,2}/g, '***'],
]

/**
 * 对一行 cloudflared 输出做密钥形态打码（幂等）。
 * @param {string} text
 * @returns {string}
 */
export function redactCloudflaredOutput(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * 只保留最近 N 行脱敏日志（有界），用于状态快照里的「最近输出」。超出按最旧淘汰。
 * @param {string[]} lines - 已脱敏单行
 * @param {number} [max=20]
 * @returns {string[]} 截断后的日志（复制，不修改入参）
 */
export function boundLogLines(lines, max = 20) {
  const cap = Math.max(0, Math.trunc(Number(max)) || 0)
  const src = Array.isArray(lines) ? lines : []
  return src.slice(-cap)
}