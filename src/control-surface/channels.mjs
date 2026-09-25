import { CHANNEL_TYPES, channelFieldsOf } from '../config.mjs'
import { INBOUND_CHANNELS } from '../inbound/channels-registry.mjs'
import { toInboundChannelName } from '../inbound/capability-matrix.mjs'
import { inboundApplyMode, outboundApplyMode } from './apply-mode.mjs'
import { healthView } from './health.mjs'

const labelOf = (type) => ({ en: type, zh: type })

/** Native 列表 = 出站渠道 + 仅入站渠道；别名渠道只保留出站代表行。 */
const SURFACE_TYPES = Object.freeze([
  ...CHANNEL_TYPES,
  ...INBOUND_CHANNELS.filter((channel) => !CHANNEL_TYPES.includes(channel)
    && !CHANNEL_TYPES.some((type) => toInboundChannelName(type) === channel)),
])

function fieldViews(fields, rawConfig = {}) {
  const out = {}
  for (const [key, meta] of Object.entries(fields ?? {})) {
    out[key] = {
      required: meta?.required === true,
      secret: meta?.secret === true,
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
    if (meta?.secret === true) continue
    if (Object.prototype.hasOwnProperty.call(rawConfig ?? {}, key)) out[key] = rawConfig[key]
  }
  return out
}

export function createChannelProjection({ outboundSource, outboundConfig, adminApi, health } = {}) {
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
      const h = notifyCapable
        ? healthView({ configured: desc.configured, active: desc.active, health: evidence })
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
          configRevision: desc.configRevision ?? outboundSource?.version ?? 0,
          fields: fieldViews(desc.fields ?? {}, raw),
          editableValues: notifyCapable ? editableValues(desc.fields ?? {}, raw) : {},
        },
        control: inRow ? {
          configured: inRow.configured === true,
          editable: inRow.editable !== false,
          active: inRow.enabled === true,
          applyMode: inboundApplyMode(),
          configRevision: 0,
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
