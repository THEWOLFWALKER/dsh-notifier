// v0.14 S02：MembersControlService（成员/配对共享编排服务）契约测试。
// 用真实 createIdentity/createPairing + 真实 createStore：断言服务只做编排、写入落到
// identity/pairing 权威（I1）、非法身份 fail-closed 零落盘（I7）、pending→member 原子提升
// （I3）、真实落盘失败绝不假报成功（I16）、返回视图零凭证/敏感泄漏。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMembersControlService, memberKeyOf } from '../src/control-plane/members.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createPairing } from '../src/inbound/pairing.mjs'
import { createStore } from '../src/inbound/store.mjs'

const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-members-control-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { dir, file }
}

/** 真实落盘必失败的 store：state.json 的父级是一个普通文件。 */
const failingStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-members-control-fail-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'i am a regular file')
  return createStore(join(blocker, 'state.json'))
}

test('S02: 合法成员写入经服务落到 identity 权威（store 键与读回一致）', () => {
  const { file } = tempState()
  const store = createStore(file)
  const identity = createIdentity({ store })
  const service = createMembersControlService({ identity })

  const first = service.addMember({ channel: 'feishu', accountId: 'feishu-app', userId: 'ou_owner', label: '张三' })
  assert.equal(first.ok, true)
  assert.equal(first.record.role, 'owner', '首条成员即 owner（identity 语义）')

  const second = service.addMember({ channel: 'qq', accountId: 'qq-app', userId: 'qqmember01' })
  assert.equal(second.ok, true)

  // store 键与 identity 读回一致（服务未自持第二份写入状态）
  const table = store.get('inbound:bindings')
  assert.equal(memberKeyOf(table['feishu:feishu-app:ou_owner']), 'feishu:feishu-app:ou_owner')
  assert.equal(identity.allows('feishu', 'ou_owner', 'feishu-app'), true)
  assert.deepEqual(identity.list('feishu').map((record) => record.userId), ['ou_owner'])
  assert.equal(service.listMembers().length, 2)

  // 非默认账号走三段键（同一权威的另一键形态）
  const scoped = service.addMember({ channel: 'feishu', accountId: 'bot2', userId: 'ou_scoped' })
  assert.equal(scoped.ok, true)
  assert.notEqual(store.get('inbound:bindings')['feishu:bot2:ou_scoped'], undefined)
  assert.equal(identity.allows('feishu', 'ou_scoped', 'bot2'), true)
})

test('S02: 非法身份（未知 channel / 非法 accountId / 空或超长 userId）fail-closed 且零落盘', () => {
  const { file } = tempState()
  const store = createStore(file)
  const identity = createIdentity({ store })
  const service = createMembersControlService({ identity })

  const cases = [
    { channel: 'slack', accountId: 'slack-app', userId: 'u1' }, // 未知 channel
    { channel: 'feishu', accountId: 'a'.repeat(129), userId: 'u1' }, // accountId 超长
    { channel: 'feishu', accountId: 'bad:id', userId: 'u1' }, // accountId 含冒号
    { channel: 'feishu', accountId: 'feishu-app', userId: '' }, // 空 userId
    { channel: 'feishu', userId: 'u1' }, // 缺 accountId
    { channel: 'feishu', accountId: 'feishu-app', userId: 'u'.repeat(129) }, // 超长 userId
  ]
  for (const input of cases) {
    const result = service.addMember(input)
    assert.equal(result.ok, false, JSON.stringify(input))
    assert.ok(['invalid-channel', 'invalid-account', 'invalid-user'].includes(result.reason), `reason=${result.reason}`)
  }

  assert.equal(store.get('inbound:bindings'), undefined, '非法写入零落盘（内存）')
  assert.equal(existsSync(file), false, '非法写入不创建 state 文件（磁盘）')
  assert.equal(service.listMembers().length, 0)
})

test('S02: pending→member 提升是原子的（落盘失败时内存与磁盘都不变、报 storage-failed）', () => {
  const seed = {
    'inbound:pending': {
      'wxpusher:wxpusher-app:12345': { channel: 'wxpusher', accountId: 'wxpusher-app', userId: '12345', origin: 'learned', at: Date.now(), extra: {} },
    },
  }
  const { file } = tempState(seed)
  const real = createStore(file)
  const diskBefore = readFileSync(file, 'utf8')
  // 读委托真实 store；写（跨键事务）强制失败 → 等价于落盘失败。
  const failing = {
    get: (key, fallback) => real.get(key, fallback),
    keys: (prefix) => real.keys(prefix),
    transact: () => ({ ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' }),
  }
  const identity = createIdentity({ store: failing })
  const service = createMembersControlService({ identity })

  const result = service.approvePending('wxpusher:wxpusher-app:12345')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'storage-failed', '落盘失败必须如实报 storage-failed（I16）')
  // 内存不变：待确认条目仍在，绑定表无新增（绝不半提交）
  assert.equal(identity.listPending().length, 1)
  assert.equal(identity.list().length, 0)
  // 磁盘不变
  assert.equal(readFileSync(file, 'utf8'), diskBefore)
})

test('S02: 真实落盘失败（state.json 父级是普通文件）→ storage-failed，绝不假报成功', () => {
  const store = failingStore()
  const identity = createIdentity({ store })
  const service = createMembersControlService({ identity })

  const added = service.addMember({ channel: 'telegram', accountId: 'telegram-app', userId: 'tg_user_1' })
  assert.equal(added.ok, false)
  assert.equal(added.reason, 'storage-failed')
  assert.equal(store.get('inbound:bindings'), undefined, '未落盘不得写内存')
  assert.equal(identity.allows('telegram', 'tg_user_1'), false, '失败写入绝不生效')

  const pending = service.addPending({ channel: 'telegram', accountId: 'telegram-app', userId: 'tg_user_2' })
  assert.equal(pending.ok, false)
  assert.equal(pending.reason, 'storage-failed')
  assert.equal(store.get('inbound:pending'), undefined, '待确认写入失败同样不假报成功')
})

test('S02: 返回视图不泄漏凭证/敏感字段（与 admin getMembers 脱敏口径一致）', () => {
  const { file } = tempState()
  const store = createStore(file)
  const identity = createIdentity({ store })
  const pairing = createPairing({ store })
  const service = createMembersControlService({ identity, pairing })

  identity.addBinding({ channel: 'feishu', accountId: 'feishu-app', userId: 'ou_owner', label: 'owner' })
  identity.addPending({ channel: 'wxpusher', accountId: 'wxpusher-app', userId: '12345' })
  const minted = pairing.mint({ origin: 'admin', mintedBy: 'admin:web' })
  assert.equal(minted.ok, true)

  const memberAllowed = new Set(['key', 'channel', 'accountId', 'userId', 'label', 'role', 'origin', 'pairedAt', 'lastSeenAt'])
  for (const member of service.listMembers()) {
    for (const key of Object.keys(member)) assert.ok(memberAllowed.has(key), `成员视图泄漏字段: ${key}`)
  }
  const pendingAllowed = new Set(['key', 'channel', 'accountId', 'userId', 'origin', 'at'])
  for (const entry of service.listPending()) {
    for (const key of Object.keys(entry)) assert.ok(pendingAllowed.has(key), `待确认视图泄漏字段: ${key}`)
  }

  const codes = service.listPairingCodes()
  assert.equal(codes.length, 1)
  assert.equal(codes[0].code, undefined, '码面绝不出现在列表')
  assert.equal('hash' in codes[0], false, '哈希也不暴露')
  assert.equal(JSON.stringify({ members: service.listMembers(), pending: service.listPending(), codes }).includes(minted.code), false, '业务视图整体不含码面')
})

test('S02: 配对 mint/revoke 与 owner-last 守卫经服务归一', () => {
  const { file } = tempState()
  const store = createStore(file)
  const identity = createIdentity({ store })
  const pairing = createPairing({ store })
  const service = createMembersControlService({ identity, pairing })

  const minted = service.mintPairingCode({ origin: 'admin', mintedBy: 'admin:web' })
  assert.equal(minted.ok, true)
  assert.match(minted.code, /^[A-HJ-KM-NP-Z2-9]{8}$/, '8 位易读字母表（无 I/L/O/0/1）')
  assert.equal(service.listPairingCodes()[0].id, minted.id)
  assert.equal(service.revokePairingCode(minted.id, { by: 'admin:web' }).ok, true)
  assert.equal(service.listPairingCodes().length, 0, '撤销后不在在铸列表')

  identity.addBinding({ channel: 'feishu', accountId: 'feishu-app', userId: 'ou_owner' })
  const downgrade = service.updateMember('feishu:feishu-app:ou_owner', { role: 'member' })
  assert.equal(downgrade.ok, false)
  assert.equal(downgrade.reason, 'owner-last')
  const removed = service.removeMember('feishu:feishu-app:ou_owner')
  assert.equal(removed.ok, false)
  assert.equal(removed.reason, 'owner-last')

  assert.equal(service.updateMember('feishu:feishu-app:ghost', { label: 'x' }).reason, 'not-found')
  assert.equal(service.updateMember('bad-key', { label: 'x' }).reason, 'invalid-key')
})