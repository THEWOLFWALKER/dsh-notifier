// dsh-notifier inbound/channels-registry.mjs
// 入站渠道枚举的单一事实来源（G-13 / S-12 前置）。
//
// 背景：六通道清单在库里写了三遍——admin/api.mjs 的可变数组、capability-matrix.mjs 的
// 冻结数组、identity.mjs 的 Set。三处一旦漂移（比如新增渠道漏改一处），形状守卫的
// fail-open 会把漂移静默放大成「未知渠道放行」（S-12 的成因之一）。
//
// 军规：任何消费方不得再内联清单字面量，一律从这里引；新增渠道只改本文件。
// 冻结数组 + 冻结 Set 双形态导出（消费方按用法取用，避免各自 new Set）。

/** 六入站通道全集（冻结；顺序 = 管理台与能力矩阵的展示序）。 */
export const INBOUND_CHANNELS = Object.freeze([
  'telegram',
  'feishu',
  'qq',
  'wxpusher',
  'wechat',
  'dingtalk',
])

/** 同一清单的 Set 形态（冻结；has() 查询用）。 */
export const INBOUND_CHANNEL_SET = new Set(INBOUND_CHANNELS)
