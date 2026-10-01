# 当前状态

更新：2026-10-01。

基线为 dev `592ff75`。当前在 `codex/v015-release-closeout` 完成 v0.15 发布收口，包版本在正式发布检查前仍为 0.13.1。

Native 配置导入导出已接通真实服务。新渠道先暂存，补齐凭证并保存后使用；已有配置冲突需要明确选择。

Cloudflare 部署按需安装固定 Wrangler，支持设备登录、账号选择和 Bark / Telegram 部署。Telegram 默认部署后自动获取地址并保存；通知和接收复用同一个 Bot Token。自定义地址兼容普通 Telegram 反代。

用户文档与工程文档已分为 `docs/user/`、`docs/developer/`。dsh-im 的桥接和导入代码仅为实验实现，不代表与当前上游可互操作。

本次全量核心回归通过 2462 项；真实 React / 本地 workerd 套件通过 32 项。完整检查和发布状态见 [HANDOFF.md](../HANDOFF.md)。

本机没有 npm 登录凭证。正式 npm 发布需要完成登录或已有受支持的发布身份；不以本地打包代替 registry 发布。
