// dsh-notifier inbound/tokens.mjs
// HMAC 一次性审批 token：mint(key) → "payload.sig"，verify 校验签名与 TTL。
// 红线（照抄 im-bridge）：token 不落库——单次核销由 approval 账本（pending 状态机）保证，
// 本模块只做密码学校验：伪造/过期/篡改一律拒绝。
// secret 未配置时进程内随机生成（重启后旧 token 全部失效，安全侧倾斜）。

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const b64url = (input) => Buffer.from(input).toString('base64url')
const unb64url = (input) => Buffer.from(input, 'base64url').toString('utf8')

/** 恒时比较两个十六进制摘要。 */
function safeEqualHex(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex')
  const b = Buffer.from(bHex, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 创建 token 金库。
 * @param {object} options
 * @param {string} [options.secret] - HMAC 密钥；缺省进程内随机（重启即全部失效）
 * @param {number} [options.ttlMs=600000] - token 有效期，默认 10 分钟
 */
export function createTokenVault({ secret, ttlMs = 10 * 60 * 1000 } = {}) {
  const key = typeof secret === 'string' && secret.length > 0 ? secret : randomBytes(32).toString('hex')
  const sign = (payloadJson) => createHmac('sha256', key).update(payloadJson).digest('hex')

  return {
    /** 为审批 key 铸一枚 token（含过期时间）。 */
    mint(approvalKey, now = Date.now()) {
      const payload = JSON.stringify({ k: approvalKey, e: now + ttlMs })
      return `${b64url(payload)}.${sign(payload)}`
    },

    /**
     * 校验 token：返回 { ok, key, reason }。
     * ok=false 时 reason ∈ 'malformed' | 'bad-signature' | 'expired'
     */
    verify(token, now = Date.now()) {
      if (typeof token !== 'string') return { ok: false, key: null, reason: 'malformed' }
      const dot = token.lastIndexOf('.')
      if (dot <= 0) return { ok: false, key: null, reason: 'malformed' }
      const payloadB64 = token.slice(0, dot)
      const sig = token.slice(dot + 1)
      let payloadJson
      try {
        payloadJson = unb64url(payloadB64)
      } catch {
        return { ok: false, key: null, reason: 'malformed' }
      }
      if (!safeEqualHex(sign(payloadJson), /^[0-9a-f]+$/i.test(sig) ? sig : '00')) {
        return { ok: false, key: null, reason: 'bad-signature' }
      }
      let payload
      try {
        payload = JSON.parse(payloadJson)
      } catch {
        return { ok: false, key: null, reason: 'malformed' }
      }
      if (typeof payload?.k !== 'string') return { ok: false, key: null, reason: 'malformed' }
      if (typeof payload?.e !== 'number' || now > payload.e) return { ok: false, key: null, reason: 'expired' }
      return { ok: true, key: payload.k, reason: null }
    },
  }
}
