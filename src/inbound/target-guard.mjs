// dsh-notifier v0.7 inbound/target-guard.mjs
// 跨渠道目标守卫（v0.7 计划书 §3.5）：两道防线修审查 #5 的出站半边——
//   1. resolveNotifyTargets 三级优先：绑定成员 → 通道配置清单 → 全局回落（仅绑定表整体空）；
//   2. guardTargets 形状守卫：目标进发送前按渠道校验 id 形态，不匹配 warn + skip。
// 入站半边（准入）由 identity.allows(channel, userId) 复合键修复（bus.mjs）。
//
// 形状表只做「明显不属于该渠道」的排除（fail-open）。R5 审查教训：形态表必须与
// 真实平台 id 对账，不能按文档想象编码——首版三处全错（TG 漏负群号、wxpusher 漏
// UID_ 前缀、feishu 多放 un_），测试还按同一想象书写把错误锁成"绿测"：
//   - telegram：user/chat id 恒为数字串；群/超级群/频道 id 恒为负数（-100…）——
//     notifyChatIds 里合法配置的群目标被无负号形态整体错杀（P1）。
//   - wxpusher：真实 UID 是 "UID_" 前缀（官方文档），纯数字形态把全部订阅用户错杀（P1）；
//     历史遗留的纯数字 uid 一并放行。
//   - feishu：open_id（ou_）/ chat_id（oc_）/ union_id（on_）；un_ 不是发送侧接受的
//     receiveIdType（feishu-bot receiveIdTypeOf 只认 oc_/on_），放进来必炸，剔除。
// qq/wechat/dingtalk 的官方 id 形态宽松（字母数字段），宁可放过不可错杀——
// 错杀真成员是 P1，放过一个跨渠道串门目标还有三级解析挡在前头。

/**
 * 各渠道 id 形态（null = 无已知形态，一律放行）。
 */
const CHANNEL_ID_PATTERNS = {
  telegram: /^-?\d{1,16}$/,
  feishu: /^(ou|oc|on)_[A-Za-z0-9]+$/,
  qq: /^[A-Za-z0-9_-]{8,64}$/,
  wxpusher: /^(UID_)?[A-Za-z0-9_-]{1,64}$/,
  wechat: /^[A-Za-z0-9_-]{4,64}$/,
  dingtalk: /^[A-Za-z0-9._-]{4,64}$/,
}

/** 渠道 id 形态是否可信（未知渠道 fail-open 放行——守卫不是白名单）。 */
export function isValidTargetId(channel, id) {
  const pattern = CHANNEL_ID_PATTERNS[String(channel ?? '')]
  if (pattern === undefined) return true
  return pattern.test(String(id ?? ''))
}

/**
 * 形状守卫：过滤掉形态不符的目标（发送前最后一道防线）。
 * @param {string} channel - 渠道键（telegram/feishu/qq/wxpusher/wechat/dingtalk）
 * @param {{ chatId: string, userId?: string }[]} targets - 待发送目标
 * @param {(message: string) => void} [warn] - 跳过时的告警回调（缺省静默）
 * @returns {{ kept: object[], skipped: object[] }}
 */
export function guardTargets(channel, targets, warn = null) {
  const list = Array.isArray(targets) ? targets : []
  const kept = []
  const skipped = []
  for (const target of list) {
    const chatId = String(target?.chatId ?? '')
    if (chatId === '') {
      skipped.push(target)
      continue
    }
    if (isValidTargetId(channel, chatId)) {
      kept.push(target)
      continue
    }
    skipped.push(target)
    if (warn !== null) {
      try { warn(`目标形状守卫拦截（${channel} 不接受 "${chatId.slice(0, 24)}"，已跳过）`) } catch { /* 告警失败不致命 */ }
    }
  }
  return { kept, skipped }
}

/**
 * 三级优先目标解析（v0.7 计划书 §3.5）：
 *   1. 该通道的绑定成员（identity.list(channel)——运行时可写，管理台增删半秒内生效）
 *   2. 该通道的既有配置清单（notifyUsers / notifyChatIds / notifyUids / feishu allowUsers）
 *   3. 全局 allowUsers 回落——仅当绑定表整体为空（纯兼容模式，不迁移用户行为零变化）
 * identity 为 null（未装配，如独立测试/旧装配）时退回旧行为：配置清单 → 全局回落。
 * @param {object} options
 * @param {object|null} options.identity - 身份绑定层实例（可空）
 * @param {string} options.channel - 渠道键
 * @param {object[]} [options.configTargets] - 通道配置清单（已是 {chatId,userId} 形态）
 * @param {(string|number)[]} [options.fallbackTargets] - 全局 allowUsers（YAML）
 * @param {object[]} [options.extraTargets] - 无条件并入的目标（如 qq notifyGroups：
 *   群目标是渠道属性不是身份属性，绑定表接管用户目标后群通知不因此消失）
 * @returns {{ chatId: string, userId: string }[]}
 */
export function resolveNotifyTargets({ identity = null, channel, configTargets = [], fallbackTargets = [], extraTargets = [] }) {
  /** 按 chatId 去重（保序，先见为准）；空 chatId 顺带过滤。 */
  const dedupeByChatId = (list) => {
    const seen = new Set()
    const out = []
    for (const target of list) {
      if (target.chatId === '' || seen.has(target.chatId)) continue
      seen.add(target.chatId)
      out.push(target)
    }
    return out
  }
  // 元素归一：配置清单是原始 id 数组（feishu allowUsers / qq notifyUsers / wxpusher notifyUids
  // 都是字符串），extras/调用方可能给 {chatId,userId} 对象——两种形态都收，字符串升维成
  // chatId=userId 的自指对象（发现记录：v0.7 首版只按对象形态读，字符串清单全被
  // chatId='' 过滤清空，静默回落全局白名单——错发目标是 P1，测试矩阵当场抓获）。
  const asPair = (item) => {
    if (item === null || item === undefined) return { chatId: '', userId: '' }
    if (typeof item === 'string' || typeof item === 'number') {
      const id = String(item).trim()
      return { chatId: id, userId: id }
    }
    return {
      chatId: String(item.chatId ?? '').trim(),
      userId: String(item.userId ?? item.chatId ?? '').trim(),
    }
  }
  const config = (Array.isArray(configTargets) ? configTargets : [])
    .map(asPair)
    .filter((target) => target.chatId !== '')
  const extras = (Array.isArray(extraTargets) ? extraTargets : [])
    .map(asPair)
    .filter((target) => target.chatId !== '')
  // 判空口径 = 配置清单 ∪ 群目标（qq v0.6 语义：users+groups 全空才走全局回落）。
  // 并集按 chatId 去重：users 与 groups 出现同一 id（或调用方清单自身重复）时不去重
  // 会同卡双发（发现记录：二级分支直拼数组，测试矩阵当场抓获）。
  const configAll = dedupeByChatId([...config, ...extras])
  const fallbackList = dedupeByChatId((Array.isArray(fallbackTargets) ? fallbackTargets : []).map(asPair))

  let primary = []
  if (identity !== null && typeof identity.list === 'function') {
    let bound = []
    try { bound = identity.list(channel) } catch { bound = [] } // 读失败按空降级（fail-open 读军规）
    if (bound.length > 0) {
      // 一级：绑定成员接管用户目标；群目标（extras）是渠道属性，无条件保留
      primary = bound.map((record) => ({ chatId: String(record.userId), userId: String(record.userId) }))
    } else if (configAll.length > 0) {
      primary = configAll
    } else {
      // 三级：仅当绑定表整体为空才走全局回落（纯兼容模式，不迁移用户行为零变化）
      let empty = true
      try { empty = identity.isEmpty() } catch { empty = true }
      primary = empty ? fallbackList : []
    }
  } else {
    // identity 未装配：v0.6 旧行为一分不变（配置清单 → 全局回落）
    primary = configAll.length > 0 ? configAll : fallbackList
  }

  // extras 去重并入（一级绑定分支需要；二级分支已含）
  const seen = new Set(primary.map((target) => target.chatId))
  const merged = [...primary]
  for (const extra of extras) {
    if (seen.has(extra.chatId)) continue
    seen.add(extra.chatId)
    merged.push(extra)
  }
  return merged
}
