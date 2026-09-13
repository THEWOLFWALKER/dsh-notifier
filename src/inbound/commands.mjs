import { stringsOf } from '../strings.mjs'
// dsh-notifier v0.7 inbound/commands.mjs
// 注册面命令（v0.7 计划书 §3.2/§3.3）：/help /whoami /pair /unpair。
// 命名决议（评审发现）：会话路由已有 /bind /unbind（conversation.mjs，绑定 agent 会话），
// 身份线的解绑命令改名 /unpair，与 /pair 成对；/help 仅引导态由本层应答，
// 已绑定成员的 /help 仍由会话路由应答（业务面命令集不变）。

/** 渠道显示名（回执文案用，避免裸英文渠道键）。strings 可选（wiring 传 stringsOf(lang)）。 */
export function getChannelName(channel, strings) {
  const t = strings ?? ZH_FALLBACK
  return t.commands.channelNames[channel] ?? String(channel ?? t.commands.unknownChannel)
}

// strings 未接线时的 zh 兜底（逐字节等于原字面量；wiring 统一传 stringsOf(lang) 后可移除）。
const ZH_FALLBACK = stringsOf()

/**
 * 解析注册面命令。
 * G-06：群聊命令常带机器人后缀——TG '/pair@MyNotifierBot code'、飞书还原后的
 * '/pair@张三 code'。命令词上的 @ 后缀做贪心剥除（/@.+$/，含点号的 botname 一并
 * 覆盖），剥完为空视为非命令；@ 只在命令词上剥，args 原样保留（不含 @ 残片）。
 * G-65：全角斜杠 '／pair' 在判定前规范化首字符为 '/'（仅首字符——句中全角斜杠是
 * 正文，不动）；解析成功不吞附言——'/help 附言' 的附言原样留在 args 交给处理器
 * （解析成功只说明认出了命令词，不等于整条消息只剩命令词）。
 * @param {string} text - 原始消息文本
 * @returns {{ name: string, args: string[], raw: string } | null} 非命令/空文本返回 null
 */
export function parseCommand(text) {
  const raw = String(text ?? '').trim().replace(/^／/, '/')
  if (raw === '' || !raw.startsWith('/')) return null
  const parts = raw.split(/\s+/)
  const name = parts[0].slice(1).replace(/@.+$/, '').toLowerCase()
  if (name === '') return null
  return { name, args: parts.slice(1), raw }
}

/**
 * G-06：命令词 @ 后缀剥离（adapter 入站 envelope 构造处调用）。
 * TG 群聊对指定机器人发命令的规范形态是 '/cmd@BotName args'——parseCommand 已在解析层
 * 剥除（注册面命令可用），但会话路由（conversation.mjs）自行分词不走 parseCommand，
 * '/stop@bot' 会在那里落成未知命令。入站处先剥一次，让注册面 / 会话路由 / 裸编号回复
 * 等所有下游看到同一份干净的 '/cmd args'。
 * 只动首个 '/' 开头 token 上的 @ 后缀（贪心到词尾，与 parseCommand 的 /@.+$/ 同源，
 * 含点号 botname 一并覆盖）；args 与正文原样保留。'/@bot'（命令词剥完为空）与不以
 * '/' 开头的文本原样返回（交由 parseCommand 判非命令）。
 * @param {string} text - 原始消息文本
 * @returns {string} 剥离后的文本（非命令形态仅做 trim）
 */
export function stripCommandMention(text) {
  const raw = String(text ?? '').trim()
  if (!raw.startsWith('/')) return raw
  const spaceAt = raw.indexOf(' ')
  const head = spaceAt === -1 ? raw : raw.slice(0, spaceAt)
  const rest = spaceAt === -1 ? '' : raw.slice(spaceAt)
  const at = head.indexOf('@')
  // at <= 1：命令词上无 @，或 '/@bot' 形态（剥完命令词为空，保留原样）
  if (at <= 1) return raw
  return `${head.slice(0, at)}${rest}`
}

/**
 * G-06：行首 @提及剥离（adapter 入站 envelope 构造处调用）。
 * 钉钉群 @ 机器人：机器人只收到 @ 它的消息，content 行首带 '@机器人名 ' 字面提及，
 * 不剥会污染 agent 语境与 /pair 参数（与 QQ 侧 stripMention 白名单（G-40）同目的；
 * QQ 是官方占位形态 + 白名单，此处是钉钉的字面文本形态）。两种形态：
 *  1. '@名字 后续内容'（名字后随空白分隔）→ '后续内容'
 *  2. 整条只剩 '@名字'（纯提及无正文）→ ''（调用方按空消息处理，与 QQ 侧一致）
 * 只剥行首一处；正文中间的 @（提及他人）一律不动。行首 '@词 ' 后跟正文的形态
 * 一律按提及剥（'@/etc/hosts 路径' 会被误剥——与 QQ 白名单纯文本形态同一取舍，
 * 文本级剥离无渠道元数据可裁决，钉钉机器人只收 @ 它的消息，误剥面收窄到行首）。
 * @param {string} text - 原始消息文本
 * @returns {string} 剥离后 trim 的文本
 */
export function stripLeadingMention(text) {
  const raw = String(text ?? '').replace(/^\s+/, '')
  const withRest = raw.match(/^@\S+\s+/)
  if (withRest !== null) return raw.slice(withRest[0].length).trim()
  if (/^@\S+$/.test(raw)) return ''
  return raw.trim()
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
 * @param {() => void} [options.onBootstrapRemint] - 引导码过期重铸回调（index 注：写 0600 码文件）
 * @param {object} [strings] - 文案表（wiring 传 stringsOf(lang)；缺省 zh 兜底）
 */
export function createCommandHandler(options = {}, strings) {
  const t = strings ?? ZH_FALLBACK
  const identity = options.identity
  const pairing = options.pairing
  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/commands]', message) } catch { /* 日志失败绝不致命 */ }
    try { console.error('[dsh-notifier/commands]', message) } catch { /* 控制台不可用不致命 */ }
  }

  /** 引导码过期后按需重铸（引导态自愈：用户 10 分钟后才来也不必重启宿主）。
   *  v0.8.7 (A4)：节流 10 分钟 + mint 失败不假断言 + 回调异常不静默。 */
  let lastBootstrapMint = 0

  function ensureBootstrap() {
    if (pairing.hasActiveBootstrap()) return null
    const now = Date.now()
    if (lastBootstrapMint > 0 && now - lastBootstrapMint < 10 * 60 * 1000) {
      warn('引导码重铸被节流（上次重铸不足 10 分钟），跳过')
      return null
    }
    const minted = pairing.mint({ origin: 'bootstrap', mintedBy: 'system:guided' })
    if (!minted.ok) {
      warn(`引导码重铸失败: ${minted.reason ?? 'unknown'}（管理台可补铸）`)
      return null
    }
    lastBootstrapMint = now
    try { options.onBootstrapRemint?.(minted) } catch (e) {
      warn(`onBootstrapRemint 回调异常: ${e?.message ?? ''}（码已铸，引导码文件可能未写入，请检查管理台）`)
    }
    return minted
  }

  const whoamiText = (envelope, bound) => {
    const head = t.commands.whoamiHead(getChannelName(envelope.channel, strings), envelope.userId)
    if (!bound) return t.commands.whoamiUnbound(head)
    const record = identity.list(envelope.channel).find((item) => String(item.userId) === String(envelope.userId))
    const label = record !== undefined && record.label !== '' ? t.commands.labelSuffix(record.label) : ''
    return t.commands.whoamiBound(head, label, record?.role ?? 'member')
  }

  const memberHelp = t.commands.memberHelp

  /** /pair 受理：私聊判定 → 码面核销 → 绑定。 */
  function handlePair(envelope, args) {
    if (args.length === 0) {
      return t.commands.pairUsage
    }
    if (!isPrivateChat(envelope)) {
      // 群里发码 = 把码亮给全群：拒答并引导私聊（不消费码）
      return t.commands.pairNotInGroup
    }
    const code = args[0]
    const label = args.slice(1).join(' ').slice(0, 64)
    // 已绑定短路（R5 审查 R5-1-P2-3：先核销后判绑定会把单次码白白烧掉——也可被任意
    // 已绑定成员恶意提交有效码拒绝新成员入伙）。先查身份，不触碰配对码。
    if (typeof identity.allows === 'function' && identity.allows(envelope.channel, envelope.userId)) {
      return t.commands.alreadyBound
    }
    const verdict = pairing.redeem(code, { channel: envelope.channel, userId: envelope.userId, label })
    if (!verdict.ok) {
      // 引导态自愈：bootstrap 过期且无在铸码 → 重铸一枚（新码写 0600 码文件），提示取新码
      if (verdict.reason === 'expired' && identity.isEmpty()) {
        // 已有在铸引导码（如上一次提交刚触发过重铸）：让用户去取现码，别谎报「重铸失败」
        if (pairing.hasActiveBootstrap()) {
          return t.commands.pairExpiredBootstrapPending
        }
        const reminted = ensureBootstrap()
        if (reminted !== null) {
          return t.commands.pairExpiredReminted
        }
        // 重铸未发生（节流窗内 / mint 失败）：明说状态，不静默吞成通用过期回执
        return t.commands.pairExpiredRemintFailed
      }
      const reasons = {
        'invalid-code': t.commands.reasonInvalidCode,
        'locked-out': t.commands.reasonLockedOut,
        expired: t.commands.reasonExpired,
        revoked: t.commands.reasonRevoked,
        locked: t.commands.reasonLocked,
        'already-redeemed': t.commands.reasonAlreadyRedeemed,
      }
      return reasons[verdict.reason] ?? t.commands.pairFailed(verdict.reason)
    }
    const added = identity.addBinding({
      channel: envelope.channel,
      userId: envelope.userId,
      label,
      origin: 'paired',
    })
    if (!added.ok) {
      if (added.reason === 'already-bound') {
        return t.commands.alreadyBound
      }
      warn(`配对核销成功但绑定失败：${added.reason}（码已消费，需人工处理）`)
      return t.commands.bindWriteFailed(added.reason)
    }
    const isOwner = added.record.role === 'owner'
    return isOwner
      ? t.commands.pairSuccessOwner(memberHelp)
      : t.commands.pairSuccess(label, memberHelp)
  }

  /** /unpair 受理：末位 owner 指引走管理台（防止把实例锁死成无人可管）。 */
  function handleUnpair(envelope) {
    if (!identity.allows(envelope.channel, envelope.userId)) {
      return t.commands.unpairNotBound
    }
    if (identity.ownerCount() <= 1) {
      const record = identity.list(envelope.channel).find((item) => String(item.userId) === String(envelope.userId))
      if (record?.role === 'owner') {
        return t.commands.unpairLastOwner
      }
    }
    const removed = identity.removeBinding(envelope.channel, envelope.userId)
    if (!removed.ok) return t.commands.unpairFailed(removed.reason)
    return t.commands.unpaired
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
          return guided ? { reply: t.commands.guidedHelp, consumed: true } : null
        default:
          return null
      }
    } catch (error) {
      // A listener never throws：命令处理异常不致命，回复兜底文案
      warn(`命令处理异常 /${command.name}: ${error instanceof Error ? error.message : String(error)}`)
      return { reply: t.commands.internalError, consumed: true }
    }
  }

  return { handle, isPrivateChat, parseCommand, ensureBootstrap }
}
