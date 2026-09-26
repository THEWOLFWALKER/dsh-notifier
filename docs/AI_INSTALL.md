# AI 安装 dsh-notifier

这份文档是给**能操作当前机器终端**的 AI / Agent 用的。

目标不是“把命令跑完”，而是：

```text
确认环境
→ 找到正确 DSH profile
→ 安装官方稳定版
→ 不破坏现有配置
→ 重启正确 Host
→ 验证实际版本
→ 验证 Notify & Control
→ 汇报结果
```

## 一句话版本

直接复制：

> 请帮我在这台机器上安装或升级 dsh-notifier 最新稳定版。先自动识别当前正在使用的 DSH profile 和现有安装来源，确认 DSH / Node 版本兼容，并保护已有配置；不要修改无关插件，也不要打印任何 Token / Secret。使用官方发布包完成安装，重启对应 DSH Host 一次，确认实际安装版本和「通知与控制」入口，最后把你执行过的命令、结果和仍存在的异常汇报给我。项目：`https://github.com/THEWOLFWALKER/dsh-notifier`

## 完整 Agent 提示词

```text
你正在帮助用户安装或升级 dsh-notifier。

项目：
https://github.com/THEWOLFWALKER/dsh-notifier

目标：
把当前机器上实际使用的 DSH profile 安装/升级到 dsh-notifier 最新稳定发布版，并验证真正运行的是新版本。

先做只读检查，不要直接改：

1. 识别 Node.js 版本。
2. 识别 DSH / Harness 版本。
3. 找出当前运行/常用的 DSH profile；如果明确只有一个就使用它，如果有多个且无法判断，不要猜，列出来让用户选择。
4. 检查是否已经安装 dsh-notifier。
5. 检查安装来源：
   - npm/registry
   - file:
   - Git
   - 手工 node_modules
6. 记录当前版本。
7. 不读取/输出完整 state.json，不输出 Bot Token、Webhook Secret、Admin Token、Authorization header。
8. 不修改其他插件。

确认环境后：

- 优先使用 DSH CLI 安装官方稳定版：
  dsh plugin add dsh-notifier@latest --profile <正确profile>
- 如果该 CLI 版本不接受 @latest，可退回：
  dsh plugin add dsh-notifier --profile <正确profile>
- 不使用未发布 dev 分支替代稳定版，除非用户明确要求。
- 不通过手工复制源码覆盖 node_modules 作为长期安装方式。

安装完成后：

1. 重启对应 DSH Host 一次。
2. 检查实际安装版本，不只相信安装命令输出。
3. 检查 dsh-notifier package 中 client.js 是否存在。
4. 如果是 web/支持 Native UI 的 profile，确认：
   - Sidebar 有「通知与控制」/ Notify & Control；
   - Plugins 能看到 dsh-notifier。
5. 不要求用户先提供通知渠道 Secret 才能宣布“插件安装完成”。
6. 如果已有渠道配置，不要擅自删除、重建或改密钥。
7. 如果安装失败，保留现场，进入只读排障，不要反复卸载重装。

最终只给用户一个短报告：

- profile
- Node 版本
- DSH 版本
- 安装前 dsh-notifier 版本与来源
- 安装后实际版本
- 执行过的命令
- 是否重启
- Notify & Control 是否出现
- 是否存在 file:/残留包风险
- 任何失败/警告
- 下一步

不要在报告里输出任何 Secret。
```

## 安装后下一步

打开：

```text
DSH → 通知与控制 → 通知渠道
```

配置一个出站渠道并「保存并测试」。

如果插件装好了，但页面不出现或行为像旧版，不要继续盲目重装，转到：

[TROUBLESHOOTING.md](TROUBLESHOOTING.md)
