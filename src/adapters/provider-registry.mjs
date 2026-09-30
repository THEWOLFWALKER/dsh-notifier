// dsh-notifier adapters/provider-registry.mjs
// v0.15（T11）：**出站 provider 契约矩阵**——28 个出站渠道的单一分类事实来源。
//
// T09/T10 只把 Bark/Webhook（stateless）与 QQ/企业微信应用（stateful）两个试点接进 sender 契约。
// T11 把**全部已登记 provider** 逐个标注再迁入，本模块就是那张表：
//
//   lifecycle  stateless | stateful
//              stateless = 每次调用自持输入，无跨调用运行时资源；
//              stateful  = 持有跨调用资源（token 管理器 / 限速门 / 消息序号 / 连接），
//                          必须走显式 runtime（createRuntime/start/stop/retire + epoch）。
//   owned      「owned resource」：该 provider **确实持有**的运行时资源名。stateless 渠道的资源
//              一律是**有界 per-resolved memo**（探测结果/一次性提示位），不是外部句柄——
//              没有 socket / timer / 凭证缓存可供 retire，故**不伪造** createRuntime。
//   interaction 该渠道是否接入了按钮/卡片交互（审批 / 提问 / 动作卡）。仅当对应入站通道
//              在 capability-matrix 里 buttons=true 才为真；这里显式列出，由测试与矩阵交叉锁死。
//
// 设计约束（T11 边界）：
//   - **不改协议**：本表只描述，不参与 payload/校验/超时任何一条真实链路；
//   - **fail-closed**：未知 provider 返回 null，调用方继续走旧 `adapter.send`（绝不猜生命周期）；
//   - **单一事实来源**：lifecycle 与 sender 注册表必须一致（测试断言），不得两处各写一份。
//
// ⚠️ 本表是**出站** provider 分类。入站六通道的能力（buttons/imageInbound/连接类型）在
//    `src/inbound/capability-matrix.mjs`，两者互不覆盖（T11 只碰出站，入站 negative 原样保留）。

import { SENDER_LIFECYCLE } from './sender.mjs'
import { senderOf } from './senders.mjs'

/** lifecycle 词汇复用 sender 契约（stateless/stateful 同义）。 */
export const PROVIDER_LIFECYCLE = SENDER_LIFECYCLE

/**
 * 每个出站 provider 的契约画像。
 *
 * `resources` 为空数组 = 无任何跨调用状态。带值的 stateless 渠道只持有**有界 memo**
 * （单次探测/单次提示，随 resolved 回收，无需生命周期动词）。
 */
export const PROVIDER_PROFILES = Object.freeze({
  // ————————————————— stateful：持有跨调用运行时资源 —————————————————
  'qq-bot': Object.freeze({
    lifecycle: PROVIDER_LIFECYCLE.STATEFUL,
    resources: Object.freeze(['token-manager', 'rate-gate', 'msg-seq']),
    interaction: true,
    note: '租户 token single-flight 缓存 + 平台限速门 + msg_seq 幂等序号（P01/P02）',
  }),
  'wecom-app': Object.freeze({
    lifecycle: PROVIDER_LIFECYCLE.STATEFUL,
    resources: Object.freeze(['token-manager']),
    interaction: false,
    note: 'corp access_token single-flight 缓存',
  }),

  // ————————————————— stateless：无跨调用资源（含少量有界 memo）—————————————————
  telegram: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: true },
  feishu: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: true },
  dingtalk: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  wxpusher: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  pushplus: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  serverchan: {
    lifecycle: PROVIDER_LIFECYCLE.STATELESS,
    // 一次性别名冲突提示位（发出后置 null）：有界、无外部句柄。
    resources: ['alias-notice-once'],
    interaction: false,
  },
  bark: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  webhook: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  bell: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  desktop: {
    lifecycle: PROVIDER_LIFECYCLE.STATELESS,
    // Windows BurntToast 探测结果缓存于 resolved（插件生命周期内一次）：有界 memo，非句柄。
    resources: ['win-probe-memo'],
    interaction: false,
  },

  // ————————————————— 声明表渠道（spec engine 产出，全部无状态）—————————————————
  slack: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  discord: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  wecom: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  mattermost: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  gchat: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  teams: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  ntfy: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  gotify: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  pushover: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  chanify: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  pushdeer: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  xizhi: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  qmsg: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  igot: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  onebot: { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
  'wps-bot': { lifecycle: PROVIDER_LIFECYCLE.STATELESS, resources: [], interaction: false },
})

/** 支持按钮/卡片交互的出站 provider（与 capability-matrix.buttons=true 的入站通道一致）。 */
export const INTERACTIVE_PROVIDERS = Object.freeze(['telegram', 'feishu', 'qq-bot'])

/** 全部已分类的出站 provider 类型（顺序按表定义，稳定）。 */
export function providerTypes() {
  return Object.keys(PROVIDER_PROFILES)
}

/**
 * 取某 provider 的契约画像。未知类型返回 null（fail-closed：调用方回落旧 adapter 路径，不猜）。
 * @param {string} type
 * @returns {{ type: string, lifecycle: string, resources: readonly string[], interaction: boolean, note?: string } | null}
 */
export function providerProfile(type) {
  const key = typeof type === 'string' ? type.trim() : ''
  const profile = Object.prototype.hasOwnProperty.call(PROVIDER_PROFILES, key)
    ? PROVIDER_PROFILES[key]
    : undefined
  if (profile === undefined) return null
  return Object.freeze({
    type: key,
    lifecycle: profile.lifecycle,
    resources: profile.resources,
    interaction: profile.interaction === true,
    ...(profile.note !== undefined ? { note: profile.note } : {}),
  })
}

/**
 * 契约自检：分类表与 sender 注册表是否一致。返回不一致项（空数组 = 一致）。
 * 单一事实来源原则——lifecycle 不得两处各写一份；已分类 provider 必须有对应 sender。
 * @returns {string[]} 人类可读的不一致描述
 */
export function providerRegistryDrift() {
  const drift = []
  for (const type of providerTypes()) {
    const sender = senderOf(type)
    if (sender === null) {
      drift.push(`${type}: 已分类但未登记 sender`)
      continue
    }
    const declared = PROVIDER_PROFILES[type].lifecycle
    if (sender.lifecycle !== declared) {
      drift.push(`${type}: 分类 ${declared} 与 sender ${sender.lifecycle} 不一致`)
    }
    const interactive = INTERACTIVE_PROVIDERS.includes(type)
    if (interactive !== (PROVIDER_PROFILES[type].interaction === true)) {
      drift.push(`${type}: interaction 标记与 INTERACTIVE_PROVIDERS 不一致`)
    }
  }
  return drift
}