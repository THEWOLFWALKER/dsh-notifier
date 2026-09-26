# dsh-notifier knowledge base

这是人类和 agent 的导航页。每个问题尽量只指向一个权威来源；运行时真相仍是 `src/` 与 `test/`，版本真相是 `package.json`。

> 当前工作线 overlay：源码包版本为待发布的 `0.13.1`（dev）；v0.13 的 C11/C12 收口、管理台双语、证据边界与 npm payload 复核已完成，2011 tests 全绿，正在执行正式 release closeout。真实 provider/真机证据仍按 `docs/memory/risks.md` 保持 open。

## 当前基线

- 当前发布线：**v0.13.1**（v0.13 follow-up release，包版本字段 `0.13.1`，2011 tests 全绿，正在完成 `main`、tag、GitHub Release 与 npm closeout）：canonical 出站键 `channel:<type>:outbound` 始终读取（Admin 关闭不得复活旧 overlay）、`OutboundSource` 为唯一运行时权威、DSH Connection RPC `/dsh-notifier`、一次性 Advanced Console 启动票据、Health/Activity/Channels/Tasks/Questions 投影、Native 前端（Host React，无 iframe/esbuild/react-dom）。上一发布线 **v0.13.0**（1985 tests；tag `v0.13.0`）。
- 当前测试：`2011`（2011 pass，v0.13.1 release baseline）。v0.13.0 发布基线为 `1985`；v0.12.0 为 `1831`；v0.11.0 为 `1816`；历史 v0.10.1/v0.10.2 为 `1616`、v0.10.0 为 `1605`、v0.9.7 为 `1548`、v0.9.6 为 `1544`、v0.9.5 为 `1531`、v0.9.0 为 `1352`、npm `0.8.6` 契约为 `909`；按版本区分。
- 单仓库双分支模型：`THEWOLFWALKER/dsh-notifier` 是唯一仓库，`dev` 分支做开发、`main` 分支做发布（发布版本 + 标签 + npm）。
- 生态收录：v0.12.0 已发布；Awesome DSH / dshfind 的公开描述刷新是发布后的外部同步步骤，不影响仓内版本事实。
- Node.js ESM、Node `>=22`、无生产依赖、无构建步骤；28 个出站渠道，Telegram/Feishu/QQ Bot/WxPusher/WeChat iLink/DingTalk 六个入站控制通道。
- v0.12 起 DSH Native「通知与控制」是日常主控制面（Sidebar/Main + Plugins 入口）；Standalone Web 管理台只监听 `127.0.0.1`，降级为 Advanced / Recovery；YAML / CLI 是高级、自动化与 headless 入口。出站保存 Hot Apply，不重启。
- Native 与 Web/admin 的问题结算均复用 Control Core；desktop `ask_user` 没有安全宿主接口，不能声称桌面结算或双端共享。DSH `0.1.7-rc.2` Native 视觉/交互与 `alpha.1` 兼容性冒烟已通过；provider/device 级验证仍按 `docs/memory/risks.md` 单独记录。

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
