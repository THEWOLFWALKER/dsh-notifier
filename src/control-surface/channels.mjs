import { CHANNEL_TYPES, channelFieldsOf } from '../config.mjs'
import { INBOUND_CHANNELS } from '../inbound/channels-registry.mjs'
import { healthView } from './health.mjs'

const labelOf = (type) => ({ en: type, zh: type })

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

    return CHANNEL_TYPES.map((type) => {
      const raw = outboundConfig?.raw?.(type) ?? {}
      const desc = outboundConfig?.describe?.(type) ?? {
        configured: Object.keys(raw).length > 0,
        active: outboundSource?.has?.(type) === true,
        fields: channelFieldsOf(type),
        applyMode: 'hot',
        configRevision: outboundSource?.version ?? 0,
      }
      const evidence = health?.snapshot?.(type) ?? {}
      const h = healthView({ configured: desc.configured, active: desc.active, health: evidence })
      const inboundType = type === 'qq-bot' ? 'qq' : type
      const inRow = inbound.get(inboundType)
      const inFields = inRow?.fields ?? {}
      const inConfig = inRow?.config ?? {}
      return {
        type,
        label: labelOf(type),
        capabilities: {
          notify: true,
          control: INBOUND_CHANNELS.includes(inboundType),
        },
        notify: {
          configured: desc.configured === true,
          editable: true,
          active: desc.active === true,
          applyMode: 'hot',
          configRevision: desc.configRevision ?? outboundSource?.version ?? 0,
          fields: fieldViews(desc.fields ?? {}, raw),
          editableValues: editableValues(desc.fields ?? {}, raw),
        },
        control: inRow ? {
          configured: inRow.configured === true,
          editable: inRow.editable !== false,
          active: inRow.enabled === true,
          applyMode: inRow.restartRequired === true ? 'restart' : 'hot',
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
