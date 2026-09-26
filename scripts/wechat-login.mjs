#!/usr/bin/env node
// dsh-notifier scripts/wechat-login.mjs
// 微信 iLink Bot 扫码登录 CLI（v0.3.0 阶段 4）：
//   node scripts/wechat-login.mjs [--state <目录>] [--timeout <秒>] [--bot-type 3]
// 流程（对照 Hermes weixin.py 行 1038-1169 状态机）：
//   get_bot_qrcode → 终端渲染二维码（qrcode-terminal 可选依赖，缺省打印可扫链接）
//   → 1s 轮询 get_qrcode_status：wait → scaned → (scaned_but_redirect 切 baseurl)
//     → confirmed 取凭证 {accountId, token, baseUrl, userId} 原子落 state.json
//   → expired 自动刷新二维码（≤3 次）；总超时默认 480s
// 凭证落在 state store 的 wechat:account 键，dsh-notifier 启动时自动读取。
// 运行约束：单 token 同时只允许一个网关实例在线（协议本身如此）。

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createStore, defaultStateDir, setDurable } from '../src/inbound/store.mjs'
import { createIlinkClient, ILINK_BASE_URL } from '../src/inbound/_ilink-api.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'

function parseArgs(argv) {
  const args = { state: '', timeout: 480, botType: '3' }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--state') args.state = argv[++i] ?? ''
    else if (arg === '--timeout') args.timeout = Number(argv[++i] ?? 480)
    else if (arg === '--bot-type') args.botType = String(argv[++i] ?? '3')
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

const HELP = `用法：node scripts/wechat-login.mjs [--state <state目录>] [--timeout <秒>] [--bot-type 3]
  --state     凭证落盘目录（默认 $DSH_HOME/dsh-notifier，与插件 stateDir 一致）
  --timeout   登录总超时秒数（默认 480）
  --bot-type  iLink 机器人类型（默认 3，一般不改）`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 渲染二维码：优先 qrcode-terminal（可选依赖）；缺省打印可扫链接。 */
async function renderQr(scanData) {
  try {
    const { toString } = await import('qrcode-terminal')
    await new Promise((resolveRender) => toString(scanData, { small: true }, (error, text) => {
      if (error == null && typeof text === 'string' && text !== '') console.log(text)
      resolveRender()
    }))
    return
  } catch {
    // 未安装 qrcode-terminal：打印链接即可（微信「扫一扫 → 相册/输入链接」均可）
  }
  console.log('（未安装 qrcode-terminal，请用微信扫一扫打开上面链接，或 npm i -g qrcode-terminal 后重试）')
}

/** 取二维码并展示；失败返回 null。 */
async function fetchAndShowQr(client, botType) {
  const response = await client.getBotQrcode(botType)
  const qrcode = String(response?.qrcode ?? '')
  const url = String(response?.qrcode_img_content ?? '')
  if (qrcode === '') return null
  console.log('')
  if (url !== '') console.log(`二维码链接：${url}`)
  await renderQr(url !== '' ? url : qrcode)
  console.log('请使用微信扫描二维码…')
  return { qrcode, url }
}

/**
 * 处理微信扫码确认：凭证必须先 durable 落盘成功，才做身份绑定与成功文案。
 * 可测入口（tests 注入 store / log / error sink），返回退出码。
 */
export function applyWechatConfirmation({ store, statusResp, stateFile, log = console.log, error = console.error }) {
  const accountId = String(statusResp?.ilink_bot_id ?? '')
  const token = String(statusResp?.bot_token ?? '')
  const baseUrl = String(statusResp?.baseurl ?? '') || ILINK_BASE_URL
  const userId = String(statusResp?.ilink_user_id ?? '')
  if (accountId === '' || token === '') {
    error('登录确认但凭证不完整（ilink_bot_id / bot_token 缺失），请重新执行。')
    return 1
  }
  // 凭证必须以 durable 结果为准：落盘失败绝不宣称成功，也不做身份绑定。
  if (setDurable(store, 'wechat:account', { accountId, token, baseUrl, userId, at: Date.now() }) !== true) {
    error('\n微信授权成功，但凭证写入失败（磁盘/权限/锁）。登录未完成，请检查 state 目录后重试。')
    return 1
  }
  log(`\n微信连接成功：accountId=${accountId}${userId !== '' ? ` userId=${userId}` : ''}`)
  // 扫码即配对：iLink 机器人是扫码微信的专属好友（1:1，只有扫码者能和它聊），
  // 扫码确认那一刻身份已唯一确定——直接写绑定（首条即 owner），不需要配对码。
  if (userId !== '') {
    const bound = createIdentity({ store }).addBinding({ channel: 'wechat', userId, origin: 'paired' })
    if (bound.ok) {
      log(`扫码即配对完成：该微信已绑定为${bound.record.role === 'owner' ? ' owner（首位成员）' : '成员'}，无需再发 /pair。`)
    } else if (bound.reason === 'storage-failed') {
      // 凭证已可靠落盘；仅身份绑定失败：如实报告部分成功，别谎称整体失败。
      log('凭证已保存，但自动配对未完成（本地存储写入失败）；重启后可发 /pair 配对码补齐。')
    } else {
      log('该微信已绑定过，无需重复配对。')
    }
  } else {
    log('提示：本次登录未返回 userId（旧协议产物），未自动配对；重启后可用 /pair 配对码补齐。')
  }
  log(`凭证已写入 ${stateFile}（wechat:account）。插件配置 inbound.wechat: {} 即可启用。`)
  log('说明：机器人只和扫码微信一对一聊天；同一 token 同时只能有一个网关实例在线。')
  return 0
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log(HELP)
    return 0
  }
  const stateDir = args.state !== '' ? args.state : defaultStateDir()
  const stateFile = resolve(stateDir, 'state.json')
  const store = createStore(stateFile)

  let client = createIlinkClient({ baseUrl: ILINK_BASE_URL })
  const qr = await fetchAndShowQr(client, args.botType)
  if (qr === null) {
    console.error('获取二维码失败：服务端未返回 qrcode 字段')
    return 1
  }

  const deadline = Date.now() + Math.max(30, args.timeout) * 1000
  let refreshCount = 0
  let currentQr = qr

  while (Date.now() < deadline) {
    let statusResp
    try {
      statusResp = await client.getQrcodeStatus(currentQr.qrcode)
    } catch (error) {
      console.warn(`状态轮询失败（1s 后重试）：${error instanceof Error ? error.message : String(error)}`)
      await sleep(1000)
      continue
    }
    const status = String(statusResp?.status ?? 'wait')
    if (status === 'wait') {
      process.stdout.write('.')
    } else if (status === 'scaned') {
      console.log('\n已扫码，请在微信里点确认…')
    } else if (status === 'scaned_but_redirect') {
      const host = String(statusResp?.redirect_host ?? '')
      if (host !== '') {
        client = createIlinkClient({ baseUrl: `https://${host}` })
        console.log(`\n已扫码（跨机房重定向 → ${host}），请继续在微信里点确认…`)
      }
    } else if (status === 'expired') {
      refreshCount += 1
      if (refreshCount > 3) {
        console.error('\n二维码多次过期，请重新执行登录。')
        return 1
      }
      console.log(`\n二维码已过期，正在刷新（${refreshCount}/3）…`)
      client = createIlinkClient({ baseUrl: ILINK_BASE_URL })
      const refreshed = await fetchAndShowQr(client, args.botType)
      if (refreshed === null) {
        console.error('二维码刷新失败，请重新执行登录。')
        return 1
      }
      currentQr = refreshed
    } else if (status === 'confirmed') {
      return applyWechatConfirmation({ store, statusResp, stateFile })
    }
    await sleep(1000)
  }
  console.error('\n微信登录超时。')
  return 1
}

// 直接运行守卫：被测试文件 import 时不执行 main（对齐 scripts/route.mjs 约定）。
// channel-login.mjs 以子进程方式调用本脚本，argv[1] 命中脚本路径，照常执行。
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`登录异常退出：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  })
}
