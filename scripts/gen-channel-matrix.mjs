#!/usr/bin/env node
// dsh-notifier scripts/gen-channel-matrix.mjs
// 从 src/config.mjs 的渠道注册表生成 README 渠道矩阵，防止「加渠道忘改文档」漂移。
// 用法：
//   node scripts/gen-channel-matrix.mjs          # 重写 README.md 中标记区间的表格
//   node scripts/gen-channel-matrix.mjs --check  # 只比对不写入（CI 用），漂移时 exit 1
// 红线：META 键集合必须与 CHANNEL_TYPES 完全一致——新增渠道不改 META 直接报错，
// 渠道列表永远只有一处事实来源（config.mjs 的 ADAPTERS 注册表）。

import { readFileSync, writeFileSync } from 'node:fs'
import { CHANNEL_TYPES } from '../src/config.mjs'

const START = '<!-- CHANNEL-MATRIX-START -->'
const END = '<!-- CHANNEL-MATRIX-END -->'

/** 渠道人类可读元数据：Auth 列写「去哪里拿凭证」的摘要，Free? 列写免费策略。 */
const META = {
  bark: { channel: 'Bark (iOS)', auth: 'device key (or self-host URL)', free: '✅' },
  bell: { channel: 'Terminal bell (local)', auth: '—', free: 'local' },
  desktop: { channel: 'Desktop notification (local)', auth: '— (Windows needs BurntToast module)', free: 'local' },
  chanify: { channel: 'Chanify (iOS)', auth: 'token (or self-host)', free: '✅' },
  dingtalk: { channel: 'DingTalk custom robot', auth: 'webhook + secret (HMAC sign)', free: '✅' },
  discord: { channel: 'Discord webhook', auth: 'webhook URL', free: '✅' },
  feishu: { channel: 'Feishu custom bot', auth: 'webhook (+ sign secret)', free: '✅' },
  gchat: { channel: 'Google Chat', auth: 'space webhook URL', free: '✅' },
  gotify: { channel: 'Gotify', auth: 'server URL + app token', free: 'self-host' },
  igot: { channel: 'iGot (iOS)', auth: 'push key', free: '✅ (limits)' },
  mattermost: { channel: 'Mattermost', auth: 'base URL + token (+ channel)', free: 'self-host' },
  ntfy: { channel: 'ntfy', auth: 'topic (+ server URL)', free: '✅ (self-host)' },
  onebot: { channel: 'OneBot 11 (QQ)', auth: 'HTTP endpoint', free: 'self-host' },
  pushdeer: { channel: 'PushDeer', auth: 'push key', free: '✅' },
  pushover: { channel: 'Pushover', auth: 'user key + app token', free: 'paid (one-time)' },
  pushplus: { channel: 'PushPlus (WeChat)', auth: 'token', free: '✅ (limits)' },
  qmsg: { channel: 'Qmsg酱 (QQ)', auth: 'key + qq number', free: '✅ (limits)' },
  'qq-bot': { channel: 'QQ official bot', auth: 'appId + appSecret', free: '✅' },
  serverchan: { channel: 'Server酱 (WeChat)', auth: 'sendkey', free: '✅ (limits)' },
  slack: { channel: 'Slack', auth: 'incoming webhook URL', free: '✅' },
  teams: { channel: 'Microsoft Teams', auth: 'Power Automate workflow URL', free: '✅' },
  telegram: { channel: 'Telegram Bot API', auth: 'bot token + chat id', free: '✅' },
  webhook: { channel: 'Any custom endpoint', auth: '—', free: '—' },
  wecom: { channel: 'WeCom group robot', auth: 'webhook key', free: '✅' },
  'wecom-app': { channel: 'WeCom app message', auth: 'corpid + agentId + secret', free: '✅' },
  wxpusher: { channel: 'WxPusher (WeChat)', auth: 'appToken + uid', free: '✅ (limits)' },
  xizhi: { channel: '息知 Xizhi', auth: 'sendkey', free: '✅ (limits)' },
}

function fail(message) {
  console.error(`gen-channel-matrix: ${message}`)
  process.exit(1)
}

// 漂移守卫：META 与注册表必须一一对应（多、少、键名不一致都失败）
const metaKeys = Object.keys(META).sort()
const registry = [...CHANNEL_TYPES].sort()
const missing = registry.filter((type) => !(type in META))
const extra = metaKeys.filter((type) => !registry.includes(type))
if (missing.length > 0) fail(`META 缺少渠道：${missing.join(', ')}（新增渠道请在 scripts/gen-channel-matrix.mjs 的 META 里补一行）`)
if (extra.length > 0) fail(`META 有多余渠道：${extra.join(', ')}（渠道已从注册表移除？请删除对应 META 行）`)

const header = '| type | Channel | Auth | Free? |\n|---|---|---|---|'
const rows = registry.map((type) => {
  const meta = META[type]
  return `| \`${type}\` | ${meta.channel} | ${meta.auth} | ${meta.free} |`
})
const table = [header, ...rows].join('\n')

const readmePath = new URL('../README.md', import.meta.url)
const readme = readFileSync(readmePath, 'utf8')

const updated = readme.includes(START)
  ? readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), `${START}\n\n${table}\n\n${END}`)
  : fail(`README.md 未找到 ${START} 标记（首次使用请手动把渠道表格包进标记区间）`)

if (process.argv.includes('--check')) {
  if (updated === readme) {
    console.log(`OK: README 渠道矩阵与注册表一致（${registry.length} 渠道）`)
  } else {
    fail('README 渠道矩阵与注册表漂移：运行 `node scripts/gen-channel-matrix.mjs` 后提交')
  }
} else {
  writeFileSync(readmePath, updated, 'utf8')
  console.log(`已重写 README 渠道矩阵（${registry.length} 渠道）`)
}
