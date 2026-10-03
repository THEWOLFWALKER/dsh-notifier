# 项目索引

代码和测试决定行为，`package.json` 决定包版本。用户操作说明在 `docs/user/`；工程接口、协议、验证和维护记录在本目录。

## 当前工作

v0.15 Stage 4：P2–P5 hardening of the Native surface, checked dsh-im delivery, package contents, and Recovery security. Current phase status and validation results are in [HANDOFF.md](HANDOFF.md) and [the acceptance record](v015-final-acceptance.md).

## 修改代码前

[AGENTS.md](../../AGENTS.md) 规定协作与验证流程；[memory](memory/README.md) 记录仍有效的决策和风险。

| 问题 | 文档 |
|---|---|
| 模块和状态流 | [architecture.md](architecture.md) |
| 保存、应用和故障行为 | [behavior-contract.md](behavior-contract.md) |
| 状态写入归属 | [state-writer-registry.md](state-writer-registry.md) |
| 外部插件调用 | [PLUGINS.md](PLUGINS.md) / [English](PLUGINS.en.md) |
| 增加通知渠道 | [ADAPTER.md](ADAPTER.md) |
| 发送渠道清单 | [channels.md](channels.md) |
| 宿主和验证证据 | [compatibility-matrix.md](compatibility-matrix.md) |
| 云部署与 Telegram 转发 | [cloudflare.md](cloudflare.md) |
| 运行和诊断 | [OPERATIONS.md](OPERATIONS.md) / [DIAGNOSTICS.md](DIAGNOSTICS.md) |
| 发布和打包 | [VERSIONING.md](VERSIONING.md) |
| 协议核对 | [protocol-preflight](protocol-preflight/README.md) |
| 历史变更 | [archive/CHANGELOG.md](archive/CHANGELOG.md) |

## 保持一致

同一次用户操作由同一个领域服务处理。入口负责鉴权、输入和展示，不另建写入路径。状态变更在事务里合并最新数据；凭证只写入私有配置，不进入导出文件、诊断摘要或日志。

修改行为后同步相关接口文档和风险。已完成的旧计划不能作为当前进度；历史证据保留原日期和验证范围。
