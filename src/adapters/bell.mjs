// dsh-notifier adapter: bell
// 本地渠道（host 半）：终端 BEL 响铃（\x07），headless/TUI 场景的 Codex BEL 等价物。
// 零依赖红线：只用 process.stdout.write，不发声卡调用、不引声音库、不查 terminfo。
// 语义对接：msg.silent === true 时不响——静默推送的「本地等价物」就是不打扰。

export const type = 'bell'

/** 校验并归一化配置；本地渠道无凭证，count 钳制 1-5。 */
export function resolve(cfg = {}) {
  const raw = cfg?.count
  const count = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(5, Math.max(1, Math.trunc(raw)))
    : 1
  return { count }
}

/**
 * 响铃 count 次（单次 write 连发，避免多次系统调用交错终端转义序列）。
 * stdout 不可写（已重定向到已关闭的管道等）时静默成功：响铃是锦上添花，绝不致命。
 */
export function send(resolved, msg) {
  if (msg?.silent === true) return
  const count = resolved?.count ?? 1
  let ring = ''
  for (let index = 0; index < count; index += 1) ring += '\x07'
  try {
    process.stdout.write(ring)
  } catch { /* stdout 已关闭：静默 */ }
}
