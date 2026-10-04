// Assemble outbound channels from the canonical channel state and YAML bootstrap rows.

import { ADAPTERS, resolveEnvRefs, CHANNEL_TYPES } from '../config.mjs'

/** store 账号防御读取：非普通对象（null/数组/标量/损坏）一律按无账号。 */
export function accountOf(store, key) {
  try {
    const value = store.get(key)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function resolveOutboundConfig(store, type) {
  const config = accountOf(store, `channel:${type}:outbound`)
  return config === null ? null : config
}

/**
 * 组装出站渠道（纯函数，无副作用）：
 * @param {{ channels: Array, yamlRows: Map<string, object>, store: object,
 *           warn: (msg: string) => void }} deps
 * @returns {{ channels: Array, testRawConfigOf: (type: string) => object|null }}
 */
export function composeOutboundChannels({ channels, yamlRows, store, warn }) {
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
    const overlayConfig = resolveOutboundConfig(store, type)
    if (overlayConfig === null) continue
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
