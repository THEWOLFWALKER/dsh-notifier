# dsh-notifier 使用指南（v0.13：从安装到日常）

> 面向普通 DSH 用户。v0.13 起，**DSH Native「通知与控制」是日常主入口**；本机 Web 管理台保留为 Advanced / Recovery，Native/Admin 共享 canonical runtime truth。
>
> 如果你是插件作者，请看 [PLUGINS.md](../PLUGINS.md)；如果你在升级旧版本，请先看 [upgrade-guide.md](upgrade-guide.md)。

## 三分钟上手

| 步骤 | 做什么 | 在哪里 |
|---|---|---|
| ① 安装 | `dsh plugin add dsh-notifier@latest --profile <你的profile名>` | 终端 |
| ② 重启一次 DSH | 让 Host 插件和 Native Client Module 生效 | DSH |
| ③ 打开「通知与控制」 | DSH Sidebar，或 Plugins → dsh-notifier → 开始设置 | DSH |
| ④ 配第一个出站渠道 | 选渠道 → 填凭证 → **保存并测试** | Native |
| ⑤ 手机真实收到 | 收到测试通知才算配置完成 | 手机 |

正常首访**不用写 YAML，也不用翻启动日志找 localhost token**。

## 第一步：安装

```bash
dsh plugin add dsh-notifier@latest --profile <profile名>
```

`--profile` 填你实际运行的 profile（常见是 `web`）。装完后重启一次 DSH。

v0.12 声明支持：

```text
0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2
```

发布时真实宿主验收覆盖 `0.1.7-rc.2`，兼容下限 `0.1.7-alpha.1` 做过冒烟；详细证据见 [compatibility-matrix.md](compatibility-matrix.md)。

## 第二步：找到 Native「通知与控制」

优先入口：

1. DSH 左侧栏 **「通知与控制」**；
2. 或 **Plugins → dsh-notifier**：
   - 未配置时点 **「设置第一个通知渠道」**；
   - 已配置时点 **「打开通知与控制」**。

这里不是把旧 Web 管理台塞进 iframe。它是 DSH 原生 Client Module，通过宿主认证的 Control Surface 通道读写状态。

### 页面怎么看

- **首页**：运行状态、待处理问题、正在运行的任务、通知渠道、最近活动；
- **通知渠道**：出站配置、真实测试、入站控制配置；
- **渠道详情**：通知 / 远程控制 / 运行状态；
- **任务**：现有 DSH 任务投影，不新建第二套任务状态；
- **活动**：只显示脱敏操作/送达元数据，不显示通知正文、token、chatId/userId 等敏感字段。

## 第三步：配第一个通知渠道

1. 点 **「设置通知渠道」**；
2. 选你手机上已经有的渠道；
3. 填凭证；
4. 点 **「保存并测试」**。

**只有真实测试 `delivered=true`，首访才完成。**

保存成功但测试失败时，页面会停在当前配置，不会假装完成。按错误原因修凭证后直接重试。

### v0.12 最重要的变化：出站保存热生效

出站配置不再是「页面先变、运行时等重启」。

现在流程是：

```text
校验 patch
→ 合并候选配置
→ adapter resolve
→ 持久化 canonical state
→ 原子替换 OutboundSource
→ 下一次发送立即使用新配置
```

因此：

- 修改 Telegram token、webhook、Bark key 等**出站配置后无需重启**；
- 测试发送与正式 notifier 读取同一份运行时权威；
- 保存失败/resolve 失败不会把坏配置切进 live runtime。

可编辑出站态写入：

```text
channel:<type>:outbound
```

旧 `admin:channel:<type>:outbound` 和非双域 `<type>:account` 只做兼容读取。

### 入站为什么有时还要重启

入站 transport 往往是启动时创建的 SDK/WS/长轮询连接。v0.12 没做一个巨大的通用热重载器。

所以以 UI 的 `applyMode` 为准：

- **立即生效**：可以直接继续；
- **等待重启**：保存后重启 DSH，让入站连接重新建立；
- **只读**：该能力只能走已有授权/CLI 路径。

## 第四步：如果要手机控制，再配入站与成员

只收通知的话，到这里已经够用了。

想在手机上审批、和 agent 对话、回答 `ask_user`，再配置入站。

### 入站配置

- Telegram：BotFather token；
- 飞书 / QQ / 钉钉：可按现有授权/扫码路径配置；
- 微信 iLink：按现有二维码授权；
- WxPusher：需要公网 callback 时再用。

二维码授权、复杂成员管理目前仍更适合 **高级管理台**。

## 第五步：打开高级管理台（需要时才用）

从 Native 的更多菜单打开 **高级管理台**。

v0.12 的正常 handoff 是一次性启动票据：

```text
Native
→ standalone.createLaunch
→ 60s 单次 ticket
→ 浏览器打开 127.0.0.1
→ ticket 交换
```

Native 前端**不会拿到长期 Admin Bearer**。

高级管理台适合：

- 成员 / 配对码；
- 待确认身份；
- 绑定矩阵；
- Session 高级设置；
- SSE/诊断与恢复；
- Native UI 不可用时的兼容入口。

> 如果你显式关闭了 `admin.enabled`，Native 不会偷偷为了打开它而新监听端口；高级管理台会显示未启用。

### Recovery：Native 进不去怎么办

Headless profile、浏览器模块异常等情况下，可以回到旧的 loopback recovery 路径。管理台仍只监听 `127.0.0.1`，并保留 Bearer 鉴权。

不要猜端口；看启动日志的 **「Web 管理台已就绪」**。首次生成 token 的进程可能同时打印 `/#token=...` 启动链接。

## 第六步：配对成员

配对 = 告诉插件「这个 IM 账号就是我」。

1. 高级管理台 → **成员** → 铸造配对码；
2. 手机私聊机器人：
   ```text
   /pair <配对码>
   ```
3. 首个有效成员成为 owner。

安全规则：

- 配对/远程控制走私聊；群聊不提升权限；
- 身份至少按 `(channel,userId)` 隔离；存在 account/chat 时继续精确匹配；
- 未绑定、未知来源、缺关键字段默认拒绝；
- 最后一个 owner 不能被随便删除/降级。

全新引导态还会把 bootstrap 配对码写到：

```text
<stateDir>/bootstrap-paircode.txt
```

文件权限 `0600`；日志只打印路径，不打印码面。

## 第七步：日常使用

### 收通知

常见自动通知：

- `turn/end`
- `approval/asked`
- `agent/error`
- 长任务 heartbeat
- stall（长时间无事件）

模型也能直接调用 `notify` 工具。

### 远程审批

- Telegram / 飞书：卡片按钮；
- QQ C2C：原生按钮优先；
- 其他支持入站的目标：安全文本 / 编号回复 fallback。

**不回复永远不等于批准。**

### 远程会话

直接发文字给 agent。

- `! 改成方案 B`：任务中途 steer；
- 连续碎片输入会按 merge window 合并；
- 群聊不开放危险控制语义。

### 远程提问

`ask_user` 会转成选项卡或编号回复。

- 支持多选；
- 错编号会提示重答，不会作废问题；
- 首达采纳；
- 超时不会替你猜答案。

Native 首页也能看到待处理问题并 choose/reject；结算仍走同一个 Control Core，不是另开一条授权旁路。

## 私聊命令速查

| 命令 | 干什么 |
|---|---|
| `/help` | 全部命令 |
| `/whoami` | 身份/绑定状态 |
| `/status` | 当前任务/会话/路由状态 |
| `/agent` | 活跃会话概览 |
| `/agent use <workspace|sid前缀>` | 切换本次对话驱动的会话 |
| `/agent back` | 回到通道默认目标 |
| `/bind <sessionId>` / `/unbind` | 精确绑定/解绑 |
| `/tasks` | 活跃任务列表 |
| `/use <workspace|sid前缀>` | 选择任务 |
| `/sessions` | 会话概览 |
| `/log [N]` | 最近通知摘要；**默认关、仅 owner、脱敏有界** |
| `/stop` | 停当前 turn |
| `/route` | 看双向路由 |
| `/quiet <目标>` / `/unquiet <目标>` | 静默/恢复会话推送 |
| `/pair <码>` / `/unpair` | 配对/解绑 |

## 高级：YAML / CLI

Native UI 不是唯一配置方式。

YAML 适合自动化：

```yaml
insert:
  - id: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "${ENV:TELEGRAM_BOT_TOKEN}"
          chatId: "987654321"
```

CLI 登录/诊断：

```bash
node scripts/channel-login.mjs <qq|dingtalk|feishu|wechat>
node scripts/channel-selfcheck.mjs ...
node scripts/route.mjs show
```

注意：运行中的 state 文件不要手改，优先用 Native / Advanced Console / CLI，让 store 的锁与合并语义保持完整。

## 出问题了

| 现象 | 先看什么 |
|---|---|
| 侧栏没有「通知与控制」 | 确认安装的是 `0.13.0+`、重启 DSH、检查 Host 版本是否在兼容范围；headless profile 用 Advanced Console/YAML |
| Plugins 里能看到插件但 Native 页面空 | 看 DSH Client/slot 错误；确认 `client.js` 被 package manifest 加载 |
| 保存出站后下一条仍走旧配置 | 这是异常；v0.13 出站应 Hot Apply。检查是否真的运行 registry 的 0.13.0，而不是旧 `file:`/残留包 |
| 测试发送失败 | 直接按页面的 provider/校验错误修；保存失败不会切换 live runtime |
| 入站保存后没连接 | 看 UI 是否标「等待重启」；如果是，重启 DSH |
| 高级管理台未启用 | 检查 `admin.enabled`；Native 不会擅自启动它 |
| 找不到高级管理台 recovery 地址 | 启动日志搜「Web 管理台已就绪」，不要猜端口 |
| Telegram 409 | 可能残留 webhook/轮询冲突；先核 bot 配置与当前 transport |
| QQ 群远程控制被拒 | 设计如此；回原私聊 |
| `/pair` 被拒 | 检查是否私聊、码是否过期/已使用、是否触发失败锁定 |
| 行为像旧版本 | 看 [升级指南](upgrade-guide.md)，排查 `file:`/node_modules 残留 |
| 其他 | Native 首页看 Health/Activity；高级问题再进 Advanced Console |

## 下一步

- 运维与发布：[OPERATIONS.md](OPERATIONS.md)
- 宿主/SDK 证据：[compatibility-matrix.md](compatibility-matrix.md)
- 升级/降级：[upgrade-guide.md](upgrade-guide.md)
- 插件消费方：[../PLUGINS.md](../PLUGINS.md)
