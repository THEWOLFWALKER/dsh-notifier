#!/usr/bin/env node
// dsh-notifier scripts/channel-login.mjs
// 官方扫码授权统一 CLI（v0.3.1）：
//   node scripts/channel-login.mjs <qq|dingtalk|feishu|wechat> [--state <目录>] [--timeout <秒>]
// 各通道机制：
//   qq       官方 qqbot-connector 扫码创建/绑定机器人（optionalDep，缺包降级手填指引）
//   dingtalk 钉钉开放平台设备授权流（RFC 8628 形态，零依赖移植）扫码一键创建企业内部应用
//   feishu   飞书 registerApp 扫码一键创建自建应用（node-sdk ≥1.61.1，缺包降级手填指引）
//   wechat   复用 v0.3.0 wechat-login.mjs（iLink 扫码登录，子进程透传参数）
// 凭证统一原子落盘 state.json（0600）：qq:account / dingtalk:account / feishu:account；
// 插件侧 config 显式配置永远优先于扫码落盘值。

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore, defaultStateDir } from '../src/inbound/store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const CHANNELS = ['qq', 'dingtalk', 'feishu', 'wechat']

const HELP = `用法：node scripts/channel-login.mjs <qq|dingtalk|feishu|wechat> [--state <state目录>] [--timeout <秒>]
  qq        腾讯 QQBot v2 官方扫码创建/绑定机器人（免填 appId/appSecret）
  dingtalk  钉钉官方扫码一键创建企业内部应用（需已加入组织/企业的钉钉账号）
  feishu    飞书官方扫码一键创建自建应用（长连接收发）
  wechat    微信 iLink 扫码登录（个人号）
  --state   凭证落盘目录（默认 $DSH_HOME/dsh-notifier，与插件 stateDir 一致）
  --timeout 扫码总超时秒数（默认 480）

  --help    显示本帮助`

function parseArgs(argv) {
  const args = { channel: '', state: '', timeout: 480 }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--state') args.state = argv[++i] ?? ''
    else if (arg === '--timeout') args.timeout = Number(argv[++i] ?? 480)
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (!arg.startsWith('--') && args.channel === '') args.channel = arg.trim().toLowerCase()
  }
  return args
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 渲染二维码：优先 qrcode-terminal（可选依赖）；缺省打印可扫链接。 */
async function renderQr(scanData) {
  try {
    const { toString } = await import('qrcode-terminal')
    await new Promise((resolveRender) => {
      toString(scanData, { small: true }, (error, text) => {
        if (error == null && typeof text === 'string' && text !== '') console.log(text)
        resolveRender()
      })
    })
    return
  } catch {
    // 未安装 qrcode-terminal：打印链接（各平台「扫一扫 → 相册/链接」均可）
  }
  console.log('（未安装 qrcode-terminal，请用对应 App 扫一扫打开上面链接，或 npm i -g qrcode-terminal 后重试）')
}

async function showQr(url, appName) {
  console.log('')
  if (url !== '') console.log(`二维码链接：${url}`)
  if (url !== '') await renderQr(url)
  console.log(`请使用${appName}扫描二维码并确认授权…`)
}

/** 透传子进程跑既有 wechat-login.mjs（单一事实源，不复制登录状态机）。 */
function runWechatLogin(args) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [
      resolve(HERE, 'wechat-login.mjs'),
      '--state', args.state !== '' ? args.state : defaultStateDir(),
      '--timeout', String(Math.max(30, args.timeout)),
    ], { stdio: 'inherit' })
    child.on('exit', (code) => resolveExit(code ?? 1))
    child.on('error', (error) => {
      console.error(`启动 wechat-login 失败：${error instanceof Error ? error.message : String(error)}`)
      resolveExit(1)
    })
  })
}

async function loginQq(args, store) {
  const { qqScan } = await import('../src/inbound/_qq-scan.mjs')
  const result = await qqScan({
    store,
    timeoutMs: Math.max(30, args.timeout) * 1000,
    onQr: (url) => showQr(String(url ?? ''), 'QQ'),
    log: (message) => console.log(message),
  })
  if (result.status === 'ok') {
    console.log(`\nQQ 连接成功：appId=${result.appId}`)
    console.log('凭证已写入 state.json（qq:account）。插件配置 inbound.qq: {} 即可启用。')
    return 0
  }
  console.error(`\nQQ 扫码未完成：${result.message ?? result.status}`)
  if (result.status === 'missing-sdk') console.error('缺包可执行 npm i @tencent-connect/qqbot-connector 后重试，或在 q.qq.com 手动获取 appId/appSecret 填入 inbound.qq。')
  return 1
}

async function loginDingtalk(args, store, stateFile) {
  const { createDingtalkAuth } = await import('../src/inbound/_dingtalk-auth.mjs')
  const auth = createDingtalkAuth({})
  const deadline = Date.now() + Math.max(30, args.timeout) * 1000
  let refreshCount = 0
  let session = null

  while (Date.now() < deadline) {
    if (session === null) {
      session = await auth.start()
      if (session === null) {
        console.error('获取钉钉扫码会话失败，请稍后重试。')
        return 1
      }
      await showQr(session.qrUrl, '钉钉')
    }
    let result
    try {
      result = await auth.poll(session.verificationCode)
    } catch (error) {
      // 结构性错误重试无意义（响应形态坏了/授权流已废）：fail-fast 给出诊断；
      // 瞬态错误（超时/网络/HTTP 5xx）才值得下一轮重试。
      const code = error?.code ?? ''
      if (code === 'missing-field' || code === 'incomplete-registration' || code === 'api-error') {
        console.error(`\n钉钉授权流异常（${code}）：${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
      console.warn(`状态轮询失败（1s 后重试）：${error instanceof Error ? error.message : String(error)}`)
      await sleep(1000)
      continue
    }
    if (result.status === 'WAITING') {
      process.stdout.write('.')
    } else if (result.status === 'EXPIRED') {
      refreshCount += 1
      if (refreshCount > 3) {
        console.error('\n二维码多次过期，请重新执行登录。')
        return 1
      }
      console.log(`\n二维码已过期，正在刷新（${refreshCount}/3）…`)
      session = null
    } else if (result.status === 'FAIL') {
      console.error(`\n钉钉授权失败：${result.error ?? '服务端返回失败'}。可在开放平台检查账号/组织状态后重试。`)
      return 1
    } else if (result.status === 'SUCCESS') {
      const { appKey = '', appSecret = '' } = result.credentials ?? {}
      if (appKey === '' || appSecret === '') {
        console.error('\n授权成功但凭证不完整（appKey/appSecret 缺失），请重新执行。')
        return 1
      }
      store.set('dingtalk:account', { appKey, appSecret, at: Date.now() })
      console.log(`\n钉钉连接成功：appKey=${appKey}`)
      console.log(`凭证已写入 ${stateFile}（dingtalk:account）。插件配置 inbound.dingtalk: {} 即可启用。`)
      console.log('提醒：机器人可见范围即入站访问范围，请在钉钉管理后台将其开放给信任的组织成员。')
      return 0
    }
    await sleep(1000)
  }
  console.error('\n钉钉扫码超时。')
  return 1
}

async function loginFeishu(args, store) {
  const { feishuRegister } = await import('../src/inbound/_feishu-register.mjs')
  const result = await feishuRegister({
    store,
    timeoutMs: Math.max(30, args.timeout) * 1000,
    onQr: (url) => showQr(String(url ?? ''), '飞书'),
    log: (message) => console.log(message),
  })
  if (result.status === 'ok') {
    console.log(`\n飞书连接成功：appId=${result.appId}`)
    if (result.openId !== '') {
      console.log(`扫码者 openId=${result.openId}（建议加入 inbound.allowUsers 白名单）`)
    }
    console.log('凭证已写入 state.json（feishu:account）。插件配置 inbound.feishu: {} 即可启用。')
    return 0
  }
  console.error(`\n飞书扫码未完成：${result.message ?? result.status}`)
  if (result.status === 'missing-sdk') console.error('缺包可执行 npm i @larksuiteoapi/node-sdk@^1.61.1 后重试，或在开放平台手动创建自建应用填入 inbound.feishu。')
  if (result.status === 'denied') console.error('授权被拒绝：请确认扫码账号有创建自建应用的权限（企业管理员）。')
  return 1
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help || args.channel === '') {
    console.log(HELP)
    return args.help ? 0 : 1
  }
  if (!CHANNELS.includes(args.channel)) {
    console.error(`未知通道 "${args.channel}"（可用：${CHANNELS.join(' / ')}）`)
    return 1
  }
  if (args.channel === 'wechat') return runWechatLogin(args)

  const stateDir = args.state !== '' ? args.state : defaultStateDir()
  const stateFile = resolve(stateDir, 'state.json')
  const store = createStore(stateFile)

  if (args.channel === 'qq') return loginQq(args, store)
  if (args.channel === 'dingtalk') return loginDingtalk(args, store, stateFile)
  return loginFeishu(args, store)
}

main().then((code) => process.exit(code), (error) => {
  console.error(`扫码登录异常退出：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
