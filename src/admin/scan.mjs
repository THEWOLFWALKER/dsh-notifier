// dsh-notifier admin/scan.mjs
// v0.3.3 网页扫码授权流状态机：把 v0.3.1 的扫码模块（qq/feishu 阻塞式 + dingtalk/wechat 步进式）
// 适配成 POST /api/scan/:channel 的轮询契约——每次调用推进一步，返回
// { qrContent, done, saved?, error? }，绝不 throw（失败一律 done:true + error 中文原因）。
//
// 三类流机：
//  - 阻塞式（qqScan/feishuRegister）：整体 Promise 跑在后台，onQr 回调尽早捕获二维码 URL；
//    handler 首调发起并短暂等待二维码（≤1.5s，等不到也返回——UI 下一轮 2s 轮询自然拿到），
//    后续调用读背景 Promise 状态；终态（ok → saved:true / 其余 → error）后复位，下次调用重开。
//  - 步进式（钉钉设备授权流）：start() 建会话、poll() 逐轮步进，天然匹配轮询契约；
//    EXPIRED 自动刷新 ≤3 次（对齐 scripts/channel-login.mjs CLI 行为）、结构性错误
//    （missing-field/incomplete-registration/api-error）fail-fast、瞬态错误下一轮重试。
//  - 步进式（微信 iLink 登录流，v0.7）：get_bot_qrcode 取码 → get_qrcode_status 逐轮步进，
//    状态机对齐 scripts/wechat-login.mjs CLI（wait/scaned/scaned_but_redirect 跨机房/
//    expired 自动刷新 ≤3 次/confirmed 取凭证）。
//
// 凭证落盘：qqScan/feishuRegister 自写 `<channel>:account`（0600 store）；钉钉由本文件
// 写 `dingtalk:account`（与 CLI 同形 { appKey, appSecret, at }）；微信由本文件写
// `wechat:account`（与 CLI 同形 { accountId, token, baseUrl, userId, at }）。凭证内容绝不进日志与返回值。
//
// 微信「扫码即配对」（v0.7）：iLink 机器人是扫码微信的**专属好友**（1:1，只有扫码者能和它聊），
// 扫码确认那一刻身份已唯一确定——confirmed 时直接 addBinding（origin=paired，首条即 owner），
// 不需要再走配对码。userId 为空（旧协议产物）时只落凭证，配对回退 /pair 配对码链路。

import { qqScan } from '../inbound/_qq-scan.mjs'
import { feishuRegister } from '../inbound/_feishu-register.mjs'
import { createDingtalkAuth } from '../inbound/_dingtalk-auth.mjs'
import { ILINK_BASE_URL, createIlinkClient } from '../inbound/_ilink-api.mjs'
import { ACCOUNT_KEY as WECHAT_ACCOUNT_KEY } from '../inbound/wechat-ilink.mjs'

/** 首调等待二维码到达的宽限（毫秒）：等不到不等死，UI 轮询下一轮自然取到。 */
const FIRST_QR_WAIT_MS = 1500
/** 钉钉二维码过期自动刷新上限（对齐 CLI：超过即终态失败，用户重新发起）。 */
const DINGTALK_MAX_RESTARTS = 3
/** 钉钉 poll 结构性错误码（重试无意义，fail-fast；对齐 CLI loginDingtalk 的判定）。 */
const DINGTALK_STRUCTURAL_CODES = new Set(['missing-field', 'incomplete-registration', 'api-error'])
/** 微信二维码过期自动刷新上限（对齐 scripts/wechat-login.mjs CLI 行为）。 */
const WECHAT_MAX_RESTARTS = 3

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

/**
 * 阻塞式扫码流机（qq/feishu 形态：begin(onQr) → Promise<{status, message?}>，终态才 resolve）。
 * @param {object} options
 * @param {(onQr: (url: string) => void) => Promise<{status: string, message?: string}>} options.begin
 *   发起扫码（qqScan/feishuRegister 的注入点，测试可 mock）。
 * @returns {() => Promise<{qrContent: string, done: boolean, saved?: boolean, error?: string}>}
 */
function makeBlockingHandler({ begin }) {
  let phase = 'idle' // idle（未发起）| running（扫码中）| settled（已终态，待取）
  let generation = 0 // 流代次：终态复位自增，旧流的迟到 onQr / settle 回调按代次丢弃
  let qrContent = ''
  let outcome = null
  let firstQrResolve = null

  function reset() {
    generation += 1 // 作废当前流的一切回调（含终态后才补发的迟到 onQr）
    phase = 'idle'
    qrContent = ''
    outcome = null
    firstQrResolve = null
  }

  return async function handler() {
    if (phase === 'idle') {
      phase = 'running'
      const epoch = generation
      const firstQr = new Promise((resolve) => { firstQrResolve = resolve })
      const onQr = (url) => {
        if (epoch !== generation) return // 迟到回调：所属流已复位，丢弃，不污染新流
        const text = String(url ?? '')
        if (text === '') return
        qrContent = text
        try { firstQrResolve?.(text) } catch { /* 回调异常不致命 */ }
      }
      let background
      try {
        background = begin(onQr)
      } catch (error) {
        // 同步 throw：流程根本没发起，直接归一终态（绝不向上抛）
        reset()
        return { qrContent: '', done: true, error: errorMessage(error) }
      }
      if (background == null || typeof background.then !== 'function') {
        // 非 Promise 形状：同样归一终态，避免 then 调用 TypeError 外泄
        reset()
        return { qrContent: '', done: true, error: `扫码流程未正常启动（返回 ${typeof background}），请重新发起` }
      }
      // 背景 Promise 只 settle 一次；迟到 rejection 由这里吸收，绝不 unhandledRejection
      background.then(
        (result) => { if (epoch !== generation) return; outcome = result; phase = 'settled' },
        (error) => { if (epoch !== generation) return; outcome = { status: 'failed', message: errorMessage(error) }; phase = 'settled' },
      )
      // 短等二维码（通常 SDK 立即回调）：拿不到也不等死，UI 下一轮轮询自然取到
      await Promise.race([
        firstQr,
        new Promise((resolve) => { setTimeout(resolve, FIRST_QR_WAIT_MS) }),
      ])
      return { qrContent, done: false }
    }
    if (phase === 'running') return { qrContent, done: false }
    // settled：取终态 → 复位（下次调用重开新流）→ 归一返回
    const result = outcome ?? { status: 'failed', message: '扫码流程异常终止' }
    const qrAtEnd = qrContent
    reset()
    if (result !== null && typeof result === 'object' && result.status === 'ok') {
      return { qrContent: qrAtEnd, done: true, saved: true }
    }
    const status = result !== null && typeof result === 'object' ? String(result.status ?? 'failed') : 'failed'
    const message = result !== null && typeof result === 'object' && typeof result.message === 'string' && result.message !== ''
      ? result.message
      : `扫码未完成（${status}），请重新发起`
    return { qrContent: qrAtEnd, done: true, error: message }
  }
}

/**
 * 钉钉步进式扫码流机（设备授权流天然步进：start() 建会话、poll() 逐轮问状态）。
 * @param {object} options
 * @param {{ start: () => Promise<{verificationCode: string, qrUrl: string}>,
 *           poll: (code: string) => Promise<{status: string, credentials?: object, error?: string}> }} options.auth
 *   设备授权实例（createDingtalkAuth() 产物；测试注入 mock）。
 * @param {{ set(key: string, value: object): void }} options.store - 凭证落盘 dingtalk:account。
 * @param {object} [options.logger] - 日志对象（warn 用）。
 * @returns {() => Promise<{qrContent: string, done: boolean, saved?: boolean, error?: string}>}
 */
function makeDingtalkHandler({ auth, store, logger }) {
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/admin:scan]', message) } catch { /* 日志失败绝不致命 */ }
  }
  let phase = 'idle'
  let qrContent = ''
  let verificationCode = ''
  let restarts = 0

  function reset() {
    phase = 'idle'
    qrContent = ''
    verificationCode = ''
    restarts = 0
  }

  /** 建新授权会话（start）：取验证码与二维码 URL；结构性问题向上抛由调用方归一终态。 */
  async function begin() {
    const session = await auth.start()
    verificationCode = String(session?.verificationCode ?? '')
    qrContent = String(session?.qrUrl ?? '')
    if (verificationCode === '') throw new Error('钉钉授权会话缺少 verificationCode，无法轮询')
  }

  return async function handler() {
    try {
      if (phase === 'idle') {
        phase = 'running'
        await begin()
        return { qrContent, done: false }
      }
      let result
      try {
        result = await auth.poll(verificationCode)
      } catch (error) {
        const code = String(error?.code ?? '')
        if (DINGTALK_STRUCTURAL_CODES.has(code)) {
          const message = errorMessage(error)
          reset()
          return { qrContent: '', done: true, error: `钉钉授权流异常（${code}）：${message}` }
        }
        // 瞬态（超时/网络/HTTP 5xx）：本轮作罢，下一轮轮询重试
        return { qrContent, done: false }
      }
      const status = String(result?.status ?? '')
      if (status === 'WAITING') return { qrContent, done: false }
      if (status === 'EXPIRED') {
        restarts += 1
        if (restarts > DINGTALK_MAX_RESTARTS) {
          reset()
          return { qrContent: '', done: true, error: `二维码已连续过期 ${DINGTALK_MAX_RESTARTS} 次，请重新发起扫码` }
        }
        await begin()
        return { qrContent, done: false }
      }
      if (status === 'FAIL') {
        const message = typeof result?.error === 'string' && result.error !== '' ? result.error : '服务端返回失败'
        reset()
        return { qrContent: '', done: true, error: `钉钉授权失败：${message}。可在开放平台检查账号/组织状态后重试` }
      }
      if (status === 'SUCCESS') {
        const appKey = String(result?.credentials?.appKey ?? '')
        const appSecret = String(result?.credentials?.appSecret ?? '')
        if (appKey === '' || appSecret === '') {
          reset()
          return { qrContent, done: true, error: '授权成功但凭证不完整（appKey/appSecret 缺失），请重新发起' }
        }
        const qrAtEnd = qrContent
        try {
          store?.set?.('dingtalk:account', { appKey, appSecret, at: Date.now() })
        } catch (error) {
          warn(`钉钉凭证落盘失败: ${errorMessage(error)}`)
          reset()
          return { qrContent: qrAtEnd, done: true, error: `凭证落盘失败：${errorMessage(error)}` }
        }
        reset()
        return { qrContent: qrAtEnd, done: true, saved: true }
      }
      // 未知 status（协议层已归一四态，这里只做兜底）：fail-fast 不死循环
      reset()
      return { qrContent: '', done: true, error: `钉钉授权返回未知状态：${status || '(空)'}` }
    } catch (error) {
      const message = errorMessage(error)
      warn(`钉钉扫码流异常: ${message}`)
      reset()
      return { qrContent: '', done: true, error: message }
    }
  }
}

/**
 * 微信 iLink 步进式扫码流机（对齐 scripts/wechat-login.mjs CLI 状态机）：
 * get_bot_qrcode 取码 → 每轮 get_qrcode_status 步进（wait/scaned 继续等、
 * scaned_but_redirect 切机房、expired 自动刷新 ≤3 次、confirmed 取凭证）。
 * confirmed 时凭证落 wechat:account，并**扫码即配对**：iLink 机器人是扫码微信的专属
 * 好友（1:1，协议上只有扫码者能与它对话），扫码者直接 addBinding（origin=paired），
 * 首条绑定即 owner——微信通道不需要配对码。
 * @param {object} options
 * @param {{ set(key: string, value: object): void }} [options.store] - 凭证落盘 wechat:account。
 * @param {object} [options.identity] - 身份绑定层（扫码即配对写入点；缺省只落凭证）。
 * @param {object} [options.logger] - 日志对象（warn 用）。
 * @param {string} [options.botType='3'] - iLink 机器人类型（一般不改）。
 * @param {number} [options.timeoutMs=300000] - 扫码总超时毫秒（下限 30s）。
 * @param {(baseUrl: string) => object} [options.clientFactory] - iLink 客户端工厂（测试注入）。
 * @param {() => number} [options.now] - 时钟注入（测试用；默认 Date.now）。
 * @returns {() => Promise<{qrContent: string, done: boolean, saved?: boolean, error?: string}>}
 */
function makeWechatHandler({
  store, identity, logger, botType = '3', timeoutMs = 300_000, clientFactory, now = Date.now,
} = {}) {
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/admin:scan]', message) } catch { /* 日志失败绝不致命 */ }
  }
  const makeClient = clientFactory ?? ((baseUrl) => createIlinkClient({ baseUrl }))
  let phase = 'idle'
  let client = null
  let qrcode = ''
  let qrContent = ''
  let refreshCount = 0
  let deadline = 0

  function reset() {
    phase = 'idle'
    client = null
    qrcode = ''
    qrContent = ''
    refreshCount = 0
    deadline = 0
  }

  /** 取新二维码（expired 刷新也走这里）：qrcode 缺失向上抛，由调用方归一终态。 */
  async function fetchQr() {
    client = makeClient(ILINK_BASE_URL)
    const response = await client.getBotQrcode(botType)
    const code = String(response?.qrcode ?? '')
    if (code === '') throw new Error('微信服务端未返回二维码（qrcode 缺失），请稍后重试')
    qrcode = code
    qrContent = String(response?.qrcode_img_content ?? '') || code
  }

  return async function handler() {
    try {
      if (phase === 'idle') {
        phase = 'running'
        deadline = now() + Math.max(30_000, timeoutMs)
        await fetchQr()
        return { qrContent, done: false }
      }
      if (now() > deadline) {
        const seconds = Math.round(Math.max(30_000, timeoutMs) / 1000)
        reset()
        return { qrContent: '', done: true, error: `微信扫码超时（${seconds} 秒无确认），请重新发起` }
      }
      let response
      try {
        response = await client.getQrcodeStatus(qrcode)
      } catch (error) {
        // 瞬态（网络/HTTP 5xx）：本轮作罢，UI 下一轮 2s 轮询重试；总超时兜底不死循环
        warn(`微信扫码状态轮询失败（下一轮重试）: ${errorMessage(error)}`)
        return { qrContent, done: false }
      }
      const status = String(response?.status ?? 'wait')
      if (status === 'wait' || status === 'scaned') return { qrContent, done: false }
      if (status === 'scaned_but_redirect') {
        // 跨机房重定向：换 baseUrl 继续问同一张码（对齐 CLI）
        const host = String(response?.redirect_host ?? '')
        if (host !== '') client = makeClient(`https://${host}`)
        return { qrContent, done: false }
      }
      if (status === 'expired') {
        refreshCount += 1
        if (refreshCount > WECHAT_MAX_RESTARTS) {
          reset()
          return { qrContent: '', done: true, error: `二维码已连续过期 ${WECHAT_MAX_RESTARTS} 次，请重新发起扫码` }
        }
        warn(`微信二维码过期，自动刷新（${refreshCount}/${WECHAT_MAX_RESTARTS}）`)
        await fetchQr()
        return { qrContent, done: false }
      }
      if (status === 'confirmed') {
        const accountId = String(response?.ilink_bot_id ?? '')
        const token = String(response?.bot_token ?? '')
        const baseUrl = String(response?.baseurl ?? '') || ILINK_BASE_URL
        const userId = String(response?.ilink_user_id ?? '')
        if (accountId === '' || token === '') {
          reset()
          return { qrContent: '', done: true, error: '扫码成功但凭证不完整（ilink_bot_id/bot_token 缺失），请重新发起' }
        }
        const qrAtEnd = qrContent
        try {
          store?.set?.(WECHAT_ACCOUNT_KEY, { accountId, token, baseUrl, userId, at: Date.now() })
        } catch (error) {
          warn(`微信凭证落盘失败: ${errorMessage(error)}`)
          reset()
          return { qrContent: qrAtEnd, done: true, error: `凭证落盘失败：${errorMessage(error)}` }
        }
        // 扫码即配对：专属好友 1:1，扫码者即成员（首条即 owner）；已绑定保持不变
        if (identity !== null && userId !== '') {
          try {
            const bound = identity.addBinding({ channel: 'wechat', userId, origin: 'paired' })
            if (bound.ok) {
              warn(`微信扫码即配对：扫码微信已绑定为${bound.record.role === 'owner' ? 'owner（首位成员）' : '成员'}，无需配对码`)
            } else {
              warn(`微信扫码即配对：扫码微信已是绑定成员（${bound.reason}），保持不变`)
            }
          } catch (error) {
            warn(`微信扫码即配对写入失败（不致命，可改用 /pair 配对码）: ${errorMessage(error)}`)
          }
        }
        reset()
        return { qrContent: qrAtEnd, done: true, saved: true }
      }
      // 未知 status（协议层五态之外）：fail-fast 不死循环
      warn(`微信扫码返回未知状态: ${status || '(空)'}`)
      reset()
      return { qrContent: '', done: true, error: `微信扫码返回未知状态：${status || '(空)'}` }
    } catch (error) {
      const message = errorMessage(error)
      warn(`微信扫码流异常: ${message}`)
      reset()
      return { qrContent: '', done: true, error: message }
    }
  }
}

/**
 * 创建网页扫码处理器表（装配层注入 admin api 的 scanHandlers）。
 * @param {object} [options]
 * @param {{ set(key: string, value: object): void }} [options.store] - state store（凭证落盘）。
 * @param {object} [options.identity] - 身份绑定层（微信扫码即配对写入点）。
 * @param {number} [options.timeoutMs=300000] - 扫码总超时毫秒（qq/feishu 阻塞式与微信步进式共用）。
 * @param {object} [options.logger] - 日志对象。
 * @param {() => any} [options.qqBegin] - qq 流注入点（测试 mock；缺省 qqScan）。
 * @param {() => any} [options.feishuBegin] - feishu 流注入点（测试 mock；缺省 feishuRegister）。
 * @param {() => any} [options.dingtalkAuthFactory] - 钉钉授权实例工厂（测试 mock；缺省 createDingtalkAuth）。
 * @param {(baseUrl: string) => any} [options.wechatClientFactory] - 微信 iLink 客户端工厂（测试 mock；缺省 createIlinkClient）。
 * @param {() => number} [options.now] - 微信流时钟注入（测试用；缺省 Date.now）。
 * @returns {{ qq: Function, dingtalk: Function, feishu: Function, wechat: Function }} handler 表（形状见三类流机）。
 */
export function createScanHandlers({
  store, identity, logger, timeoutMs = 300_000, qqBegin, feishuBegin, dingtalkAuthFactory,
  wechatClientFactory, now,
} = {}) {
  const qqHandler = makeBlockingHandler({
    begin: qqBegin ?? ((onQr) => qqScan({ store, onQr, timeoutMs, logger })),
  })
  const feishuHandler = makeBlockingHandler({
    begin: feishuBegin ?? ((onQr) => feishuRegister({ store, onQr, timeoutMs, logger })),
  })
  const dingtalkHandler = makeDingtalkHandler({
    auth: (dingtalkAuthFactory ?? createDingtalkAuth)(),
    store,
    logger,
  })
  const wechatHandler = makeWechatHandler({ store, identity, logger, timeoutMs, clientFactory: wechatClientFactory, now })
  return { qq: qqHandler, dingtalk: dingtalkHandler, feishu: feishuHandler, wechat: wechatHandler }
}
