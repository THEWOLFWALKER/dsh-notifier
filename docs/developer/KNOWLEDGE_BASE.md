# 工程资料入口

当前重构的唯一执行入口是 [rebuild-v015](rebuild-v015/README.md)。它包含产品决定、架构、阶段、测试审查、原始 ID 和上游契约。历史计划已从工作树移除，不能用旧测试或旧报告推断新产品需求。

| 需要了解 | 资料 |
|---|---|
| 下一阶段决定与执行 | [重构 taskpack](rebuild-v015/README.md) |
| 当前代码结构 | [architecture.md](architecture.md)，并以实际 `src/` 核对 |
| 外部插件契约 | [PLUGINS.md](PLUGINS.md) / [English](PLUGINS.en.md)；实施时按 taskpack 修订 |
| 渠道协议与本地运行 | [protocol-preflight](protocol-preflight/README.md)、[OPERATIONS.md](OPERATIONS.md) |
| 发布与打包 | [VERSIONING.md](VERSIONING.md)、taskpack 的发布门禁 |
| 当前交接状态 | [HANDOFF.md](HANDOFF.md)、[PROGRESS.md](rebuild-v015/PROGRESS.md) |

用户入口是根 README 和 `docs/user/`。用户文档只讲任务与结果，不能堆内部术语。代码是当前行为证据；需求与取舍以用户决定和 taskpack 为准。
