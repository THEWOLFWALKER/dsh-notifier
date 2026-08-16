// dsh-notifier admin/scan.mjs
// v0.3.3 网页扫码授权流状态机：把 v0.3.1 的三个扫码模块（qq/feishu 阻塞式 + dingtalk 步进式）
// 适配成 POST /api/scan/:channel 的轮询契约——每次调用推进一步，返回
// { qrContent, done, saved?, error? }，绝不 throw（失败一律 done:true + error 中文原因）。
//
// 两类流机：
//  - 阻塞式（qqScan/feishuRegister）：整体 Promise 跑在后台，onQr 回调尽早捕获二维码 URL；
//    handler 首调发起并短暂等待二维码（≤1.5s，等不到也返回——UI 下一轮 2s 轮询自然拿到），
//    后续调用读背景 Promise 状态；终态（ok → saved:true / 其余 → error）后复位，下次调用重开。
//  - 步进式（钉钉设备授权流）：start() 建会话、poll() 逐轮步进，天然匹配轮询契约；
//    EXPIRED 自动刷新 ≤3 次（对齐 scripts/channel-login.mjs CLI 行为）、结构性错误
//    （missing-field/incomplete-registration/api-error）fail-fast、瞬态错误下一轮重试。
//
// 凭证落盘：qqScan/feishuRegister 自写 `<channel>:account`（0600 store）；钉钉由本文件
// 写 `dingtalk:account`（与 CLI 同形 { appKey, appSecret, at }）。凭证内容绝不进日志与返回值。

import { qqScan } from '../inbound/_qq-scan.mjs'
import { feishuRegister } from '../inbound/_feishu-register.mjs'
import { createDingtalkAuth } from '../inbound/_dingtalk-auth.mjs'

/** 首调等待二维码到达的宽限（毫秒）：等不到不等死，UI 轮询下一轮自然取到。 */
const FIRST_QR_WAIT_MS = 1500
/** 钉钉二维码过期自动刷新上限（对齐 CLI：超过即终态失败，用户重新发起）。 */
const DINGTALK_MAX_RESTARTS = 3
/** 钉钉 poll 结构性错误码（重试无意义，fail-fast；对齐 CLI loginDingtalk 的判定）。 */
const DINGTALK_STRUCTURAL_CODES = new Set(['missing-field', 'incomplete-registration', 'api-error'])

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
 * 创建网页扫码处理器表（装配层注入 admin api 的 scanHandlers）。
 * @param {object} [options]
 * @param {{ set(key: string, value: object): void }} [options.store] - state store（凭证落盘）。
 * @param {number} [options.timeoutMs=300000] - 阻塞式扫码总超时毫秒（qq/feishu）。
 * @param {object} [options.logger] - 日志对象。
 * @param {() => any} [options.qqBegin] - qq 流注入点（测试 mock；缺省 qqScan）。
 * @param {() => any} [options.feishuBegin] - feishu 流注入点（测试 mock；缺省 feishuRegister）。
 * @param {() => any} [options.dingtalkAuthFactory] - 钉钉授权实例工厂（测试 mock；缺省 createDingtalkAuth）。
 * @returns {{ qq: Function, dingtalk: Function, feishu: Function }} handler 表（形状见两类流机）。
 */
export function createScanHandlers({
  store, logger, timeoutMs = 300_000, qqBegin, feishuBegin, dingtalkAuthFactory,
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
  return { qq: qqHandler, dingtalk: dingtalkHandler, feishu: feishuHandler }
}
