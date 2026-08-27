// v0.8.7 测试：inbound/store 持久化成功/失败的显式传播（对抗评审 Stage-4 P1-2）。
// createStore.set 现在把「写是否真正落盘」作为布尔返回：可写路径返回 true，
// 落盘失败（父路径被常规文件占用，写必然失败）返回 false 而非被静默吞掉——
// 调用方（agent-router.safeSet → admin PATCH control）据此才能把写失败报成 500。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/inbound/store.mjs'

test('set：可写路径持久化成功返回 true，同路径新 store 重启读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-ok-'))
  const file = join(dir, 'state.json')
  const store = createStore(file)
  assert.equal(store.set('k', { v: 1 }), true)
  assert.deepEqual(store.get('k'), { v: 1 })
  // 重启：同一文件路径新建 store，读到上次落盘内容（值语义，非仅内存）
  const reloaded = createStore(file)
  assert.deepEqual(reloaded.get('k'), { v: 1 })
})

test('set：父路径被常规文件占用 → 落盘失败返回 false（不抛、不静默吞、不谎报成功）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-fail-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'i am a regular file')
  const store = createStore(join(blocker, 'state.json')) // 父级是普通文件 → 落盘必然失败
  // 失败显式传播：false 让上层（router.safeSet → admin 500）能把写失败与成功区分开，
  // 而不是「重启即丢」还被当作 200。
  assert.equal(store.set('k', { v: 1 }), false)
})