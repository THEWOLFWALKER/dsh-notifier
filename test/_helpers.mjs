import { normalizeInbound } from '../src/inbound/_contract.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createTelegramInbound } from '../src/inbound/telegram-bot.mjs'
import { createFeishuInbound } from '../src/inbound/feishu-bot.mjs'
import { createQqInbound } from '../src/inbound/qq-gw.mjs'
import { createDingtalkInbound } from '../src/inbound/dingtalk-stream.mjs'
import { createWxpusherInbound } from '../src/inbound/wxpusher-callback.mjs'
import { createWechatIlinkInbound } from '../src/inbound/wechat-ilink.mjs'

export const CONTRACT_BASE = {
  bus: createInboundBus({ allowUsers: ['u1'] }),
  vault: createTokenVault({ secret: 'contract-secret' }),
}

export function collectContractFactories() {
  return [
    {
      name: 'telegram',
      expectedChannel: 'telegram',
      raw: () => createTelegramInbound({
        config: { botToken: 'T', notifyChatIds: [100] },
        bus: CONTRACT_BASE.bus,
        vault: CONTRACT_BASE.vault,
        fetchImpl: undefined,
      }),
    },
    {
      name: 'feishu',
      expectedChannel: 'feishu',
      raw: () => createFeishuInbound({
        config: { appId: 'a', appSecret: 's' },
        bus: CONTRACT_BASE.bus,
      }),
    },
    {
      name: 'qq',
      expectedChannel: 'qq',
      raw: () => createQqInbound({
        config: { appId: 'a', appSecret: 's' },
        bus: CONTRACT_BASE.bus,
      }),
    },
    {
      name: 'dingtalk',
      expectedChannel: 'dingtalk',
      raw: () => createDingtalkInbound({
        config: { appKey: 'k', appSecret: 's' },
        bus: CONTRACT_BASE.bus,
      }),
    },
    {
      name: 'wxpusher',
      expectedChannel: 'wxpusher',
      raw: () => createWxpusherInbound({
        config: { appToken: 'AT_appToken', webhookPath: '/hook/secret123' },
        bus: CONTRACT_BASE.bus,
      }),
    },
    {
      name: 'wechat',
      expectedChannel: 'wechat',
      raw: () => createWechatIlinkInbound({
        config: { accountId: 'a', token: 't', baseUrl: 'https://example.test' },
        bus: CONTRACT_BASE.bus,
      }),
    },
  ]
}

export function normalizeContractChannels() {
  return collectContractFactories().map(({ name, expectedChannel, raw }) => {
    const entry = normalizeInbound(raw())
    return { name, expectedChannel, channel: entry?.channel ?? null }
  })
}
