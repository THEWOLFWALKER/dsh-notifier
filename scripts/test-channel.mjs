#!/usr/bin/env node
// dsh-notifier scripts/test-channel.mjs
// 渠道健康自检 CLI：真机验证一个渠道配置（resolve → send 全链路）。
// 用法：
//   node scripts/test-channel.mjs telegram '{"botToken":"...","chatId":"..."}'
//   node scripts/test-channel.mjs bark --config '{"key":"..."}'
//   echo '{"key":"..."}' | node scripts/test-channel.mjs bark
//   node scripts/test-channel.mjs bark --config-file cfg.json --message "自定义正文"
// 配置 JSON 支持 ${ENV:NAME} 引用（与插件运行时一致）。退出码 0=成功 1=失败。

import { readFileSync } from 'node:fs'
import { runChannelTest } from '../src/health.mjs'

const args = process.argv.slice(2)
const positional = []
const flags = {}
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--config' || arg === '--message' || arg === '--config-file') {
    flags[arg] = args[index + 1]
    index += 1
    continue
  }
  positional.push(arg)
}

const type = positional[0]
let configRaw = flags['--config']
if (configRaw === undefined && flags['--config-file'] !== undefined) {
  try { configRaw = readFileSync(flags['--config-file'], 'utf8') } catch (error) {
    console.error(`读取配置文件失败：${error.message}`)
    process.exit(1)
  }
}
if (configRaw === undefined && type !== undefined) {
  configRaw = positional[1] // 位置参数第二位也接受配置 JSON
}

if (type === undefined || type === '' || configRaw === undefined || configRaw === '') {
  if (type !== undefined && !process.stdin.isTTY) {
    // 只有类型没配置：从 stdin 读（管道/重定向场景）。TTY 交互终端不读——
    // readFileSync(0) 在 TTY 上会阻塞等输入，用户应该看到用法提示而不是卡住。
    try {
      configRaw = readFileSync(0, 'utf8')
    } catch { /* 无 stdin */ }
  }
}

if (type === undefined || type === '' || configRaw === undefined || configRaw === '') {
  console.error('用法：node scripts/test-channel.mjs <channel-type> [config-json]')
  console.error('  config-json 也可用 --config "<json>" / --config-file <file> / stdin 提供；支持 ${ENV:NAME} 引用')
  process.exit(1)
}

let rawConfig
try {
  rawConfig = JSON.parse(configRaw)
} catch (error) {
  console.error(`配置 JSON 解析失败：${error.message}`)
  process.exit(1)
}

const result = await runChannelTest({ type, rawConfig, message: flags['--message'] })
if (result.ok) {
  console.log(`✅ [${result.channel}] ${result.detail}`)
  process.exit(0)
}
console.error(`❌ [${result.channel}] ${result.detail}`)
process.exit(1)
