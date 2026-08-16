// dsh-notifier adapters/_engine.mjs
// spec 引擎：吃「声明表」产出 resolve/send，新渠道零逻辑接入。
// 设计动机：80% 的推送渠道本质是同一件事——POST 固定 URL、映射字段名、判定成功。
// 声明表渠道禁止写控制流（超过两个 if 降级为独立代码适配器，见 ADAPTER.md）。
// 端点/body/成功判定语义参考 push-all-in-one（MIT）与 all-pusher-api（Apache-2.0），
// 移植方式为「协议知识移植」：axios.post 机械改写为零依赖 fetch。见 THIRD_PARTY_NOTICES.md。

import { postJson, postForm, postText, readTextCapped, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

/** 从任意响应负载里提取人类可读的失败原因（跨渠道常见字段名兜底）。 */
export function describeFailure(json, text) {
  if (json !== null && typeof json === 'object') {
    const detail = json.errmsg ?? json.message ?? json.error ?? json.reason ?? json.msg ?? json.errors
    if (typeof detail === 'string' && detail.length > 0) return detail.slice(0, 200)
    if (Array.isArray(detail)) return detail.map(String).join('; ').slice(0, 200)
    const code = json.errcode ?? json.code ?? json.ret ?? json.retcode
    if (typeof code === 'number') return `错误码 ${code}`
  }
  if (typeof text === 'string' && text.length > 0) return text.slice(0, 200)
  return ''
}

/**
 * 把一条 spec 编译成标准 adapter（{ type, resolve, send }）。
 * spec 形状：
 *   label   渠道显示名（错误文案前缀）
 *   desc    渠道一句话说明（README 矩阵生成用）
 *   fields  { [key]: { required?, secret?, desc, default?, type?: 'number' } }
 *   encode  'json' | 'form' | 'text'（默认 json）
 *   request (cfg, msg) => { url, headers?, body? | text? }   // 必须纯函数
 *   ok      ({ status, json, text, cfg, msg }) => boolean     // 成功判定，必须纯函数
 *   fail    ({ status, json, text }) => string                // 可选：中文失败文案
 *   validate(resolved) => void                                // 可选：跨字段校验，非法抛 NotifyError
 */
export function makeSpecAdapter(type, spec) {
  const label = spec.label ?? type

  function resolve(cfg = {}) {
    const resolved = {}
    for (const [key, field] of Object.entries(spec.fields ?? {})) {
      const raw = cfg[key]
      let value
      if (field.type === 'number') {
        value = typeof raw === 'number' && Number.isFinite(raw) ? raw : field.default
      } else {
        value = str(raw)
      }
      const missing = value === '' || value === undefined || value === null
      if (missing && field.required === true) {
        throw new NotifyError(`${type} 未配置：${key}（${field.desc ?? label}）未填写`, ERROR_CODES.NOT_CONFIGURED)
      }
      resolved[key] = missing && field.default !== undefined ? field.default : value
    }
    if (typeof spec.validate === 'function') spec.validate(resolved)
    resolved.timeoutMs = num(cfg.timeoutMs, spec.timeoutMs ?? 10000, 1000, 60000)
    return resolved
  }

  async function send(resolved, msg) {
    const request = spec.request(resolved, msg)
    const url = str(request?.url)
    if (url === '') {
      throw new NotifyError(`${type} 请求构造失败：url 为空`, ERROR_CODES.NOT_CONFIGURED)
    }
    const encode = spec.encode ?? 'json'
    const options = { timeoutMs: resolved.timeoutMs, channel: label }
    let response
    try {
      if (encode === 'form') {
        response = await postForm(url, request.body ?? {}, options)
      } else if (encode === 'text') {
        response = await postText(url, request.text ?? msg.content, { ...options, headers: request.headers })
      } else {
        response = await postJson(url, request.body ?? {}, { ...options, headers: request.headers })
      }
    } catch (error) {
      // v0.6.5（审查 R4-3-P2-2）：非 2xx 给 spec.fail 一次合成中文排障指引的机会。
      // 原实现 post* 直接抛 HTTP_ERROR，slack 403「去哪换 webhook」/discord 404「重建」
      // /ntfy 的 error 字段指引在真实失败路径上永不可达（2xx+业务码渠道不受影响）。
      if (error instanceof NotifyError && error.code === ERROR_CODES.HTTP_ERROR && typeof spec.fail === 'function') {
        const hint = spec.fail({ status: error.status, json: error.json, text: error.text }) ?? ''
        if (String(hint).length > 0) {
          throw new NotifyError(`${type} 推送失败（HTTP ${error.status}）: ${String(hint).slice(0, 200)}`, ERROR_CODES.API_ERROR)
        }
      }
      throw error
    }
    const text = await readTextCapped(response)
    let json
    if (text.length > 0 && (text[0] === '{' || text[0] === '[')) {
      try { json = JSON.parse(text) } catch { /* 非 JSON 交由 ok() 判定 */ }
    }
    const pass = spec.ok({ status: response.status, json, text, cfg: resolved, msg })
    if (pass !== true) {
      // v0.6.5（审查 R4-3-P3-2）：reason 统一截断——服务端超长 errmsg 会整段进
      // 日志/notifyAll failed/工具渲染（agent 上下文膨胀）。
      const reason = typeof spec.fail === 'function'
        ? String(spec.fail({ status: response.status, json, text }) ?? '').slice(0, 200)
        : describeFailure(json, text)
      throw new NotifyError(`${type} 推送失败${reason.length > 0 ? `: ${reason}` : `（HTTP ${response.status}）`}`, ERROR_CODES.API_ERROR)
    }
  }

  return { type, spec, resolve, send }
}

/** 把整张声明表编译成 { [type]: adapter } 注册表（供 config.mjs 合并）。 */
export function makeSpecAdapters(table) {
  const out = {}
  for (const [type, spec] of Object.entries(table)) {
    out[type] = makeSpecAdapter(type, spec)
  }
  return out
}

/** 从声明表提取 secret 字段映射（供 config.mjs 的脱敏登记，spec 渠道自动登记）。 */
export function secretFieldsOfTable(table) {
  const out = {}
  for (const [type, spec] of Object.entries(table)) {
    out[type] = Object.entries(spec.fields ?? {})
      .filter(([, field]) => field.secret === true)
      .map(([key]) => key)
  }
  return out
}
