// dsh-notifier inbound/_feishu-register.mjs
// 飞书官方扫码一键创建自建应用（v0.3.1）：@larksuiteoapi/node-sdk ≥1.61.1 内置的 registerApp。
// 流程：registerApp({ onQRCodeReady, addons, createOnly }) → SDK 内部轮询授权状态机
//   → onQRCodeReady 推二维码 URL（CLI 渲染终端二维码）→ 用户扫码确认
//   → resolve { status, client_id, client_secret, user_info?: { open_id } }
//   → 状态机：user_denied → denied（账号无建应用权限/点了拒绝）；expired → expired（二维码过期）；
//     凭证齐全 → 落 state store 'feishu:account'（含 at 时间戳），openId 一并带回给 CLI（白名单提示）。
// SDK 懒加载：node-sdk 为 optionalDependencies——未安装（或版本 <1.61.1 没有 registerApp）时返回
// missing-sdk + 中文指引，绝不 throw（与 feishu-bot.mjs 缺包降级模式一致）；
// 结果对象形态由 scripts/channel-login.mjs 的 loginFeishu 消费（status/appId/openId/message）。

const SDK_PACKAGE = '@larksuiteoapi/node-sdk'
const MIN_SDK_VERSION = '1.61.1'
const ACCOUNT_KEY = 'feishu:account'

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
      else logger?.info?.('[dsh-notifier/feishu-register]', message)
    } catch { /* 日志异常不影响扫码 */ }
  }
}

/**
 * 飞书官方扫码一键创建自建应用。
 * @param {object} options
 * @param {{ set(key: string, value: object): void }} options.store - state store（凭证落盘 feishu:account）
 * @param {(url: string) => void} [options.onQr] - 二维码 URL 回调（CLI 渲染终端二维码；抛错不致命）
 * @param {number} [options.timeoutMs=480000] - 扫码总超时毫秒
 * @param {object} [options.logger] - 日志对象（{ info? }）；CLI 契约另支持 log(message) 函数
 * @param {() => Promise<object>} [options.sdkLoader] - node-sdk 懒加载器（测试注入 mock）
 * @returns {Promise<{ status: 'ok'|'missing-sdk'|'denied'|'expired'|'failed', appId?: string,
 *                     openId?: string, message?: string }>} 绝不 throw。
 */
export async function feishuRegister({ store, onQr, timeoutMs = 480000, logger, sdkLoader, log } = {}) {
  const emitLog = makeLog({ log, logger })
  // onQr 回调（二维码渲染）抛错不致命：吞掉后扫码流程继续
  const emitQr = (url) => {
    try { onQr?.(url) } catch { /* 渲染失败不影响扫码 */ }
  }
  const loadSdk = sdkLoader ?? (async () => import(SDK_PACKAGE))

  let timedOut = false // 超时后即使 registerApp 迟到完成也不落盘半截凭证

  const work = (async () => {
    let sdk
    try {
      sdk = await loadSdk()
    } catch (error) {
      if (isModuleMissing(error)) {
        return {
          status: 'missing-sdk',
          message: `未安装 ${SDK_PACKAGE}（需 ≥${MIN_SDK_VERSION}，registerApp 扫码建应用为 ${MIN_SDK_VERSION} 新增）。可执行 npm i ${SDK_PACKAGE}@^${MIN_SDK_VERSION} 后重试，或在飞书开放平台手动创建自建应用填入 inbound.feishu`,
        }
      }
      return { status: 'failed', message: `加载 ${SDK_PACKAGE} 失败：${error instanceof Error ? error.message : String(error)}` }
    }

    // 防御性导出兼容：官方 ≥1.61.1 为具名导出 registerApp；个别打包形态/转译链会挂到 default.registerApp。
    // 模块能加载但取不到 registerApp ⇒ 装的是 <1.61.1 旧版——同样按 missing-sdk 语义返回
    // （CLI 对 missing-sdk 会给安装/升级指引，比笼统 failed 更可操作）。
    const registerApp = typeof sdk?.registerApp === 'function'
      ? sdk.registerApp
      : typeof sdk?.default?.registerApp === 'function'
        ? sdk.default.registerApp
        : null
    if (registerApp === null) {
      return {
        status: 'missing-sdk',
        message: `已安装 ${SDK_PACKAGE} 但版本过旧（未找到 registerApp，需 ≥${MIN_SDK_VERSION}）。可执行 npm i ${SDK_PACKAGE}@^${MIN_SDK_VERSION} 后重试`,
      }
    }

    let outcome
    try {
      outcome = await registerApp({
        // 新版 SDK registerApp 的回调名是 onQRCodeReady（接收 { url, expireIn }），
        // 旧的 onQrCode 会让 SDK 拿到 undefined 回调并抛 "onQRCodeReady is not a function"。
        onQRCodeReady: (info) => emitQr(info?.url),
        // 最小权限集（与 feishu-bot.mjs 长连接收发能力一一对应，申请多了过不了企业管理员审）。
        // 新版 @larksuiteoapi/node-sdk 的 normalizeAddons 只接受 preset/scopes/events/callbacks
        // （见 SDK es/index.js normalizeAddons），旧的 resources 名值映射会抛
        // "addons.resources is not allowed" 导致扫码建应用失败，故改用 scopes/events/callbacks。
        //   preset: false —— 不安装官方「全家桶」预设权限组，只申请下面声明的 im 权限；
        //   scopes.tenant:
        //     im:message                              —— 读取消息（基础）
        //     im:message.p2p_msg:readonly             —— 读取用户发给机器人的单聊消息（私聊入站）
        //     im:message.group_at_msg:readonly        —— 读取群组中用户@机器人消息（群聊入站）
        //     im:message.group_msg.include_bot:read   —— 读取群组中用户和机器人发送的消息
        //     im:message.group_at_msg.include_bot:readonly —— 读取群组中其他机器人和用户@当前机器人的消息
        //     im:message.group_msg                    —— 读取群组中所有消息（敏感）
        //     im:chat                                 —— 读取群基础信息（群聊回执/卡片推送定位会话用）
        //     im:message:send_as_bot                  —— 以机器人身份发送消息（出站/回执）
        //   events.items.tenant: im.message.receive_v1 —— 长连接订阅文本消息（私聊/群聊入站）
        //   callbacks.items:     card.action.trigger     —— 长连接订阅卡片按钮回调（审批/停止）
        //   注：扫码确认页仍可手动增补权限；addons 只需结构合法即可放行扫码。
        addons: {
          preset: false,
          scopes: {
            tenant: [
              'im:message',
              'im:message.p2p_msg:readonly',
              'im:message.group_at_msg:readonly',
              'im:message.group_msg.include_bot:read',
              'im:message.group_at_msg.include_bot:readonly',
              'im:message.group_msg',
              'im:chat',
              'im:message:send_as_bot',
            ],
            user: [],
          },
          events: {
            items: { tenant: ['im.message.receive_v1'] },
          },
          callbacks: {
            items: ['card.action.trigger'],
          },
        },
        createOnly: true, // 只创建自建应用，不动扫码账号已有应用
      })
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
    }

    // SDK 状态机：先看终态标志，再看凭证完整性
    const status = String(outcome?.status ?? '')
    if (status === 'user_denied') {
      return { status: 'denied', message: '授权被拒绝：请确认扫码账号有创建自建应用的权限（企业管理员），并在扫码后点击同意授权' }
    }
    if (status === 'expired') {
      return { status: 'expired', message: '二维码已过期，请重试' }
    }
    const appId = String(outcome?.client_id ?? '')
    const appSecret = String(outcome?.client_secret ?? '')
    if (appId === '' || appSecret === '') {
      return { status: 'failed', message: `扫码建应用返回凭证不完整（client_id/client_secret 缺失${status !== '' ? `，status=${status}` : ''}），请重新执行` }
    }
    if (timedOut) return { status: 'failed', message: '扫码超时' }
    const openId = String(outcome?.user_info?.open_id ?? '')
    store?.set?.(ACCOUNT_KEY, { appId, appSecret, at: Date.now() })
    emitLog(`飞书扫码建应用成功：appId=${appId}（已写入 ${ACCOUNT_KEY}）`)
    // openId 兜底空串（CLI 用 result.openId !== '' 判断是否提示白名单，绝不能是 undefined）
    return { status: 'ok', appId, openId }
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
