// v0.7 测试：inbound/target-guard（三级目标解析 + 渠道形态守卫，计划书 §3.5）。
// 覆盖面：
//  - isValidTargetId 六渠道真形态放行/跨渠道串门拦截/未知渠道 fail-open
//  - guardTargets 保留/拦截/告警回调/空 chatId/非数组容错
//  - resolveNotifyTargets 三级优先矩阵：绑定成员 → 通道配置 → 全局回落（仅绑定表整体空）；
//    identity 未装配退 v0.6 旧行为；字符串/数字/对象三形态清单归一（含回归：字符串清单
//    曾被当对象读导致 chatId='' 全过滤，静默回落全局白名单——错发目标 P1）；
//    绑定表非空但该通道零绑定零配置 → []（宁可零发不跨渠道错发）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { isValidTargetId, guardTargets, resolveNotifyTargets } from '../src/inbound/target-guard.mjs'

// ---------------------------------------------------------------- isValidTargetId

test('isValidTargetId：六渠道真形态全部放行（R5 对账：TG 负群号 / wxpusher UID_ 前缀）', () => {
  assert.equal(isValidTargetId('telegram', '10086'), true)
  assert.equal(isValidTargetId('telegram', '123456789012345'), true)
  assert.equal(isValidTargetId('telegram', '-1001234567890'), true, 'TG 群/超级群 id 恒为负数（R5-1-P1-2：漏负号曾整体错杀群目标）')
  assert.equal(isValidTargetId('feishu', 'ou_3c2a4b5c'), true)
  assert.equal(isValidTargetId('feishu', 'oc_chat001'), true)
  assert.equal(isValidTargetId('feishu', 'on_union99'), true)
  assert.equal(isValidTargetId('qq', 'OPENID1234ABC'), true)
  assert.equal(isValidTargetId('qq', 'group-id_99'), true)
  assert.equal(isValidTargetId('wxpusher', 'UID_ABC123xyz'), true, 'WxPusher 真实 UID 带 UID_ 前缀（R5-3-P1-1：纯数字形态曾全灭订阅用户）')
  assert.equal(isValidTargetId('wxpusher', '12345'), true, '历史遗留纯数字 uid 一并放行')
  assert.equal(isValidTargetId('wechat', 'WX_USER_99'), true)
  assert.equal(isValidTargetId('dingtalk', 'staff.001.x'), true)
})

test('isValidTargetId：跨渠道串门形态拦截（TG 数字进飞书 / 飞书 ou_ 进 TG / 短串进 qq / un_ 非发送形态）', () => {
  assert.equal(isValidTargetId('feishu', '10086'), false, 'TG 数字 id 不是飞书形态')
  assert.equal(isValidTargetId('telegram', 'ou_3c2a4b5c'), false, '飞书前缀不是 TG 形态')
  assert.equal(isValidTargetId('qq', 'op1'), false, 'qq openid 最低 8 字符')
  assert.equal(isValidTargetId('feishu', 'un_union99'), false, 'un_ 不是 feishu 发送侧接受的 receiveIdType（R5-1-P3-6），放进必炸')
  assert.equal(isValidTargetId('feishu', 'oc1'), false, '飞书 id 必须带 ou_/oc_/on_ 前缀')
})

test('isValidTargetId：未知渠道/空值 fail-open + fail-closed（守卫不是白名单）', () => {
  assert.equal(isValidTargetId('bark', 'anything-goes'), true, '未知渠道放行：只排已知形态')
  assert.equal(isValidTargetId('', '10086'), true)
  assert.equal(isValidTargetId(null, 'x'), true)
  assert.equal(isValidTargetId('telegram', ''), false, '空串在任何已知渠道都不合格')
})

// ---------------------------------------------------------------- guardTargets

test('guardTargets：按渠道保留合格目标、拦截串门并回调告警（不中断）', () => {
  const warnings = []
  const { kept, skipped } = guardTargets('feishu', [
    { chatId: 'oc_chat001', userId: 'ou_user001' },
    { chatId: '10086' },        // TG 数字混进飞书 → 拦
    { chatId: '' },             // 空串 → 拦
    null,                       // 坏元素 → 拦（不抛）
    { chatId: 'ou_user002' },   // 合格
  ], (message) => warnings.push(message))
  assert.deepEqual(kept.map((target) => target.chatId), ['oc_chat001', 'ou_user002'])
  assert.equal(skipped.length, 3)
  assert.equal(warnings.length, 1, '空串/null 是坏数据静默拦；形态串门才告警')
  assert.match(warnings[0], /feishu 不接受 "10086"/)
})

test('guardTargets：无告警回调/非数组输入不抛（A listener never throws）', () => {
  assert.deepEqual(guardTargets('telegram', undefined), { kept: [], skipped: [] })
  assert.deepEqual(guardTargets('telegram', null, () => {}), { kept: [], skipped: [] })
  assert.deepEqual(guardTargets('telegram', 'not-an-array', () => {}), { kept: [], skipped: [] })
  // 告警回调自身抛错也不上抛
  const { kept } = guardTargets('feishu', [{ chatId: '10086' }], () => { throw new Error('logger dead') })
  assert.deepEqual(kept, [])
})

// ---------------------------------------------------------------- resolveNotifyTargets：元素归一

test('resolveNotifyTargets 回归：字符串清单直接可用（v0.7 首版字符串被当对象读全过滤）', () => {
  const targets = resolveNotifyTargets({
    identity: null,
    channel: 'feishu',
    configTargets: ['ou_a', 'ou_b'],
    fallbackTargets: ['ou_global'],
  })
  assert.deepEqual(targets, [
    { chatId: 'ou_a', userId: 'ou_a' },
    { chatId: 'ou_b', userId: 'ou_b' },
  ])
})

test('resolveNotifyTargets：数字清单（wxpusher uid）/对象清单/混合清单三形态归一', () => {
  assert.deepEqual(
    resolveNotifyTargets({ identity: null, channel: 'wxpusher', configTargets: [123, '456'] }),
    [{ chatId: '123', userId: '123' }, { chatId: '456', userId: '456' }],
  )
  assert.deepEqual(
    resolveNotifyTargets({ identity: null, channel: 'qq', configTargets: [{ chatId: 'opengrp01', userId: 'user01' }] }),
    [{ chatId: 'opengrp01', userId: 'user01' }],
  )
  assert.deepEqual(
    resolveNotifyTargets({ identity: null, channel: 'qq', configTargets: [{ userId: 'user01' }, '  ', null, undefined, ''] }),
    [], '对象缺 chatId / 空白串 / null 全部过滤',
  )
})

// ---------------------------------------------------------------- resolveNotifyTargets：三级优先矩阵

/** 最小 identity 桩：绑定表 + 空表语义可注入。 */
function fakeIdentity({ bindings = {}, throws = false } = {}) {
  return {
    list(channel = '') {
      if (throws) throw new Error('store read failed')
      const records = Object.values(bindings)
      return channel === '' ? records : records.filter((record) => record.channel === channel)
    },
    isEmpty() {
      if (throws) throw new Error('store read failed')
      return Object.keys(bindings).length === 0
    },
  }
}

test('一级：该通道有绑定成员 → 绑定接管用户目标；群目标（extras）无条件保留', () => {
  const identity = fakeIdentity({
    bindings: {
      'qq:user01': { channel: 'qq', userId: 'user01' },
      'feishu:ou_other': { channel: 'feishu', userId: 'ou_other' },
    },
  })
  const targets = resolveNotifyTargets({
    identity,
    channel: 'qq',
    configTargets: ['legacyuser'],
    fallbackTargets: ['globaluser'],
    extraTargets: ['opengrp01'],
  })
  assert.deepEqual(targets, [
    { chatId: 'user01', userId: 'user01' }, // 绑定成员压过配置清单
    { chatId: 'opengrp01', userId: 'opengrp01' }, // 群目标是渠道属性，不因绑定接管而消失
  ])
})

test('二级：该通道零绑定但配置清单非空 → 配置清单（v0.6 语义）；群目标并入去重', () => {
  const identity = fakeIdentity({
    bindings: { 'feishu:ou_other': { channel: 'feishu', userId: 'ou_other' } },
  })
  const targets = resolveNotifyTargets({
    identity,
    channel: 'qq', // 绑定表非空（有 feishu 成员）但 qq 通道无绑定
    configTargets: ['qquser1'],
    fallbackTargets: ['globaluser'],
    extraTargets: ['qquser1', 'opengrp02'], // 与配置重复的群目标去重
  })
  assert.deepEqual(targets, [
    { chatId: 'qquser1', userId: 'qquser1' },
    { chatId: 'opengrp02', userId: 'opengrp02' },
  ])
})

test('三级：绑定表整体为空且无配置 → 全局回落；绑定表非空但该通道零绑定零配置 → []（不回落）', () => {
  const empty = fakeIdentity({ bindings: {} })
  assert.deepEqual(
    resolveNotifyTargets({ identity: empty, channel: 'qq', fallbackTargets: ['globaluser'] }),
    [{ chatId: 'globaluser', userId: 'globaluser' }],
    '纯兼容模式：全实例无人绑定时保持 v0.6 回落',
  )
  const nonEmpty = fakeIdentity({
    bindings: { 'feishu:ou_other': { channel: 'feishu', userId: 'ou_other' } },
  })
  assert.deepEqual(
    resolveNotifyTargets({ identity: nonEmpty, channel: 'qq', fallbackTargets: ['globaluser'] }),
    [],
    '实例已有成员（在别的渠道）：qq 不回落全局白名单——跨渠道错发是 P1',
  )
})

test('identity 读失败降级：list 抛错按空绑定处理，isEmpty 抛错按空表处理（fail-open 读军规）', () => {
  const identity = fakeIdentity({ throws: true })
  const targets = resolveNotifyTargets({
    identity,
    channel: 'qq',
    configTargets: ['qquser1'],
    fallbackTargets: ['globaluser'],
  })
  assert.deepEqual(targets, [{ chatId: 'qquser1', userId: 'qquser1' }], '读失败 → 有配置走配置')
  const fallback = resolveNotifyTargets({ identity, channel: 'qq', fallbackTargets: ['globaluser'] })
  assert.deepEqual(fallback, [{ chatId: 'globaluser', userId: 'globaluser' }], '读失败且无配置 → 回落（放行优先于锁死）')
})

test('identity 未装配：v0.6 旧行为一分不变（配置 → 全局回落 → 空）', () => {
  assert.deepEqual(
    resolveNotifyTargets({ identity: null, channel: 'telegram', configTargets: ['10001'], fallbackTargets: ['20002'] }),
    [{ chatId: '10001', userId: '10001' }],
  )
  assert.deepEqual(
    resolveNotifyTargets({ identity: null, channel: 'telegram', fallbackTargets: ['20002'] }),
    [{ chatId: '20002', userId: '20002' }],
  )
  assert.deepEqual(resolveNotifyTargets({ identity: null, channel: 'telegram' }), [])
})

test('一级 + extras 重复去重：绑定成员与群目标同 chatId 只发一次', () => {
  const identity = fakeIdentity({
    bindings: { 'qq:opengrp01': { channel: 'qq', userId: 'opengrp01' } },
  })
  const targets = resolveNotifyTargets({
    identity,
    channel: 'qq',
    extraTargets: ['opengrp01', 'opengrp02'],
  })
  assert.deepEqual(targets, [
    { chatId: 'opengrp01', userId: 'opengrp01' },
    { chatId: 'opengrp02', userId: 'opengrp02' },
  ])
})
