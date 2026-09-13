# dsh-notifier 当前交接快照

更新时间：2026-09-12。当前发布线 **v0.10.0（codex/mobile-task-loop-v010 收口，1605 tests 全绿）**：手机接管 DSH 任务闭环——宿主能力快照（`createHostCapabilitySnapshot`）、经 `ctx.userQuestions` 公开 seam 桥接原生提问（无安全扩展点时安全降级 fallback）、Web-first 远程延迟升级（Stage 0/1/2 + 定时器取消 + 跨端终态同步）、移动任务路由（任务投影 / 任务选择 / 歧义前置 + `/tasks`/`/use` 命令）、图片进入 DSH 会话（P0 图片路径 + 受控下载 SSRF 防护 + 失败回执）、管理台暴露 DSH 连接与任务状态（`/api/tasks`、`/api/host`）。上一发布线 **v0.9.7（codex/pr22-issue23-fix 收口，1548 tests）**：Telegram ask_user 单选卡片补「自定义回答/跳过」按钮 + callback ref 回收 + custom/skip 来源与 token fail-closed 校验（PR #22）、QQ 网关心跳时序死循环修复（HELLO 只鉴权，READY/RESUMED 后才幂等起搏；Issue #23）。再上一发布线 **v0.9.6（codex/admin-zero-config-onboarding 收口，1544 tests）**：安装后不写 YAML——admin 默认启用、首启打印 `http://127.0.0.1:<port>/#token=...` fragment 启动链接（launchToken 仅此一次明文）、端口冲突自动回退系统分配端口、出站 state 键域分域（`admin:channel:<type>:outbound`）、方向明确 API、管理台 UI 整体重构（`src/admin/ui/` 三件套 + 首访三步向导）。明细见 [CHANGELOG.md](CHANGELOG.md) 对应段。已知残留：原生提问桥与 QQ 图片解析按 contract/fixture 证据实现、未跑真机复验（缺口记 `docs/memory/risks.md`）。

上一发布线：**R5（v0.9.5，已收口 1531 tests）**：按 2026-08 审查线 80 项问题清单累计完成 70 项修复（另 G-19 取证登记不改码；9 项登记不修：G-35/36/37 结构债、S-01/03/08/09/10/15，见 TECHNICAL_DEBT/risks）。R1（v0.9.1，21 项）：W1 钉钉 Stream 协议 G-01/02/10/23/24/42、W2 码点分段 G-03/22/40、W3 命令矩阵 G-04/06/25/33/43/52/65、W4 管理台审计 G-05/41、W5 合并窗路由键 G-51/48/49。R2（v0.9.2，12 项）：W6 出站投递语义 G-50/08/09/56、W7 错误可见性 G-53/54、W8 token 与网关生命周期 G-11/55/29/07/21/12。R3（v0.9.3，4 项）：W9 安全中危 S-02/S-05/S-06/S-07。R4（v0.9.4，27 项）：W10 配置校验与渠道枚举收敛（G-13/S-12/G-61/62/63/64/G-32/G-38/G-39/G-45/G-28，提交 `5a06dac`）；W11 入站生命周期（G-15 bus priority + G-46 合成键 60s 短窗，提交 `6036706`；G-16 重启失效告知/G-17 飞书 TTL/G-18 去重键分离/G-26 非文本静默/G-27 单调 seq/G-30/31 过期码不计锁出/G-34 文本线 5min 抑制，提交 `01c20ec`；G-19 证据不足仅登记 `docs/memory/risks.md` 不改码）；W12 存储与状态（G-20 铸造原子写/G-47 覆盖行 30d/G-44 坏键清洗/G-14 出站视图热投递冷/S-14 resolve 前态/S-04 权限自检，提交 `28cbd75`）。R5（v0.9.5，W13）：G-57 脚本重命名 channel-selfcheck、G-58 mock 保真（qq error/半帧/超时 + public 超时 + 分层原则）、G-59 三新套件（health/escalation/pairing）、G-60 命令清单 11 条 + accountId 排障、S-11 hook-server 排除出包、S-13 optionalDeps 精确锁定。全部为 mock/contract 证据，协议类修复未经真机验证（缺口记 `docs/memory/risks.md`）。

| 测试 | `npm test`：**1605 tests**（v0.10.0 发布收口基线） |

## 下一位开发者从这里开始

1. 先读 [AGENTS.md](AGENTS.md)、[docs/KNOWLEDGE_BASE.md](docs/KNOWLEDGE_BASE.md)、[docs/memory/README.md](docs/memory/README.md)。
2. 用户操作从 [docs/guide.md](docs/guide.md) 开始；运维、状态目录和发布冒烟见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。
3. 稳定模块和数据流见 [docs/architecture.md](docs/architecture.md)；协议事实边界见 [docs/protocol-preflight/](docs/protocol-preflight/)；安全评审见 [docs/security/](docs/security/)。
4. 当前维护队列只看 [docs/TECHNICAL_DEBT.md](docs/TECHNICAL_DEBT.md)，版本/发布规则只看 [docs/VERSIONING.md](docs/VERSIONING.md)。`docs/agent-taskpacks/` 仅是历史索引，不是执行入口。

## 产品与架构现状

- Node.js ESM（Node `>=22`），无生产依赖、无构建步骤；27 个出站渠道由统一 adapter/spec 层装配。
- 入站控制通道为 Telegram、Feishu、QQ Bot、WxPusher、WeChat iLink、DingTalk。通知、审批、会话输入和 `ask_user` 共享状态、路由、账本与 Control Core。
- 身份是 `(channel, userId)` 绑定；涉及账号/聊天时继续精确匹配 `(channel, accountId, userId, chatId)`。未绑定、来源冲突、未知 `chatType`、缺关键来源字段均默认拒绝。
- Web 管理台是唯一控制台，且只监听 `127.0.0.1`、使用 Bearer token。个人模式首屏引导配置通道、配对成员、测试发送；会话/绑定等高级项按需展开。YAML 是高级/自动化入口，不是第二套控制台。
- Web/admin 已有脱敏问题列表及 choose/reject 结算（`/api/questions`、`/api/questions/:ref/settle`），结算始终经过 Control Core。桌面 `ask_user` 没有安全宿主接口，因此不得声称 desktop 可结算或已有双端共享；超时/失败必须交还桌面，绝不代答。

## 已完成范围（代码/契约证据）

- Control Core/session arbiter 已覆盖 token 单次核销、来源/会话/聊天精确绑定、首达采纳、竞态与失效 fail-closed；团队审批成员为有界精确三元组。
- Session control overlay 已经由 registry、router 和 loopback admin 持久化并做字段/来源隔离、记录级合并、拷贝读取和持久化失败传播；管理台只返回脱敏摘要。
- Telegram/Feishu provider facade、QQ C2C 按钮与 GROUP 文本 fallback、WeChat iLink/DingTalk 图片 envelope、WxPusher 本地 `accountId`、回调容量和插件 facade 边界均已契约测试。
- 已移除将 channel 名伪作 accountId 的兜底；Telegram/Feishu 直接按钮回调带 provider eventId；问题编号回复的账号透传和成功回执已修正。
- 管理台个人模式首屏、加载/空态/错误/禁用/窄屏/破坏性确认状态已覆盖 focused tests。所有通知渠道故障应隔离，不得阻塞启动或其他渠道。

## 不可越过的安全红线

- 入站默认拒绝；身份和回调必须绑定原始 channel/account/user/chat。token 有时限且单次使用，错误来源、异常、超时、畸形输入都回到桌面。
- Control Core 是审批与提问的唯一授权/结算边界；管理台不能直写答案或账本。`notifyAll().delivered` 只能说明渠道级结果，不能证明具体聊天送达。
- 凭证、token、完整用户/聊天/agent 标识不得出现在日志、API 响应、脱敏快照或 DOM。状态写入必须保留无关 key，并通过现有 store 锁与合并语义。
- `ctx.notifier` 预算、冻结 facade、回调容量和限流只是支持路径上的约束；同进程插件仍是受信边界，不宣称 OS 隔离。内部构造器只从 `dsh-notifier/internal` 暴露。

## 明确残余与验证缺口

- 所有当前证据主要是 mock/contract/seam tests。未完成真实 Telegram/Feishu/QQ/DingTalk/iLink/WxPusher 设备 payload、按钮 ACK、重连、媒体/文件限制和长连接验证；`declared` 能力不得写成正式支持。
- 未完成 DSH 宿主真实事件/桌面 toast（BurntToast/PowerShell）验证；桌面 `ask_user` 没有安全宿主接口。管理台真实浏览器操作、宿主重启读取 overlay、真实 provider 回调仍待做。
- npm registry 接受/干净 disposable profile 安装仍是发布门；工程树与 npm archive 若不一致，以工程树为准并记录差异。多 WxPusher 应用必须配置不同本地 `accountId`，否则共享 `default` 命名空间。

## 发布前步骤

```text
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
npm pack --dry-run --json
```

确认干净工作树、版本/测试数与 [docs/VERSIONING.md](docs/VERSIONING.md) 一致后，在 disposable DSH profile 安装已发布的 `dsh-notifier@0.9.0` registry artifact，验证启动装配、一次出站测试和一次入站命令。不要从公共镜像继续开发。

## 当前提交入口

继续开发前以源码和测试为准，先建立新的 `codex/<topic>` workstream；不要复活已删除的旧 taskpack 或 `docs/test-notes/` 测试包。当前长期方向仍是个人模式优先的跨 IM control-plane 路线图，详见 [docs/architecture-roadmap.md](docs/architecture-roadmap.md)，其中规划内容不等于已发布能力。
