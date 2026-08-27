// Compatibility facade for historical imports.
// New runtime code lives under src/channels/wechat-ilink/; keep this path stable for
// existing plugins/tests without duplicating protocol or control logic.
export {
  createWechatIlinkInbound,
  resolveWechatInboundConfig,
  ACCOUNT_KEY,
} from '../channels/wechat-ilink/legacy-core.mjs'
