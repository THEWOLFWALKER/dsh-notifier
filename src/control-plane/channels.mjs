// Channel control application service.
//
// Single orchestration entry for channel-config mutation, shared by the Native
// control surface (src/control-surface/service.mjs). It owns orchestration only:
//
//   - save / remove outbound channel config
//   - save / remove inbound channel config
//   - test orchestration (read canonical raw -> provider test)
//
// It deliberately does NOT own:
//   - provider adapters
//   - React / client state
//   - HTTP authentication
//   - revision waiters
//   - activity / health truth
//
// Authority stays where I1 puts it: outbound desired config in
// `src/control-surface/outbound-config.mjs`, inbound config in
// `src/inbound/channel-config.mjs`. This module wraps those authorities so that
// no adapter holds a second write path or a second revision counter.
//
// Failure semantics (I2 / I4 / I11 / I16): persist failure -> no publish;
// persist success + runtime apply failure -> desired saved, applied=false; test
// `accepted` is never upgraded to `delivered` here (that projection lives in the
// adapter).

const isFn = (value) => typeof value === 'function'

function requireOutbound(outboundConfig) {
  if (outboundConfig === null || outboundConfig === undefined
    || !isFn(outboundConfig.save) || !isFn(outboundConfig.remove)) {
    const error = new Error('出站配置写入能力不可用')
    error.code = 'not-supported'
    throw error
  }
}

/**
 * @param {object} deps
 * @param {object} [deps.outboundConfig] - createOutboundConfigService() instance (canonical outbound authority)
 * @param {object} [deps.inboundConfig] - createInboundChannelConfigPort() instance (canonical inbound authority)
 * @param {(type: string, raw: object) => Promise<object>} [deps.channelTest] - provider connectivity test
 * @param {(type: string, patch: object) => Promise<object>} [deps.saveInbound] - inbound save fallback when no port
 */
export function createChannelControlService({
  outboundConfig = null,
  inboundConfig = null,
  channelTest = null,
  saveInbound: saveInboundFn = null,
} = {}) {
  const hasInboundPort = inboundConfig !== null && inboundConfig !== undefined && isFn(inboundConfig.put)

  const saveOutbound = (type, patch) => {
    requireOutbound(outboundConfig)
    return outboundConfig.save(type, patch)
  }

  const removeOutbound = (type, options = {}) => {
    requireOutbound(outboundConfig)
    return outboundConfig.remove(type, options)
  }

  const rawOutbound = (type) => {
    if (outboundConfig !== null && outboundConfig !== undefined && isFn(outboundConfig.raw)) {
      return outboundConfig.raw(type)
    }
    return null
  }

  const describeOutbound = (type) => {
    if (outboundConfig !== null && outboundConfig !== undefined && isFn(outboundConfig.describe)) {
      return outboundConfig.describe(type)
    }
    return null
  }

  const saveInbound = async (type, patch) => {
    // Prefer the canonical inbound port. Fall back to the injected save function
    // only for pre-v0.13 callers; the fallback must still report a durable
    // commit, never a silent success.
    let saved
    if (hasInboundPort) saved = await inboundConfig.put(type, patch)
    else if (isFn(saveInboundFn)) saved = await saveInboundFn(type, patch)
    else {
      const error = new Error('入站配置写入能力不可用')
      error.code = 'not-supported'
      throw error
    }
    if (saved?.saved !== true) {
      const error = new Error('入站配置写入失败：未落盘，已保留当前状态')
      error.code = 'storage-failed'
      throw error
    }
    return saved
  }

  // v0.15（T17）：删除 `removeInboundFn` / `mergeAccountFn` 两个**无 caller** 的旧写入口
  // （无任何生产装配或测试注入；唯一真实入口是 canonical inbound 端口）。少一层转发，
  // 也少一个能绕开端口的缝——能力缺失一律 `not-supported` fail-closed。
  const removeInbound = (type) => {
    if (hasInboundPort) return inboundConfig.remove(type)
    const error = new Error('入站配置删除能力不可用')
    error.code = 'not-supported'
    throw error
  }

  const setInboundEnabled = (type, enabled) => {
    if (hasInboundPort && isFn(inboundConfig.setPrivateChatEnabled)) return inboundConfig.setPrivateChatEnabled(type, enabled)
    const error = new Error('私聊开关当前不可用')
    error.code = 'not-supported'
    throw error
  }

  // v0.14（S12）：凭证域 `<type>:account` 的事务化字段级合并写，收敛账号凭证字段级写入
  // （`PUT /api/channels/:type`）的持久化入口——适配器不再直接写 store（I9），服务不再自持第二套
  // 读-改-写（I10）。只做持久化，字段校验留给调用方（I9 允许表现层做形态校验）。
  // 落盘失败归一为 `storage-failed`，绝不假报成功（I2/I16）。
  const saveChannelAccount = (type, patch) => {
    let saved
    if (hasInboundPort && isFn(inboundConfig.mergeAccount)) saved = inboundConfig.mergeAccount(type, patch)
    else {
      const error = new Error('通道凭证写入能力不可用')
      error.code = 'not-supported'
      throw error
    }
    if (saved?.saved !== true) {
      const error = new Error('通道凭证写入失败：未落盘，已保留当前状态')
      error.code = 'storage-failed'
      throw error
    }
    return saved
  }

  const testOutbound = async (type) => {
    if (!isFn(channelTest)) {
      const error = new Error('连通性测试不可用')
      error.code = 'not-supported'
      throw error
    }
    const raw = rawOutbound(type)
    if (raw === null || Object.keys(raw).length === 0) {
      const error = new Error(`渠道 "${type}" 未配置`)
      error.code = 'not-configured'
      throw error
    }
    return await channelTest(type, raw)
  }

  return {
    saveOutbound,
    removeOutbound,
    rawOutbound,
    describeOutbound,
    saveInbound,
    removeInbound,
    setInboundEnabled,
    saveChannelAccount,
    testOutbound,
  }
}
