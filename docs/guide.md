# dsh-notifier 使用指南

> 目标：让你从“装好插件”走到“手机能收到通知、需要时能处理 Agent 请求”。\
> English: [guide.en.md](guide.en.md)

## 先决定你要做到哪一步

dsh-notifier 可以只当通知插件，也可以继续开启手机控制。

| 模式 | 你能做什么 | 需要配置 |
| --- | --- | --- |
| **通知模式** | 收到任务完成、审批、错误、长任务状态等通知 | 至少 1 个出站渠道 |
| **控制模式** | 手机审批、回答 `ask_user`、远程对话、切任务 / Session | 出站 + 支持的入站渠道 + 成员配对 |
| **Headless / 自动化** | 不依赖 Native UI，用 YAML / CLI 管理 | DSH profile + YAML / CLI |

第一次使用，建议先把**通知模式**跑通，再加控制。

---

## 第一步：安装

### 推荐：让 AI 帮你安装

把这句话发给能操作当前机器终端的 AI / Agent：

> 请帮我在这台机器上安装或升级 dsh-notifier 最新稳定版。先自动识别当前正在使用的 DSH profile 和现有安装来源，确认 DSH / Node 版本兼容，并保护已有配置；不要修改无关插件，也不要打印任何 Token / Secret。使用官方发布包完成安装，重启对应 DSH Host 一次，确认实际安装版本和「通知与控制」入口，最后把你执行过的命令、结果和仍存在的异常汇报给我。项目：`https://github.com/THEWOLFWALKER/dsh-notifier`

完整 Agent 提示词：[AI_INSTALL.md](AI_INSTALL.md)。

### 手动安装

```bash
dsh plugin add dsh-notifier@latest --profile <profile名>
```

如果你的 CLI 不接受 `@latest`：

```bash
dsh plugin add dsh-notifier --profile <profile名>
```

安装后**重启 DSH 一次**，让 Host 插件和 `client.js` 装载。

### 安装完成后怎么确认

优先看三件事：

1. DSH 侧栏出现 **「通知与控制」**；
2. Plugins 页面能看到 `dsh-notifier`；
3. 实际安装版本是你预期的发布版本。

如果版本对，但界面像旧版，先看 [升级指南](upgrade-guide.md)，尤其检查旧 `file:` 安装和残留包。

---

## 第二步：配置第一个通知渠道

打开：

```text
DSH Sidebar
→ 通知与控制
→ Channels / 通知渠道
```

选一个你已经在用的渠道，例如 Telegram、飞书、QQ、PushPlus、Bark、Webhook 等。

填写凭证后点：

```text
保存并测试
```

### “测试成功”到底代表什么

项目区分两种证据：

- **provider accepted**：提供方 API 已接受请求；
- **confirmed**：有明确端到端回执，能证明已送达。

很多通知平台只提供第一种。因此页面如果提示“已接受，请到设备确认”，你需要真的看一下手机。

不要把 HTTP 2xx / messageId 自动理解成“客户端一定显示了”。

---

## 第三步：理解 Hot Apply

装好 v0.13 后，**出站配置保存后会热生效**：

```text
保存
→ 校验
→ 持久化 canonical state
→ 更新 live runtime
→ 下一次发送使用新配置
```

正常情况下，修改 Telegram token、Webhook、Bark key 等**不需要重启 DSH**。

但入站 transport 往往是 WebSocket / SDK / 长轮询连接。页面如果显示：

```text
等待重启 / Restart pending
```

就需要重启一次，让入站连接重新建立。

---

## 第四步：如果只要通知，到这里就够了

常见自动通知包括：

- `turn/end`
- `approval/asked`
- `agent/error`
- 长任务 heartbeat
- stall（长时间无事件）
- 模型主动调用 `notify`

日常只收通知，不需要配置成员或入站。

---

## 第五步：开启手机控制

想从手机审批、回答问题或直接和 Agent 对话，需要再配置入站。

当前支持 6 个入站控制通道：

```text
Telegram
Feishu
QQ official bot
WxPusher
WeChat iLink
DingTalk
```

不同 provider 的接入方式不同：

- Telegram：Bot Token；
- 飞书 / QQ / 钉钉：凭证或现有授权/扫码流程；
- 微信 iLink：扫码授权；
- WxPusher：需要 callback / app 配置。

如果 Native 页面提示该入站需要重启，保存后重启 DSH。

---

## 第六步：配对成员

配对的作用是告诉插件：

```text
这个 IM 账号是谁
它有没有远程操作权限
```

成员身份按 canonical principal：

```text
(channel, accountId, userId)
```

没有多账号概念的 provider 使用默认 `accountId`。`chatId` / `chatType` 属于事件来源范围，不等于成员身份本身。

### 配对流程

在高级管理台：

```text
成员
→ 生成配对码
```

然后手机私聊机器人：

```text
/pair <配对码>
```

首个有效成员成为 owner。

安全边界：

- 配对和高风险控制默认走私聊；
- 未绑定 / 未知身份默认拒绝；
- 缺关键来源信息时 fail-closed；
- 最后一位 owner 不能随意删掉或降级。

---

## 第七步：日常从手机操作

### 直接对话

私聊机器人直接发文字，就会进入远程会话流程。

### 中途纠偏

任务正在运行时：

```text
! 改成方案 B，先别动数据库
```

`!` 前缀表示 steer 当前 turn。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看命令 |
| `/whoami` | 查看身份 / 配对状态 |
| `/status` | 当前路由 / Session 状态 |
| `/tasks` | 查看活跃任务 |
| `/use <目标>` | 选择任务 |
| `/sessions` | Session 概览 |
| `/stop` | 停当前 turn |
| `/route` | 查看双向路由 |
| `/quiet <目标>` | 静默某个目标的通知 |
| `/unquiet <目标>` | 恢复通知 |
| `/pair <码>` | 配对 |
| `/unpair` | 解绑 |
| `/log [N]` | 近期通知摘要；默认关闭、owner-only、脱敏有界 |

群聊默认不开放高风险远程控制语义。

---

## 第八步：高级管理台什么时候用

Native 「通知与控制」负责日常操作。

Advanced Console 更适合：

- 成员 / 配对码；
- 待确认身份；
- 绑定矩阵；
- Session 管理；
- 深度诊断；
- Native UI 不可用时 Recovery。

Advanced Console 只监听：

```text
127.0.0.1
```

Native 打开它时使用短时一次性 ticket；不要为了方便把管理台直接暴露到公网。

---

## 第九步：YAML / CLI

普通用户优先 UI。YAML 适合可重复部署和 headless。

示例：

```yaml
insert:
  - id: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "${ENV:TELEGRAM_BOT_TOKEN}"
          chatId: "987654321"
```

密钥优先用：

```text
${ENV:NAME}
```

不要把 Token 提交到 Git 仓库。

CLI 适合登录和诊断，例如：

```bash
node scripts/channel-login.mjs <qq|dingtalk|feishu|wechat>
node scripts/channel-selfcheck.mjs ...
node scripts/route.mjs show
```

运行中的 `state.json` 不建议手改。优先 Native / Advanced Console / CLI，让 store 自己处理锁、事务和跨进程合并。

---

## 第十步：升级

推荐：

```bash
dsh plugin add dsh-notifier@latest --profile <profile名>
```

升级包以后重启一次 DSH，让新代码加载。

这次“升级后的重启”不代表以后每次修改出站配置都要重启。

完整升级 / 残留安装 / 回滚说明：

[upgrade-guide.md](upgrade-guide.md)

---

## 出问题怎么办

第一步不是开 Issue，而是先让 AI 做一次只读定位：

[TROUBLESHOOTING.md](TROUBLESHOOTING.md)

如果仍解决不了，再按：

[DIAGNOSTICS.md](DIAGNOSTICS.md)

生成 Support Report 后上报。

常见现象：

| 现象 | 先查 |
| --- | --- |
| 侧栏没有「通知与控制」 | 实际版本、是否重启、DSH Host 兼容范围、client module |
| Plugins 有插件但页面空 | `client.js` 是否装进包、slot/client 错误 |
| 出站保存后还走旧配置 | 是否实际运行旧包 / `file:` 包；v0.13 出站应 Hot Apply |
| 入站保存后不在线 | 是否显示 Restart pending |
| 测试 API 成功但手机没消息 | provider/client 语义；accepted 不等于 confirmed |
| Telegram 409 | webhook / poller 冲突 |
| `/pair` 被拒 | 私聊、码过期/已使用、失败锁定、身份来源 |
| 行为像旧版本 | `npm ls` / `pnpm why` 检查真实安装来源 |

---

## 安全提醒

不要把这些发到 Issue / QQ / 邮件：

- Bot Token
- Webhook Secret
- Admin Token
- 完整 `state.json`
- 完整配置文件中的密钥
- 未脱敏私聊
- Authorization Header

公开日志前先脱敏。

---

## 下一步

- AI 安装：[AI_INSTALL.md](AI_INSTALL.md)
- 排障：[TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- 定位与上报：[DIAGNOSTICS.md](DIAGNOSTICS.md)
- 兼容性：[compatibility-matrix.md](compatibility-matrix.md)
- 运维：[OPERATIONS.md](OPERATIONS.md)
- 插件 API：[../PLUGINS.md](../PLUGINS.md)
