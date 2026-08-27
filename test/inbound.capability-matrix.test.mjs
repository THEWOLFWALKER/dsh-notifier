// test/inbound.capability-matrix.test.mjs
// 入站能力矩阵测试：确保矩阵与实际代码一致、别名正确、fail-closed 默认值正确。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  INBOUND_CHANNELS,
  OUTBOUND_TO_INBOUND_ALIAS,
  inboundToOutboundType,
  isCoveredByOutbound,
  DISPLAY_NAMES_ZH,
  DISPLAY_NAMES_EN,
  displayNameOf,
  CONNECTION_TYPES,
  capabilitiesOf,
  channelsWith,
  OUTBOUND_CHANNELS,
  hasInbound,
} from '../src/inbound/capability-matrix.mjs'
import { CHANNEL_TYPES } from '../src/config.mjs'
import { INBOUND_CHANNELS as API_INBOUND_CHANNELS } from '../src/admin/api.mjs'
import { collectContractFactories } from './_helpers.mjs'
import { normalizeInbound } from '../src/inbound/_contract.mjs'

describe('capability-matrix: 入站通道全集', () => {
  it('与 admin/api.mjs INBOUND_CHANNELS 顺序和内容完全一致', () => {
    assert.deepEqual([...INBOUND_CHANNELS], [...API_INBOUND_CHANNELS])
  })

  it('六通道全集：telegram / feishu / qq / wxpusher / wechat / dingtalk', () => {
    assert.equal(INBOUND_CHANNELS.length, 6)
    assert.deepEqual([...INBOUND_CHANNELS].sort(),
      ['dingtalk', 'feishu', 'qq', 'telegram', 'wechat', 'wxpusher'])
  })
})

describe('capability-matrix: 出站→入站别名', () => {
  it('qq-bot → qq 是核心别名对', () => {
    assert.equal(OUTBOUND_TO_INBOUND_ALIAS['qq-bot'], 'qq')
  })

  it('同名通道也在别名表中（矩阵完整性）', () => {
    assert.equal(OUTBOUND_TO_INBOUND_ALIAS.feishu, 'feishu')
    assert.equal(OUTBOUND_TO_INBOUND_ALIAS.telegram, 'telegram')
    assert.equal(OUTBOUND_TO_INBOUND_ALIAS.wxpusher, 'wxpusher')
    assert.equal(OUTBOUND_TO_INBOUND_ALIAS.dingtalk, 'dingtalk')
  })

  it('inboundToOutboundType 正向反向一致', () => {
    assert.equal(inboundToOutboundType('qq'), 'qq-bot')
    assert.equal(inboundToOutboundType('feishu'), 'feishu')
    assert.equal(inboundToOutboundType('telegram'), 'telegram')
    assert.equal(inboundToOutboundType('wxpusher'), 'wxpusher')
    assert.equal(inboundToOutboundType('dingtalk'), 'dingtalk')
  })

  it('wechat 无对应出站 adapter → 返回 null', () => {
    assert.equal(inboundToOutboundType('wechat'), null)
  })

  it('未知入站名 → null', () => {
    assert.equal(inboundToOutboundType('slack'), null)
    assert.equal(inboundToOutboundType(''), null)
    assert.equal(inboundToOutboundType(undefined), null)
  })
})

describe('capability-matrix: isCoveredByOutbound（编号回复双发去重）', () => {
  it('同名通道直接覆盖', () => {
    assert.equal(isCoveredByOutbound('feishu', ['feishu']), true)
    assert.equal(isCoveredByOutbound('telegram', ['telegram']), true)
  })

  it('qq-bot 出站覆盖 qq 入站（issue #11 修复核心）', () => {
    assert.equal(isCoveredByOutbound('qq', ['qq-bot']), true)
  })

  it('未覆盖返回 false', () => {
    assert.equal(isCoveredByOutbound('qq', ['feishu']), false)
    assert.equal(isCoveredByOutbound('wechat', ['qq-bot']), false)
  })

  it('空数组 / 非数组 → false', () => {
    assert.equal(isCoveredByOutbound('feishu', []), false)
    assert.equal(isCoveredByOutbound('feishu', null), false)
  })
})

describe('capability-matrix: 展示名', () => {
  it('中文展示名齐全', () => {
    for (const ch of INBOUND_CHANNELS) {
      assert.equal(typeof DISPLAY_NAMES_ZH[ch], 'string', `${ch} 应有中文展示名`)
      assert.ok(DISPLAY_NAMES_ZH[ch].length > 0, `${ch} 展示名非空`)
    }
  })

  it('英文展示名齐全', () => {
    for (const ch of INBOUND_CHANNELS) {
      assert.equal(typeof DISPLAY_NAMES_EN[ch], 'string', `${ch} 应有英文展示名`)
      assert.ok(DISPLAY_NAMES_EN[ch].length > 0, `${ch} 英文名非空`)
    }
  })

  it('displayNameOf 默认中文', () => {
    assert.equal(displayNameOf('feishu'), '飞书')
    assert.equal(displayNameOf('feishu', 'zh'), '飞书')
    assert.equal(displayNameOf('feishu', 'en'), 'Feishu')
  })

  it('未知渠道名原样返回（防御式，不抛）', () => {
    assert.equal(displayNameOf('unknown-channel'), 'unknown-channel')
    assert.equal(displayNameOf(''), '')
    assert.equal(displayNameOf(null), '') // null → 空串（fail-safe，绝不抛）
    assert.equal(displayNameOf(undefined), '')
  })
})

describe('capability-matrix: 连接类型', () => {
  it('每通道都有连接类型', () => {
    for (const ch of INBOUND_CHANNELS) {
      assert.ok(['ws', 'long-poll', 'callback'].includes(CONNECTION_TYPES[ch]),
        `${ch} 应有合法连接类型`)
    }
  })

  it('WS 组：feishu / qq / dingtalk', () => {
    assert.equal(CONNECTION_TYPES.feishu, 'ws')
    assert.equal(CONNECTION_TYPES.qq, 'ws')
    assert.equal(CONNECTION_TYPES.dingtalk, 'ws')
  })

  it('长轮询组：telegram / wechat', () => {
    assert.equal(CONNECTION_TYPES.telegram, 'long-poll')
    assert.equal(CONNECTION_TYPES.wechat, 'long-poll')
  })

  it('HTTP 回调组：wxpusher（需公网）', () => {
    assert.equal(CONNECTION_TYPES.wxpusher, 'callback')
  })
})

describe('capability-matrix: 能力表 fail-closed', () => {
  it('未知渠道所有能力为 false', () => {
    const caps = capabilitiesOf('non-existent-channel')
    assert.equal(caps.buttons, false)
    assert.equal(caps.approvalCard, false)
    assert.equal(caps.actionCard, false)
    assert.equal(caps.questionCard, false)
    assert.equal(caps.imageInbound, false)
    assert.equal(caps.fileInbound, false)
    assert.equal(caps.sourceChatCheck, false)
  })

  it('空值 / null / undefined → 全 false', () => {
    for (const val of ['', null, undefined]) {
      const caps = capabilitiesOf(val)
      assert.equal(caps.buttons, false, `${val} → buttons=false`)
    }
  })
})

describe('capability-matrix: 各通道能力符合已知事实', () => {
  it('telegram: 全按钮能力 + 来源校验', () => {
    const tg = capabilitiesOf('telegram')
    assert.equal(tg.buttons, true)
    assert.equal(tg.approvalCard, true)
    assert.equal(tg.actionCard, true)
    assert.equal(tg.questionCard, true)
    assert.equal(tg.sourceChatCheck, true)
  })

  it('feishu: 全按钮能力 + 来源校验', () => {
    const fs = capabilitiesOf('feishu')
    assert.equal(fs.buttons, true)
    assert.equal(fs.approvalCard, true)
    assert.equal(fs.actionCard, true)
    assert.equal(fs.questionCard, true)
    assert.equal(fs.sourceChatCheck, true)
  })

  it('qq: 单聊原生按钮/审批/提问 + 来源校验，图片入站为 contract-tested', () => {
    const qq = capabilitiesOf('qq')
    assert.equal(qq.buttons, true)
    assert.equal(qq.approvalCard, true)
    assert.equal(qq.actionCard, false)
    assert.equal(qq.questionCard, true)
    assert.equal(qq.imageInbound, true)
    assert.equal(qq.sourceChatCheck, true)
  })

  it('wxpusher / wechat / dingtalk: 无按钮能力；后两者图片入站为 contract-tested', () => {
    for (const ch of ['wxpusher', 'wechat', 'dingtalk']) {
      const caps = capabilitiesOf(ch)
      assert.equal(caps.buttons, false, `${ch} 无按钮`)
      assert.equal(caps.approvalCard, false, `${ch} 无审批卡`)
      assert.equal(caps.actionCard, false, `${ch} 无动作卡`)
      assert.equal(caps.questionCard, false, `${ch} 无提问卡`)
      assert.equal(caps.imageInbound, ch !== 'wxpusher', `${ch} 图片入站契约状态`)
    }
  })
})

describe('capability-matrix: channelsWith 能力查询', () => {
  it('buttons 能力通道 = telegram + feishu + qq', () => {
    const withButtons = channelsWith('buttons')
    assert.deepEqual([...withButtons].sort(), ['feishu', 'qq', 'telegram'])
  })

  it('questionCard 能力通道 = telegram + feishu + qq', () => {
    const withQ = channelsWith('questionCard')
    assert.deepEqual([...withQ].sort(), ['feishu', 'qq', 'telegram'])
  })

  it('approvalCard 能力通道 = telegram + feishu + qq', () => {
    assert.deepEqual([...channelsWith('approvalCard')].sort(), ['feishu', 'qq', 'telegram'])
  })

  it('未知能力名返回空数组（防御式）', () => {
    assert.deepEqual(channelsWith('nonexistent-cap'), [])
  })
})

describe('capability-matrix: registry 与实际 renderer 入口一致', () => {
  it('六个 inbound 的按钮声明与 normalized contract 以及 renderer 方法一致', () => {
    const factories = new Map(collectContractFactories().map((entry) => [entry.expectedChannel, entry]))
    for (const channel of INBOUND_CHANNELS) {
      const raw = factories.get(channel)?.raw()
      const normalized = normalizeInbound(raw)
      const caps = capabilitiesOf(channel)
      assert.ok(raw && normalized, `${channel} 应能构造并归一`)
      assert.equal(normalized.capabilities.buttons, caps.buttons, `${channel}: buttons 声明漂移`)
      if (caps.approvalCard) assert.equal(typeof raw.sendApprovalCard === 'function', true, `${channel}: native approval renderer 缺失`)
      if (caps.actionCard) assert.equal(typeof raw.sendActionCard === 'function', true, `${channel}: native action renderer 缺失`)
      if (caps.questionCard) assert.equal(typeof raw.sendQuestionCard === 'function', true, `${channel}: native question renderer 缺失`)
    }
  })
})

describe('capability-matrix: 出站通道全集与 hasInbound', () => {
  it('OUTBOUND_CHANNELS 数量 = 27（与 config.mjs CHANNEL_TYPES 一致）', () => {
    assert.equal(OUTBOUND_CHANNELS.length, 27)
    assert.equal(OUTBOUND_CHANNELS.length, CHANNEL_TYPES.length)
  })

  it('OUTBOUND_CHANNELS 内容与 CHANNEL_TYPES 完全一致（顺序可不同）', () => {
    const set1 = new Set(OUTBOUND_CHANNELS)
    const set2 = new Set(CHANNEL_TYPES)
    assert.deepEqual(set1, set2)
  })

  it('hasInbound: 双向通道正确识别', () => {
    assert.equal(hasInbound('qq-bot'), true)
    assert.equal(hasInbound('telegram'), true)
    assert.equal(hasInbound('feishu'), true)
    assert.equal(hasInbound('wxpusher'), true)
    assert.equal(hasInbound('dingtalk'), true)
  })

  it('hasInbound: 纯出站通道返回 false', () => {
    assert.equal(hasInbound('slack'), false)
    assert.equal(hasInbound('bark'), false)
    assert.equal(hasInbound('desktop'), false)
    assert.equal(hasInbound('webhook'), false)
  })
})
