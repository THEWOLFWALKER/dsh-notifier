// dsh-notifier inbound/wxpusher-callback.mjs
// WxPusher 双向入站（v0.3.0 阶段 3）：HTTP 回调（`send_up_cmd` 上行指令）+ appToken 推送回执。
// 协议（官方文档，回调对响应体无格式要求、无签名机制）：
//  - 统一载荷 {action, data}；本通道处理 send_up_cmd（data.{uid, appId, time, content}）
//    与 app_subscribe（关注/订阅事件，学习 uid）；未知 action 记日志直接 200（官方会扩展动作）
//  - 上行内容若为 `#{appId} 内容` 标准指令格式则剥前缀取净文本
//  - 回调无消息 id：合成幂等键 cmd:<uid>:<time>:<hash6(content)>（同 time+content 两次只过一次）
// 安全（官方无签名，三重自防）：① 密径（webhookPath，随机 32B hex 等价 bearer secret）；
// ② bus 白名单（uid）；③ 可选 allowedIps（WxPusher 出口 IP，缺省不启用）。
// 审批：纯编号回复（回调天然无按钮），via=wxpusher:reply；推送走出站同款 API（单 uid 定向），
// 官方限频约 2 QPS → createRateGate(500ms)。
// 军规：任何异常只 warn；stop() 关 server 等收敛。

import { createHash } from 'node:crypto'
import { createRateGate } from '../adapters/_tokens.mjs'
import { startHttpCallback } from './http-callback.mjs'
import { resolveNotifyTargets } from './target-guard.mjs'

const SEND_ENDPOINT = 'https://wxpusher.zjiecode.com/api/send/message'
const DEFAULT_PORT = 8103

/** content → 6 位十六进制摘要（合成幂等键用）。 */
function hash6(content) {
  return createHash('sha256').update(String(content ?? '')).digest('hex').slice(0, 6)
}

/** 剥 `#{appId} 内容` 标准指令前缀（WxPusher 上行的官方格式），返回净文本。 */
function stripCommandPrefix(content, appId) {
  const text = String(content ?? '').trim()
  // 词边界：`#AT_app` 不得部分匹配 `#AT_application msg`（后随字符必须是空白或结尾）
  const prefixed = appId !== '' ? `#${appId}` : ''
  if (prefixed !== '' && (text === prefixed || (text.startsWith(prefixed) && /\s/.test(text[prefixed.length] ?? '')))) {
    return text.slice(prefixed.length).trim()
  }
  // 兼容 `#<任意appId> ` 形态（配置 appId 与回调 appId 不一致时仍可剥）
  return text.replace(/^#\S+\s+/, '').trim()
}

/**
 * 解析并校验 inbound.wxpusher 配置。
 * webhookPath 缺省生成随机密径（启动时打印完整回调 URL，用户填进 WxPusher 控制台）。
 * @returns {{ ok: true, config: object } | { ok: false, reason: string }}
 */
export function resolveWxpusherInboundConfig(raw, { randomPath } = {}) {
  const cfg = (raw !== null && typeof raw === 'object') ? raw : {}
  const appToken = String(cfg.appToken ?? '').trim()
  if (appToken === '') {
    return { ok: false, reason: 'wxpusher inbound 需要 appToken（扫码关注 WxPusher 后在应用后台获取）。回执与审批推送也依赖它' }
  }
  const fallback = () => `/hook/${createHash('sha256').update(`${appToken}:${Math.random()}`).digest('hex').slice(0, 32)}`
  const webhookPath = String(cfg.webhookPath ?? '').trim() || (typeof randomPath === 'function' ? randomPath() : fallback())
  const portRaw = cfg.port === undefined || cfg.port === null || cfg.port === '' ? DEFAULT_PORT : Number(cfg.port)
  const timeoutRaw = cfg.timeoutMs === undefined || cfg.timeoutMs === null || cfg.timeoutMs === '' ? 10000 : Number(cfg.timeoutMs)
  return {
    ok: true,
    config: {
      appToken,
      webhookPath: webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`,
      host: String(cfg.host ?? '').trim() || '127.0.0.1',
      port: Math.min(65535, Math.max(0, Number.isFinite(portRaw) ? portRaw : DEFAULT_PORT)),
      notifyUids: (Array.isArray(cfg.notifyUids) ? cfg.notifyUids : []).map((id) => String(id).trim()).filter((id) => id !== ''),
      allowedIps: (Array.isArray(cfg.allowedIps) ? cfg.allowedIps : []).map((ip) => String(ip).trim()).filter((ip) => ip !== ''),
      timeoutMs: Math.min(60000, Math.max(1000, Number.isFinite(timeoutRaw) ? timeoutRaw : 10000)),
    },
  }
}

/**
 * 创建 WxPusher 入站通道（统一契约；buttons=false，审批走编号回复）。
 * @param {object} options
 * @param {{ appToken: string, webhookPath: string, host?: string, port?: number,
 *           notifyUids?: string[], allowedIps?: string[], timeoutMs?: number }} options.config
 * @param {ReturnType<typeof import('./bus.mjs').createInboundBus>} options.bus
 * @param {import('./store.mjs').store} [options.store] - 学习到的 uid 绑定落盘（app_subscribe）
 * @param {string[]} [options.fallbackTargets] - 未配置 notifyUids 时的推送目标（全局白名单回落）
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] - fetch 注入（测试用）
 * @param {(options: object) => Promise<{ port: number, close: () => Promise<void> }>} [options.serverStarter]
 *        - HTTP server 启动器注入（测试用；默认 startHttpCallback）
 */
export function createWxpusherInbound(options = {}) {
  const { config, bus, store = null, fallbackTargets = [], logger = null, identity = null } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  const startServer = options.serverStarter ?? startHttpCallback
  const allowedIps = Array.isArray(config.allowedIps) ? config.allowedIps.map(String) : []

  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/inbound:wxpusher]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时轮询/装配告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/inbound:wxpusher]', message) } catch { /* 控制台不可用不致命 */ }
  }
  const rateGate = createRateGate(500) // 官方约 2 QPS

  let running = false
  let startPromise = null
  let server = null // { port, close }

  function ipAllowed(ip) {
    if (allowedIps.length === 0) return true
    const bare = String(ip ?? '').replace(/^::ffff:/, '')
    return allowedIps.some((entry) => entry.replace(/^::ffff:/, '') === bare)
  }

  function handlePayload(payload, { ip } = {}) {
    if (!ipAllowed(ip)) {
      warn(`拒绝回调来源 IP：${ip}（不在 allowedIps）`)
      return
    }
    const action = String(payload?.action ?? '')
    const data = (payload?.data !== null && typeof payload?.data === 'object') ? payload.data : {}
    try {
      if (action === 'send_up_cmd') {
        const uid = String(data.uid ?? '')
        const time = String(data.time ?? '')
        const appId = String(data.appId ?? '')
        const text = stripCommandPrefix(data.content, appId)
        if (uid === '' || text === '') return
        // v0.7：accept 返回值消费——拒绝/命令回执不再已读不回
        const result = bus.accept({
          channel: 'wxpusher',
          userId: uid,
          chatId: uid,
          messageId: `cmd:${uid}:${time}:${hash6(text)}`,
          text,
        })
        if (result?.reply !== undefined) {
          pushToUid(uid, String(result.reply)).catch((error) => {
            warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`) // 回执失败不致命
          })
        }
        return
      }
      if (action === 'app_subscribe') {
        const uid = String(data.uid ?? '')
        if (uid !== '') {
          try { store?.set(`wxpusher:bind:${uid}`, { at: Date.now(), extra: String(data.extra ?? '') }) } catch { /* 落盘失败不致命 */ }
          // v0.7 学习键汇流（计划书 §3.6）：订阅 uid 进待确认绑定，管理台成员页收口
          // （origin=learned；已是成员时 addPending 幂等拒绝，不产生重复条目）
          if (identity !== null && typeof identity.addPending === 'function') {
            try {
              const learned = identity.addPending({ channel: 'wxpusher', userId: uid, origin: 'learned', extra: { source: 'app_subscribe', extra: String(data.extra ?? '').slice(0, 256) } })
              if (learned.ok) warn(`uid ${uid} 已订阅（已入待确认绑定，管理台成员页可转正）`)
            } catch (error) {
              warn(`订阅学习入待确认失败（不致命）: ${error instanceof Error ? error.message : String(error)}`)
            }
          } else {
            warn(`uid ${uid} 已订阅（绑定已学习${data.extra !== undefined ? `，extra=${String(data.extra)}` : ''}）`)
          }
        }
        return
      }
      // 官方声明动作类型会扩展：未知动作记日志放行
      warn(`未知回调动作 ${action || '(empty)'}：忽略`)
    } catch (error) {
      warn(`回调处理异常: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function pushToUid(uid, content) {
    if (fetchImpl === undefined) return null
    await rateGate.gate()
    const response = await fetchImpl(SEND_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appToken: config.appToken,
        content: String(content ?? '').slice(0, 4000),
        summary: String(content ?? '').split('\n')[0].slice(0, 100),
        contentType: 1,
        uids: [String(uid)],
        topicIds: [],
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10000),
    })
    const payload = await response.json().catch(() => null)
    if (typeof payload?.code !== 'number' || payload.code !== 1000) {
      throw new Error(`wxpusher 推送失败（code ${payload?.code ?? `HTTP ${response.status}`}：${payload?.msg ?? ''}）`)
    }
    return hash6(`${uid}:${content}`)
  }

  return {
    channel: 'wxpusher',
    capabilities: { buttons: false },

    /** 启动回调服务器（幂等）。 */
    start() {
      if (running || startPromise !== null) return
      running = true
      startPromise = (async () => {
        try {
          server = await startServer({
            path: config.webhookPath,
            host: config.host,
            port: config.port,
            onPayload: handlePayload,
            logger,
          })
          warn(`回调服务器已监听 ${config.host}:${server.port}${config.webhookPath}（填入 WxPusher 应用后台的回调地址）`)
        } catch (error) {
          running = false
          startPromise = null
          warn(`wxpusher inbound 启动失败（本通道不可用，不影响其他通道）: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    },

    /** 关闭回调服务器（幂等）。 */
    async stop() {
      running = false
      try { await startPromise } catch { /* 启动失败不影响停止 */ }
      if (server !== null) {
        await server.close().catch(() => {})
        server = null
      }
      startPromise = null
    },

    /** 实际监听端口（启动前为 null；测试用）。 */
    get port() {
      return server?.port ?? null
    },

    /** 审批推送目标（v0.7 三级解析）：绑定成员 → notifyUids → 全局回落（仅绑定表整体空）。 */
    notifyTargets() {
      return resolveNotifyTargets({
        identity,
        channel: 'wxpusher',
        configTargets: Array.isArray(config.notifyUids) ? config.notifyUids.map(String) : [],
        fallbackTargets,
      })
    },

    /** 推审批文本通知（无按钮，回复 1/2 裁决）；失败 null 降级纯通知。 */
    async sendApprovalCard({ chatId, title, content }) {
      try {
        const messageId = await pushToUid(chatId, `${title}\n${content}\n\n回复 1 批准 / 2 拒绝`)
        return messageId !== null ? { messageId } : null
      } catch (error) {
        warn(`审批通知发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /** 推送不可编辑：补发一条结果回执（尽力而为）。 */
    async editResolved(target, text) {
      if (target?.chatId === undefined || String(target.chatId) === '') return
      try {
        await pushToUid(target.chatId, `[审批结果] ${text}`)
      } catch (error) {
        warn(`审批结果回执失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /** 定向推送文本（命令回执）。 */
    async sendText(chatId, text) {
      try {
        return (await pushToUid(chatId, text)) !== null
      } catch (error) {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
  }
}
