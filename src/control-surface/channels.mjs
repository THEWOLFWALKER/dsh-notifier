import { CHANNEL_TYPES, channelFieldsOf } from '../config.mjs'
import { INBOUND_CHANNELS } from '../inbound/channels-registry.mjs'
import { toInboundChannelName } from '../inbound/capability-matrix.mjs'
import { inboundApplyMode, outboundApplyMode } from './apply-mode.mjs'
import { healthView } from './health.mjs'
import { exposureOf, isPublicExposure } from '../security/exposure.mjs'

const labelOf = (type) => ({ en: type, zh: type })

/** Native 列表 = 出站渠道 + 仅入站渠道；别名渠道只保留出站代表行。 */
const SURFACE_TYPES = Object.freeze([
  ...CHANNEL_TYPES,
  ...INBOUND_CHANNELS.filter((channel) => !CHANNEL_TYPES.includes(channel)
    && !CHANNEL_TYPES.some((type) => toInboundChannelName(type) === channel)),
])

// v0.15（T19 / U06）：把声明上的**控件类型**透给 Native 表单——bool 开关 / enum 选择 /
// 数字输入 / 列表输入 / 文本。这是表现元数据（schema），不是业务规则：没声明的字段一律
// 退回 `string`，绝不猜。
const CONTROL_TYPES = new Set(['boolean', 'enum', 'number', 'list'])

function fieldViews(fields, rawConfig = {}) {
  const out = {}
  for (const [key, meta] of Object.entries(fields ?? {})) {
    const declared = String(meta?.type ?? '').toLowerCase()
    const type = CONTROL_TYPES.has(declared) ? declared : 'string'
    const options = Array.isArray(meta?.options)
      ? meta.options.filter((option) => typeof option === 'string' || typeof option === 'number' || typeof option === 'boolean')
      : null
    out[key] = {
      required: meta?.required === true,
      secret: exposureOf(meta) === 'secret',
      exposure: exposureOf(meta),
      type,
      ...(type === 'enum' && options !== null && options.length > 0 ? { options } : {}),
      configured: Object.prototype.hasOwnProperty.call(rawConfig, key) && rawConfig[key] !== '' && rawConfig[key] !== null && rawConfig[key] !== undefined,
      label: { en: key, zh: key },
      ...(meta?.desc ? { description: { en: String(meta.desc), zh: String(meta.desc) } } : {}),
    }
  }
  return out
}

function editableValues(fields, rawConfig) {
  const out = {}
  for (const [key, meta] of Object.entries(fields ?? {})) {
    if (!isPublicExposure(meta)) continue
    if (Object.prototype.hasOwnProperty.call(rawConfig ?? {}, key)) out[key] = rawConfig[key]
  }
  return out
}

export function createChannelProjection({ outboundSource, outboundConfig, inboundConfig, adminApi, health } = {}) {
  const list = () => {
    let adminRows = []
    try { adminRows = typeof adminApi?.getChannels === 'function' ? adminApi.getChannels() : [] } catch { adminRows = [] }
    const inbound = new Map()
    for (const row of adminRows) if (row?.direction === 'inbound') inbound.set(row.type, row)

    return SURFACE_TYPES.map((type) => {
      const inboundType = toInboundChannelName(type)
      const notifyCapable = CHANNEL_TYPES.includes(type)
      const raw = notifyCapable ? (outboundConfig?.raw?.(type) ?? {}) : {}
      const desc = notifyCapable ? (outboundConfig?.describe?.(type) ?? {
        configured: Object.keys(raw).length > 0,
        active: outboundSource?.has?.(type) === true,
        fields: channelFieldsOf(type),
        applyMode: outboundApplyMode(),
        configRevision: outboundSource?.version ?? 0,
      }) : { configured: false, active: false, fields: {}, applyMode: outboundApplyMode(), configRevision: 0 }
      const evidence = notifyCapable ? (health?.snapshot?.(type) ?? {}) : null
      // v0.14（Stage C）：outbound divergence（旧 runtime 仍在跑但 desired 未收敛）必须与
      // inbound 一样在投影里表达 restartPending——健康度也要显式区分「等待重启」而非「健康」。
      const notifyRestartPending = notifyCapable && desc.restartPending === true
      const h = notifyCapable
        ? healthView({ configured: desc.configured, active: desc.active, health: evidence, restartPending: notifyRestartPending })
        : healthView({ configured: false, active: false, health: null })
      const inRow = inbound.get(inboundType)
      const inFields = inRow?.fields ?? {}
      const inConfig = inRow?.config ?? {}
      return {
        type,
        label: labelOf(type),
        capabilities: {
          notify: notifyCapable,
          control: INBOUND_CHANNELS.includes(inboundType),
        },
        notify: {
          configured: desc.configured === true,
          editable: notifyCapable,
          active: desc.active === true,
          applyMode: outboundApplyMode(),
          // v0.14（Stage C）：与 control 行同构——desired/active/restartPending 分层，diverged
          // 显式标记「旧 runtime 仍在跑但未收敛到 desired」。
          restartPending: notifyRestartPending,
          diverged: notifyCapable && desc.diverged === true,
          configRevision: desc.configRevision ?? outboundSource?.version ?? 0,
          fields: fieldViews(desc.fields ?? {}, raw),
          editableValues: notifyCapable ? editableValues(desc.fields ?? {}, raw) : {},
        },
        control: inRow ? {
          configured: inRow.configured === true,
          editable: inRow.editable !== false,
          // v0.13（C11.5 / R6）：runtime truth——不再把 persisted/enabled 当成 active。
          active: inRow.active === true,
          applyMode: inboundApplyMode(),
          restartPending: inRow.restartPending === true,
          configRevision: Number(inboundConfig?.version) || 0,
          fields: fieldViews(inFields, inConfig),
          editableValues: editableValues(inFields, inConfig),
        } : null,
        health: h,
      }
    })
  }

  return {
    list,
    get(type) {
      const key = String(type ?? '')
      return list().find((row) => row.type === key) ?? null
    },
  }
}
