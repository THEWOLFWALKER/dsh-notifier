# dsh-notifier knowledge base

这是人类和 agent 的导航页。每个问题尽量只指向一个权威来源；运行时真相仍是 `src/` 与 `test/`，版本真相是 `package.json`。

## 当前基线

- 当前发布线：**v0.12.0**（Native Control Surface + 出站热生效 + 出站状态迁移，包版本字段 `0.12.0`，`main` 已并入并 tag `v0.12.0`；真机 DSH 宿主 `0.1.7-rc.2` 视觉/交互验证与 `alpha.1` 兼容性冒烟均已通过）：canonical 出站键 `channel:<type>:outbound` 始终读取（Admin 关闭不得复活旧 overlay）、`OutboundSource` 为唯一运行时权威、DSH Connection RPC `/dsh-notifier`、一次性 Advanced Console 启动票据、Health/Activity/Channels/Tasks/Questions 投影、Native 前端（Host React，无 iframe/esbuild/react-dom）。上一发布线 **v0.11.0**（issue/PR 清零 + 宿主对齐 + 生态公共面，1816 tests；`main` @ `dfb4983`，tag `v0.11.0`）。更早 v0.10.2（文档清理与收录状态收口，1616 tests）。
- 当前测试：`1831`（1831 pass，v0.12.0 发布基线）。v0.11.0 发布基线为 `1816`；历史 v0.10.1/v0.10.2 为 `1616`、v0.10.0 为 `1605`、v0.9.7 为 `1548`、v0.9.6 为 `1544`、v0.9.5 为 `1531`、v0.9.0 为 `1352`、npm `0.8.6` 契约为 `909`；按版本区分。
- 单仓库双分支模型：`THEWOLFWALKER/dsh-notifier` 是唯一仓库，`dev` 分支做开发、`main` 分支做发布（发布版本 + 标签 + npm）。
- 生态收录：Awesome DSH 收录条目已按 v0.10.2 刷新（PR #4981，更新手机任务接管/图片入会话/双语消息等描述），下一次刷新随 v0.11.0 发布；dshfind 按仓库元数据周期性同步。
- Node.js ESM、Node `>=22`、无生产依赖、无构建步骤；28 个出站渠道，Telegram/Feishu/QQ Bot/WxPusher/WeChat iLink/DingTalk 六个入站控制通道。
- Web 管理台是唯一控制台，绑定 `127.0.0.1` 并使用 Bearer token；YAML 是高级/自动化入口。个人模式流程是配置通道 → 配对/扫码 → 测试发送 → 日常审批与 `ask_user`。
- Web/admin 的问题 choose/reject 已接 Control Core；desktop `ask_user` 没有安全宿主接口，不能声称桌面结算或双端共享。真机、provider 和 DSH 宿主协议验证仍未完成。

## 阅读顺序

1. [AGENTS.md](../AGENTS.md)：边界、工作流、验证命令。
2. [memory/README.md](memory/README.md) 与 [memory/project-state.md](memory/project-state.md)：当前事实和发布门。
3. [README.md](../README.md) / [README.zh-CN.md](../README.zh-CN.md)：安装与能力概览。
4. [guide.md](guide.md)：从安装、开启管理台到个人模式、配对、测试通知和日常使用。
5. [architecture.md](architecture.md) / [architecture-roadmap.md](architecture-roadmap.md)：已实现架构与规划方向（规划不等于已发布）。
6. [OPERATIONS.md](OPERATIONS.md) / [VERSIONING.md](VERSIONING.md)：运维、验证和发布规则。
7. [protocol-preflight/](protocol-preflight/) / [security/](security/) / [compatibility-matrix.md](compatibility-matrix.md)：协议、安全与兼容性证据。
8. [HANDOFF.md](../HANDOFF.md)：当前交接快照；[CHANGELOG.md](../CHANGELOG.md)：变更历史。

## 能力与安全摘要

- 出站统一经 adapter/spec 层，通知分为 `timeSensitive`、`active`、`passive`；入站审批、会话、问题共享 Control Core、token vault、身份绑定、来源聊天校验和首达结算。
- 身份至少按 `(channel,userId)` 隔离，携带账号/聊天时精确匹配 `(channel,accountId,userId,chatId)`。未知来源、缺关键字段、错误 token、过期或异常均 fail-closed。
- QQ C2C 按钮与 GROUP 文本 fallback、QQ/WeChat iLink/DingTalk 图片 envelope 属于 contract-tested；文件/媒体和 provider payload、重连、回调 ACK 仍是 `declared` 或未验证，禁止写成真机支持。
- `ctx.notifier` facade 具有冻结消费面、来源标签清洗、有限调用/字节/并发/队列预算；这些是支持路径约束，不是同进程插件的 OS 隔离边界。

## 权威规则

- 文档与源码冲突时先查源码和测试，再在同一变更中修文档。记忆文件保持短小、使用绝对日期，不记录聊天流水账。
- `docs/agent-taskpacks/` 只保留历史协作索引，不是当前执行入口；已完成旧 taskpack 与旧真机测试笔记已清理。
- 状态写入必须保留无关 key、使用现有锁/合并行为，且不在日志/API 暴露凭证。公共仓库不作为开发 relay。
