// 维护批 3 阶段 2：admin token 决策抽出模块的纯装配测试（模块边界直击）。
// resolveAdminToken 从 apply() 原样搬出（行为零变的契约锚由 test/admin-wiring.test.mjs
// 的 HTTP 鉴权测试继续兜底）。覆盖这里 apply 级测不到的角度：
// explicit 覆盖存储损坏哈希、verifyToken 长度差异/空串/非字符串/长输入、generated 只走 info 不接触控制台。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolveAdminToken } from '../src/assembly/admin-token.mjs'

const sha256HexOf = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')
const HEX_64 = /^[0-9a-f]{64}$/

/** store 桩：get 抛错模拟损坏。 */
function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial))
  const store = {
    get: (key) => (data.has(key) ? data.get(key) : undefined),
    set: (key, value) => data.set(key, value),
  }
  store.raw = data
  return store
}

function boot(store, explicitToken = '') {
  const infos = []
  const result = resolveAdminToken({ store, explicitToken, info: (msg) => infos.push(msg) })
  return { ...result, infos }
}

test('简洁路径核对：explicit → 哈希同步 state，invalid(空串) → generated 打印一次', () => {
  const store = fakeStore()
  const r = boot(store, 'explicit-tok')
  assert.equal(r.tokenMode, 'explicit')
  assert.equal(store.raw.get('admin:token-hash'), sha256HexOf('explicit-tok'))
  assert.equal(r.infos.length, 0)
  assert.equal(r.verifyToken('explicit-tok'), true)

  const store2 = fakeStore()
  const r2 = boot(store2, '')
  assert.equal(r2.tokenMode, 'generated')
  assert.equal(r2.infos.length, 2, 'generated 分支打印两条 info（明文 + 找回指引）')
  assert.equal(r2.infos[0].startsWith('admin token（仅此一次打印，请妥善保存）: '), true)
  assert.match(r2.infos[1], /删除 state\.json 的 admin:token-hash 键/, '找回指引第二行')
  const printed = r2.infos[0].split(': ')[1]
  assert.match(printed, /^[A-Za-z0-9_-]{32}$/, 'base64url 24 字节 ≈ 32 字符')
  assert.equal(store2.raw.get('admin:token-hash'), sha256HexOf(printed), '打印的明文与哈希对应')
})

test('reused：既有合法哈希不重写、不打印明文；explicit 覆盖损坏/非 64hex 存储', () => {
  const keep = sha256HexOf('kept-secret')
  const store = fakeStore({ 'admin:token-hash': keep })
  const r = boot(store, '')
  assert.equal(r.tokenMode, 'reused')
  assert.equal(r.infos.length, 0, 'reused 不得重发或打印任何明文')
  assert.equal(r.verifyToken('kept-secret'), true)
  assert.equal(r.verifyToken('wrong'), false)

  // explicit 覆盖损坏哈希：存储被规范化，verifyToken 只认显式
  const corrupt = fakeStore({ 'admin:token-hash': 'not-a-64-hex' })
  const re = boot(corrupt, 'set-by-yaml')
  assert.equal(re.tokenMode, 'explicit')
  assert.equal(corrupt.raw.get('admin:token-hash'), sha256HexOf('set-by-yaml'), '损坏哈希被显式值规范化覆盖')
  assert.equal(re.verifyToken('set-by-yaml'), true)
  assert.equal(re.verifyToken('not-a-64-hex'), false)

  // 长度不符：storedHash 不是 64hex → 视为无 → 首启生成
  const lenBad = fakeStore({ 'admin:token-hash': 'abc' })
  const rl = boot(lenBad, '')
  assert.equal(rl.tokenMode, 'generated', '非 64 hex 的既有哈希视为损坏 → 重新生成')
})

test('verifyToken 恒时安全面：length 检查 + 任何异常一律 false', () => {
  const store = fakeStore({ 'admin:token-hash': sha256HexOf('abc') })
  const r = boot(store, '')
  assert.equal(r.tokenMode, 'reused')
  // 不同长度：不抛 timingSafeEqual，提前 false
  assert.equal(r.verifyToken('a'), false)
  assert.equal(r.verifyToken('a'.repeat(68)), false)
  // 非字符串 / 空串 / null：false，不抛
  assert.equal(r.verifyToken(''), false)
  assert.equal(r.verifyToken(null), false)
  assert.equal(r.verifyToken(undefined), false)
  assert.equal(r.verifyToken(12345), false)
  assert.equal(r.verifyToken({ toString: () => 'abc' }), false, '对象 candidate 视为非法')
  // 同长同哈希才 true；同长不同内容 false
  assert.equal(r.verifyToken('abc'), true)
  assert.equal(r.verifyToken('abd'), false)
})

test('store.get 抛错（损坏 store）→ 视为无既有哈希，不影响显式路径', () => {
  const brokenStore = {
    get: () => { throw new Error('store corrupt') },
    set: () => {}, // 本场景仅验证 get 抛错被吞；set 抛错属于宿主 store 损坏面，由 apply 的 try/catch warn 降级
  }
  const r = resolveAdminToken({ store: brokenStore, explicitToken: 'tok', info: () => {} })
  assert.equal(r.tokenMode, 'explicit')
  assert.equal(r.verifyToken('tok'), true, 'verifyToken 依赖 activeHash 闭包，不读 store')
  assert.equal(r.activeHash, sha256HexOf('tok'))
})