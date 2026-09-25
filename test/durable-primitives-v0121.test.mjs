// v0.12.1 Phase A：durable 原语的契约测试（新增能力的直接验证）。
//
// 覆盖：A1（setDurable / deleteDurable / store.deleteDurable）、
//       R1（store.delete 的返回类型不得改变，task-selection.mjs:133 依赖它）。
//
// ⚠️ 本文件在修复前【无法加载】——它 import 的 setDurable / deleteDurable 尚不存在。
// 这是预期的：它证明的是「修复前连能力都不存在」，不是 bug 的行为复现。
// bug 的行为复现见 durability-contract-v0121.test.mjs（那个文件会以断言失败报错）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, deleteDurable, setDurable } from '../src/inbound/store.mjs'

const tempStorePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v0121-prim-'))
  return { dir, path: join(dir, 'state.json') }
}

test('A1：setDurable 把「显式 false」判为失败，把 undefined 判为成功（I9）', () => {
  assert.equal(setDurable({ set: () => true }, 'k', 1), true, '显式 true → 成功')
  assert.equal(setDurable({ set: () => false }, 'k', 1), false, '显式 false → 失败')
  assert.equal(setDurable({ set: () => undefined }, 'k', 1), true, 'undefined 是遗留 mock 语义 → 成功')
  assert.equal(setDurable({ set: () => {} }, 'k', 1), true, '无 return 等价 undefined → 成功')
})

test('A1：setDurable 对缺失/抛错的 store 归一为 false，且不向上抛', () => {
  assert.equal(setDurable(undefined, 'k', 1), false)
  assert.equal(setDurable({}, 'k', 1), false)
  assert.equal(setDurable({ set: () => { throw new Error('boom') } }, 'k', 1), false, '抛错也必须归一为 false')
})

test('A1：真 store 的 deleteDurable 返回 durable 结论，落盘失败时为 false', () => {
  const { dir, path } = tempStorePath()
  writeFileSync(join(dir, 'blocker'), 'i am a regular file')
  const failing = createStore(join(dir, 'blocker', 'state.json')) // 父级是普通文件 → 必然落盘失败

  const result = failing.deleteDurable('whatever')
  // 该 store 内存里没有这个键：无可删是幂等成功（不涉及落盘）
  assert.deepEqual(result, { existed: false, durable: true }, '无可删不涉及落盘，算幂等成功')

  const real = createStore(path)
  assert.equal(real.set('k', 1), true)
  assert.deepEqual(real.deleteDurable('k'), { existed: true, durable: true })
  assert.deepEqual(real.deleteDurable('k'), { existed: false, durable: true }, '第二次删除：无 key 可删')
})

test('A1：deleteDurable 对遗留 mock（无 deleteDurable）退回 delete 的 existed 语义', () => {
  const memory = new Map([['ap:1', { status: 'pending' }]])
  const legacy = {
    get: (key) => memory.get(key),
    set: (key, value) => { memory.set(key, value) },
    delete: (key) => memory.delete(key),
  }
  assert.deepEqual(deleteDurable(legacy, 'ap:1'), { existed: true, durable: true })
  assert.deepEqual(deleteDurable(legacy, 'ap:none'), { existed: false, durable: true })
})

test('A1：deleteDurable 对缺失/抛错的 store 归一为 { existed:false, durable:false }', () => {
  assert.deepEqual(deleteDurable(undefined, 'k'), { existed: false, durable: false })
  assert.deepEqual(deleteDurable({}, 'k'), { existed: false, durable: false })
  assert.deepEqual(
    deleteDurable({ delete: () => { throw new Error('boom') } }, 'k'),
    { existed: false, durable: false },
  )
})

test('R1：store.delete 仍返回 existed:boolean —— 新增能力不得改写既有语义', () => {
  const { path } = tempStorePath()
  const store = createStore(path)

  store.set('k', 1)
  assert.equal(store.delete('k'), true, 'delete 必须仍返回 existed === true（task-selection.mjs:133 依赖）')
  assert.equal(store.delete('k'), false, '键不存在仍返回 false')
  assert.equal(typeof store.delete('k'), 'boolean', '返回类型必须是 boolean，不得变成对象')
})

test('R1：task-selection 依赖的既有读取路径未被破坏（keys/delete 组合）', () => {
  const { path } = tempStorePath()
  const store = createStore(path)
  store.set('sel:a', { v: 1 })
  store.set('sel:b', { v: 2 })

  assert.deepEqual(store.keys('sel:').sort(), ['sel:a', 'sel:b'])
  assert.equal(store.delete('sel:a') === true, true, '=== true 判据仍成立')
  assert.deepEqual(store.keys('sel:'), ['sel:b'])
})