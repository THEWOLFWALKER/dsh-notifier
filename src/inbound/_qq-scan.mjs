// dsh-notifier inbound/_qq-scan.mjs
// QQ 官方扫码创建/绑定机器人（v0.3.1）：@tencent-connect/qqbot-connector（optionalDependencies）。
// 流程（官方 connector 1.2.0 扫码授权语义）：
//   startQrConnect(占位凭证, 回调) → onQrCode 推二维码 URL（CLI 渲染终端二维码）
//   → 用户 QQ 扫码确认 → 会话 resolve 出凭证数组（官方批量授权：一次扫码可能授权多个机器人）
//   → 遍历取第一个 appId/appSecret 均非空的有效项 → 落 state store 'qq:account'（含 at 时间戳）
// SDK 懒加载：connector 为 optionalDependencies——未安装时返回 missing-sdk + 中文指引，绝不 throw
// （与 feishu-bot.mjs 的缺包降级模式一致）；超时/抛错一律归一为 { status, message } 结果对象，
// 形态由 scripts/channel-login.mjs 的 loginQq 消费（status: ok/missing-sdk/failed，ok 带 appId）。

const CONNECTOR_PACKAGE = '@tencent-connect/qqbot-connector'
const ACCOUNT_KEY = 'qq:account'

/** 判定 loader/import 失败是否属于「包未安装」类（ERR_MODULE_NOT_FOUND / resolver 报错）。 */
function isModuleMissing(error) {
  const code = String(error?.code ?? '')
  const message = error instanceof Error ? error.message : String(error ?? '')
  return code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package|Failed to resolve|MODULE_NOT_FOUND/i.test(message)
}

/**
 * 日志归一：scripts/channel-login.mjs 传 log(message) 函数（CLI 契约），
 * 库内调用可传 logger 对象（feishu-bot.mjs 同款 { info?, warn? } 形态）。
 * 日志失败绝不致命。
 */
function makeLog({ log, logger }) {
  return (message) => {
    try {
      if (typeof log === 'function') log(message)
      else logger?.info?.('[dsh-notifier/qq-scan]', message)
    } catch { /* 日志异常不影响扫码 */ }
  }
}

/**
 * 等待扫码会话完成，resolve 出官方凭证数组。
 * 防御性兼容（对官方 1.2.0 导出形态的防御）：
 *   常见形态 startQrConnect 直接返回 Promise<凭证数组>，直接 await 即可；
 *   个别版本/打包产物返回「会话对象」（等待句柄挂在 wait()/promise/result 字段上），
 *   这里逐一兜底，避免官方小版本调整等待形态导致整体失败。
 * @param {Promise<any> | { wait?: () => any, promise?: any, result?: any }} session
 */
async function settleSession(session) {
  if (session !== null && typeof session === 'object' && typeof session.then !== 'function') {
    if (typeof session.wait === 'function') return session.wait()
    if (session.promise !== undefined) return session.promise
    if (session.result !== undefined) return session.result
  }
  return session
}

/**
 * QQ 官方扫码创建/绑定机器人。
 * @param {object} options
 * @param {{ set(key: string, value: object): void }} options.store - state store（凭证落盘 qq:account）
 * @param {(url: string) => void} [options.onQr] - 二维码 URL 回调（CLI 渲染终端二维码；抛错不致命）
 * @param {number} [options.timeoutMs=480000] - 扫码总超时毫秒
 * @param {object} [options.logger] - 日志对象（{ info? }）；CLI 契约另支持 log(message) 函数
 * @param {() => Promise<object>} [options.connectorLoader] - connector 懒加载器（测试注入 mock）
 * @returns {Promise<{ status: 'ok'|'missing-sdk'|'failed', appId?: string, message?: string }>}
 *   绝不 throw：所有失败路径（缺包/版本不兼容/SDK 抛错/超时/凭证无效）都归一为结果对象。
 */
export async function qqScan({ store, onQr, timeoutMs = 480000, logger, connectorLoader, log } = {}) {
  const emitLog = makeLog({ log, logger })
  // onQr 回调（二维码渲染）抛错不致命：吞掉后扫码流程继续
  const emitQr = (url) => {
    try { onQr?.(url) } catch { /* 渲染失败不影响扫码 */ }
  }
  const loadConnector = connectorLoader ?? (async () => import(CONNECTOR_PACKAGE))

  let timedOut = false // 超时后即使会话迟到完成也不落盘半截凭证

  const work = (async () => {
    let connector
    try {
      connector = await loadConnector()
    } catch (error) {
      if (isModuleMissing(error)) {
        return {
          status: 'missing-sdk',
          message: `未安装 ${CONNECTOR_PACKAGE}（扫码创建机器人需要它）。可执行 npm i ${CONNECTOR_PACKAGE} 后重试，或在 q.qq.com 手动获取 appId/appSecret 填入 inbound.qq`,
        }
      }
      return { status: 'failed', message: `加载 ${CONNECTOR_PACKAGE} 失败：${error instanceof Error ? error.message : String(error)}` }
    }

    // 防御性导出兼容（对官方 1.2.0 导出形态的防御）：
    // 官方 README 形态为具名导出 startQrConnect；个别打包产物/转译链会挂到 default.startQrConnect。
    // 两级都取不到时按「版本不兼容」failed（不按 missing-sdk：包已装到，是导出形态变了）。
    const startQrConnect = typeof connector?.startQrConnect === 'function'
      ? connector.startQrConnect
      : typeof connector?.default?.startQrConnect === 'function'
        ? connector.default.startQrConnect
        : null
    if (startQrConnect === null) {
      return { status: 'failed', message: `${CONNECTOR_PACKAGE} 导出形态不兼容（未找到 startQrConnect）：请确认安装 ^1.2.0 版本后重试` }
    }

    let credentials
    try {
      // 官方调用骨架：占位凭证（扫码创建阶段无需预置 appId/appSecret）+ onQrCode 回调收二维码 URL；
      // 扫码确认后 resolve 出凭证数组（官方批量授权语义）。
      const session = startQrConnect(
        { appId: '', appSecret: '' },
        { onQrCode: (url) => emitQr(url) },
      )
      credentials = await settleSession(session)
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
    }

    // 遍历凭证数组取第一个有效项（appId 与 appSecret 均非空才算可用凭证，跳过占位/半截项）
    const list = Array.isArray(credentials) ? credentials : []
    const valid = list.find((item) => item !== null && typeof item === 'object'
      && String(item.appId ?? '') !== '' && String(item.appSecret ?? '') !== '')
    if (valid === undefined) {
      return { status: 'failed', message: '扫码已完成但未返回有效凭证（appId/appSecret 缺失），请重新执行' }
    }
    if (timedOut) return { status: 'failed', message: '扫码超时' }
    const appId = String(valid.appId)
    store?.set?.(ACCOUNT_KEY, { appId, appSecret: String(valid.appSecret), at: Date.now() })
    emitLog(`QQ 扫码授权成功：appId=${appId}（已写入 ${ACCOUNT_KEY}）`)
    return { status: 'ok', appId }
  })()

  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve(null) }, Math.max(0, Number(timeoutMs) || 0))
  })
  try {
    // race 先到先得；work 的迟到 rejection 由 race 内部吸收，不会产生 unhandledRejection
    const result = await Promise.race([work, timeout])
    return result === null ? { status: 'failed', message: '扫码超时' } : result
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
