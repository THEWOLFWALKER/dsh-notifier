// dsh-notifier src/assembly/outbound.mjs
// 出站凭证 state overlay（从 src/index.mjs apply() 抽出，维护批 3 阶段 1）。
// 职责：把 store 里的出站 overlay 与 YAML 行字段级合并——store 字段覆盖同名 YAML
// 字段（改过的即为准）——重新过 adapter.resolve 后替换/追加 resolved.channels。
//
// v0.12 读取优先级（STATE-MIGRATION-v0.12.0.md）：
//   1. `channel:<type>:outbound`（canonical 产品/运行时键，始终读取，与 Admin 无关）
//   2. `admin:channel:<type>:outbound`（admin-zero-config-onboarding，仅 admin.enabled === true）
//   3. 非双域类型的旧 `<type>:account`（UI putChannel / 手写产物，同样仅 admin.enabled === true）
//   4. YAML bootstrap
// Admin 关闭时不得重新激活任何 Admin 自有 overlay（§6 兼容红线：无 overlay 命中则
// channels 数组引用原样透传，零执行、逐字节不变）。
// 双域通道（feishu/dingtalk）的 `<type>:account` 键域归入站机器人凭证
// （v0.3.1 扫码落盘语义），不读出站；canonical 出站键让 feishu/dingtalk 也能在网页
// 保存出站 webhook，不再要求改 YAML。
// 只读 store（无写副作用）；任何适配器 resolve 失败都只单选跳过/沿用，绝不弄崩装配。

import { ADAPTERS, resolveEnvRefs, CHANNEL_TYPES } from '../config.mjs'

export const DUAL_INBOUND_DOMAIN_TYPES = new Set(['feishu', 'dingtalk'])

/** store 账号防御读取：非普通对象（null/数组/标量/损坏）一律按无账号。 */
export function accountOf(store, key) {
  try {
    const value = store.get(key)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 读取某类型的出站 store overlay（按优先级）：canonical `channel:<type>:outbound`（始终）
 * → 旧 `admin:channel:<type>:outbound` → 旧 `<type>:account`（后两者仅 admin 开启、非双域）。
 * 返回 null 表示无 store overlay——纯 YAML 类型不在此重建（装配主流程已 resolve 过，
 * 重过 adapter 只会变动对象同一性/补默认值，零收益且破坏「未触碰类型逐字节不变」）。
 * @param {object} store
 * @param {string} type
 * @param {boolean} adminEnabled
 * @returns {{ source: 'canonical-outbound'|'admin-outbound'|'legacy-account'|null, config: object|null }}
 */
function resolveOutboundConfig(store, type, adminEnabled) {
  // v0.12 canonical product/runtime key is independent of Standalone Admin.
  const canonical = accountOf(store, `channel:${type}:outbound`)
  if (canonical !== null) return { source: 'canonical-outbound', config: canonical }
  // v0.11 Admin-owned overlays (`admin:channel:<type>:outbound` and legacy `<type>:account`)
  // stay compatibility-only: never reactivate them for a user who disabled Admin.
  if (adminEnabled !== true) return { source: null, config: null }
  const oldAdmin = accountOf(store, `admin:channel:${type}:outbound`)
  if (oldAdmin !== null) return { source: 'admin-outbound', config: oldAdmin }
  if (!DUAL_INBOUND_DOMAIN_TYPES.has(type)) {
    const legacy = accountOf(store, `${type}:account`)
    if (legacy !== null) return { source: 'legacy-account', config: legacy }
  }
  return { source: null, config: null }
}

/**
 * 组装出站渠道（纯函数，无副作用）：
 * @param {{ channels: Array, yamlRows: Map<string, object>, store: object,
 *           adminEnabled: boolean, warn: (msg: string) => void }} deps
 * @returns {{ channels: Array, testRawConfigOf: (type: string) => object|null }}
 */
export function composeOutboundChannels({ channels, yamlRows, store, adminEnabled, warn }) {
  /** 连通性测试的 rawConfig（合并行优先，回落 YAML 行；ENV 引用由 runChannelTest 自行解析）。 */
  const makeTestRaw = (mergedRowOf) => (type) => {
    const row = mergedRowOf.get(type) ?? yamlRows.get(type)
    if (row === undefined) return null
    const { type: _drop, ...rest } = row
    return rest
  }
  const byType = new Map(channels.map((entry) => [entry.type, entry]))
  // type → 合并后的原始行（channelTest 的 rawConfig 来源）
  const mergedRowOf = new Map()
  for (const type of CHANNEL_TYPES) {
    const { source, config: overlayConfig } = resolveOutboundConfig(store, type, adminEnabled)
    if (source === null || overlayConfig === null) continue
    const merged = { ...(yamlRows.get(type) ?? {}), ...overlayConfig, type }
    try {
      byType.set(type, { type, config: ADAPTERS[type].resolve(resolveEnvRefs(merged)) })
      mergedRowOf.set(type, merged)
    } catch (error) {
      // resolve 失败：YAML 条目原样保留（未破坏 byType），只记原因；store-only 类型即「暂不启用」
      const reason = error instanceof Error ? error.message : String(error)
      if (byType.has(type)) warn(`渠道 "${type}" state 凭证合并失败，沿用 YAML 配置: ${reason}`)
      else warn(`渠道 "${type}" 跳过（state 凭证不完整）: ${reason}`)
    }
  }
  // 无 overlay 命中 → 数组引用原样透传（零执行、零 warn；「未触碰类型逐字节不变」）。
  return {
    channels: mergedRowOf.size === 0 ? channels : [...byType.values()],
    testRawConfigOf: makeTestRaw(mergedRowOf),
  }
}
