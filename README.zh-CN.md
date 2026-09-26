# dsh-notifier

<p align="center">
  <img src="https://raw.githubusercontent.com/THEWOLFWALKER/dsh-notifier/main/docs/assets/dsh-notifier-icon.png" width="132" alt="dsh-notifier logo">
</p>

<p align="center"><strong>Your agent, in your pocket.</strong><br>通知、审批、遥控，都在你的手机里；日常管理现在直接进入 DSH。</p>

> **维护公告**：至 **2026-10-01** 前作者因考试无法及时维护与查看 PR/Issue，回复会延迟，非常抱歉。

[**English**](README.md) · **简体中文**

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Zero mandatory runtime deps](https://img.shields.io/badge/mandatory%20runtime%20deps-0-000000?style=flat-square)
![Channels](https://img.shields.io/badge/channels-28-00B4D8?style=flat-square)
![npm version](https://img.shields.io/npm/v/dsh-notifier?style=flat-square&logo=npm&logoColor=white)
![tests](https://img.shields.io/badge/tests-1984-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)
[![dshfind](https://dshfind.com/api/badge/THEWOLFWALKER/dsh-notifier?lang=zh)](https://dshfind.com/zh/plugins/THEWOLFWALKER/dsh-notifier?ref=badge)

`dsh-notifier@0.13.0` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的通知与远程操作控制面：**28 个出站渠道**、**6 个入站控制渠道**、手机审批/提问/会话、任务状态、渠道健康与活动流，以及 **DSH 原生 Sidebar/Main 控制面**。运行时依赖仍然是 0。

包元数据：`dsh-notifier@0.13.0` · 1984 个自动化契约测试 · MIT 许可。

[开始使用](docs/guide.md) · [升级指南](docs/upgrade-guide.md) · [兼容性](docs/compatibility-matrix.md) · [插件接入](PLUGINS.md) · [变更记录](CHANGELOG.md)

## v0.12：日常控制正式回到 DSH 里

主入口现在是 DSH 侧栏里的 **「通知与控制」**。正常配置渠道、看状态、测试通知，不需要再去启动日志里找 localhost 地址和 token。

- **Native Control Surface**：DSH Sidebar + Main 面板，并接入 Plugins 激活/配置入口。
- **出站 Hot Apply**：保存出站渠道后，下一次发送立即使用新配置；不重建 notifier，也不需要重启 DSH。
- **单一运行时权威**：notifier、路由、工具、审批/提问可用性和 UI 投影都读同一个 `OutboundSource`。
- **Health / Tasks / Questions / Activity**：直接投影现有运行时状态，不再做第二套任务/问题状态。
- **高级管理台继续保留**：本机 Web 管理台降级为 Advanced / Recovery，用于成员、配对、绑定、会话和深度诊断。
- **安全交接**：Native 打开高级管理台使用短时一次性 ticket，不把长期 Admin Bearer 暴露给 Native 前端。

> **出站保存热生效。** 入站 transport 如果 UI 显示「等待重启」，仍需要重启；v0.12 没有假装所有 SDK/长连接都能热重载。

## 快速开始

```bash
dsh plugin add dsh-notifier@latest --profile <profile名>
```

安装完成后重启一次 DSH，让新的 Host 插件与 Client Module 装载。然后：

1. 从 DSH 侧栏打开 **「通知与控制」**，或进入 **Plugins → dsh-notifier → 开始设置**；
2. 选一个你已经在用的通知渠道；
3. 填凭证，点 **「保存并测试」**；
4. 提供方接受测试消息后首访即可完成；如果没有端到端回执，界面会明确提示你到设备确认。

之后修改**出站**渠道会立即热生效，正常使用无需 YAML。

如果当前 profile 没有 Native UI（例如 headless 场景），仍可使用本机 **高级管理台** 或 YAML / CLI 作为恢复和自动化入口。

## 工作原理

```text
DSH Sidebar / Plugins
        │
        ▼
Native Control Surface ── DSH Connection RPC ──┐
                                                │
DSH 事件 ─────────────────┐                    ▼
agent notify() 工具 ──────┼──▶ OutboundSource ─▶ notifier core ─▶ 28 个出站渠道
其他插件 / ctx.notifier ──┘         │
                                    └── health · activity · ledger

你的手机 ── 6 个入站渠道 ──▶ 身份系统 + Control Core
                              ├─ 审批
                              ├─ 会话 / steer
                              ├─ ask_user 提问
                              └─ 任务 / 会话控制

Advanced Console（127.0.0.1）──▶ 同一份运行时状态
  成员 · 配对 · 绑定 · 会话 · 诊断 · 恢复
```

`turn/end`、`approval/asked`、`agent/error` 等 DSH 事件可以自动通知；模型也可以直接调用 `notify` 工具。六个入站渠道把审批、对话与 `ask_user` 结果从手机带回 DSH。裁决始终一次性、fail-closed：沉默永不等于批准，未知/未绑定来源默认拒绝，最终结算仍走共享 Control Core。

## 四个入口怎么分工

| 入口 | 适合干什么 | 定位 |
|---|---|---|
| **通知与控制**（DSH Native） | 首页状态、渠道、真实测试、任务、待处理问题、最近活动 | **日常主入口** |
| **Plugins → dsh-notifier** | 首次设置、状态、跳转到通知与控制 | 不做第二套后台 |
| **高级管理台** | 成员/配对、绑定矩阵、会话、高级诊断与恢复 | 仅本机 `127.0.0.1` |
| **YAML / CLI** | 自动化、可复现部署、headless | 高级入口 |

## 核心能力

| 功能 | 说明 |
|---|---|
| **28 个出站渠道** | IM webhook、推送 App、国内常用服务、桌面/本地目标；零强制运行时依赖。 |
| **DSH 原生 UI**（v0.12） | Sidebar/Main + Plugins 激活/配置入口；复用 Host React 与 DSH 视觉 token，无 iframe/Vite/esbuild/自带 React。 |
| **出站 Hot Apply**（v0.12） | 保存前先校验/resolve，持久化后原子替换 live channel；下一次发送直接用新配置，不重启。 |
| **双触发线** | 自动状态推送（`turn/end` · `approval/asked` · `agent/error`）+ 模型侧 `notify` 工具。 |
| **分级路由** | `timeSensitive` / `active` / `passive`，带渠道原生语义、重试、分段和防打扰。 |
| **远程审批** | Telegram/飞书卡片、QQ C2C 原生按钮、编号回复兜底；沉默永不批准。 |
| **远程提问** | `ask_user` 选择题/编号回复、多选，自定义/跳过按渠道能力提供；首达采纳。 |
| **远程会话** | 纯文本 followup/inject；`!` 中途纠偏；合并窗拼回手机碎片输入。 |
| **手机任务/会话控制** | `/tasks`、`/use`、`/sessions`、`/stop`、`/quiet`、`/unquiet`；`/log [N]` 默认关闭且仅 owner。 |
| **身份与配对** | `(channel,userId)` 复合绑定、配对码、owner/member、来源精确校验。 |
| **插件公共面** | 其他插件可注入 `ctx.notifier`，复用同一渠道/路由/账本/限流，并订阅 metadata-only 的 `dsh-notifier/sent`。 |
| **高级管理台** | 本机恢复/深度管理；Native 只拿一次性启动票据，不拿长期 Bearer。 |
| **账本与摘要** | JSONL append-only 账本 + 可选每日摘要。 |
| **凭证安全** | secret 在投影中只表示「已配置」，不回明文；YAML 可用 `${ENV:NAME}`。 |

### 私聊命令速查

| 命令 | 干什么 | 边界 |
|---|---|---|
| `/help` | 列出可用命令 | 私聊 |
| `/whoami` | 看身份与绑定状态 | 私聊 |
| `/status` | 看当前路由/会话状态 | 私聊 |
| `/agent` / `/agent use …` / `/agent back` | 看并切换活跃会话 | 已绑定身份 |
| `/bind <sessionId>` / `/unbind` | 精确绑定/解绑会话 | 已绑定身份 |
| `/tasks` / `/use …` | 看/选活跃任务 | 只读任务投影 |
| `/sessions` | 会话概览与 attention | 只读投影 |
| `/log [N]` | 有界、脱敏的最近通知摘要 | **默认关**、仅 owner |
| `/stop` | 停止当前 turn | 必须裸 `/stop` |
| `/route` | 查看双向路由解析 | Router 可用时 |
| `/quiet <目标>` / `/unquiet <目标>` | 静默/恢复某会话出站推送 | 不影响远程对话 |
| `/pair <码>` / `/unpair` | 配对/解绑入站身份 | 私聊 |

直接发文字就是给 agent 的输入；`!` 前缀可以在任务进行中纠偏。群聊不开放危险的远程控制语义，请回原私聊操作。

## 配置

日常使用优先在 **「通知与控制」** 里配置出站渠道。YAML 适合 bootstrap、自动化和 headless：

```yaml
insert:
  - id: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "${ENV:TELEGRAM_BOT_TOKEN}"
          chatId: "987654321"
        - type: feishu
          webhook: "${ENV:FEISHU_WEBHOOK}"
```

v0.12 可编辑出站态统一写到 canonical `channel:<type>:outbound`。YAML 仍是 bootstrap/fallback；旧 `admin:channel:<type>:outbound` 与 `<type>:account` 仅保留兼容读取。

| 模块 | 用途 | 常用键 |
|---|---|---|
| `inbound` | 远程审批 + 会话 | 首次导入 `allowUsers`，之后走运行时配对 |
| `approval` | 超时、编号回复、升级提醒 | `mode: answer` |
| `conversation` | 合并窗、steer 前缀 | `mergeWindowMs: 1500` |
| `route` | 多 agent 路由 | `sessionTtlHours: 24` |
| `admin` | 高级管理台 | 默认启用、仅本机；可显式关闭 |
| `events` / `keywords` / `graceSeconds` | 防打扰 | `exclude: ["heartbeat"]` |
| `events.turnStart` / `longRunning` / `stall` | 长任务状态线 | `longRunning: { firstAfterMs: 900000 }` |
| `digest` | 账本 + 每日摘要 | `enabled: true` |

完整流程见 [docs/guide.md](docs/guide.md)。

## 渠道

<!-- CHANNEL-MATRIX-START -->

| type | 渠道 | 凭证 | 免费? |
|---|---|---|---|
| `bark` | Bark (iOS) | device key（或自架 URL） | ✅ |
| `bell` | 终端响铃（本地） | — | 本地 |
| `chanify` | Chanify (iOS) | token（或自架） | ✅ |
| `desktop` | 系统桌面通知（本地） | —（Windows 需 BurntToast 模块） | 本地 |
| `dingtalk` | 钉钉自定义机器人 | webhook + secret（HMAC 加签） | ✅ |
| `discord` | Discord webhook | webhook URL | ✅ |
| `feishu` | 飞书自定义机器人 | webhook（+ 加签 secret） | ✅ |
| `gchat` | Google Chat | space webhook URL | ✅ |
| `gotify` | Gotify | 服务器 URL + app token | 自架 |
| `igot` | iGot (iOS) | push key | ✅（限量） |
| `mattermost` | Mattermost | base URL + token（+ channel） | 自架 |
| `ntfy` | ntfy | topic（+ 服务器 URL） | ✅（可自架） |
| `onebot` | OneBot 11 (QQ) | HTTP endpoint | 自架 |
| `pushdeer` | PushDeer | push key | ✅ |
| `pushover` | Pushover | user key + app token | 付费（一次性） |
| `pushplus` | PushPlus（微信） | token | ✅（限量） |
| `qmsg` | Qmsg酱 (QQ) | key（+ 可选 group，v3） | ✅（限量） |
| `qq-bot` | QQ 官方机器人 | appId + appSecret | ✅ |
| `serverchan` | Server酱（微信） | sendkey | ✅（限量） |
| `slack` | Slack | incoming webhook URL | ✅ |
| `teams` | Microsoft Teams | Power Automate workflow URL | ✅ |
| `telegram` | Telegram Bot API | bot token + chat id | ✅ |
| `webhook` | 任意自定义端点 | — | — |
| `wecom` | 企业微信群机器人 | webhook key | ✅ |
| `wecom-app` | 企业微信应用消息 | corpid + agentId + secret | ✅ |
| `wps-bot` | WPS 协作群机器人（WOA） | webhook URL（含 `?key=`） | ✅ |
| `wxpusher` | WxPusher（微信） | appToken + uid | ✅（限量） |
| `xizhi` | 息知 | sendkey | ✅（限量） |

<!-- CHANNEL-MATRIX-END -->

另有六个渠道开放入站控制：`telegram`、`feishu`、`qq-bot`、`wxpusher`、`wechat`、`dingtalk`。Telegram / 飞书及 QQ C2C 可使用原生控制按钮，其他目标自动回退安全文本/编号回复。媒体/文件能力仍以 capability matrix 与真实平台验证结果为准，不把「代码已接线」等同于「真机已验证」。

## DSH 兼容性

声明范围：

```text
0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2
```

v0.12 发布证据：

- **0.1.7-rc.2**：真实宿主 Native UI / 渠道设置 / 保存并测试 / Hot Apply 验收通过；
- **0.1.7-alpha.1**：兼容下限冒烟通过（插件激活、RPC、28 渠道、Client Module 加载）；
- **alpha.2 / rc.1**：源码/制品 seam 兼容已核；证据级别详见 [docs/compatibility-matrix.md](docs/compatibility-matrix.md)。

## 架构

```text
src/
  adapters/                 28 个出站适配器 + 声明式 spec
  runtime/
    outbound-source.mjs     唯一 live 出站权威
  control-surface/
    service.mjs             Native command/query facade
    rpc.mjs                 DSH 鉴权控制通道
    channels.mjs            渠道投影
    health.mjs              有界健康证据
    activity.mjs            脱敏活动投影
    tasks.mjs               任务投影适配
    questions.mjs           Control Core 问题桥
    launch-ticket.mjs       高级管理台一次性票据
  notify.mjs                notify / notify_test + 路由/限流
  event-listener.mjs        DSH 事件自动通知
  routing/                  多 agent 路由
  inbound/                  六个入站控制通道 + 身份/配对
  approval/                 审批 token / 去重 / 升级提醒
  questions/                ask_user 远程提问
  admin/                    Advanced / Recovery Web 管理台
  ledger.mjs                append-only 账本 + digest
client.js                   DSH Native Web Client Module
```

消费方公共面见 [PLUGINS.md](PLUGINS.md)。`ctx.notifier.version` 仍是 `0.7`；v0.12 改的是产品控制面与运行时渠道权威，不是消费方 API breaking。

## 开发

发布门禁：

```bash
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
node --check client.js
npm pack --dry-run --json
git diff --check
```

v0.13.0 收敛线：登记 **1984 个契约测试**；全量 hermetic 套件已通过，真实 provider/设备证据仍是外部门禁。

test/ 1984 个测试；历史 0.8.6 包为 909 个测试。

## 许可

MIT
