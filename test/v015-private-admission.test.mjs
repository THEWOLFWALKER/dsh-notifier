import test from 'node:test'
import assert from 'node:assert/strict'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { normalizeSessionPolicy } from '../src/control/session-arbiter.mjs'

for (const channel of ['telegram', 'qq', 'feishu', 'dingtalk', 'wechat', 'wxpusher']) {
  test(`F09: ${channel} group messages and pairing are rejected before fanout or identity changes`, () => {
    let fanout = 0, identityReads = 0
    const bus = createInboundBus({ identity: { allows() { identityReads++; return true } } })
    bus.onMessage(() => { fanout++ })
    for (const text of ['/pair code', '/bind task', 'hello', '1']) {
      const result = bus.accept({ channel, accountId: 'bot', userId: 'user', chatId: 'group_chat', chatType: 'group', messageId: text, text })
      assert.equal(result.reason, 'group_chat_disabled')
    }
    assert.equal(fanout, 0); assert.equal(identityReads, 0)
    bus.dispose()
  })
  test(`F09: ${channel} group callback rejects before pending lookup or policy routing`, () => {
    let lookup = 0, resolve = 0, effect = 0
    const control = createControlEntry({ policy: { mode: 'team', capabilities: { approve: true, converse: true, groupChatControl: true } }, policyForSession: () => { resolve++; return {} } })
    control.register('approval', { getPending() { lookup++; return {} }, settle() { effect++; return true } })
    for (const command of ['approval', 'question-answer', 'stop', 'steer', 'ordinary-message']) {
      const receipt = control.handle({ channel, accountId: 'bot', userId: 'user', chatId: 'group_chat', chatType: 'group', command, eventId: command })
      assert.equal(receipt.status, 'rejected')
    }
    assert.equal(lookup, 0); assert.equal(resolve, 0); assert.equal(effect, 0)
    assert.equal('groupChatControl' in normalizeSessionPolicy({ mode: 'team', capabilities: { groupChatControl: true } }).capabilities, false)
    control.dispose()
  })
}
