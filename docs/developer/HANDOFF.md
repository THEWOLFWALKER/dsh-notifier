# 当前交接

更新：2026-10-01。工作分支 `codex/v015-release-closeout`，起点 dev `592ff75`。v0.15 功能收口仅同步 dev。当前稳定包版本仍为 0.13.1，本次不执行正式发布。

## 已实现

- Native 导入导出：下载或复制公共配置、预览、明确选择冲突、过期预览拒绝、取消、暂存渠道补齐配置。
- Cloudflare：固定 Wrangler 4.119.0、设备登录、账号选择、部署结果读回、资源复用、取消、绑定和解除绑定。
- Telegram：一键部署反代、获取地址、自动填写保存；共用 Bot Token；自定义地址兼容普通反代；通知和接收共用配置。
- Bark：实际 D1 迁移、默认关闭注册、明确开启注册、保留官方公开 APNs 自建配置、隔离并保留 GPL 许可。
- 用户文档集中在 `docs/user/`，技术接口和证据集中在 `docs/developer/`。

## 检查

| 检查 | 结果 |
|---|---|
| 测试 | `npm test` **2510 tests**（P0 全量 2505 pass；5 项旧世代/形状断言已更新并 focused 验证，最终全量见 P5） |
| 配置和 Worker | 核心部署 / 转发检查与真实 React 操作检查 33 项通过；本地 workerd 执行 D1 迁移和签名请求通过 |
| 打包与发布 | 文档、宿主兼容、渠道矩阵与打包检查通过；已推 dev 并通过 Ubuntu/macOS CI；最新隧道收尾已推 dev，最终 CI 状态需查看该提交的 Actions |

## 支持范围

检查的 dsh-im 上游提供 `dshImClient` 面板嵌入接口，没有证实 `ctx.dshIm.send/listBots/listTargets`。
现有 bridge/import 属于实验代码，不能宣传为当前 dsh-im 支持。入口说明不引导用户使用它；测试只能证明模拟服务契约。

公网 Cloudflare 账号部署和真实 Telegram / APNs 设备回执尚无本次新增证据。
本地 workerd 与协议检查的范围见 [cloudflare.md](cloudflare.md)，长期缺口见 [memory/risks.md](memory/risks.md)。

## 后续检查

用户已接手 review；冒烟与截图交给另一个 agent，本次停止打包和发布操作。代码与文档已同步 dev。

## v0.15 执行追踪（2026-10-02）

按 2026-10-02 交接包（WP00–WP23）在 `dev` 逐包执行，追踪目录见
[docs/developer/v0.15-execution/](v0.15-execution/README.md)：基线、目标契约→现有符号映射、
个人/群范围清单、546 条逐项账本。账本在逐项源码证据落地前保持 `planned`，U06 第二遍语义核对未完成。

按用户最新要求，只同步 dev，main 不动。包版本保持 0.13.1；正式 0.15.0 发布留到另一次明确发布操作。GitHub PAT 只用于指定仓库的 git 推送，不用于 API 或其他服务。
本次不执行 tag、GitHub Release 或 npm 发布。
