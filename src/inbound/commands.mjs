// dsh-notifier v0.7 inbound/commands.mjs
// 注册面命令（v0.7 计划书 §3.2/§3.3）：/help /whoami /pair /unpair。
// 命名决议（评审发现）：会话路由已有 /bind /unbind（conversation.mjs，绑定 agent 会话），
// 身份线的解绑命令改名 /unpair，与 /pair 成对；/help 仅引导态由本层应答，
// 已绑定成员的 /help 仍由会话路由应答（业务面命令集不变）。

/** 渠道显示名（回执文案用，避免裸英文渠道键）。 */
export function getChannelName(channel) {
  const names = {
    telegram: 'Telegram',
    feishu: '飞书',
    qq: 'QQ',
    wxpusher: 'WxPusher',
    wechat: '微信',
    dingtalk: '钉钉',
  }
  return names[channel] ?? String(channel ?? '未知渠道')
}

/**
 * 解析注册面命令。
 * @param {string} text - 原始消息文本
 * @returns {{ name: string, args: string[], raw: string } | null} 非命令/空文本返回 null
 */
export function parseCommand(text) {
  const raw = String(text ?? '').trim()
  if (raw === '' || !raw.startsWith('/')) return null
  const parts = raw.split(/\s+/)
  const name = parts[0].slice(1).toLowerCase()
  if (name === '') return null
  return { name, args: parts.slice(1), raw }
}

/**
 * 私聊判定（/pair 仅私聊受理——群里发码会被同群所有人看见，单次核销下先到先得）。
 * 判定不了的通道按渠道默认形态处理并 warn（计划书 §3.3）。
 * @param {object} envelope - { channel, userId, chatId, chatType? }
 * @returns {boolean}
 */
export function isPrivateChat(envelope) {
  const channel = String(envelope?.channel ?? '')
  const userId = String(envelope?.userId ?? '')
  const chatId = String(envelope?.chatId ?? '')
  const chatType = String(envelope?.chatType ?? '')
  switch (channel) {
    case 'telegram':
      // chat.type 由 adapter 透传；缺省回落 chat.id === from.id（TG 私聊恒等）
      return chatType === 'private' || (chatType === '' && chatId === userId)
    case 'feishu':
      // message.chat_type: 'p2p' | 'group'；oc_ 会话 id 与 ou_ open_id 形态不同，不能比等
      return chatType === 'p2p'
    case 'dingtalk':
      // conversationType: '1' 单聊 | '2' 群聊
      return chatType === '1'
    case 'qq':
      // qq-gw：私聊 envelope chatId 即 userId；群聊 chatId 是群号
      return chatId === userId
    case 'wxpusher':
    case 'wechat':
      // 订阅/单聊形态通道，无群概念
      return true
    default:
      return false
  }
}

/**
 * 创建注册面命令处理器（bus 在扇出前调用；返回 reply 即消费该消息）。
 * @param {object} options
 * @param {ReturnType<typeof import('./identity.mjs').createIdentity>} options.identity
 * @param {ReturnType<typeof import('./pairing.mjs').createPairing>} options.pairing
 * @param {object} [options.logger]
 * @param {() => void} [options.onBootstrapRemint] - 引导码过期重铸回调（index 注 stderr 展示）
 */
export function createCommandHandler(options = {}) {
  const identity = options.identity
  const pairing = options.pairing
  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/commands]', message) } catch { /* 日志失败绝不致命 */ }
    try { console.error('[dsh-notifier/commands]', message) } catch { /* 控制台不可用不致命 */ }
  }

  /** 引导码过期后按需重铸（引导态自愈：用户 10 分钟后才来也不必重启宿主）。 */
  function ensureBootstrap() {
    if (pairing.hasActiveBootstrap()) return null
    const minted = pairing.mint({ origin: 'bootstrap', mintedBy: 'system:guided' })
    try { options.onBootstrapRemint?.(minted) } catch { /* 回调异常不致命 */ }
    warn('引导态无在铸引导码，已重铸一枚（stderr 已展示）')
    return minted
  }

  const whoamiText = (envelope, bound) => {
    const head = `你的${getChannelName(envelope.channel)}身份：${envelope.userId}`
    if (!bound) return `${head}\n尚未绑定。发送 /pair <配对码> 完成绑定；配对码请联系管理员，或在宿主启动日志中查看引导码。`
    const record = identity.list(envelope.channel).find((item) => String(item.userId) === String(envelope.userId))
    const label = record !== undefined && record.label !== '' ? `（${record.label}）` : ''
    return `${head}\n已绑定${label}，角色：${record?.role ?? 'member'}。/help 查看会话命令。`
  }

  const guidedHelp = `引导模式：白名单为空，仅注册命令可用。
  /pair <配对码> [备注] — 绑定你的身份（首位绑定者成为 owner）
  /whoami — 查看你的渠道身份
配对码位置：宿主启动日志（stderr）或管理台「成员」页。其余消息在完成绑定前不受理。`

  const memberHelp = `身份命令：
  /whoami — 查看你的绑定身份
  /unpair — 解绑当前身份（换号时用，之后重新 /pair）
会话命令见 /help（由会话路由应答）。`

  /** /pair 受理：私聊判定 → 码面核销 → 绑定。 */
  function handlePair(envelope, args) {
    if (args.length === 0) {
      return '用法：/pair <配对码> [备注]\n配对码由管理员在管理台生成（10 分钟内有效）；首次部署的引导码见宿主启动日志。'
    }
    if (!isPrivateChat(envelope)) {
      // 群里发码 = 把码亮给全群：拒答并引导私聊（不消费码）
      return '配对码请勿在群聊中发送（会被其他人抢用）。请私聊我发送 /pair <配对码>。'
    }
    const code = args[0]
    const label = args.slice(1).join(' ').slice(0, 64)
    // 已绑定短路（R5 审查 R5-1-P2-3：先核销后判绑定会把单次码白白烧掉——也可被任意
    // 已绑定成员恶意提交有效码拒绝新成员入伙）。先查身份，不触碰配对码。
    if (typeof identity.allows === 'function' && identity.allows(envelope.channel, envelope.userId)) {
      return '你已绑定过身份（/whoami 查看）。如需换号，先发送 /unpair。'
    }
    const verdict = pairing.redeem(code, { channel: envelope.channel, userId: envelope.userId, label })
    if (!verdict.ok) {
      // 引导态自愈：bootstrap 过期且无在铸码 → 重铸一枚（stderr 已再展示），提示取新码
      if (verdict.reason === 'expired' && identity.isEmpty()) {
        const reminted = ensureBootstrap()
        if (reminted !== null) {
          return '配对码已过期。已重铸一枚引导码，请从宿主启动日志（stderr）获取新码后重试。'
        }
      }
      const reasons = {
        'invalid-code': '配对码无效（核对后重试；连续错 5 次将临时锁定）。',
        'locked-out': '尝试次数过多，已临时锁定 10 分钟。',
        expired: '配对码已过期，请联系管理员重新生成。',
        revoked: '配对码已被撤销，请联系管理员重新生成。',
        locked: '配对码已被锁定，请联系管理员。',
        'already-redeemed': '配对码已被使用（单次有效），请联系管理员重新生成。',
      }
      return reasons[verdict.reason] ?? `配对失败：${verdict.reason}`
    }
    const added = identity.addBinding({
      channel: envelope.channel,
      userId: envelope.userId,
      label,
      origin: 'paired',
    })
    if (!added.ok) {
      if (added.reason === 'already-bound') {
        return '你已绑定过身份（/whoami 查看）。如需换号，先发送 /unpair。'
      }
      warn(`配对核销成功但绑定失败：${added.reason}（码已消费，需人工处理）`)
      return `配对码核销成功，但绑定写入失败（${added.reason}）。请联系管理员检查状态文件。`
    }
    const isOwner = added.record.role === 'owner'
    return isOwner
      ? `配对成功！你是首位成员（owner），已可使用全部功能。\n${memberHelp}`
      : `配对成功！你的身份已绑定${label !== '' ? `（${label}）` : ''}。\n${memberHelp}`
  }

  /** /unpair 受理：末位 owner 指引走管理台（防止把实例锁死成无人可管）。 */
  function handleUnpair(envelope) {
    if (!identity.allows(envelope.channel, envelope.userId)) {
      return '你尚未绑定身份，无需解绑。'
    }
    if (identity.ownerCount() <= 1) {
      const record = identity.list(envelope.channel).find((item) => String(item.userId) === String(envelope.userId))
      if (record?.role === 'owner') {
        return '你是唯一的 owner，不能自解绑（否则实例将无人可管理）。请先在管理台添加成员或转移角色，再解绑旧号。'
      }
    }
    const removed = identity.removeBinding(envelope.channel, envelope.userId)
    if (!removed.ok) return `解绑失败：${removed.reason}`
    return '已解绑。换新号后重新发送 /pair <配对码> 即可。'
  }

  /**
   * 处理一条已被识别为命令的消息。
   * @returns {{ reply: string, consumed: boolean } | null} null = 非注册面命令，交还业务扇出
   */
  function handle(envelope, command, guided) {
    try {
      switch (command.name) {
        case 'whoami': {
          const bound = identity.allows(envelope.channel, envelope.userId)
          return { reply: whoamiText(envelope, bound), consumed: true }
        }
        case 'pair':
          return { reply: handlePair(envelope, command.args), consumed: true }
        case 'unpair':
          return { reply: handleUnpair(envelope), consumed: true }
        case 'help':
          // 引导态由本层应答；已绑定成员的 /help 属业务面，交还会话路由
          return guided ? { reply: guidedHelp, consumed: true } : null
        default:
          return null
      }
    } catch (error) {
      // A listener never throws：命令处理异常不致命，回复兜底文案
      warn(`命令处理异常 /${command.name}: ${error instanceof Error ? error.message : String(error)}`)
      return { reply: '命令内部错误，请稍后重试；若持续失败请联系管理员查看宿主日志。', consumed: true }
    }
  }

  return { handle, isPrivateChat, parseCommand, ensureBootstrap }
}
