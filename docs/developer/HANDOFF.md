# 当前交接

更新：2026-10-01。工作分支 `codex/v015-release-closeout`，起点 dev `592ff75`。目标版本 0.15.0；当前包字段在发布门完成前仍为 0.13.1。

## 已实现

- Native 导入导出：下载或复制公共配置、预览、明确选择冲突、过期预览拒绝、取消、暂存渠道补齐配置。
- Cloudflare：固定 Wrangler 4.119.0、设备登录、账号选择、部署结果读回、资源复用、取消、绑定和解除绑定。
- Telegram：一键部署反代、获取地址、自动填写保存；共用 Bot Token；自定义地址兼容普通反代；通知和接收共用配置。
- Bark：实际 D1 迁移、默认关闭注册、明确开启注册、保留官方公开 APNs 自建配置、隔离并保留 GPL 许可。
- 用户文档集中在 `docs/user/`，技术接口和证据集中在 `docs/developer/`。

## 检查

| 检查 | 结果 |
|---|---|
| 测试 | `npm test` **2462 tests**（2462 pass，0 fail，0 skip） |
| 配置和 Worker | 核心部署 / 转发检查与真实 React 操作检查通过；本地 workerd 执行 D1 迁移和签名请求通过 |
| 打包与发布 | 文档、宿主兼容、渠道矩阵与打包检查通过；dev/main CI 和发布待完成 |

## 支持范围

检查的 dsh-im 上游提供 `dshImClient` 面板嵌入接口，没有证实 `ctx.dshIm.send/listBots/listTargets`。
现有 bridge/import 属于实验代码，不能宣传为当前 dsh-im 支持。入口说明不引导用户使用它；测试只能证明模拟服务契约。

公网 Cloudflare 账号部署和真实 Telegram / APNs 设备回执尚无本次新增证据。
本地 workerd 与协议检查的范围见 [cloudflare.md](cloudflare.md)，长期缺口见 [memory/risks.md](memory/risks.md)。

## 继续

完成最后回归、打包安装和 CI，再更新 0.15.0 元数据。GitHub PAT 只用于指定仓库的 git 推送，不用于 API 或其他服务。
本机 `npm whoami` 返回 ENEEDAUTH；npm 发布不能记为完成。
