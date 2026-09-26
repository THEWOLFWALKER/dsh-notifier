# dsh-notifier 排障指南

## 支持原则

遇到问题时，优先：

```text
AI 只读定位
→ 明确问题层级
→ 能安全本地解决就修复并复测
→ 仍失败则生成 Support Report
→ 再上报项目
```

**不要先卸载重装，也不要先删 state。**\
很多问题其实是旧 `file:` 安装、错误 profile、Host 没重启、入站等待重启或 provider 配置问题。先保留现场更容易定位。

## 一句话排障提示词

把下面整段发给能看当前终端/日志的 AI：

> 请帮我排查 dsh-notifier。第一轮只做只读诊断，不卸载、不重装、不删除 state、不修改密钥。确认实际 dsh-notifier 版本和安装来源、DSH 版本/profile、Node 版本、`client.js` 是否装载、问题属于 Native UI / 出站 / 入站 / 身份配对 / provider / 存储 / 网络中的哪一层，并做最小复现。日志和配置必须脱敏，绝不能输出 Token/Secret/Authorization。先给我证据和结论；如果是明确、低风险、本地可修复的问题，再给修复步骤。若仍解决不了，请按项目 `docs/DIAGNOSTICS.md` 生成可直接上报的 Support Report。项目：`https://github.com/THEWOLFWALKER/dsh-notifier`

## AI 第一轮必须查什么

### 1. 版本身份

至少确认：

```text
Node
DSH / Harness
dsh-notifier
profile
安装来源
```

不要只看 `package.json` 仓库版本，要看**当前机器实际装载的包**。

特别检查：

```text
registry
file:
Git source
手工覆盖 node_modules
```

### 2. 问题发生在哪一层

把症状归类：

| 层 | 典型症状 |
| --- | --- |
| 安装 / profile | 插件根本没加载、版本不对 |
| Native Client | 侧栏入口不存在、页面空、slot error |
| 出站配置 | 保存失败、Hot Apply 后仍走旧配置 |
| provider | API 拒绝、消息未显示、权限/额度问题 |
| 入站 runtime | 配置保存了但 bot/WS 没上线 |
| 身份 / pairing | `/pair`、权限、owner/member 问题 |
| Control Core | 审批 / `ask_user` 无法结算 |
| storage | state read/write、corrupt、permission、disk full |
| network | DNS / proxy / timeout / TLS / webhook |
| Host compatibility | attachment/session/client seam 不存在 |

### 3. 最小复现

AI 应把问题缩成：

```text
动作
→ 预期
→ 实际
→ 是否稳定复现
→ 哪个渠道 / direction
```

例如：

```text
Telegram outbound
保存 token/chatId
发送测试
provider accepted
手机未显示
```

而不是“通知不工作”。

### 4. 保护现场

第一轮不要：

- 删除 `state.json`
- 删除整个 profile
- 重装全部依赖
- force reset
- 更换所有 token
- 关闭安全检查
- 把 Admin 暴露公网
- 直接贴完整配置

## 常见问题

### 侧栏没有「通知与控制」

先确认：

1. 实际安装版本；
2. DSH 已重启；
3. 当前打开的是正确 profile；
4. `client.js` 在实际安装包里；
5. Host 版本在声明范围；
6. Client/slot 日志有没有报错。

### 版本写着新，但行为像旧版

高概率是安装来源问题。

检查：

```bash
npm ls dsh-notifier
pnpm why dsh-notifier
```

如果看到 `file:` 或本地路径，说明实际运行的可能不是 registry 包。

### 出站保存后仍走旧配置

v0.13 出站应 Hot Apply。

重点查：

- 实际运行包版本；
- 是 outbound 还是 inbound；
- 是否旧 `file:` 包；
- 保存是否真的 durable success；
- 页面与 runtime 是否读同一 canonical config。

### 入站保存后没有上线

看 UI 是否显示：

```text
Restart pending / 等待重启
```

入站 SDK / WebSocket / 长轮询并非全部支持热重载。

### 测试显示 API 成功，手机没看到

这不一定是插件 false failure。

区分：

```text
provider accepted
confirmed delivery
```

2xx / messageId 不等于客户端一定渲染。

记录 provider 返回、消息类型、客户端版本和实际表现，避免只说“测试成功”。

### `/pair` 失败

检查：

- 是否私聊；
- 配对码是否过期/已核销；
- 是否命中失败锁定；
- accountId/userId 来源是否完整；
- 是否已经绑定其他成员身份。

### Telegram 409

常见于多个 poller 或 webhook/polling 冲突。先确认是否有其他实例正在使用同一个 Bot Token。

### 高级管理台打不开

检查：

- `admin.enabled`
- loopback 地址
- 一次性 launch ticket
- Host 上是否真的启动了 Admin server

不要为了访问方便改成 `0.0.0.0`。

## 如果 AI 能解决

让 AI：

```text
说明根因
→ 给最小修复
→ 执行后复测
→ 汇报 before/after
```

不要把“重装后好了”当成根因分析。

## 如果仍解决不了

进入：

[DIAGNOSTICS.md](DIAGNOSTICS.md)

让 AI 输出标准 Support Report，再开 GitHub Issue 或联系维护者。
