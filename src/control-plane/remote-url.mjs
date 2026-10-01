// dsh-notifier v0.15（T24）— 远程入口 URL 校验（纯本地解析，零网络）。
//
// 一个「已有 URL」的远程入口必须由**用户显式自填**并经过本模块校验后才可作为打开 / 复制 / 二维码
// 内容。它只做本地字符串解析——绝不发起任何网络请求、绝不探测可达性、绝不做 DNS/连接校验，
// 因此不存在 SSRF / 后台 fetch 面。
//
// 安全红线（06-INTEGRATIONS §Remote/Tunnel + T24 边界 / R04）：
//   * 只允许 https（无 TLS 的 http 拒绝，其余 scheme 一律拒绝）；
//   * 拒绝 URL 内嵌 username/password（userinfo）；
//   * 拒绝 query 命中「明显 secret 参数名」的 URL（ticket/token/password/secret/…），提示不要把
//     秘密放进 URL——二维码与普通链接都来自同一规范化字符串，因此天然不含这些值；
//   * 不猜测 Host 深链：本模块绝不构造 session URL / 动态 deep link，只规范回显用户自填地址。
//
// 本模块拥有**零** store 键、**零** effect，是纯 translator + validator。

const MAX_URL_LENGTH = 8192

// 明显 secret 查询参数名（大小写不敏感）。只针对「形如凭据」的键，不做宽泛正则以避免误拒。
const SECRET_QUERY_PARAMS = new Set([
  'token', 'ticket', 'password', 'passwd', 'pass', 'secret', 'credential',
  'apikey', 'api_key', 'key', 'auth', 'authorization', 'signature', 'sign',
  'access_token', 'session', 'session_id', 'sessionId', 'sid',
  'jwt', 'signed_url', 'signedpayload', 'signed_payload',
])

const bad = (reason) => ({ ok: false, reason })

/**
 * 校验并规范化一个用户自填的远程入口 URL。
 * @param {unknown} input
 * @returns {{ok:true, url:string, hostname:string, origin:string} | {ok:false, reason:string}}
 *   reason ∈ empty | too-long | unparseable | no-tls | unsafe-scheme | embedded-credentials |
 *              no-host | contains-secret
 */
export function validateRemoteUrl(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') return bad('empty')
  if (text.length > MAX_URL_LENGTH) return bad('too-long')

  let url
  try {
    url = new URL(text)
  } catch {
    return bad('unparseable')
  }

  // 仅 https；无 TLS 与危险 scheme 分别给出稳定 reason（R04「无TLS/危险scheme 拒绝」）。
  if (url.protocol === 'http:') return bad('no-tls')
  if (url.protocol !== 'https:') return bad('unsafe-scheme')
  if (url.username !== '' || url.password !== '') return bad('embedded-credentials')
  if (url.hostname === '') return bad('no-host')

  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY_PARAMS.has(name.toLowerCase())) return bad('contains-secret')
  }

  const canonical = url.href
  return { ok: true, url: canonical, hostname: url.hostname, origin: url.origin }
}

/**
 * 由校验结果生成「远程入口」展示投影。普通链接与二维码**必须等价**：二者都取自同一个
 * 规范化字符串（`qrPayload === url`），扫码打开的就是下方普通链接指向的地址（R04）。
 * @param {unknown} input
 * @returns {{ok:true, url:string, qrPayload:string, qrSupported:false, hostname:string} |
 *   {ok:false, reason:string}}
 */
export function buildRemoteEntry(input) {
  const result = validateRemoteUrl(input)
  if (result.ok !== true) return result
  return {
    ok: true,
    url: result.url,
    // 二维码内容 = 普通链接（严格相等）。当前宿主未暴露浏览器端二维码渲染能力，故
    // qrSupported=false：请求方只显示普通链接，绝不渲染一个与链接不同的二维码。
    qrPayload: result.url,
    qrSupported: false,
    hostname: result.hostname,
  }
}

export const REMOTE_URL_REASONS = Object.freeze({
  empty: '请填写远程访问链接',
  'too-long': '链接过长',
  unparseable: '无法解析为合法链接',
  'no-tls': '仅支持 HTTPS 链接（拒绝无 TLS 的明文 http）',
  'unsafe-scheme': '仅支持 HTTPS 链接（拒绝危险协议）',
  'embedded-credentials': '链接中不得内嵌用户名或密码',
  'no-host': '链接缺少主机名',
  'contains-secret': '链接不得携带 ticket / token / 密码等秘密参数，请从链接中移除后再填写',
})