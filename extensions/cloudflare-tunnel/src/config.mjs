// dsh-notifier extensions/cloudflare-tunnel/src/config.mjs
// T25（可选 Cloudflare Tunnel）— 配置校验与安全边界（R03）。
//
// 这里**不**启动隧道、**不**读宿主私有字段，只做纯校验：把用户想给的隧道配置翻译成一个
// 可安全执行 / 明确拒绝的裁决。三条红线：
//
//  R03-1（Origin / Host trust）：任何试图「无条件清除 Origin / 重写 localhost / 关掉 Host
//        信任」的配置一律拒绝——本扩展绝不为了可达性抹掉鉴权边界。
//  R03-2（Access 保护）：命名隧道若宣称「受保护入口」，必须来自**已配置**的 Access 保护；
//        未配置访问保护时，不得把受信任 Host 入口自动公开。
//  R03-3（Quick Tunnel）：Quick Tunnel 是临时/不稳定入口，绝不标成稳定 SSE 生产入口。
//
// 纯函数模块：不 import 任何项目内文件、不发起任何网络请求、不 spawn 子进程。

const isRecord = (value) => typeof value === 'object' && value !== null

// 破坏 Host trust 边界的危险配置项（大小写不敏感）。命中即拒绝，不解释成「宽松」。
const HOST_TRUST_VIOLATIONS = new Set([
  'clearorigin', 'striporigin', 'removeorigin', 'droporigin', 'noorigin',
  'bypasshost', 'disablehostcheck', 'insecurehost', 'rewritelocalhost', 'localhostrewrite',
])

/**
 * 校验一份隧道配置。返回 `{ ok:true, value }`（值为净化后的投影）或 `{ ok:false, reason }`。
 * reason ∈ empty | unparseable | not-record | no-tunnel-name | invalid-tunnel-name |
 *          missing-credentials-source | quick-tunnel-stable | untrusted-origin | host-trust-violation |
 *          access-as-cleartrust
 * @param {unknown} input
 * @returns {{ok:true, value:object} | {ok:false, reason:string}}
 */
export function validateTunnelConfig(input) {
  if (input === null || input === undefined) return bad('empty')
  if (!isRecord(input)) return bad('not-record')
  if (Array.isArray(input)) return bad('not-record')

  const name = input.name
  if (name === undefined || name === null || String(name).trim() === '') return bad('no-tunnel-name')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(name))) return bad('invalid-tunnel-name')

  // Quick Tunnel（未命名 / 显式 quick）不得标成稳定入口
  if (input.quick === true) return bad('quick-tunnel-stable')

  const credentialsSource = input.credentialsSource
  if (credentialsSource === undefined || credentialsSource === null
    || String(credentialsSource).trim() === '') {
    return bad('missing-credentials-source')
  }

  // 默认**不**删除 Origin / 不改写 localhost / 不改 Host trust；任何显式越界即拒绝（R03-1）
  const hostTrustFlags = input.hostTrust ?? {}
  if (isRecord(hostTrustFlags)) {
    for (const key of Object.keys(hostTrustFlags)) {
      if (HOST_TRUST_VIOLATIONS.has(String(key).toLowerCase()) && hostTrustFlags[key] === true) {
        return bad('host-trust-violation')
      }
    }
    if (hostTrustFlags.untrustedOrigin === true) return bad('untrusted-origin')
  }

  // Access 保护：宣称「已受保护」必须有明确 access 配置（R03-2）；空值不得当信任
  const access = input.access
  const claimsProtected = input.protected === true
  if (claimsProtected && (!isRecord(access) || access.applicationId === undefined
    || String(access.applicationId).trim() === '')) {
    return bad('access-as-cleartrust')
  }

  // 默认停用；仅显式 enabled 才 active
  const value = {
    name: String(name).trim(),
    enabled: input.enabled === true,
    quick: false,
    credentialsSource: String(credentialsSource).trim(),
    access: isRecord(access)
      ? { applicationId: String(access.applicationId ?? '').trim(),
          protected: claimsProtected }
      : { applicationId: '', protected: false },
    hostTrust: {
      // 永远保持默认 true 的信任边界；本扩展从不清除
      originCheck: isRecord(hostTrustFlags) ? hostTrustFlags.originCheck !== false : true,
      hostCheck: isRecord(hostTrustFlags) ? hostTrustFlags.hostCheck !== false : true,
    },
  }
  return { ok: true, value }
}

/**
 * 由「状态」解析是否可被认定为受保护的稳定入口（用于投影，不决策写盘）。
 * 只有命名 + Access 保护均成立的隧道才是 `protected`；Quick（quick 标注）绝不 `protected`。
 * @param {unknown} state
 * @returns {{ available:boolean, protected:boolean, quick:boolean }}
 */
export function describeTunnelTrust(state) {
  if (!isRecord(state)) return { available: false, protected: false, quick: false }
  return {
    available: state.status === 'running' && state.quick !== true,
    protected: state.access?.protected === true && state.quick !== true,
    quick: state.quick === true,
  }
}

const bad = (reason) => ({ ok: false, reason })

export const TUNNEL_CONFIG_REASONS = Object.freeze({
  empty: '请填写隧道配置',
  'not-record': '隧道配置必须是对象',
  'no-tunnel-name': '命名隧道缺少名称',
  'invalid-tunnel-name': '隧道名称不合法（仅限字母数字与 . _ -，首字符为字母数字，最长 64）',
  'missing-credentials-source': '缺少隧道凭据来源（请提供 cloudflared 证书或合法 Host 凭据引用）',
  'quick-tunnel-stable': 'Quick Tunnel 是临时入口，不能作为稳定入口使用',
  'untrusted-origin': '不得无条件清除 Origin 校验',
  'host-trust-violation': '不得改写 localhost / 关闭 Host 信任校验',
  'access-as-cleartrust': '未配置 Access 保护时不得宣称受保护入口',
})