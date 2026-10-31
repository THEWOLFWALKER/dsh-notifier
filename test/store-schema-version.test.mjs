// T03：新版数据 namespace 与 schema 版本合同。
//
// 目标（CONTRACTS.md §身份与数据版本 / ACCEPTANCE T03）：
//  1. 未知/缺失 schema 版本的状态**不作为**身份/待决/配对/选择权威（读侧 fail-closed）；
//  2. 原文件**不被删除**（新 namespace 的首次显式写会先取证 .bak 再落盘）；
//  3. 新 namespace 与旧文件的键**隔离**（旧权威键不被并入新文件）；
//  4. 版本门下事务**原子**——失败不发布新内存态、不动盘上文件。
//
// 这些用例锁定 store.mjs 的 schema 门；它们不实现 T05/T06 的 bind/taskselect/offset 作用域。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, STORE_SCHEMA_VERSION, STORE_SCHEMA_NAMESPACE, SCHEMA_KEY } from '../src/inbound/store.mjs'

const tempStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-t03-schema-'))
  return { dir, path: join(dir, 'state.json') }
}

// 一份「旧宿主期」state：合法对象、无 __schema 标记，且带足量权威键。
const LEGACY_STATE = {
  'inbound:bindings': { 'telegram:42': { channel: 'telegram', userId: '42', role: 'owner', origin: 'paired' } },
  'inbound:pending': { 'telegram:43': { channel: 'telegram', userId: '43', origin: 'learned', at: 1 } },
  'route:sessions': { 'telegram:42': { agentId: 'a1' } },
  'bind:telegram:42': { agentId: 'a1' },
  'taskselect:telegram:42:chat': { agentId: 'a1' },
  'admin:token-hash': 'deadbeef',
  'channel:webhook:outbound': { url: 'http://old.example/hook' },
  'dedup:telegram:1': 123,
}

test('T03: 缺失/未知 schema 版本 → 不作为权威（读侧 fail-closed + re-pair 信号）', () => {
  const { dir, path } = tempStore()
  writeFileSync(path, JSON.stringify(LEGACY_STATE))
  const store = createStore(path)

  // 信号：legacy + 明确要求重新配置/配对。
  const ms = store.migrationStatus()
  assert.equal(ms.legacy, true)
  assert.equal(ms.reason, 'legacy-schema-unknown')
  assert.equal(ms.action, 'reconfigure-or-repair')
  assert.equal(ms.bootSchemaVersion, null)
  assert.equal(ms.expectedVersion, STORE_SCHEMA_VERSION)

  // 权威键读侧 fail-closed：拿不到旧绑定/待决/凭证/游标。
  assert.deepEqual(store.get('inbound:bindings', {}), {})
  assert.equal(store.get('admin:token-hash', null), null)
  assert.equal(store.get('channel:webhook:outbound', null), null)
  assert.deepEqual(store.keys('inbound:'), [])
  assert.deepEqual(store.keys('route:'), [])
  assert.equal(store.keys('bind:').length, 0)

  // bootStatus 未被旧 schema 污染成 corrupt（它只是版本不符，不是损坏）。
  assert.equal(store.bootStatus().status, 'ready')

  // 未知版本（有标记但版本不同）同样不加载为权威。
  writeFileSync(path, JSON.stringify({ [SCHEMA_KEY]: { version: 999, namespace: STORE_SCHEMA_NAMESPACE }, ...LEGACY_STATE }))
  const store2 = createStore(path)
  assert.equal(store2.migrationStatus().legacy, true)
  assert.equal(store2.migrationStatus().bootSchemaVersion, 999)
  assert.deepEqual(store2.get('inbound:bindings', {}), {})
})

test('T03: 原文件不被删除；首次显式写先取证 .bak 再建立新 namespace', () => {
  const { path } = tempStore()
  const legacyText = JSON.stringify(LEGACY_STATE)
  writeFileSync(path, legacyText)
  const store = createStore(path)

  // 只读不写：盘上文件逐字节不变（未被删除、未被改写）。
  void store.get('inbound:bindings', {})
  void store.keys('')
  assert.equal(existsSync(path), true)
  assert.equal(readFileSync(path, 'utf8'), legacyText, '读路径绝不改写原文件')

  // 首次显式写：取证 .bak 副本 + 写新 namespace。
  const result = store.transact((draft) => { draft['admin:token-hash'] = 'newhash'; return true })
  assert.equal(result.committed, true)

  // 原文件内容保留在 .bak 取证副本里（绝不删除）。
  const dir = join(path, '..')
  const backups = readdirSync(dir).filter((name) => name.startsWith('state.json.pre-v0.14-legacy.'))
  assert.ok(backups.length >= 1, '期望存在 .bak 取证副本')
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), legacyText)
})

test('T03: 新 namespace 与旧文件的键隔离（不并入旧权威键）', () => {
  const { path } = tempStore()
  writeFileSync(path, JSON.stringify(LEGACY_STATE))
  const store = createStore(path)

  // 首次显式写建立新 namespace。
  const result = store.transact((draft) => { draft['admin:token-hash'] = 'newhash'; return true })
  assert.equal(result.committed, true)

  const written = JSON.parse(readFileSync(path, 'utf8'))
  // 新文件带当前 schema 标记。
  assert.deepEqual(written[SCHEMA_KEY], { version: STORE_SCHEMA_VERSION, namespace: STORE_SCHEMA_NAMESPACE })
  // 写入的键在。
  assert.equal(written['admin:token-hash'], 'newhash')
  // 旧权威键**没有**被并入新文件。
  assert.equal('inbound:bindings' in written, false)
  assert.equal('inbound:pending' in written, false)
  assert.equal('route:sessions' in written, false)
  assert.equal('bind:telegram:42' in written, false)
  assert.equal('channel:webhook:outbound' in written, false)

  // 升级后 legacy 信号清除。
  assert.equal(store.migrationStatus().legacy, false)
  // 重新读盘：新实例看到新 namespace。
  const reopened = createStore(path)
  assert.equal(reopened.migrationStatus().legacy, false)
  assert.equal(reopened.get('admin:token-hash'), 'newhash')
})

test('T03: 版本门下的原子性——失败不发布新内存态、不动盘上文件', () => {
  const { path } = tempStore()
  const legacyText = JSON.stringify(LEGACY_STATE)
  writeFileSync(path, legacyText)
  const store = createStore(path)

  // mutator 抛错：事务失败，内存与磁盘均保持原样（legacy 仍为 true，原文件未改）。
  const failed = store.transact(() => { throw new Error('boom') })
  assert.equal(failed.committed, false)
  assert.equal(failed.ok, false)
  assert.equal(store.migrationStatus().legacy, true, '失败后不得清除 legacy 标志')
  assert.equal(readFileSync(path, 'utf8'), legacyText, '失败后原文件逐字节不变')
  // 内存态没有新键被发布。
  assert.equal(store.get('admin:token-hash', null), null)

  // 成功后才是唯一提交点。
  const okResult = store.transact((draft) => { draft['admin:token-hash'] = 'committed'; return true })
  assert.equal(okResult.committed, true)
  assert.equal(store.get('admin:token-hash'), 'committed')
})
