import { createInboundBus } from '../../src/inbound/bus.mjs'

const privateType = Object.freeze({
  telegram: 'private', feishu: 'p2p', qq: 'private', dingtalk: '1',
  wxpusher: 'private', wechat: 'private',
})

// Conversation and command unit tests start after transport normalization. Supply explicit
// private source evidence in their fixture so each case can focus on routing behavior.
export function createPrivateFlowBus({ store = null, identity = null, pairing = null, accountId = 'tg-app', userId = '42', channel = 'telegram', pairedUsers = null, allowUsers = null, ...options } = {}) {
  const paired = new Set((pairedUsers ?? allowUsers ?? [userId]).map(String))
  const pairedIdentity = identity ?? {
    isEmpty: () => false,
    allows: (sourceChannel, sourceUserId, sourceAccountId) =>
      Object.hasOwn(privateType, sourceChannel) && paired.has(String(sourceUserId)) && String(sourceAccountId ?? '').trim() !== '' && String(sourceAccountId) !== 'default',
  }
  const bus = createInboundBus({ ...options, store, pairing, identity: pairedIdentity })
  return {
    ...bus,
    acceptRaw(envelope) {
      return bus.accept(envelope)
    },
    accept(envelope = {}) {
      const sourceChannel = envelope.channel ?? channel
      const sourceUserId = envelope.userId ?? userId
      return bus.accept({
        channel: sourceChannel,
        accountId,
        userId: sourceUserId,
        chatId: envelope.chatId ?? sourceUserId,
        chatType: privateType[sourceChannel] ?? 'private',
        ...envelope,
      })
    },
  }
}
