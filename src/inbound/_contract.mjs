// dsh-notifier inbound/_contract.mjs
// 入站通道公共契约（v0.3.0 阶段 0）：让 approval router / conversation router
// 不感知具体通道——所有 inbound 实例经 normalizeInbound() 归一为同一形状。
// telegram 是 v0.2.0 旧形状（notifyChatIds + editResolved(chatId, messageId, text)），
// 在这里做旧→新适配，telegram-bot.mjs 零改动（只加不动）。
//
// 新通道直接按统一契约实现（无需适配）：
//   {
//     channel: 'feishu' | 'qq' | 'wxpusher' | 'wechat',
//     start(),                                            // 幂等
//     async stop(),
//     notifyTargets() -> [{ chatId, userId }],            // 审批卡推送目标
//     async sendApprovalCard({ chatId, title, content, approvalKey, token })
//       -> { messageId } | null,                          // 失败 null，caller 降级纯通知
//     async editResolved(target, text),                   // target = 账本 pushedTo 行
//     async sendText(chatId, text) -> boolean,            // 命令回执
//   }
// 入站方向统一走 bus.accept(envelope)；按钮回调统一走 bus.decide({ approvalKey,
// decision, token, via, userId })，回调负载格式用本文件的 buildApprovalAction 生成、
// parseApprovalAction 解析（与 telegram callback_data 完全同构，复用同一套 token 核销）。

export const APPROVAL_ACTION_PREFIX = 'ap'

/** 组装按钮回调负载：ap:<decision>:<approvalKey>:<token>。 */
export function buildApprovalAction(decision, approvalKey, token) {
  return `${APPROVAL_ACTION_PREFIX}:${decision}:${approvalKey}:${token}`
}

/**
 * 解析按钮回调负载。
 * approvalKey 自身含冒号（ap:<callId>:<n>）：decision 取第二段、token 取末段、
 * 中间全部归 key（slice+join 重组），不能按固定长度切。格式不符返回 null。
 * @returns {{ decision: string, approvalKey: string, token: string } | null}
 */
export function parseApprovalAction(data) {
  const parts = String(data ?? '').split(':')
  if (parts[0] !== APPROVAL_ACTION_PREFIX || parts.length < 4) return null
  return {
    decision: parts[1],
    approvalKey: parts.slice(2, -1).join(':'),
    token: parts[parts.length - 1],
  }
}

// ---- v0.5 动作闭环（通知按钮 → 处置动作）----
// 与审批按钮完全同构的负载协议：ac:<actionKey>:<token>。actionKey 自身含冒号
// （act:<kind>:<rand>），解析时首段判 ac、末段取 token、中间全部归 key。

export const ACTION_PAYLOAD_PREFIX = 'ac'

/** 组装动作按钮负载：ac:<actionKey>:<token>。 */
export function buildActionPayload(actionKey, token) {
  return `${ACTION_PAYLOAD_PREFIX}:${actionKey}:${token}`
}

/**
 * 解析动作按钮负载（与 parseApprovalAction 同构）。格式不符返回 null。
 * @returns {{ actionKey: string, token: string } | null}
 */
export function parseActionPayload(data) {
  const parts = String(data ?? '').split(':')
  if (parts[0] !== ACTION_PAYLOAD_PREFIX || parts.length < 3) return null
  return {
    actionKey: parts.slice(1, -1).join(':'),
    token: parts[parts.length - 1],
  }
}

/**
 * 把任意 inbound 实例归一为统一契约。
 * 判定规则（确定性，不做 arity 探测）：有 notifyTargets = 新契约；只有 notifyChatIds =
 * telegram 旧契约。两个形状都保证：sendApprovalCard 异常归一为 null、editTarget /
 * sendText 异常吞掉（回执尽力而为，绝不向上抛）。
 * capabilities.buttons（默认 true）：该通道审批卡片是否带可点按钮。无按钮通道
 * （如 QQ 官方机器人）靠「回复 1 批准 / 2 拒绝」降级，广播文案据此区分。
 * @param {object} raw - inbound 实例（新旧契约均可）
 * @param {string} [fallbackChannel] - 实例未自带 channel 字段时的兜底名
 * @returns {null | {
 *   channel: string, raw: object, capabilities: { buttons: boolean },
 *   notifyTargets(): {chatId: string, userId: string}[],
 *   sendApprovalCard(payload): Promise<{messageId}|null>,
 *   sendActionCard(payload): Promise<{messageId}|null>,
 *   editTarget(target, text): Promise<void>,
 *   sendText(chatId, text): Promise<boolean>,
 * }}
 */
export function normalizeInbound(raw, fallbackChannel = '') {
  if (raw === null || raw === undefined) return null
  const legacy = typeof raw.notifyTargets !== 'function' && typeof raw.notifyChatIds === 'function'
  const channel = typeof raw.channel === 'string' && raw.channel !== ''
    ? raw.channel
    : (legacy ? 'telegram' : fallbackChannel)
  const buttons = raw.capabilities?.buttons !== false
  return {
    channel,
    raw,
    capabilities: { buttons },
    notifyTargets() {
      // 异常归一 []（R5 审查 R5-3-P2-2：sendApprovalCard/editTarget/sendText 都有守护，
      // 唯独 notifyTargets 裸调——某通道解析抛错会沿防抖/宽限窗定时器冒成 uncaught
      // exception，「绝不弄崩宿主」军规被打破）。失败即零目标：宁可不发不崩宿主。
      try {
        if (typeof raw.notifyTargets === 'function') {
          return raw.notifyTargets()
            .map((t) => ({ chatId: String(t.chatId), userId: String(t.userId ?? t.chatId) }))
        }
        if (legacy) {
          return raw.notifyChatIds().map((id) => ({ chatId: String(id), userId: String(id) }))
        }
        return []
      } catch {
        return []
      }
    },
    async sendApprovalCard(payload) {
      if (typeof raw.sendApprovalCard !== 'function') return null
      try {
        return await raw.sendApprovalCard(payload)
      } catch {
        return null // caller 降级为纯通知
      }
    },
    // v0.5 动作卡片（可选方法）：未实现的通道实例（含全部旧形状）恒 null，
    // caller 降级为通知文本里的命令 hint（「回复 /stop 取消」）——全通道兜底。
    async sendActionCard(payload) {
      if (typeof raw.sendActionCard !== 'function') return null
      try {
        return await raw.sendActionCard(payload)
      } catch {
        return null // caller 降级为纯通知
      }
    },
    async editTarget(target, text) {
      try {
        if (typeof raw.editResolved !== 'function') return
        if (legacy) await raw.editResolved(target.chatId, target.messageId, text)
        else await raw.editResolved(target, text)
      } catch { /* 回执尽力而为，绝不向上抛 */ }
    },
    async sendText(chatId, text) {
      if (typeof raw.sendText !== 'function') return false
      try {
        return (await raw.sendText(chatId, text)) !== false
      } catch {
        return false
      }
    },
  }
}
