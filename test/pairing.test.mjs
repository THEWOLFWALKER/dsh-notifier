// G-59 测试：inbound/pairing.mjs（配对码状态机）锁出与 TTL。
// W11 G-30/G-31 语义修订（本模块按新语义写，与 test/identity.test.mjs 的 G-30/G-31 用例对齐）：
//  - 过期码不计 5 次失败锁出（只 expired 回执）——过期码不是爆破信号
//    （能提交过期码说明曾真实持有在铸码）；防泵码由 commands.mjs ensureBootstrap
//    10min 节流单层兜住，锁出层不参与过期路径。
//  - 无效码仍计失败翻锁（形态非法 / 查无此码 = 真暴力面）：连续 5 次锁 10 分钟，
//    锁出期内任何码（含有效码）都进不来；锁出期满恢复受理。
//  - 锁出按 (channel,userId) 用户级隔离；成功核销清零失败计数；失败滑窗 10 分钟。
// TTL 覆盖：默认 10 分钟、自定义 ttlMs、惰性过期（sweep 读路径翻转即落盘 + expire 审计）、
// minted-active 单态（G-20 W12）同等可过期。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/inbound/store.mjs'
import { createPairing } from '../src/inbound/pairing.mjs'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notifier-pairing-'))
  return { dir, store: createStore(join(dir, 'state.json')) }
}

const quiet = { warn: () => {}, info: () => {} }

test('G-59 TTL 过期：码超时后核销 → expired 回执，翻转即落盘 + expire 审计', () => {
  const { store } = tempStore()
  const audits = []
  const pairing = createPairing({ store, logger: quiet, onAudit: (event, detail) => audits.push({ event, ...detail }) })
  const now = Date.now()
  const minted = pairing.mint({ origin: 'admin', mintedBy: 'boss', now }) // 默认 TTL 10 分钟
  assert.equal(pairing.redeem(minted.code, { channel: 'telegram', userId: '1', now: now + 10 * 60 * 1000 }).reason, 'expired')
  const table = store.get('inbound:pairing', {})
  const entry = table[Object.keys(table).find((k) => k.startsWith(minted.id))]
  assert.equal(entry.state, 'expired', '惰性过期翻转即落盘（不是只改内存）')
  assert.ok(audits.some((a) => a.event === 'expire' && a.id === minted.id), 'expire 审计必须发出')
})

test('G-59 自定义 ttlMs：mint 参数覆盖默认；到期前一刻可核销、恰到期即过期', () => {
  const pairing = createPairing({ store: null, logger: quiet }) // 内存态（仅测试用）
  const now = Date.now()
  const a = pairing.mint({ origin: 'admin', mintedBy: 'boss', ttlMs: 5000, now })
  assert.equal(a.expiresAt, now + 5000)
  assert.equal(pairing.redeem(a.code, { channel: 'telegram', userId: '1', now: now + 4999 }).ok, true, '到期前一刻仍可核销')
  const b = pairing.mint({ origin: 'admin', mintedBy: 'boss', ttlMs: 5000, now })
  assert.equal(pairing.redeem(b.code, { channel: 'telegram', userId: '1', now: now + 5000 }).reason, 'expired', '恰好到期即过期')
})

test('G-20 minted-active 单态同等可过期：过期后不在在铸列表（W12 语义）', () => {
  const pairing = createPairing({ store: null, logger: quiet })
  const now = Date.now()
  const minted = pairing.mint({ origin: 'admin', mintedBy: 'boss', ttlMs: 60_000, now })
  assert.equal(pairing.listActive(now).length, 1, '刚铸在列（minted-active 视同在铸）')
  const later = now + 61 * 1000
  assert.equal(pairing.listActive(later).length, 0, '过期后 sweep 移出在铸列表')
  assert.equal(pairing.redeem(minted.code, { channel: 'telegram', userId: '1', now: later }).reason, 'expired')
})

test('G-59 过期码不计锁出（W11 新语义）：连提 6 次过期码始终 expired，永不 locked-out', () => {
  const { store } = tempStore()
  const pairing = createPairing({ store, logger: quiet })
  const stale = pairing.mint({ origin: 'bootstrap', mintedBy: 'system:boot', ttlMs: 1 })
  const later = Date.now() + 5000 // 码已过期
  for (let i = 0; i < 6; i += 1) {
    assert.equal(pairing.redeem(stale.code, { channel: 'telegram', userId: '42', now: later }).reason, 'expired',
      `第 ${i + 1} 次应始终是 expired（过期码不翻锁）`)
  }
  assert.equal(pairing.isLockedOut('telegram', '42', later), false, '过期码提交不触发锁出')
  const fresh = pairing.mint({ origin: 'admin', mintedBy: 'boss', now: later })
  assert.equal(pairing.redeem(fresh.code, { channel: 'telegram', userId: '42', now: later }).ok, true,
    '过期码不计失败 → 合法新码直接可配对，无锁出阴影')
})

test('G-59 无效码翻锁（W11 语义保留）：5 次锁 10 分钟，锁出期内有效码也进不来，期满恢复', () => {
  const pairing = createPairing({ store: null, logger: quiet })
  const now = Date.now()
  for (let i = 0; i < 4; i += 1) {
    assert.equal(pairing.redeem('AAAA1111', { channel: 'qq', userId: 'q1', now }).reason, 'invalid-code',
      `第 ${i + 1} 次无效码仍计失败`)
  }
  assert.equal(pairing.isLockedOut('qq', 'q1', now), false, '4 次后不该锁（阈值 5，下边界）')
  assert.equal(pairing.redeem('AAAA2222', { channel: 'qq', userId: 'q1', now }).reason, 'locked-out', '第 5 次翻锁（上边界）')
  const fresh = pairing.mint({ origin: 'admin', mintedBy: 'boss', now })
  assert.equal(pairing.redeem(fresh.code, { channel: 'qq', userId: 'q1', now }).reason, 'locked-out', '锁出期内有效码也进不来')
  const unlocked = now + 10 * 60 * 1000 + 1
  assert.equal(pairing.isLockedOut('qq', 'q1', unlocked), false, '锁出期满解锁（lockedUntil 持久化，不看滑窗）')
  const after = pairing.mint({ origin: 'admin', mintedBy: 'boss', now: unlocked })
  assert.equal(pairing.redeem(after.code, { channel: 'qq', userId: 'q1', now: unlocked }).ok, true,
    '解锁后合法用户可正常配对（宪法#6：用户失误不永久锁死）')
})

test('G-59 锁出按 (channel,userId) 隔离：一个用户被锁不牵连他人', () => {
  const pairing = createPairing({ store: null, logger: quiet })
  const now = Date.now()
  for (let i = 0; i < 5; i += 1) pairing.redeem('AAAA1111', { channel: 'telegram', userId: '42', now })
  assert.equal(pairing.isLockedOut('telegram', '42', now), true, '前置：42 已锁（无效码触发）')
  assert.equal(pairing.isLockedOut('telegram', '43', now), false, '同渠道另一 userId 不受牵连')
  assert.equal(pairing.isLockedOut('qq', '42', now), false, '同 userId 另一渠道：复合键隔离')
})

test('G-59 成功核销清零失败计数：3 次无效码 + 成功 → 计数清零，后续再错从 0 计', () => {
  const pairing = createPairing({ store: null, logger: quiet })
  const now = Date.now()
  for (let i = 0; i < 3; i += 1) {
    assert.equal(pairing.redeem('BBBB2222', { channel: 'telegram', userId: 'c1', now }).reason, 'invalid-code')
  }
  assert.equal(pairing.isLockedOut('telegram', 'c1', now), false, '前置：3 次未锁')
  const code = pairing.mint({ origin: 'admin', mintedBy: 'boss', now })
  assert.equal(pairing.redeem(code.code, { channel: 'telegram', userId: 'c1', now }).ok, true)
  for (let i = 0; i < 4; i += 1) {
    assert.equal(pairing.redeem('BBBB2222', { channel: 'telegram', userId: 'c1', now }).reason, 'invalid-code')
  }
  assert.equal(pairing.isLockedOut('telegram', 'c1', now), false, '清零后 4 次不锁（失败计数已复位）')
  assert.equal(pairing.redeem('BBBB2222', { channel: 'telegram', userId: 'c1', now }).reason, 'locked-out', '第 5 次翻锁')
})

test('G-59 失败滑窗：间隔超 10 分钟窗口的失败不累计（分散尝试永不翻锁）', () => {
  const pairing = createPairing({ store: null, logger: quiet })
  const t0 = Date.now()
  for (let i = 0; i < 5; i += 1) {
    const at = t0 + i * 11 * 60 * 1000 // 每次相隔 11 分钟（> ATTEMPT_WINDOW_MS 10 分钟）
    assert.equal(pairing.redeem('BBBB2222', { channel: 'telegram', userId: 's1', now: at }).reason, 'invalid-code')
  }
  assert.equal(pairing.isLockedOut('telegram', 's1', t0 + 5 * 11 * 60 * 1000), false, '分散失败各次滑出窗口，不翻锁')
})

test('G-59 锁出审计：翻锁时发 lockout(tripped)，锁出期拒绝发 lockout(rejected)', () => {
  const audits = []
  const pairing = createPairing({ store: null, logger: quiet, onAudit: (event, detail) => audits.push({ event, ...detail }) })
  const now = Date.now()
  for (let i = 0; i < 4; i += 1) pairing.redeem('BBBB2222', { channel: 'qq', userId: 'q9', now })
  assert.ok(!audits.some((a) => a.event === 'lockout'), '未翻锁前无 lockout 审计')
  pairing.redeem('BBBB2222', { channel: 'qq', userId: 'q9', now })
  const tripped = audits.filter((a) => a.event === 'lockout')
  assert.equal(tripped.length, 1)
  assert.equal(tripped[0].phase, 'tripped')
  assert.equal(tripped[0].user, 'qq:q9')
  pairing.redeem('CCCC3333', { channel: 'qq', userId: 'q9', now }) // 锁出期内再提交
  const rejected = audits.filter((a) => a.event === 'lockout')
  assert.equal(rejected.length, 2)
  assert.equal(rejected[1].phase, 'rejected', '锁出期拒绝也要审计')
})

test('G-59 revoked/locked 终态：管理台处置后不可核销（人工处置面）', () => {
  const pairing = createPairing({ store: null, logger: quiet })
  const now = Date.now()
  const a = pairing.mint({ origin: 'admin', mintedBy: 'boss', now })
  pairing.revoke(a.id, { by: 'admin', now })
  assert.equal(pairing.redeem(a.code, { channel: 'telegram', userId: 'u', now }).reason, 'revoked')
  const b = pairing.mint({ origin: 'admin', mintedBy: 'boss', now })
  pairing.lock(b.id, { by: 'admin', now })
  assert.equal(pairing.redeem(b.code, { channel: 'telegram', userId: 'u', now }).reason, 'locked')
})
