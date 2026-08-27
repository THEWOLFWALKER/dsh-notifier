// dsh-notifier src/assembly/inbound-signals.mjs
// 入站通道 resolve/启用信号（从 src/index.mjs apply() 抽出，维护批 3 阶段 3）。
// 纯计算 + 一处受控副作用（wxpusher 密径首铸落盘 store.set）；六个通道的「显式配置/
// admin 下 store 凭证即启用信号」判定集中在此，产出各通道 resolved 配置供后面的
// guarded 装载块使用。任何解析失败只 warn + 标记 !ok，绝不弄崩装配。

import { resolveEnvRefs } from '../config.mjs'
import { resolveFeishuInboundConfig } from '../inbound/feishu-bot.mjs'
import { resolveQqInboundConfig } from '../inbound/qq-gw.mjs'
import { resolveDingtalkInboundConfig } from '../inbound/dingtalk-stream.mjs'
import { resolveWxpusherInboundConfig } from '../inbound/wxpusher-callback.mjs'
import { accountOf } from './outbound.mjs'

/**
 * 解析六通道入站启用信号与 resolved 配置（不含微信 resolve——它在 apply 的
 * guided 装配块内晚绑定 resolveWechatInboundConfig；这里只出 wanted/raw 信号）。
 * @param {{ inboundRaw: object, approvalRaw: object, resolved: object, store: object,
 *           adminEnabled: boolean, warn: (msg: string) => void }} deps
 */
export function resolveInboundSignals({ inboundRaw, approvalRaw, resolved, store, adminEnabled, warn }) {
  // 阶段 4：inbound 白名单（allowUsers 为空 = 整栈不启动，默认全拒）。
  const allowUsers = (Array.isArray(inboundRaw.allowUsers) ? inboundRaw.allowUsers : [])
    .map((id) => String(id).trim())
    .filter((id) => id !== '')
  const tgRaw = (inboundRaw.telegram !== null && typeof inboundRaw.telegram === 'object') ? inboundRaw.telegram : {}
  // 便捷回退：未显式配置 inbound.telegram 时，复用出站 telegram 渠道的 botToken/chatId；
  // v0.3.3：admin 下再回落 store 的 telegram:account（UI/手写产物；出站 overlay 已含同源凭证，
  // 这里是 overlay resolve 失败时的兜底链尾）。
  const tgOutbound = resolved.channels.find((entry) => entry.type === 'telegram')
  const tgAccount = adminEnabled ? accountOf(store, 'telegram:account') : null
  const inboundBotToken = String(tgRaw.botToken ?? tgOutbound?.config?.botToken ?? tgAccount?.botToken ?? '').trim()
  const notifyChatIds = Array.isArray(tgRaw.notifyChatIds) && tgRaw.notifyChatIds.length > 0
    ? tgRaw.notifyChatIds.map(String)
    : (tgOutbound != null && String(tgOutbound.config.chatId ?? '') !== ''
        ? [String(tgOutbound.config.chatId)]
        : (tgAccount !== null && String(tgAccount.chatId ?? '') !== '' ? [String(tgAccount.chatId)] : []))
  const approvalWanted = approvalRaw.mode === 'answer' || approvalRaw.mode === 'observe'

  // 飞书 inbound：显式配置 inbound.feishu（可为空对象——空 = 走扫码 CLI 落盘凭证）时启用；
  // 配置不全只在加载期 warn 跳过（与其他渠道同规矩，绝不弄崩启动）。
  // v0.3.1：凭证缺省回落扫码 CLI 落盘的 feishu:account（config 显式配置优先）。
  // v0.3.3：admin 开启时，store 存在 feishu:account（扫码/UI 产物）本身即启用信号——
  // 网页扫码授权后无需再改 YAML（inbound.feishu: {} 语义的自然延伸）。
  // 注意门槛是「显式提供了对象」而非「对象非空」——扫码授权的承诺就是 inbound.feishu: {} 即启用。
  const fsExplicit = inboundRaw.feishu !== null && typeof inboundRaw.feishu === 'object'
  const fsWanted = fsExplicit || (adminEnabled && accountOf(store, 'feishu:account') !== null)
  const fsRaw = fsExplicit ? inboundRaw.feishu : {}
  const feishuResolved = fsWanted
    ? resolveFeishuInboundConfig(resolveEnvRefs(fsRaw), { credentials: store.get('feishu:account') })
    : null
  if (feishuResolved !== null && !feishuResolved.ok) warn(`inbound.feishu 跳过: ${feishuResolved.reason}`)
  const feishuOk = feishuResolved?.ok === true

  // QQ 官方机器人 inbound：显式配置 inbound.qq（可为空对象——空 = 走扫码 CLI 落盘凭证）时启用；
  // 裸协议实现（WS 网关 + REST），无 SDK 依赖。
  // v0.3.1：凭证缺省回落扫码 CLI 落盘的 qq:account（config 显式配置优先）。
  // v0.3.3：admin 开启时，store 存在 qq:account 本身即启用信号（同 feishu）。
  const qqExplicit = inboundRaw.qq !== null && typeof inboundRaw.qq === 'object'
  const qqWanted = qqExplicit || (adminEnabled && accountOf(store, 'qq:account') !== null)
  const qqRaw = qqExplicit ? inboundRaw.qq : {}
  const qqResolved = qqWanted
    ? resolveQqInboundConfig(resolveEnvRefs(qqRaw), { credentials: store.get('qq:account') })
    : null
  if (qqResolved !== null && !qqResolved.ok) warn(`inbound.qq 跳过: ${qqResolved.reason}`)
  const qqOk = qqResolved?.ok === true

  // 钉钉 Stream inbound（v0.3.1 新增）：显式配置 inbound.dingtalk（appKey + appSecret，
  // 或空对象走扫码落盘凭证）时启用；Stream 裸协议长连接，审批走编号回复。
  // v0.3.3：admin 开启时，store 存在 dingtalk:account 本身即启用信号（同 feishu）。
  const dtExplicit = inboundRaw.dingtalk !== null && typeof inboundRaw.dingtalk === 'object'
  const dtWanted = dtExplicit || (adminEnabled && accountOf(store, 'dingtalk:account') !== null)
  const dtRaw = dtExplicit ? inboundRaw.dingtalk : {}
  const dingtalkResolved = dtWanted
    ? resolveDingtalkInboundConfig(resolveEnvRefs(dtRaw), { credentials: store.get('dingtalk:account') })
    : null
  if (dingtalkResolved !== null && !dingtalkResolved.ok) warn(`inbound.dingtalk 跳过: ${dingtalkResolved.reason}`)
  const dingtalkOk = dingtalkResolved?.ok === true

  // WxPusher inbound：显式配置 inbound.wxpusher（appToken）时启用；
  // 回调需公网可达（frp/反代由用户解决），密径即凭证。
  // v0.3.3：admin 开启时，store 的 wxpusher:account（UI 保存产物）为启用信号 +
  // appToken 链尾兜底——resolveWxpusherInboundConfig 不收 credentials 参数，
  // 在装配层做字段级合并（YAML 显式键优先覆盖 store）。
  const wxExplicit = (inboundRaw.wxpusher !== null && typeof inboundRaw.wxpusher === 'object')
    ? inboundRaw.wxpusher : {}
  const wxAccount = adminEnabled ? accountOf(store, 'wxpusher:account') : null
  const wxMerged = { ...wxAccount, ...wxExplicit }
  // v0.7 密径持久化：webhookPath 未显式配置时复用 store 首铸密径——缺省每次启动
  // 随机换路径，用户已填进 WxPusher 控制台的回调 URL 立即失效（真机事故：每次
  // 重启都要去控制台改地址）。首铸落盘 wxpusher:webhookPath；显式配置仍是用户意志。
  let wxPathPersistNeeded = false
  if (String(wxMerged.webhookPath ?? '').trim() === '') {
    const persistedPath = store.get('wxpusher:webhookPath')
    if (typeof persistedPath === 'string' && persistedPath.startsWith('/') && persistedPath.length > 1) {
      wxMerged.webhookPath = persistedPath
    } else {
      wxPathPersistNeeded = true // 本次 resolve 生成新随机密径，成功后落盘复用
    }
  }
  const wxResolved = (Object.keys(wxExplicit).length > 0 || wxAccount !== null)
    ? resolveWxpusherInboundConfig(resolveEnvRefs(wxMerged))
    : null
  if (wxResolved !== null && !wxResolved.ok) warn(`inbound.wxpusher 跳过: ${wxResolved.reason}`)
  const wxOk = wxResolved?.ok === true
  if (wxOk && wxPathPersistNeeded) {
    try { store.set('wxpusher:webhookPath', wxResolved.config.webhookPath) } catch (error) {
      warn(`wxpusher 密径持久化失败（下次重启将重新生成，需重填回调地址）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 微信 iLink inbound：显式配置 inbound.wechat（可为空对象）时启用；
  // 凭证优先取登录 CLI 落盘的 wechat:account（需先执行 node scripts/wechat-login.mjs）。
  // v0.3.3：admin 开启时，store 的 wechat:account 本身即启用信号（同 feishu；
  // 凭证链不变——resolve 内部已回落 credentials）。
  const wechatExplicit = inboundRaw.wechat !== null && typeof inboundRaw.wechat === 'object'
  const wechatWanted = wechatExplicit || (adminEnabled && accountOf(store, 'wechat:account') !== null)
  const wechatRaw = wechatExplicit ? inboundRaw.wechat : {}

  return {
    allowUsers, // 空 = 整栈不启动，默认全拒
    tgRaw, // 入站 telegram 原始行（装载块 config.apiBase 晚用）
    inboundBotToken,
    notifyChatIds,
    approvalWanted, // approvalRaw.mode ∈ answer/observe
    feishuResolved, feishuOk,
    qqResolved, qqOk,
    dingtalkResolved, dingtalkOk,
    wxResolved, wxOk,
    wechatWanted, wechatRaw, // 微信 resolve 由 apply 晚绑定
  }
}