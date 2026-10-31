# dsh-notifier × dsh-std：固定基线独立静态适配审查

**审查日期：** 2026-10-25  
**方法：** 只读静态检查 GitHub 固定提交的源码、类型、配置、发布元数据、GitHub Release/tag 源树和现有测试文本。没有安装依赖、构建、运行测试、启动 DSH、执行探针或修改项目/远端状态。现有测试是测试意图与覆盖位置证据，**不是本次通过的验证**。

**唯一的 notifier 审查目标：** [`THEWOLFWALKER/dsh-notifier@9d69dd7a8908fcfec6e20d92d56509764a8f23ec`](https://github.com/THEWOLFWALKER/dsh-notifier/tree/9d69dd7a8908fcfec6e20d92d56509764a8f23ec)，`main`，`package.json` 版本 **0.13.1**。不纳入 notifier `dev` 或任何重写分支。  
**唯一的 dsh-std 源码审查目标：** [`T-Auto/dsh-std@37e9c35b953f0dccaad089df6e68e4f00daae7bd`](https://github.com/T-Auto/dsh-std/tree/37e9c35b953f0dccaad089df6e68e4f00daae7bd)。  
**发布基准另列：** `@dsh-std/adapter-dsh@0.1.1-rc.4` 对应 [GitHub 发布 tag](https://github.com/T-Auto/dsh-std/releases/tag/%40dsh-std/adapter-dsh%400.1.1-rc.4) 的被标记提交 [`7401fcd78303ff4636c6dc348aae1acf81bc3cc3`](https://github.com/T-Auto/dsh-std/tree/7401fcd78303ff4636c6dc348aae1acf81bc3cc3)。固定 dsh-std 源码比该发布 tag **超前 25 个提交**（GitHub commit compare 的实际结果）。源码工作区 `package.json` 虽仍标 `0.1.1-rc.4`，**不能据此把 Unreleased 更改当作 rc.4 已发布**。

> **核心裁决：暂缓整体接入 dsh-std，保留 notifier 现有原生宿主适配。** `Tool` 的本地注册执行、部分 Session 只读查询、另起标准 UI 的两个 Web surface 是真实可映射的窄子集；它们不覆盖 notifier 的关键复杂性——事件、Agent 操控、原生审批/提问、手机 GUI 并行首达、附件持久化、Native 主面板、真实 IM。当前只为 notifier 一个项目引入 adapter，净收益偏低、产品运行依赖和版本矩阵显著增加。

## 1. 四种事实必须分开

| 层次 | 证据源 | 能确定什么 | 不能推断什么 |
|---|---|---|---|
| ① 设计提案 | `docs/proposals/*.zh.md` | 作者设想的未来 operation、authority、生命周期 | 不能证明 npm 包存在、Adapter 发布了 support、DSH 调用了操作 |
| ② 真实协议包定义 | `packages/*/src/*.ts` | 本提交定义、导出与校验的 kind/operation | 定义已 `register(catalog)` 不等于产品 `supports` 或实现 handler |
| ③ Adapter 真实 support / 映射 | `packages/adapter-dsh/src/index.ts`、`session-adapter.ts`、`client.ts` | `standardImplementations()`、`declaration.supports`、`installProductExtensions()`、UI surface registration 的实际边界 | 不能把整个 union operation、所有 proposals 或 TS 类型视为支持 |
| ④ npm 指定版本字节 | npm 发布 tarball / dist 元数据 | 用户最终安装得到的 JS、d.ts、依赖声明 | **本次未取得并核对 npm tarball 字节；本层全部标记“未直接核实”。** GitHub 发行 tag 和 GitHub Release 的 tgz 资产是独立的间接证据，不能代替 npm 包校验 |

在 dsh-std 固定提交中，`packages/agent`、`packages/permission`、`packages/events` **不存在**；相应 `docs/proposals/agent.zh.md`、`permission.zh.md`、`events.zh.md` 为设计提案。协议包 `messages` 与 `presentation` 已有定义与 helper，但 adapter 内 `registerMessages()`、`registerPresentation()` **只为协商目录注册定义**；`standardImplementations()` 实际只给 `CommandRuntime`、`ModelCatalog`、`SessionCatalog` 和 `SessionHistory`（以及独立的 extension/Skill 映射）。

**发布元数据复核：** GitHub release 在 **2026-10-02 13:56 UTC** 公布 `@dsh-std/adapter-dsh@0.1.1-rc.4`，GitHub asset 名 `dsh-std-adapter-dsh-0.1.1-rc.4.tgz`（119,232 字节；发布页面标的 SHA-256 为 `8ea47d9fe22cd6d89943cc69b23af886db1e91bb5c87f6e4c0fb14513b212516`）。**资产未下载、未解包；npm dist-tags `latest`、`rc` 的当前精确指向仍未知。** 不能沿用历史上“latest=rc.2、rc=rc.4”的结论为本次核验结果。GitHub 的发行机制文档称 prerelease 使用 `rc` dist-tag、稳定发行才用 `latest`，但这仍不是 npm 当前 registry 快照。

## 2. 固定提交逐能力覆盖矩阵

说明：**可用**表示在源码/Release tag 对照看到可落地的宿主映射，但不代表在 notifier 或当前 DSH 中运行成功；**部分**表示只覆盖子需求；**提案**表示仅设计层；**无**表示该映射在所审固定提交与发行 tag 范围未发现。`Std` 文件默认指 `T-Auto/dsh-std@37e9c35`。**测试位置一律为既有测试文件，不是本次实测**。

| notifier 实际需求 | notifier 固定基线来源 | dsh-std 定义与 Adapter 真实行为 | 判断 | 现有测试（静态） |
|---|---|---|---|---|
| **模型可调用 `notify` 工具注册 / 执行** | `src/tool-register.mjs:99-183`；`src/index.mjs` 装配 | `packages/tool/src/index.ts` 定义 `Tool`/`ToolOverride` resource；`packages/adapter-dsh/src/index.ts:1680-1717` 处理 Tool extension，经 `ctx.tools.register()` 真正入 DSH 工具 runtime；ToolHandler 为**同进程本地 handler**，不是通用远程执行 capability；保留 notifier 的限流、路由、返回形状、渲染语义需另外核对/桥接 | **部分可替换“注册入口”**；不替换通知实现 | notifier `test/tool-register.test.mjs`；std `packages/tool/tests/tool.spec.ts`、`packages/adapter-dsh/tests/adapter.spec.ts`（Tool 注册/执行） |
| **任务开始/输出/结束/失败事件** | `src/event-listener.mjs:93-137,491-579`、`src/host-events.mjs:110-198`，`status/turn-tracker.mjs` | `SessionHistory.read/follow` 映射真实持久 Session events；`MessageObserver` 定义只列 `message.created/received/sent` 且 adapter **未发布** source；标准通用 Events 为提案。没有对应 `agent/error`、`turn/start`、`turn/end` 的等价实时语义推送映射 | **不替换**原生事件订阅 | notifier `test/event-listener.test.mjs`、`test/host-events.test.mjs`；std `packages/adapter-dsh/tests/session-adapter.spec.ts`、`packages/messages/tests/messages.spec.ts` |
| **Session 列表/get** | `src/routing/session-registry.mjs`、`src/inbound/conversation.mjs`（`/sessions`、绑定/路由） | `SessionCatalog` 经 `sessionController.list/inspect`，`operations:['list','get','create','rename']`；只读 list/get 可查宿主持久 Session，排除 subagents；不携带 notifier 的 `route:sessions`、owner、workspace、订阅、IM binding | **部分**：宿主持久 Session 查询投影可选，不可替换 notifier 路由台账 | notifier `test/session-registry.test.mjs`、`test/inbound-sessions-command.test.mjs`；std `packages/adapter-dsh/tests/session-adapter.spec.ts` |
| **Session 历史 read/follow** | notifier `src/inbound/conversation.mjs` `/log` 侧，`src/ledger.mjs` 通知账本，宿主源事件 | `SessionHistory` adapter 真正发布 `read`,`follow`，有分页与 history cursor；标准 contract 的 `fork` **未发布**；`/log` 自身依赖通知 ledger，不等同 SessionHistory；follow 不是未经加工的 `session/event` 总线 | **部分可用，不作原生事件替代** | notifier `test/inbound-log-command.test.mjs`；std `packages/session/tests/session.spec.ts`、`packages/adapter-dsh/tests/session-adapter.spec.ts` |
| **Session 创建/修改** | notifier 当前以宿主 live agents 与插件绑定为主 | adapter `SessionCatalog.create/rename` 实现且有 `requestId` 的实例内去重；标准 `delete/watch` 仅在类型 union 中，**adapter 未实现**。没有 workspace membership 和 notifier identity/router 自动关联 | **部分**：create/rename 是真实现；**delete/watch 无** | std `packages/adapter-dsh/tests/session-adapter.spec.ts`（create/rename 重试）、`packages/session/tests/session.spec.ts` |
| **Agent followup/inject/steer/stop** | `src/inbound/conversation.mjs:819-883`、`src/actions.mjs`、`src/control/session-arbiter.mjs` | `docs/proposals/agent.zh.md` 写 `AgentControl`，但无 `packages/agent` 和无 Adapter AgentControl support/handler。SessionCatalog 不控制活动 Agent | **提案 / 不替换** | notifier `test/conversation.route.test.mjs`、`test/actions.test.mjs`、`test/session-arbiter.test.mjs`；std 无对应 adapter 操作测试 |
| **原生审批** | `src/approval/router.mjs` 的 `approval/request` waterfall 与 IM waiters | `presentation.dsh/v1alpha1 UserInteraction` contract 含 `approval`，但只是 **单次 invocation 的客户端请求**；Adapter 本身没有发布实际 Presentation provider / 宿主 approval seam 映射；`docs/proposals/permission.zh.md` 的 grants 还只是提案 | **不替换** | notifier `test/approval.test.mjs`、`test/approval.multi.test.mjs`；std `packages/presentation/tests/presentation.spec.ts`（仅协议层） |
| **原生提问** | `src/host/native-questions.mjs` 的 `userQuestions.registerProvider` 或 `user-questions/request` waterfall；`src/questions/router.mjs` fallback | `UserInteraction` 定义 `question/approval/secret-input`，但 adapter 没把 `userQuestions` 产品源接进来；浏览器命令 Remote 的 Presentation 默认 `undefined`；原生批次/GUI 并行裁决也无映射 | **不替换** | notifier `test/native-questions.test.mjs`、`test/questions.test.mjs`；std `packages/presentation/tests/presentation.spec.ts` |
| **手机与 GUI 首达结算、取消输家、超时、重启** | `src/questions/router.mjs`、`src/approval/router.mjs`、`src/interaction/ledger.mjs`、`src/host/native-questions.mjs`、`src/inbound/store.mjs` | Presentation 规定 invocation-scoped 请求结果与协商，不提供跨设备原生/IM 并行 authority 仲裁、持久 retry/settle、撤卡清理与重启恢复；Notification receipt 的 `accepted` 不等于最终 IM delivered；`CleanupScope` 不是 durable ledger | **不替换，必须保留 interaction owner** | notifier `test/mobile-task-loop-contract.test.mjs`、`test/questions-web-first.test.mjs`、`test/terminal-cleanup-v013.test.mjs`、`test/interaction.ledger.test.mjs` |
| **附件保存、UserMessage V4** | `src/host/messages.mjs:37-124`、`src/inbound/conversation.mjs:827-886` | adapter tool context 内可经 DSH attachment 存取**用于标准工具**的图片等设施；`MessageObserver` 只定义只读 text/image 子集，不支持入站 file durable refs，也没发布 observe source；不替代 `saveImage/saveFile` 及 DSH UserMessage V4 | **不替换** | notifier `test/conversation.attachment-delivery.test.mjs`、`test/inbound.message.test.mjs`；std `packages/messages/tests/messages.spec.ts`、`packages/adapter-dsh/tests/adapter.spec.ts` |
| **Native 侧栏、主面板、原生设置/插件配置** | `client.js:1041-1088` 实际注册 `main`、`sidebar.panellist`、`plugins.bundle.config`、`plugins.bundle.activation`；`src/control-surface/rpc.mjs` | std `ContributionHost` 真实 browser surface 仅 `SettingsSection→settings.section`、`ToolCallView→tool.call.toolview`；与 notifier 四个 slots 不同，不是自动映射。UI v1alpha2 的可选 surface 只在 frozen std 源码，**不是 rc4 tag** | **不替换主 UI**；仅可另设标准 SettingsSection | notifier `test/client-module.test.mjs`、`test/control-surface-rpc-v012.test.mjs`；std `packages/adapter-dsh/tests/client.spec.ts`、`packages/ui/tests/ui.spec.ts`；main 新增 `optional-surfaces.spec.ts` |
| **工具视图 ToolCallView** | notifier `notify` 自带 DSH output render；Native 主 UI 与工具输出语义分开 | adapter browser `ToolCallView` 实际映射 `tool.call.toolview` slot，限定 Web LocalModule；需标准 component 发布相应 UI facet 与正确 tool key，不保证原有 `notify` 输出 render 等价 | **可选新增 / 非必要替代** | notifier `test/tool-register.test.mjs`；std `packages/adapter-dsh/tests/client.spec.ts` |
| **headless 最小启动** | `src/index.mjs` 只强制 `tools,agents,connection`，`webServer`/native questions optional；`package.json` 运行时无强制 `@dsh-std` | adapter 强制 `agents,llm,sessionController`，且 constructor 无 `sessionController` 时直接 throw；UI 可不载入但不能自动认为裸 headless 有 Session Controller；profile 扫描额外链路 | **无证据证明适用更小 host；可能使最小启动更重** | notifier `test/index.test.mjs`、`test/assembly-runtime.test.mjs`；std `packages/adapter-dsh/tests/adapter.spec.ts` |
| **真实 IM 离线推送与入站回传** | `src/adapters/*`、`src/inbound/*`、`src/inbound/identity.mjs`、`src/routing/*`、`src/notify.mjs` | `Presentation.Notification` 只是向当前 presentation endpoint 显示提示，`NotificationReceipt.accepted` 不代表 Telegram/飞书/QQ 已真实投递，更没有配对/身份/可靠回传；标准消息观察也不是传输通道 | **不替换** | notifier `test/adapters.test.mjs`、`test/inbound.telegram.test.mjs`、`test/inbound.feishu.test.mjs`、`test/inbound.qq.test.mjs` 等 |
| **生命周期 / 撤销** | `src/index.mjs` `ctx.effect→disposeAll()`，手动关闭监听/推送/定时器/HTTP 等 | adapter `LifecycleCoordinator` + `CleanupScope` 能撤销**纳入本次 facet activation 归属**的 scoped protocol/extension 与 wrapper 安装的注册；并不会自动认识 notifier 的网络连接、timer、in-flight 请求、状态持久化 | **部分取代登记框架，不代替资源管理语义** | notifier `test/index.test.mjs`、`test/terminal-cleanup-v013.test.mjs`；std `packages/lifecycle/tests/lifecycle.spec.ts` |

### 不能混淆的六个「看着相同，实际不同」

- `registerMessages(catalog)` **不是** Adapter 发布 `MessageObserver` publisher；`MessageObserver` 也不是 `turn/end` 或 `agent/error` 的等价物。
- `UserInteraction` 里的 `approval` 类型 **不是** DSH `approval/request` waterfall 的 handler，也不是两个端点同时等待同一审批的账本。
- `SessionCatalog` 的 operation union 有 `watch/delete`，但 adapter support **只声明** `list/get/create/rename`；`SessionHistory.fork` 同理未发布。
- `Tool` resource 本地 handler 可以映射到 `ctx.tools.register`，不等于 adapter 公开了任意进程直接调用模型工具的远程 RPC。
- `SettingsSection` 不是 notifier 的 `plugins.bundle.config`；`ToolCallView` 不是 `sidebar.panellist` / `main`。
- `NotificationReceipt.accepted` 是展示端接受，不等于 provider delivered、用户收到、手机可回传。

## 3. Adapter 必须服务、依赖和当前版本语义

### 必需服务与条件性服务

在 tag 和固定 std main 的 `packages/adapter-dsh/src/index.ts`，Adapter 类显式 `static inject=['agents','llm','sessionController']`；构造立即通过 `ctx.get('sessionController')` 取得服务，缺失就抛错。这个**额外强制项**相对于 notifier 的 `['tools','agents','connection']`，使得“headless 可用”不能仅由没有 browser UI 推导。使用 Tool 扩展时仍需 `tools` DSH service，`ToolOverride` 在 Agent 创建和工具视图中处理；Skill 要 `skills`，工具/模型具体上下文还可依赖 attachments、fs、llm、write-intent 等；Web UI facet 则另需 browser slots、locale、remote、sessions、modules 和对应 client 包。

`packages/adapter-dsh/package.json` 记录 `@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/schemastery ^3.18.1`、`react ^18.2.0` 与多项 `@deepseek-ai` DSH peers。`dsh-commands`、`dsh-attachment`、`dsh-llm`、`dsh-session`、`dsh-skill`、`dsh-tools`、`dsh-typert-protocol`、`dsh-api-gateway`、`dsh-api-session-controller`、`dsh-client-modules`、`dsh-client-ui-settings`、`dsh-client-ui-tool` 的 version range 一致：

```text
>=0.1.5-rc.2 <0.1.6 || >=0.2.0-rc.1 <0.2.1
```

注意在 `peerDependenciesMeta` 里 `api-gateway`、`dsh-skill`、`dsh-client-modules`、`dsh-client-ui-settings`、`dsh-client-ui-tool`、`react` 为可选 peer；`dsh-api-session-controller` **不是** optional。Adapter 自己 `dependencies` 列有 `@dsh-std/core,manifest,composition,lifecycle,connection,command,messages,model,session,skill,storage,tool,ui,ui-browser,presentation,sdk,workspace` **17 个 @dsh-std 包**，加 `zod`。`workspace:^` 在发行安装时必须由打包/发布转换为可解析 npm 版本；本次无法核对实际 npm tarball，所以不能宣称已解决或有包体缺陷。

**重要：预发布版本预检。** 用户给出的 DSH `0.2.1-rc.2` 安装器使用 `includePrerelease:true`；以此选项解释上述 `>=0.2.0-rc.1 <0.2.1`，语义上包括 `<0.2.1` 的 `0.2.1-rc.2`（以及相应的 `rc.3`），不能用默认 semver 排除它而得出不兼容结论。**但 semver 匹配只说明版本范围，不证明 ABI/API 已对齐。** Adapter 发布 tag 明确按 `0.2.0-rc.2` 类型开发/对齐；对 `0.2.1-rc.2/rc.3` 仍无本次宿主运行验证。反过来，notifier `package.json` 的 `@deepseek-ai/dsh-session` optional peer 只列 `0.1.7-alpha/rc`，与新版 DSH 并非已声明的直接兼容，此问题引入 std 也不能自动解决。

### npm dist-tags 的证据等级

截至本次静态查询：GitHub Release 与 tag 证实 **`0.1.1-rc.4` 有发行记录**，`packages/adapter-dsh/package.json` 标记的版本也是 `0.1.1-rc.4`。**npm registry 指定版本真正提供的 JS/d.ts 文件、`latest` 与 `rc` 的实时指向未取得。** 因此此前观察“`latest → rc.2`，`rc → rc.4`”仍是一条**待核验历史观察**，而不是本次新确认。也不能仅用 `main` README 的未来时能力推断 rc4 npm 包已包含。

## 4. 明确哪些内容已进入 main 但未进入 rc4 GitHub 发布 tag

以 GitHub 2026-10-02 rc4 发布 tag 提交 `7401fcd...` 与固定 std main `37e9c35...` 比较（ahead 25 commits，**并非 npm 包字节对比**）：

| 固定 std main 能力/修补 | rc4 发布 tag 的静态状况 | 文件与已有测试 |
|---|---|---|
| 导入 facet 之前对 manifest-readable required contracts 做**静态 preflight**，并在 `mount()` 再次检查 live state | **未进入 tag**。tag 的 profile discovery 先 `import()` Host facet 再 `mount()` 检查；不能把 main 的 import-before-preflight 保证归给 rc4 | `packages/adapter-dsh/src/index.ts`；main `packages/adapter-dsh/tests/adapter.spec.ts:522+` |
| `ui.dsh/v1alpha2 ContributionHost`，required/optional surfaces 和 version-isolated clients；V1 仍默认 | **未进入 tag**，tag 仅 V1 Host provider；V2 的导出和 binding 是 main 新内容 | `packages/ui/src/index.ts`、`packages/adapter-dsh/src/index.ts`、`src/client.ts`；main 新增 `packages/ui/tests/optional-surfaces.spec.ts` |
| browser facets 的 V2 requirement 通过 `contributes['x-dev.dsh-std.extensions']` 正确保留并映射 | **未进入 tag** | `packages/adapter-dsh/src/client.ts`、`src/index.ts`；main 新增 client/adapter 测试 |
| Host UI provider 注销后同 provider object 重新注册不让旧 agreement 恢复；异步 provider cleanup 与撤销隔离 | **属于 main Unreleased 修补**；tag 不拥有该具体补强的回归证据 | `packages/adapter-dsh/src/index.ts`；main `tests/adapter.spec.ts:1402+,1561+` |
| Lifecycle activation `generation` 参与者隔离，避免同一 facet 并行实例身份碰撞；停用并发共享 settlement；保留 activation 与 cleanup 双方错误、隔离 observer 失败 | **main 新增**；tag 仅包含原先 `CleanupScope.add` 幂等 disposer 与 reverse-await 收敛 | `packages/lifecycle/src/index.ts`；main `packages/lifecycle/tests/lifecycle.spec.ts:146+,205+,249+` |
| core 公共入口整理、多个包内部 import 对齐 | **main 变更未发版**；不等于新协议 capability 已落地 | `packages/core/src/*`、adapter / 各包 import diff、`packages/*/CHANGELOG.md` 的 `Unreleased` |

**证据边界：** 表格只能说“固定 std main 相比 GitHub rc4 发布 tag 新增了哪些源代码”，不能绝对说“npm 指定 tarball 逐字节必然不含”，因为本次未直接获取 npm 发布物。若需要严格的 npm 含量结论，该项标记 **未知，待单独取得对应 tarball 文本/校验**。

## 5. CleanupScope：实际约束与撤销的边界

源码 `packages/lifecycle/src/index.ts` 中 `CleanupScope` 只有 `signal:AbortSignal` 与 `add(dispose:()=>void|Promise<void>)`；`Scope.close()` abort 后倒序等待已登记的 disposers，单个 disposer 的重复调用共享 settlement；回收阶段累积 cleanup 错误。`LifecycleCoordinator` 会将通过 `context.protocols.implement()`、`context.extensions.publish()` 暂存并发布的句柄绑定到当前 scope，并在 unmount/shutdown 触发撤销。Adapter 的 Tool / UI 映射额外登记/关闭自己的 product handles。

**它不自动捕捉任何未经登记的资源。** notifier 中对 `ctx.on`、IM inbound 长轮询与 websocket、channel sender、HTTP webhook、`setTimeout/setInterval`、tracker/debounce/grace、native question waterfall、未完成 `Promise`、未决 interaction、附件保存、状态落盘，仍须由插件安排 `dispose` 或 signal 取消、等待完成/失败，或在多次启停时使用自己的 epoch/fencing 与 durable receipt。`signal.aborted` 本身不能阻断不遵循 signal 的下游回调，也不撤销已发往手机的外部卡片，更不会把持久交互账本“自动回滚”。

**版本限制：** rc4 tag 已有反注册/async disposer，但在**并发停用相同实例**、原错误与清理错误并存、observer 异常隔离、同 facet generation、重新注册相同 UI provider object 等场景，main 比 rc4 tag 增加了明确的代码补强。旧 agreement 的范围失效不是对任意宿主外部 listener 的自动撤销承诺。

## 6. 可否保留单一 Store、identity、路由及交互账本？

**可以“外围接入”，不可以“让 std 接管整个 notifier 而不做改造”。** 只要 std 只承担一个输出边界（例如把 notifier **既有** `notify` 执行入口包装为 Tool resource），并继续把 `createNotifier`、`publicFacade`、`inbound/store`、`identity`、`pairing`、`agent-router`、`session-registry`、`interaction/ledger` 作为**唯一主权源**，无需复制它们。但必须明确标准 Tool 的 execute context 到现有 notifier handler 的转换：agent/session 身份、信任与路由上下文、限流器持有状态、Tool output schema/render、返回的送达证据必须不变。

不能把 `SessionCatalog` 的数据复制到 `route:sessions` 形成第二个权威数据库；可将它视为只读“宿主持久 Session 索引”，**不替代绑定、owner 与消息来源身份**。不能把 Presentation 建另一套审批/问答 waiters 与 `ap:/aq:` 并行结算。不能让每个 std facet 自己另建 IM 身份或发信池。

## 7. 双订阅、双注册与双结算的防线

为每个能力设定**唯一生效 owner**，而非把原生与 std 并行当作“增强”：

| 领域 | 生产时唯一生效路径 | 若试点标准入口 | 必须禁止的状态 |
|---|---|---|---|
| `notify` model tool | 原生 `ctx.tools.register('notify')` | 只有明确试点 profile 的同一注册位由 std Tool extension 独占；tool body 仍调 notifier 的同一个 `notify` 函数；进入 active 后才切换，退出要恢复或 fail-closed | 同名工具注册两次、两个独立 limiter/路由解析、重复 IM 发送 |
| 任务 events | `host-events` 全局 `session/event` + `agent/error` → **一个** `createEventListener` | 本轮不得用 `SessionHistory.follow/MessageObserver` 混接成并发生产源；只可用于隔离的旁路诊断且不得触发 notifier | 一个 turn 对用户推送两次、事件 cursor 与事件 seq 混用 |
| 原生 approvals/questions | 既有 `approval/request` waterfall 与 `userQuestions` 桥为唯一 handler；interaction ledger 唯一 commit | 不启用 std UserInteraction 作为并列 provider；未来若有明确产品映射，只能调用原账本同一 `settle`，有唯一 requestId / epoch | GUI 与手机两边各提交成功、输家晚到覆盖、重启重复判决 |
| Session ownership | notifier 路由 Store + native Agent 实时状态 | 标准 Catalog 只读投影或规范化查询，不回写新 authority | `sessionController` 与 notifier `route:sessions` 双向同步循环 / 跨重启不一致 |
| Native UI | `client.js` 的 4 个既有 slot + control surface RPC | 仅为不同 slot 的标准 SettingsSection/ToolCallView 新增 UI facet，避免注入同一槽位 | std 与 native 两份“通知与控制”页面、两套 question action |
| shutdown | notifier 原生 `ctx.effect` `disposeAll()` | 只有 std ownership 内 handle 交给 `CleanupScope`；其他 resources 仍原来清理，必须等待并阻止迟到 | 两边各自认为负责关闭或两边都不负责、disposed waiter 收晚到 callback |

**真正能实现的最小边界：** “同一 notifier 核心 + 两种互斥的 tool registration adapter”，不是“两个 notifier runtime 实例”，更不是“先加 dsh-std 再删 native events/approval/UI”。

## 8. 主张保留的原生适配

必需保留：

- `src/host-events.mjs`、`src/event-listener.mjs`、`src/status/turn-tracker.mjs`：直接捕获 DSH lifecycle/turn/agent/error 与延迟合并通知。
- `src/inbound/conversation.mjs`、`src/control/session-arbiter.mjs`、`src/actions.mjs`、`src/host/messages.mjs`：Agent 实时 followup/inject/steer/stop、动作与附件入场。
- `src/approval/router.mjs`、`src/host/native-questions.mjs`、`src/questions/router.mjs`、`src/interaction/ledger.mjs`：宿主原生 hook，GUI 与手机裁决、限时/撤卡与持久化。
- `src/inbound/store.mjs`、`src/inbound/identity.mjs`、`src/inbound/pairing.mjs`、`src/routing/agent-router.mjs`、`src/routing/session-registry.mjs`、`src/control/entry.mjs`：可信身份、授权、Store 与 routing authority。
- `src/adapters/*`、`src/inbound/*` 渠道 transport、`src/notify.mjs`：真正离线 IM 发/收、发送/失败证据。
- `client.js` 和 `src/control-surface/*`：Native sidebar/main/config/activation、原生 RPC、headless 降级。标准 SettingsSection 不等价于这些 slots。
- `src/index.mjs` 提供的公共服务 `ctx.provide('notifier')`：外部使用插件通过 `inject:['notifier']` 的兼容路径；Tool resource 不自动提供这个 Cordis service。

## 9. 最小迁移建议（**建议延期，不立即改代码**）

如果因明确的第三方互操作需求需要验证 std，而不是为了替换现有适配，最小边界限定为 **一个可关闭、无生产副作用的 Tool-only 核查面**：

1. **不修改** Store、identity、router、interaction ledger、IM 通道、event subscriber、native question/approval；不变更 notifier 的其他公共服务和 Native UI。
2. 仅把 `src/tool-register.mjs` 已有模型工具逻辑包装为标准 Tool 的同进程 `ToolHandler.resolve()` 输出；Handler execute 委托同一原生 `notify` function，不新建 notifier、sender 或 ledger；从原生执行上下文到 std Tool context 的映射需静态比对字段/取消语义。
3. 在独立的可选 profile / feature gate 下，原生与 std `notify` 注册必须互斥；默认仍原生。既有 `notify_test` 等其他 tools 不被无意接管；`ToolOverride` 不是默认必须方案，因 shadow 管理会引入更大故障面。
4. 只读取 `SessionCatalog.list/get` / `SessionHistory.read` 的对照结果用于静态接口契约讨论，不把这些 API 用于 notifier 的通知、路由、状态回写或 `session/event` 替换。未来决定真的需要时再单独立项。
5. 明确 adapter `sessionController` 等必需服务在目标 profile 的来源，采用**具体的 adapter 发行 tag**，不引用 `main` 的 Unreleased 接口；头对头检查目标 DSH 0.2.1 的实际 API 形状及依赖可用性。由于本轮拒绝运行，所有 live support / activation / cleanup 性能与可靠性结论标记“待运行验证”。
6. 试点后若发现唯一收益只是多了一种包声明，而主程序仍依赖 DSH 服务，应将试点视为**没有迁移收益**并终止扩展。不得以“未来可能跨宿主”为理由扩张范围。

**可选静态模块边界：** `src/tool-register.mjs`（导出已有执行语义供封装）、`src/index.mjs`（选择一种 Tool registrar）、单独的 `dsh-plugin.json`/facet 定义（需与现有 `cordis.patch.yml` 的运行角色分离）、标准 Adapter plugin/profile 的装配和清理所有权。该名单**不是实施承诺**，不要求触碰任何其他模块。新 manifest 的选择应在实际约束进一步核对后才定。

## 10. 收益、成本、缺口及最终评定

| 考量 | 可得收益 | 新增成本/风险 | 判定 |
|---|---|---|---|
| Tool | 可以把一层本地 DSH `ctx.tools.register` 映射外包给公共 Adapter；若未来多宿主共享同一 Tool handler，减少该一层宿主差异 | 17 个 std 包的 runtime 依赖集合 + Adapter 宿主 peers；`sessionController` 和 `llm` 的必需启动；Tool output render/context/Agent 路由仍有差异 | **有条件试点**，现在没必要全量纳入 |
| Session 查询 | 外部 portable consumer 能用标准 Catalog/History 读取宿主持久信息；有已存在的类型/测试 | 不等于 notifier 的路由台账；标准 `watch/delete/fork` 未 map，跨 DSH 版本仍要兼容验证 | **保留只读机会**；不迁移本项目 Session authority |
| Events / Agent / Approval / Question / IM | 目前没有能覆盖 notifier 这些主链路的已发布 Adapter capability | 强行迁移将复制主权 Store、增加两个裁决者、削弱取消/撤销与到达证明 | **保留原生** |
| Native UI | 可为另起 Web SettingsSection / ToolCallView 带来 UI 插件移植入口 | 不能替换四个现有 slots；UI V2+optional 尚未进 rc4 tag；额外浏览器侧依赖 | **保留原生**，不用 UI 迁移当入口 |
| Lifecycle | std facet 范围的发布/撤销比较清晰 | 不是业务 durable/async cleanup 的魔法；rc4 tag 缺 main 的 generation/async-hardening 修补 | **局部收益**，不独立支持迁移 |
| Headless | facet 模型按设计允许无 UI 执行 | Adapter 硬依赖 Session Controller 和 llm/agents；无证明比 notifier 当前轻 | **不为此迁移** |

**最终选择：`暂缓接入（整体） + 保留原生（关键链路） + 条件性允许 Tool-only 最小试点`。** 对 notifier `main@9d69dd7` 来说，dsh-std 的真实功能覆盖不是瓶颈的解除，而是把已工作但宿主特定的薄适配换成一套尚未证实在当前新版 DSH 发布组合可运行的新加载与协商系统。除非出现**已经确定必须服务的第二种宿主/标准组件消费者**，否则不建议付出引入成本。

## 11. 可直接核对的固定基线源码索引

**notifier：**

- [`package.json`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/package.json)
- [`src/index.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/index.mjs)
- [`src/tool-register.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/tool-register.mjs)
- [`src/host-events.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host-events.mjs)
- [`src/event-listener.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/event-listener.mjs)
- [`src/host/native-questions.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/native-questions.mjs)
- [`src/approval/router.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/approval/router.mjs)
- [`src/questions/router.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/questions/router.mjs)
- [`src/inbound/conversation.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs)
- [`src/host/messages.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/messages.mjs)
- [`client.js`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/client.js)

**std 固定源码：**

- [`packages/adapter-dsh/src/index.ts`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/adapter-dsh/src/index.ts)（重点 996–1100、1217–1299、1299–1445、1636–1746、1806–1841）
- [`packages/adapter-dsh/src/session-adapter.ts`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/adapter-dsh/src/session-adapter.ts)（重点 79–143）
- [`packages/adapter-dsh/src/client.ts`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/adapter-dsh/src/client.ts)（重点 340–388）
- [`packages/adapter-dsh/package.json`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/adapter-dsh/package.json)
- [`packages/adapter-dsh/CHANGELOG.md`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/adapter-dsh/CHANGELOG.md)
- [`packages/lifecycle/src/index.ts`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/lifecycle/src/index.ts)
- [`packages/session/src/catalog.ts`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/session/src/catalog.ts)
- [`packages/session/src/history.ts`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/session/src/history.ts)
- [`packages/messages/src/index.ts`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/messages/src/index.ts)
- [`packages/presentation/src/index.ts`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/presentation/src/index.ts)
- [`packages/ui/src/index.ts`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/packages/ui/src/index.ts)
- [`docs/proposals/agent.zh.md`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/docs/proposals/agent.zh.md) / [`permission.zh.md`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/docs/proposals/permission.zh.md) / [`events.zh.md`](https://github.com/T-Auto/dsh-std/blob/37e9c35b953f0dccaad089df6e68e4f00daae7bd/docs/proposals/events.zh.md)（均为设计提案，非 adapter capability）

**std GitHub 发行 tag 源码与发布证据：**

- [release `@dsh-std/adapter-dsh@0.1.1-rc.4`](https://github.com/T-Auto/dsh-std/releases/tag/%40dsh-std/adapter-dsh%400.1.1-rc.4)
- [rc4 tag 指向的原始源码 `7401fcd…`](https://github.com/T-Auto/dsh-std/tree/7401fcd78303ff4636c6dc348aae1acf81bc3cc3)
- [rc4 tag 与固定 std main 代码比较](https://github.com/T-Auto/dsh-std/compare/7401fcd78303ff4636c6dc348aae1acf81bc3cc3...37e9c35b953f0dccaad089df6e68e4f00daae7bd)

**最终剩余未知项：** npm `@dsh-std/adapter-dsh@0.1.1-rc.4` tarball 的实际 JS/d.ts 内容、npm 实时 `latest/rc` dist-tags 与依赖 resolved versions；目标 DSH `0.2.1-rc.2` 对 adapter-dsh 的真实服务注入/API 兼容；`headless` profile 对 `sessionController` 的实际可用性；Tool output 渲染与取消/超时是否完全保真。**这些项目没有被本次静态审查或已有测试记录“验证通过”。**
