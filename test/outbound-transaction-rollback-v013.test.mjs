// v0.13（C11.5 / R1）回归：事务化 store 上的 durable 失败禁止「写回旧值」。
//
// 背景：C2 把 store 换成 detached-draft + lock + fresh-read + rename 的事务实现，
// 契约是「commit 失败 ⇒ 内存与磁盘都不变」。但 outbound-config 的 save/remove 仍保留
// 旧 Store 时代（内存先改）的调用方回滚：
//
//   if (setDurable(...) !== true) { setDurable(store, key, currentCanonical); throw }
//
// 在事务 store 上这段回滚不但多余，还会制造 lost update：
//
//   A 读 old=v1 → A 提交 v2 失败（STATE_BUSY/写失败）
//              → B 成功提交 v3
//              → A 回滚写 v1        ← B 的 v3 被抹掉
//
// 本文件用一个「事务语义」的 store 精确复现该交错（失败当次先让 B 提交，再宣告失败），
// 断言失败返回后盘上/内存里仍是 v3 —— 即 A 的失败不得改变任何事实。
//
// 反方向（遗留 store 的 set() 先改内存再宣告失败）仍由
// test/durability-contract-v0121.test.mjs 的 P0-01 守着：那里必须补回滚。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'

const CANONICAL_BARK = 'channel:bark:outbound'

/**
 * 事务语义 store：transact 只在 mutator 成功且本次写不失败时发布 draft。
 * @param {object} options
 * @param {object} options.initial 初始键值
 * @param {number[]} options.failAt 第几次 transact（1 起）宣告失败
 * @param {() => void} [options.beforeFail] 失败当次、宣告失败之前的交错钩子
 *        —— 用来模拟「另一进程在本进程失败返回之前已成功提交新值」
 */
function transactionalStore({ initial = {}, failAt = [], beforeFail = null } = {}) {
  let memory = { ...initial }
  let calls = 0
  const failing = new Set(failAt)
  return {
    get: (key) => (key in memory ? memory[key] : undefined),
    keys: (prefix = '') => Object.keys(memory).filter((key) => key.startsWith(prefix)),
    transact(mutator) {
      calls += 1
      if (failing.has(calls)) {
        // 本次写失败：不发布 draft。失败前允许交错写入，模拟并发窗口。
        if (typeof beforeFail === 'function') beforeFail()
        return { ok: false, committed: false, durable: false, code: 'STATE_BUSY' }
      }
      const draft = JSON.parse(JSON.stringify(memory))
      const value = mutator(draft)
      memory = draft
      return { ok: true, committed: true, durable: true, value }
    },
    /** 直接改内存，扮演「另一个进程成功提交」 */
    commitExternally(key, value) { memory = { ...memory, [key]: value } },
    snapshot: () => JSON.parse(JSON.stringify(memory)),
  }
}

function rig(store) {
  const source = createOutboundSource([{ type: 'bark', config: { key: 'old' } }])
  const config = createOutboundConfigService({ store, yamlRows: new Map(), source, adminEnabled: false })
  return { config, source }
}

const captureThrow = (fn) => {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

test('R1：save 提交失败后不得回滚旧值——并发已提交的新值必须存活', () => {
  const store = transactionalStore({
    initial: { [CANONICAL_BARK]: { key: 'v1' } },
    failAt: [1],
    // 交错：本进程宣告失败之前，另一进程已成功提交 v3
    beforeFail: () => store.commitExternally(CANONICAL_BARK, { key: 'v3' }),
  })
  const { config, source } = rig(store)

  const error = captureThrow(() => config.save('bark', { key: 'v2' }))

  assert.ok(error !== null, '提交失败必须抛错')
  assert.equal(error.code, 'storage-failed')
  assert.deepEqual(
    store.snapshot()[CANONICAL_BARK],
    { key: 'v3' },
    '提交失败不得写回 v1 —— 否则并发窗口里 B 的 v3 会被 A 的回滚抹掉（lost update）',
  )
  assert.equal(source.get('bark').config.key, 'old', '持久化失败不得替换运行时 source')
})

test('R1：remove 提交失败后不得恢复旧值——并发已提交的新值必须存活', () => {
  const store = transactionalStore({
    initial: { [CANONICAL_BARK]: { key: 'v1' } },
    failAt: [1],
    beforeFail: () => store.commitExternally(CANONICAL_BARK, { key: 'v3' }),
  })
  const { config, source } = rig(store)

  const error = captureThrow(() => config.remove('bark'))

  assert.ok(error !== null, '删除未落盘必须抛错')
  assert.equal(error.code, 'storage-failed')
  assert.deepEqual(
    store.snapshot()[CANONICAL_BARK],
    { key: 'v3' },
    '删除失败不得恢复 existing —— 否则会覆盖并发提交的新值',
  )
  assert.equal(source.has('bark'), true, '删除失败不得移除运行时 source')
})

test('R1：事务 store 成功路径不受影响（提交成功即发布并热替换）', () => {
  const store = transactionalStore({ initial: { [CANONICAL_BARK]: { key: 'v1' } } })
  const { config, source } = rig(store)

  const result = config.save('bark', { key: 'v2' })

  assert.equal(result.saved, true)
  assert.equal(result.applied, true)
  assert.deepEqual(store.snapshot()[CANONICAL_BARK], { key: 'v2' })
  // live source 持有的是 adapter.resolve 之后的运行态配置（bark 归一化为 endpoint），
  // 不是原始 patch；这里断言热替换确实换成了 v2 对应的 endpoint。
  assert.equal(source.get('bark').config.endpoint, 'https://api.day.app/v2')
})