# dsh-notifier 0.13.1 × DSH 0.2.x 独立兼容性与 28+6 渠道静态审查

> **审查日期：2026-10-31｜审查性质：源码/类型/配置/发行元数据/已有测试的只读静态检查。** 这不是成功安装声明、真实宿主验收、真实 IM 渠道联调，也不是补丁。
>
> **核心约束**：仅审查 `THEWOLFWALKER/dsh-notifier` 固定 `main@9d69dd7a8908fcfec6e20d92d56509764a8f23ec`，版本 **0.13.1**。没有使用 `dev` 或重写分支，也没有将项目随附的历史测试结果当成本次执行结果。**本次未执行任何项目代码、测试、安装脚本、探针、复现脚本或 DSH；未修改任何仓库、配置、profile、Issue/PR、提交或发布。**

## 1. 审查对象、来源与证据分级

| 对象 | 不可变版本 | 完整源码 SHA | 本次用途 |
|---|---|---|---|
| dsh-notifier | `main` / `0.13.1` | `9d69dd7a8908fcfec6e20d92d56509764a8f23ec` | 唯一审查主体 |
| DSH | `dsh-v0.2.0-rc.2` | `639ed015397290b3745d163aafe02ffee4aa3f84` | 起始版本形状 |
| DSH | `dsh-v0.2.1-rc.2` | `687f282e8625c6b8d11ff58211a90524be2e4317` | 新版形状对照 |
| DSH | `dsh-v0.2.1-rc.3` | `1f81c047fc48fa190a683e469daa699857e9afe8` | 新版差异终点 |

以上 DSH 标签 SHA 由官方 Git refs 读取，不以 `latest`、`main` 或相近版本代替。notifier `package.json` 定义 `main=src/plugin-entry.mjs`、`dsh.client.platform=web`、`./client=client.js`，依赖 Node `>=22`，且声明 28 个出站适配器。证据：[notifier manifest](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/package.json#L1-L102)、[插件入口](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/plugin-entry.mjs#L1-L5)。

**四种结论，不能混用**：

- **S｜源码确定不兼容**：固定源码的接口、必需服务或安装预检直接互斥，可在源码层推出拒绝/错误。没有声称已见到生产报错。
- **M｜静态形状一致**：方法名、参数、载荷、声明或路由形状相符；不能据此声称真实端到端可用。
- **C｜条件成立**：取决于 profile 组合、账号/服务实例、提供方响应、运行状态或 UI 实际挂载；列出成立的前提。
- **U｜无法静态确认**：必须有真实构建/安装/设备/权限/视觉/网络证据的结论。本轮不作积极断言。

**重要隔离**：之前的 A/B/C、扩展审计存在函数级模拟复现，本报告**没有做任何复现或运行**；仅把同一固定源码中可见的问题作为源码事实，重新独立对照。关于错误分支的判断是读源码后的逻辑推演，不称“本次实测”。

## 2. 结论摘要：兼容不是一个布尔值

**已知两项阻挡**不计为本次新发现，但仍是部署顺序的第一层：

1. `package.json` 旧 `@deepseek-ai/dsh-session` peer 精确限定在 `0.1.7-*`，DSH profile 预检解析它并阻挡三个 0.2.x 对照版本，除非存在**对 notifier 精确版本和 DSH 精确版本**的豁免。详见 §3。
2. notifier 核心插件静态 `inject=['tools','agents','connection']`。官方 headless 组合没有 `connection`，故核心插件的 headless 激活受阻；不能仅凭 `src/index.mjs` 里后续条件注入 `webServer` 就说 headless 支持。详见 §4。

除这两项之外，**主要 Host API 的参数及载荷在三个 DSH 标签间有相当多的静态一致性**，尤其是 `tools.register`、`agents.list/get/roots`、`Agent.followup/steer/inject/cancel`、`session/event`、`agent/error`、`agent/disposed`、`approval/request`、`user-questions/request`、`attachments.saveImage/saveFile`。这说明“新版所有 API 都坏了”的说法没有依据；但**实际装配、权限、UI、取消与提供方送达**仍待针对性验证。

**本次扩展的渠道侧重要结果**：28 个出站类型和 6 个入站类型能从真实工厂/注册表逐项追溯；共享出站 HTTP 封装存在**成功响应 body 读取脱离超时计时器**的静态风险；QQ Bot 的“2xx JSON”校验不能保证正文有有效消息标识；WxPusher 回调的 `syntheticSeq` 与“同 payload 重投去重”目标在代码上相互冲突。**私聊-only** 目标与部分入站群事件、若干默认群/全员出站能力仍不一致。详见 §7—§10。

## 3. 三层安装兼容：预检、包管理器、运行时

### 3.1 notifier manifest 的确切状态

- `engines` **只有** `node: ">=22"`；**没有** `engines.dsh`。因此当前 DSH 预检不会优先读取 notifier 自有 engines.dsh。
- `peerDependencies` 有 `@deepseek-ai/cordis: ^4.0.1`、`@deepseek-ai/dsh-session: 0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2`。
- `peerDependenciesMeta['@deepseek-ai/dsh-session'].optional=true`，作用属于包管理器的可选 peer 元数据，**不是 DSH 预检的“忽略此项”指令**。
- `dshWorkshop.compatibility.dshVersions` 与旧测试中的四个 0.1.7 版本一致；这是项目自述/检查脚本的矩阵，不等同于 Host 自动通过。

固定证据：[package.json，engines/peers/dshWorkshop](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/package.json#L49-L135)、[兼容性文档](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/docs/compatibility-matrix.md#L29-L49)、[已有验证脚本](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/scripts/verify-host-compat.mjs#L45-L90)。

### 3.2 DSH 预检实际算法

DSH `evaluatePluginCompatibility()`：先看自有 `engines.dsh`，有则独占决定；否则遍历名称等于 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 **所有** peer；调用 `semver.satisfies(runtimeVersion, range, { includePrerelease:true })`；在该循环中**没有检查 `peerDependenciesMeta.optional`**。对于不满足项，在 `exemptions["dsh-notifier@0.13.1"]` 中找精确 runtimeVersion。未豁免时 profile preflight 把对应 Loader row 标为 `disabled:true`；不是“只是打印警告然后尝试继续启动”。

证据：[DSH rc.3 plugin-compatibility.ts:34-125](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/boot/app-boot/src/plugin-compatibility.ts#L34-L125)、[compatibility-preflight.ts:89-140](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/boot/app-boot/src/compatibility-preflight.ts#L89-L140)。

| 层次 | 结论 | 证据等级 | 不能推论的事 |
|---|---|---|---|
| DSH profile 版本预检 | 当前四项旧范围不包含三组 0.2.x，正常 profile 路径会阻挡未豁免 notifier | **S** | 无法证明用户特定 profile 已安装或正在运行 |
| exact-version 豁免 | 源码支持针对 `dsh-notifier@0.13.1` 和某个**精确 DSH 版本**显式放行 | **M/C** | 豁免不证明 API 兼容，也不代表生产安全 |
| npm / pnpm peer 安装解析 | `optional:true` 是包管理器元数据；最终是否冲突受安装树与包管理器策略影响 | **C/U** | 不可把 DSH 自己的预检等同于 npm `ERESOLVE`，本次未调用包管理器 |
| Cordis/Host API 实际运行 | 只有服务真正提供、方法与调用兼容、事件可达且生命周期收敛才能说兼容 | **U** | 预检放行不等于实际可用 |

`includePrerelease:true` 允许预发布版本参与半开区间、比较等**已有范围**的匹配，但不能让 `0.2.1-rc.3` 落进写死的 `0.1.7-rc.2`。**不要**靠配置某个整族 wildcard 豁免来声称修复了安装兼容。预检代码在 rc.2/rc.3 为同一 Git blob；0.2.0-rc.2 的对应逻辑也需要以独立标签为准，不能拿新标签覆盖旧版本事实。证据：[0.2.0-rc.2 对应文件](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/app-boot/src/plugin-compatibility.ts#L35-L125)。

## 4. Web / Headless / TUI 的真实 profile 装配

不可只从某个 package `package.json` 名称推断服务；DSH 的有效层级是 **`PROFILE_TEMPLATES` → base patch → 各模式 patch → 用户的 profile patch → Loader 按服务可用性激活**。用户 profile、disabled、缺包、额外 overlay 都会改变结果。

固定证据：[DSH rc.3 PROFILE_TEMPLATES:179-195](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/boot/app-boot/src/profile.ts#L179-L195)、[headless 旧混装 tuple 迁移:655-669](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/boot/app-boot/src/profile.ts#L655-L669)、[base patch](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/bundle/base/cordis.patch.yml#L15-L88)、[web patch](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/bundle/web-app/cordis.patch.yml)、[headless patch](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/bundle/headless/cordis.patch.yml#L1-L44)。

| 服务/界面 | 官方 Web 模板 `base+web-app` | 官方 headless 模板 `base+headless` | TUI（作为官方现行 profile） |
|---|---|---|---|
| `tools` | base `tools` + Web `mode` 覆盖 | base `tools` + headless `mode` 覆盖 | **无官方 TUI 模板，不能推断存在** |
| `agents` | base `agent` | base `agent` | 同左，不适用 |
| `connection` | Web `connection` row；依赖自身 `credentials`，浏览器 HTTP 还依赖 webServer | **无**该 row | 无 TUI profile |
| `webServer` | Web `webserver` row；由 `webStartup` 提供 bind 配置 | **无**该 row | 无 TUI profile |
| `sessionController` | Web `session-controller` row | **无**该 row | 无 TUI profile |
| `userQuestions` | base `user-questions` | base `user-questions` | 无 TUI profile |
| `attachments` | base `attachment-local` | base `attachment-local` | 无 TUI profile |
| `approval` | base `approval` | base `approval` | 无 TUI profile |
| `slots` / Native sidebar | Web browser roster + UI slots | 无 Browser roster | 无 TUI profile |

**注意两个细节**：

- `PROFILE_TEMPLATES` 在三个目标标签均无 `tui` 项。这只证明**默认发行模板没有 TUI profile**，不是“用户绝不可能通过自定义插件接上某个终端 UI”；不可凭历史 TUI 文档臆造本次 profile。
- `headless` 存在一条旧 `base+web-app+headless` **安装自带 tuple 规范化为 `base+headless`** 的逻辑。不能因为代码里出现旧 tuple 的 `web-app` 就宣称当前 headless 默认有 HTTP/Connection；见上方迁移代码。

Web 的 `connection` row 位于 `web-app/cordis.patch.yml` 中，而它的 `apply()` 仅在 **可选 `webServer` 注入成功**时挂 `/api`；`session-controller` 是 Web 专有行。`userQuestions` 和 `attachments` 不是这两层的替代品。证据：[Web webserver/connection/session-controller rows](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/bundle/web-app/cordis.patch.yml)、[connection apply:92-166](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/connection/src/index.ts#L92-L166)。

## 5. Host 逐调用兼容矩阵

下表里的 “0.2.0 → rc.2 → rc.3” 只对**固定源码中所列的契约本身**作判断，未运行任何版本。rc.2 与 rc.3 的 `tools/index.ts`、`agent/runtime-types.ts`、`agent/index.ts`、`session/index.ts`、`approval/index.ts`、`user-questions/index.ts` 对照是同一 Git blob；0.2.0 对若干文件 blob 不同，但下列具体方法签名/事件形状均能在 0.2.0 源码找到。

| notifier 的实际用法（固定行号） | DSH 官方定义（rc.3 固定行号；必要时 rc.2/0.2.0） | 版本对照与影响 | 判定 |
|---|---|---|---|
| [`index.mjs:63`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/index.mjs#L62-L66) 强制 `tools/agents/connection` | [base tools/agent](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/bundle/base/cordis.patch.yml#L79-L84)、[Web connection](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/bundle/web-app/cordis.patch.yml) | Web 模板有依赖候选；headless 缺 connection（已知阻挡） | **S/C** |
| [`tool-register.mjs:108-121,169-174`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/tool-register.mjs#L108-L174) `tools.register`、`execute(args,exec)`、注册 disposer | [DSH ToolDefinition:214-237](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/tools/src/index.ts#L214-L237)、[register():1065-1096](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/tools/src/index.ts#L1065-L1096) | 三版均有 `register(definition)` 和注销函数；`output.schema/render` 为强契约，notifier 提供；具体 schema 用真宿主仍待确认 | **M** |
| [`tool-register.mjs:149-160`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/tool-register.mjs#L143-L162) 从 `exec.agent?.id` 找工作区与分流 | [ToolExecutionInput:327-353](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/tools/src/index.ts#L327-L353) | `agent?:Agent` 三版存在；未找到时回退全广播是 notifier 自身策略，不是 DSH 必然缺失 | **M/C** |
| [`index.mjs:354,585-595`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/index.mjs#L583-L596) `agents.list/get` | [DSH AgentRegistry list/roots:584-602](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/index.ts#L584-L602)、[get() 注册表](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/index.ts) | `list` 与 `roots` 为活跃 agent 列表，不能当已归档 session；`get(id)` 找不到需降级。三版基本契约存在 | **M** |
| [`conversation.mjs:197-202`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs#L193-L202) `agents.list/get`，会话默认选最近 Agent | [AgentRegistry list/roots](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/index.ts#L584-L602) | 基本形状一致；notifier 的 `latest` 启发式不保证业务归属正确 | **M/C** |
| [`conversation.mjs:828-872`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs#L819-L875) `followup/steer` | [Agent runtime-types:217-241](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/runtime-types.ts#L217-L241) | 三版 `UserMessage → void`；`followup` 新 turn、`steer` 下一步边界、`inject` 不唤醒 idle；方法返回 void 不表示模型已消化消息 | **M/C** |
| [`conversation.mjs:875-909`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs#L875-L909) `inject` 与文件/图片入站 | [Agent.inject(UserMessage):233-241](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/runtime-types.ts#L233-L241) | 三版形状相符；附件必须先 durable admission；写入 inbox ≠ 下一步确定已采纳 | **M/C** |
| [`conversation.mjs:363-377`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs#L363-L377)、[`index.mjs:585-595`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/index.mjs#L585-L595) `cancel({kind:'user'})` | [Agent.cancel:176-183](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/runtime-types.ts#L176-L183) | 三版均是结构化 cause，方法 `void`；取消当前活动/队列，不是会话撤销或事务回滚 | **M/C** |
| [`event-listener.mjs:543-565`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/event-listener.mjs#L540-L567) `session/event` | [DSH session index:63-77](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/session/src/index.ts#L63-L77) | 三版 `(session,event)`，受 scope 过滤；notifier 兼容 tuple/envelope，注册 `{global:true}`；需验证插件 Context 事件可见性 | **M/C** |
| [`event-listener.mjs:553-564`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/event-listener.mjs#L550-L566) `agent/error`、`agent/disposed` | [Agent Events:261-280,393](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/runtime-types.ts#L261-L280)、[error:393](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/runtime-types.ts#L387-L395) | `{agent,turn,step,error}` 与 `{agent}` 三版形状一致；不应把 payload 当直接 Agent；注销由 disposer/Context 持有 | **M/C** |
| [`host-events.mjs:110-182`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host-events.mjs#L110-L182) `{global:true}`、Context/root 回落 | [DSH session scope declaration](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/session/src/index.ts#L43-L77)、[Agent scoped events](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/runtime-types.ts#L245-L270) | 形状合理；“已订阅”不等于收到事件，真 Host 生命周期与 disposer 序仍需检查 | **M/C** |
| [`approval/router.mjs:537-555`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/approval/router.mjs#L537-L555) approval interceptor | [DSH user-approval request/return:205-230,269-291](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/interaction/user-approval/src/index.ts#L205-L230)、[request event types](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/interaction/user-approval/src/types.ts#L63-L93) | `approval/request` 是带 agent scope 的 waterfall；`allowed-once/rejected/cancelled/unavailable`，宿主要求 open turn 并配对 append 审计。notifier 的桥接必须保留 `next` 与 cancellation | **M/C** |
| [`host/native-questions.mjs:217-266`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/native-questions.mjs#L217-L266) `user-questions/request` | [DSH ask waterfall:287-334](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/interaction/user-questions/src/index.ts#L287-L334)、[事件类型](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/interaction/user-questions/src/types.ts#L128-L162) | DSH 三版 `ask()` 内走 waterfall；无 `registerProvider` 时 notifier 用 `{prepend:true,global:true}`，是正确选择；真实答案 race/取消仍待验证 | **M/C** |
| [`host/messages.mjs:60-94`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/messages.mjs#L60-L94) `attachments.saveImage/saveFile` | [DSH attachment-local:207-242](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/attachment/attachment-local/src/index.ts#L207-L242) | 两种方法均存在；notifier 拒绝保存失败后回退 URL，思路与 Host durable ref 一致；媒体类型、字节限额、可回放/读取均要单独验收 | **M/C** |
| [`host/messages.mjs:105-123`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/messages.mjs#L105-L123) 构造 `UserMessage` | [Host Agent 接收 UserMessage](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/runtime-types.ts#L217-L241) | 需要同时符合 Host 的文本/附件 blocks 和 `source`；本次未以真消息或真资源回放核验 | **C/U** |
| [`control-surface/rpc.mjs:95-159`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/rpc.mjs#L95-L159) `connection.admit`、`webServer.register` | [DSH Connection admit:122-136](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/connection/src/rpc-host.ts#L122-L136)、[WebServer register](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/host/webserver/src/index.ts#L366-L395) | Web 有形状；当前 `rpc.handle` fallback 必须做 host capability 测试。admit 是请求身份准入，非自动 method-level ACL（见 §6） | **M/C** |
| [`client.js:1,1035-1086`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/client.js#L1-L12) 浏览器 loader/React/slot | [DSH Module loader bootstrap:543-579](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/modules/src/index.ts#L543-L579)、[sidebar.panellist](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-sidebar/src/client/index.ts#L46-L95) | `__ModuleLoader__.load` 与 Web 客户端装载机制同形；`sidebar.panellist` slot 仍存在；加载、React seed、视觉布局、插件页实际嵌入需真 UI | **M/C/U** |

**一项必须防止误判的语义**：Host `Agent.followup() / steer() / inject() / cancel()` 均返回 `void`，并且 `whenIdle()` 也只保证 Agent 整体静止，不证明某条远程消息提交成功/某次取消已撤销所有副作用。notifier 若向手机回“已收到/已发起”，可以依据调用成功；若回“已执行完/对端已确认”，需要更强证据。证据：[Host Agent runtime-types:176-241](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/runtime-types.ts#L176-L241)。

## 6. rc.2 → rc.3：与 notifier 真正相关的变动

rc.2 SHA `687f282…` 到 rc.3 SHA `1f81c047…`，官方 compare 列出 6 个提交：`#6247` navigation entry customization、`#6600` analytics、`#6883` sidebar pin/selection/UI icons、`#6944` DeepSeek 官方模型列表、rc.3 release 与合并提交。比较 URL：[`687f282...1f81c047`](https://github.com/deepseek-ai/deepseek-harness/compare/687f282e8625c6b8d11ff58211a90524be2e4317...1f81c047fc48fa190a683e469daa699857e9afe8)。

| 项目 | 核对到的版本差异 | notifier 影响 |
|---|---|---|
| 工具接口 | `packages/core/tools/src/index.ts` rc.2 / rc.3 Git blob 相同 | **没有证据**显示 `notify`/`notify_test` 定义或卸载接口因 rc.3 改坏 |
| Agent/Session | `agent/runtime-types.ts`、`agent/index.ts`、`session/index.ts` 两版 blob 相同 | `followup/steer/inject/cancel`、`session/event`、`agent/error/disposed` 未见 rc.3 契约改动 |
| 审批/提问 | `interaction/user-approval` 与 `user-questions` index 两版 blob 相同 | waterfall 签名本身未变；争用/取消是否无 bug 仍属 U |
| 安装预检 | `plugin-compatibility.ts` 两版 blob 相同 | 旧 peer 的阻挡不会因“换 rc.3”消失 |
| Browser module loader | `client/modules/src/index.ts` 两版 blob 相同 | `window.__ModuleLoader__.load()` 机制未见 rc.3 改动 |
| UI sidebar | rc.3 改了 sidebar 自定义入口/pin、客户端导航列表，`sidebar.panellist` slot 仍在 | **C**：可挂载的 API 不能证明 notifier 栏目的可见顺序、固定/隐藏状态、图标、手机窄屏行为；需真 GUI 验证 |
| model catalogue | 由上游官方 `/models` 改动 | notifier 不直接实现模型目录，影响为与 Agent/Session 旁路选择的间接 UI 条件，不可包装为 notifier 直接 API 不兼容 |

在 `0.2.0-rc.2` → `0.2.1-rc.2` 期间，若干 core 文件 blob 不同，但本报告逐点读取的 `register`、Agent 四控制方法、关键三事件签名均有对应定义；**没有做完整 18,000+ 文件语义 diff，因此不声称“所有改动均无影响”**。各对照点可直接对读：[rc.0 tools](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/tools/src/index.ts#L215-L245)、[rc.3 tools](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/tools/src/index.ts#L214-L237)、[rc.0 Agent](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent/src/runtime-types.ts#L176-L241)、[rc.3 Agent](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/runtime-types.ts#L176-L241)。

## 7. 28 个出站渠道逐项静态正确性矩阵

**矩阵判定范围**：核对 notifier 的类型注册、配置/必填校验、请求构造、共享 HTTP 发送器、应答成功条件。**不代表已对照各提供方 2026-10-31 实际在线文档/真机**；本次依用户边界，未访问任何提供方账号或 API，也没有发消息。“M” 表示内部逻辑自洽，不等于真实送达。“C” 表示依赖提供方权限/返回负载/部署情况。

总权威：[config.mjs:9-45](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/config.mjs#L9-L45)，声明式引擎：[spec-channels.mjs:126-524](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L126-L524)、[_engine.mjs:38-130](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/_engine.mjs#L38-L130)。

| # | 渠道 | 实现位置（固定 main） | 已核实的实现 | 静态局限 / 需补证据 | 判定 |
|---:|---|---|---|---|---|
| 01 | Telegram | [`adapters/telegram.mjs:12-39`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/telegram.mjs#L12-L39) | 需要 botToken/chatId；POST `sendMessage`，解析 `ok:true` 且 `result` 存在；支持静音 | token/自定义 apiBase、目标 chat 权限、真实接收均未验证；成功非设备回执 | **M/C** |
| 02 | DingTalk webhook | [`adapters/dingtalk.mjs:12-69`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/dingtalk.mjs#L12-L69) | 签名/HMAC、`errcode:0` 成功、特定错误码分流 | 安全关键词/签名配置与群机器人权限外部依赖；群 webhook 与私聊-only 目标不一致 | **M/C** |
| 03 | Feishu webhook | [`adapters/feishu.mjs:17-69`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/feishu.mjs#L17-L69) | timestamp/sign 与交互卡片；要求 `code:0` | 卡片规范与消息大小需真平台确认；此出站类型是群机器人 webhook | **M/C** |
| 04 | WxPusher | [`adapters/wxpusher.mjs:18-50`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/wxpusher.mjs#L18-L50) | appToken、uid/topic 校验；POST 后检查业务 `code` | 部分 uid/topic 的接收结果与客户端确认无法凭 `code` 推出 | **M/C** |
| 05 | PushPlus | [`adapters/pushplus.mjs:22-72`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/pushplus.mjs#L22-L72) | token、template/channel 枚举、业务码 | 用户推送渠道/模板格式是否被平台接受未验 | **M/C** |
| 06 | ServerChan | [`adapters/serverchan.mjs:13-76`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/serverchan.mjs#L13-L76) | SENDKEY 形态、SC3/Turbo URL 处理，form POST 并检查 code | 迁移型 key/提供方返回格式需真实验收 | **M/C** |
| 07 | Bark | [`adapters/bark.mjs:25-59`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/bark.mjs#L25-L59) | key、服务器地址、level、业务 `code` | 自建服务器真实证书/响应、设备响铃非源码可判定 | **M/C** |
| 08 | Generic Webhook | [`adapters/webhook.mjs:17-65`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/webhook.mjs#L17-L65) | URL/发送体定义；共享网络边界/超时 | 接收端约定任意，2xx 仅代表请求接受；不可验证“内容已使用” | **C/U** |
| 09 | Bell | [`adapters/bell.mjs:9-29`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/bell.mjs#L9-L29) | 无网络、本地 stdout `\x07`，silent 不响 | `stdout.write` 被 try/catch 包裹但不证明终端听到；可“成功但无实际响铃” | **M/C** |
| 10 | Desktop | [`adapters/desktop.mjs:136-201`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/desktop.mjs#L136-L201) | macOS/Linux/Windows 命令路径、子进程退出码、命令超时 | 依赖桌面/PowerShell/BurntToast，尤其 headless 无图形会话不应视设备确认 | **M/C** |
| 11 | QQ Bot official | [`adapters/qq-bot.mjs:22-119`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/qq-bot.mjs#L22-L119) | access_token、消息分段/msg_seq、markdown 模式、QQ v2 endpoint | **重要**：2xx `{}` 无 `code` 时也会视成功（§8.2）；默认 targetType=`group` 与私聊-only 冲突；真实权限/键盘需验证 | **C/缺陷** |
| 12 | WeCom application | [`adapters/wecom-app.mjs:36-102`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/wecom-app.mjs#L36-L102) | corpid/secret/agentId，GET token，send errcode，失效刷新 | 默认 `touser='@all'` 为全员推送，若私聊-only 应显式审查接收者范围；非设备回执 | **C/产品冲突** |
| 13 | Slack | [`spec-channels.mjs:129-150`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L129-L150) | Incoming Webhook，要求 hooks.slack.com 主机，HTTP 200 判成功 | 校验仅检查 hostname，没有实际检查注释所说 `/services/` path；错误路径配置可能延迟到请求才失败 | **M/C** |
| 14 | Discord | [`spec-channels.mjs:151-171`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L151-L171) | webhook JSON，2000 字符上限，2xx 成功 | 全局分段 1200 码点不涵盖任意超长 title；平台接入/权限未验 | **M/C** |
| 15 | WeCom group robot | [`spec-channels.mjs:172-193`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L172-L193) | webhook/key 二选一，业务 `errcode:0` | **出站明确群机器人**；应与私聊-only 产品边界明确区分 | **M/产品冲突** |
| 16 | Mattermost | [`spec-channels.mjs:194-220`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L194-L220) | URL 或 server+hookId，拒绝缺参数，HTTP 2xx | 自建部署 HTTPS/私网许可须定向验证；出站 channel webhook | **M/C** |
| 17 | Google Chat | [`spec-channels.mjs:221-232`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L221-L232) | spaces Incoming Webhook，2xx 判定 | 仅空间 webhook，私聊-only 目标冲突；返回成功非成员可见证明 | **M/C** |
| 18 | Microsoft Teams | [`spec-channels.mjs:233-263`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L233-L263) | Workflows webhook，Adaptive Card 结构 | Workflows 版本/授权/接收端行为难以静态证实，且常面向频道 | **M/C/U** |
| 19 | ntfy | [`spec-channels.mjs:264-292`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L264-L292) | JSON publish / topic/title/message/priority，支持 Authorization，自建地址 | 订阅和推送端并非一一收据，2xx 不证明手机接收；私网策略依赖配置 | **M/C** |
| 20 | Gotify | [`spec-channels.mjs:293-309`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L293-L309) | POST `/message`、`x-gotify-key`、priority，2xx | 实例/Token/客户端连接未验 | **M/C** |
| 21 | Pushover | [`spec-channels.mjs:310-332`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L310-L332) | form POST 官方固定 endpoint，`status:1` | 额度/客户端可达性不在本次范围 | **M/C** |
| 22 | Chanify | [`spec-channels.mjs:333-351`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L333-L351) | baseUrl/token，form POST 2xx | 私服路径兼容/客户端权限未验 | **M/C** |
| 23 | PushDeer | [`spec-channels.mjs:352-368`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L352-L368) | `/message/push` form，`code:0` | 提供方变更/自建服务需另证据 | **M/C** |
| 24 | XiZhi | [`spec-channels.mjs:369-383`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L369-L383) | key endpoint，`code:200` | 仅实现形状检查，无真消息验收 | **M/C** |
| 25 | Qmsg | [`spec-channels.mjs:384-401`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L384-L401) | v3 endpoint / 旧 group 迁移 / `success:true` | 单聊目标由平台端绑定；旧显式 QQ/bot 不会被无声迁移；群模式与私聊-only 冲突 | **M/C** |
| 26 | iGot | [`spec-channels.mjs:402-418`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L402-L418) | key endpoint，`ret:0` | 未验证真实 API 返回与设备收取 | **M/C** |
| 27 | OneBot 11 | [`spec-channels.mjs:419-462`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L419-L462) | HTTP `/send_msg`、文本 segment 防 CQ 注入、`retcode:0`；private 默认 | `private-ok` SSRF 策略显式允许内网，需信任本地服务；群选项仍存在；真实 OneBot 实现差异 U | **M/C** |
| 28 | WPS bot | [`spec-channels.mjs:476-523`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/spec-channels.mjs#L476-L523) | webhook 归一、三域名 allowlist、key、text/markdown；2xx | `2xx` 成功仅沿用当前本地声明；若业务返回 2xx+错误体会误判；群机器人与私聊-only 冲突 | **M/C** |

### 7.1 所有出站渠道共用的正确性底线

- 这 28 个是**配置注册类型**，不是 28 个“当前均能成功投递”的证据。`resolveConfig` 把校验失败的渠道加入 `skipped`，而不是崩溃启动；`notify` 有按渠道独立 try/catch。证据：[config.mjs:353-380](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/config.mjs#L353-L380)、[notify.mjs:87-123](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/notify.mjs#L87-L123)。
- 共享 `_engine` 依赖 `postJson/postForm/postText`，按各 spec `ok()` 判定；有些渠道**只按 HTTP 2xx**，另一些明确检查 JSON 业务码。这是证据等级差异，不应把全部 `delivered` 同一解释为端到端设备送达。证据：[_engine.mjs:78-128](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/_engine.mjs#L78-L128)、[notify.mjs:70-72,193-203](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/notify.mjs#L193-L203)。
- 对 `ssrfGuard` 的声明式渠道，底层 network policy 在发送前拒绝默认私网/重定向；`onebot` 的 `private-ok` 是设计上有意放开内网，不应说“所有 webhook 一律可以访问内网”。证据：[_engine.mjs:84-102](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/_engine.mjs#L84-L102)、[_shared.mjs:146-178](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/_shared.mjs#L146-L178)。
- 出站默认按 1200 **Unicode 码点**分段，渠道正文/标题/卡片限制不一定也用码点，且个别适配器（QQ Bot）有二次分段；“已分段”不能代替 28 渠道各自字符/字节上限检查。证据：[config.mjs:344-351](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/config.mjs#L344-L351)、[notify.mjs:48-68](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/notify.mjs#L48-L68)。

## 8. 出站层值得优先处理的静态问题与证据边界

### CH-01｜P1｜成功 HTTP 响应后 `body` 读取脱离原请求超时窗（源码确定的控制流缺口，是否卡住取决于上游）

[`_shared.mjs:181-204`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/_shared.mjs#L181-L204) 中 `postJson` 的 `AbortController` 计时器在 `fetch()` 返回 **Response**、`return response` 后就于 `finally` 清理。之后的 `response.json()`（例如 [`adapters/telegram.mjs:34-37`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/telegram.mjs#L34-L37)）或 `readTextCapped()`（[`_engine.mjs:114-119`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/_engine.mjs#L114-L119)）**已不再受该超时定时器控制**。`postForm`、`getJson`、`postText` 有同类结构。[`_shared.mjs:206-280`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/_shared.mjs#L206-L280)。

**可静态证明的是：成功响应 body 完成期限没有被同一计时器保护。** 只有在上游/网络出现“已响应头、body 长期挂住”的特定行为下，才可能造成通知任务滞留、`flush()` 等待过长或未完成。没有运行故障注入，不能称已有生产死锁。范围影响通用出站路径，修复边界应在共享网络基础层，而不是给 28 个渠道分别补计时器；必须保持现有超时后 `noRetry` 的不确定结果语义。与 [`notify.mjs:74-85`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/notify.mjs#L74-L85) 的在途 `flush` 合看。

### CH-02｜P2｜QQ Bot 将无业务错误字段的任意 JSON 对象当“发送成功”（源码可确定）

[`adapters/qq-bot.mjs:101-119`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/qq-bot.mjs#L101-L119) 校验了“JSON 是非 null 的 object”，再仅在 `payload.code` 为非空 **string** 时抛错；并未强制验证自己注释声明的成功 `id/timestamp`。因此就代码判定规则而言，HTTP 2xx 的 `{}` 或不含 `code` 的无关对象会使 `lastSeq=seq`，最终作为成功返回。**是否存在这种真实平台错误回包，本次没有证据**；这不是“QQ 官方稳定返回 `{}`”的断言。它会降低错误网关/协议漂移的可诊断性。最小边界：核对成功响应契约与可接受字段，失败必须可见；不要混同 provider accepted 与 delivered。

### CH-03｜P2｜多种“本地成功”会被视作 provider accepted，但不代表用户收到

`bell` 的 `send()` 在 `stdout.write()` 同步失败时吞异常并返回 undefined；`desktop` 命令退出零仅代表操作系统调用成功；声明式 HTTP 通道多数返回 undefined；`notify.mjs` 的 `accepted` 来自 adapter 未抛错，`confirmed` 则另有 `isConfirmedReceipt`。本设计对内部状态有区分，但对 UI/测试文字中“已送达”须以 `confirmed` 的证据为准。证据：[`bell.mjs:17-29`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/bell.mjs#L17-L29)、[`desktop.mjs:170-201`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/desktop.mjs#L170-L201)、[`notify.mjs:193-203`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/notify.mjs#L193-L203)。

### CH-04｜P2｜渠道为零目标时结果字段 `ok` 有两套含义

`notifyAll()` 在**全局无已配置渠道**时 `ok:false`，但当路由或 `channelTypes` 筛选为空时 `ok:true`、`skipped:['(no-targets)']`、`accepted:[]`；静音也 `ok:true`。`notify` 工具对广播的 `ok` 又直接取 `failed.length===0`，不查看 accepted/skipped。这不是“网络投递失败”，是静态**返回语义漂移**。证据：[`notify.mjs:143-167`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/notify.mjs#L143-L167)、[`tool-register.mjs:164-174`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/tool-register.mjs#L164-L174)。完成任务需要明确三个布尔量：**成功处理调用**、**提供方接受 ≥1 次**、**确认送达 ≥1 次**，而不是仅用 `ok` 承载全部含义。

### CH-05｜产品边界｜只做私聊的目标与群/全员默认目标并存

源码里仍有：QQ Bot `targetType` 未设即 `group`（[`qq-bot.mjs:22-39`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/qq-bot.mjs#L22-L39)）；WeCom App `touser` 未设即 `'@all'`（[`wecom-app.mjs:48-55`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters/wecom-app.mjs#L48-L55)）；OneBot 可选 `group`；Slack/Discord/WPS/DingTalk/Feishu Webhook/Google Chat 等本质用于空间/群/频道。**这是项目产品规则不统一的证据，不是这些渠道 API 一定错误**。需要在维护者明确的私聊-only 范围内决定渠道/配置 UI 展示和已配置用户的迁移行为；本审查不擅自删渠道或改配置。

## 9. 六个入站渠道：生产装配与权限/传输核查

六个入站渠道的唯一常量见 [`channels-registry.mjs:11-19`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/channels-registry.mjs#L11-L19)。真实装配见 [`assembly/inbound-channels.mjs:8-25,78-148`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/assembly/inbound-channels.mjs#L78-L148)：**每通道各启动一个实例**；`interactiveInstances`、`replyTargets`、`running` 均以渠道名或单实例维护。这**不能**证明同渠道多账号同时运行受支持（目前代码层恰好限制为一个启动点）。上次审查的跨账号键问题因此须定位为“设计允许多账号后的条件风险/更换账号时的旧状态风险”，不能直接声称多机器人实例在现有默认装配中必然共存。

| 渠道 | 入站路径（固定 main） | 已证明的源码行为 | 正确性缺口、验证条件及结论 |
|---|---|---|---|
| Telegram | [`inbound/telegram-bot.mjs:52-112,267-296`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/telegram-bot.mjs#L267-L296)、[`channels/telegram/index.mjs:30-57`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/channels/telegram/index.mjs#L30-L57) | Bot API long poll、accountId 本地注入、`message_id+chatId`、callback token、sendText | **S**：`handleUpdate()` 将 group 类型消息照送 `bus.accept`，不存在最前置私聊过滤。全产品私聊-only 未贯彻；真实 callback/updates 权限、getUpdates ack 后状态另验。 |
| Feishu | [`inbound/feishu-bot.mjs:382-420`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/feishu-bot.mjs#L382-L420)、[`749-805`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/feishu-bot.mjs#L749-L805) | WebSocket/SDK、appId 账号源、message.chat_type；敏感审批/提问卡片阻止发群 | **S/C**：普通群文本仍可过 `bus.accept`；sendActionCard 在群做文本降级，与“完全只私聊”有别；SDK 真实事件和卡片权限待验。 |
| QQ | [`inbound/qq-gw.mjs:430-523`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/qq-gw.mjs#L430-L523) | C2C、群 AT、互动按钮均有独立处理；账号来自 appId；WebSocket READY/RESUMED 维护心跳 | **S**：`GROUP_AT_MESSAGE_CREATE` 明确进入 `bus.accept`；结合非 `/stop` 斜杠命令绕 Control Core 的代码存在私聊准入旁路。真实 API 是否下发这类群事件为 C。 |
| WxPusher | [`inbound/wxpusher-callback.mjs:63-83,145-205`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/wxpusher-callback.mjs#L145-L205) | secret callback path、公网绑定无 IP 白名单则拒绝、本地 accountId/UID 不使用 callback 自报 appId | **S/C**：合成消息 id 含递增 syntheticSeq，无法吸收相同内容的回调重投，详 §9.1；代理 IP/密径真部署有效性另验。 |
| WeChat iLink | [`channels/wechat-ilink/index.mjs:41-99`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/channels/wechat-ilink/index.mjs#L41-L99) | 代理 legacy iLink，`accountScoped:true`，会话过期清凭据；imageInbound true、sendImage 无协议时 false | **C/U**：协议/登录有效性和 source accountId 一致性需要真会话；readiness 不可由布尔 `imageInbound:true` 推出能读取全部媒体；登录无凭证文件仅源码可判策略。 |
| DingTalk Stream | [`inbound/dingtalk-stream.mjs:380-407`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/dingtalk-stream.mjs#L380-L407)、[`517-590`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/dingtalk-stream.mjs#L517-L590) | Stream、appKey 账号源、conversationType `1` 私聊/`2` 群聊、图片占位、sessionWebhook 降级 | **S/C**：群会话消息仍交 bus，需统一前置拒绝；sessionWebhook 过期、补发额度、消息重投与真实 SDK 版本待验。 |

**不能把 SDK 出站与入站互相等同**：出站 `feishu` 是自定义群机器人 webhook，入站 `feishu` 是应用 SDK/WS；出站 `dingtalk` 是机器人 webhook，入站 `dingtalk` 是 Stream；出站 `qq-bot` 与入站 `qq` Gateway 也不是同一份运行时实例或凭据的充分证明。配置/文档应使这点清晰。对应工厂证据：[config.mjs](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/config.mjs#L9-L45)、[inbound assembly](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/assembly/inbound-channels.mjs#L8-L25)。

### 9.1 IN-01｜P1｜WxPusher 同 payload 回调重投无法靠 `messageId` 去重

`send_up_cmd` 的 `messageId` 构造为 `cmd:${uid}:${time}:${hash6(text)}:${syntheticSeq++}`；全局 bus 的去重主键是 `dedup:${channel}:${messageId}`。因此**两次相同 uid、time、text 的回调，序号不同，去重键必然不同**。[`wxpusher-callback.mjs:173-201`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/wxpusher-callback.mjs#L173-L201)、[`bus.mjs:85-110`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/bus.mjs#L85-L110)。

此设计试图解决“同一秒连续发送相同文本不能互吞”，但把“平台重投同一条”和“用户确实重发同样文本”变成了无法从现有字段区分的两件事。**源码确定的是这类合成键无法识别重复回调**；本次没有证据证明 WxPusher 实际会以该形状重推同一条，也没有运行回调测试。若要保证副作用类命令恰好一次，需要平台事件权威 ID 或可审计的重复判定策略，不能仅调短 FIFO 时间窗。

### 9.2 IN-02｜P1｜`bus.accept` 不把下游持久化/业务处理结果当成入站 ack 条件

在绑定身份下，`bus.accept()` 先 `remember(envelope)`，后同步遍历 `handler(envelope)`；handler 抛错会被 catch/warn 后继续，最终 `{ok:true}`。这证明**当前 API 的 `ok:true` 表示“通过了本层入站判断”，而不是所有消费者成功处理，更不是后续 Agent 已接纳**。任何入站适配器若据此推进平台 offset/ack，就有条件出现“业务失败不可重放”的可靠性问题。证据：[`bus.mjs:193-233`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/bus.mjs#L193-L233)、[`telegram-bot.mjs:267-311`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/telegram-bot.mjs#L267-L311)。

### 9.3 IN-03｜账号隔离：本轮不把可构造跨账号碰撞直接当“生产实锤”

identity 已有 `principalKey(channel,accountId,userId)`，但 `conversation` 的 `bind:` 和短句合并仅按 `(channel,userId[,chatId])`；bus dedup 仅按 `(channel,messageId)`；`/log` 的 owner 筛选仅按 channel+userId。**这是代码域设计不一致的确定事实**。然而默认 `createInboundChannelRegistry()` 每种 provider **只装配一个实例**；故“同渠道两个 bot 同时启动串权”需要明确的多账号装配证据，不能仅用合成 envelope 当生产可达漏洞。单通道账号更换后仍复用旧会话 bind/角色的风险，应单独检查持久化迁移。证据：[`identity.mjs:49-73`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/identity.mjs#L49-L73)、[`conversation.mjs:203-206,924-926`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs#L203-L206)、[`bus.mjs:85-88`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/bus.mjs#L85-L88)、[`conversation.mjs:550-561`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs#L550-L561)、[`assembly/inbound-channels.mjs:63-91`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/assembly/inbound-channels.mjs#L63-L91)。

### 9.4 IN-04｜非 `/stop` 斜杠命令与群聊：控制 gate 的可达性缺口

`route()` 将非 `/stop` 斜杠文本的 `command` 置为 `null`，然后直接走 `routeUnsafe()`；QQ 私聊/群拒绝只在这个分支**之后**。因此该 gate 没有覆盖 `/status`、`/tasks`、`/bind`、未知 `/whatever` 等命令。`routeUnsafe()` 内，未知命令会产生提示后以普通文本继续处理。**这属于可从源码证明的 gate 覆盖缺口**，没有在本轮实际发送任何消息，也不能直接推断远端真实 Host 执行了未经授权指令。证据：[`conversation.mjs:301-460`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs#L301-L460)、[`conversation.mjs:1025-1064`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs#L1025-L1064)。私聊-only 目标需要在**所有入站渠道的共同准入层**拦截，而非只给 QQ 的 `ordinary-message` 加判断。

## 10. Native Control Surface 的兼容/认证额外条件

### NA-01｜`connection.admit` 是接入认证，不自动承担业务方法授权

notifier 的自有 `/dsh-notifier/<endpoint>` 前缀路由调用 `connection.admit(req)`，只在 `rejection` 时拒绝；否则直接 `service.call(endpoint,payload,signal)`。DSH `admit` 返回 `{peer}` 或 `{rejection}`，并不自行解释 notifier 业务方法。DSH 标准 `/api` 网关还通过 `remote-access` 等提供额外方法层策略；notifier 自定义路由未明显复用该标准 method-level policy。证据：[`notifier rpc.mjs:95-138`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/rpc.mjs#L95-L138)、[DSH admit:122-136](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/connection/src/rpc-host.ts#L122-L136)、[base remote-access row](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/bundle/base/cordis.patch.yml#L49-L59)。

**判定 C**：需要确定自有 route 对哪类 Peer/浏览器 cookie 可达、service 内部是否再次验证操作权限、当前部署有无非 owner API Peer，才能谈“非 owner 可改配置”。**本次没有证明任何越权者实际可访问**。但在升级复核时，不应把“`admit` 通过”与“业务权限校验完成”当同义词。

### NA-02｜Web UI 可注册不代表 Native 完整功能可用

`client.js` 通过宿主的 loader 表接入 React、`ctx.slots.register`、`sidebar.panellist/main/plugins.bundle.config/plugins.bundle.activation`，当前三版相关 Browser 容器形状可追溯；**但**插件前置预检可能使服务压根不加载、Native route 可能没挂、用户 profile 可能没有 Web、更改导航 pin 的 rc.3 还可能改变视觉表现。证据：[`client.js:1035-1089`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/client.js#L1035-L1089)、[client module registry:850-875](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/modules/src/index.ts#L850-L875)、[sidebar slot:46-95](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-sidebar/src/client/index.ts#L46-L95)。

### NA-03｜Native 原生提问的取消与多回答者竞争需要单独验收

`host/native-questions` 使用 `user-questions/request` waterfall 并与下游 `next()` 竞争，含自身 AbortController，但真实宿主 `request.signal` 可能另有取消原因和时序；`questionBridge` 的业务回执不等同 Host `ask()` 最终返回。在静态形状一致的前提下，应核对外部取消是否能同时关闭手机桥、GUI 先答后手机卡片是否终止、Agent disposed 后迟到消息是否不结算。此处仅列**条件性验证项**，不报为已确认竞态 bug。证据：[`host/native-questions.mjs:88-136,151-207`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/native-questions.mjs#L151-L207)、[DSH UserQuestions ask:287-334](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/interaction/user-questions/src/index.ts#L287-L334)。

## 11. 审查覆盖说明与现有测试的证据位置

- notifier `testCount:2011` 是 manifest 字段，历史 `docs/OPERATIONS.md` 有发布报告记录；**本次没有重新执行测试，不能写“本轮 2011 tests 全绿”**。参考：[`package.json`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/package.json)、[`OPERATIONS.md:5-18`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/docs/OPERATIONS.md#L5-L18)。
- `test/host-compat-matrix.test.mjs` 明确固定的是四项旧 `0.1.7-*` 版本、manifest 与项目矩阵保持一致；这种检查是**声明一致性测试**，不是 0.2.x boot、Client、权限或真实渠道验证。证据：[`host-compat-matrix.test.mjs:18-80`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/test/host-compat-matrix.test.mjs#L18-L80)。
- 仅根据存在的测试断言可以定位“有意维持的现状”和局部覆盖范围；没有综合核对每个提供方全部真实协议变更，因此矩阵中的 M/C 不可自动升级为“已通过”。
- 已有 `compatibility-matrix.md` 明确把 **contract/source verified / host smoke verified / real-provider-device verified** 三层分开；本报告保持这个严格口径，不采信旧 Host 或 0.1.7 设备报告作为 0.2.x 实测。证据：[`docs/compatibility-matrix.md:1-49`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/docs/compatibility-matrix.md#L1-L49)。

### 后续验收矩阵（仅定义边界，本次未执行）

| 未来验收组 | 需证明的条件 | 源码审查不能替代的证据 |
|---|---|---|
| 安装/升级 | 0.2.0-rc.2、0.2.1-rc.2、0.2.1-rc.3，未经豁免/精确豁免/正式新声明三种路径 | profile preflight 的真实结果、包管理器依赖解析记录 |
| Web / headless | Host tools/agents/connection/webServer/sessionController 的真实生命周期 | 激活顺序、卸载/重挂、缺服务时可降级、不拖垮核心 |
| Host tools | 注册/重复注册/取消/卸载、执行上下文 agent 的归属 | notifier 工具已注册且实际由模型调用、不重复、能撤销 |
| Events | session/turn-start/end、agent/error/disposed、scope 与 disposer | 接收计数、按会话触发一次、停止后不重发 |
| Approval/questions | owner/member、准确来源、GUI/手机双回答、取消/超时、迟到回执 | 只有授权来源的首答生效，Host audit pairing 不破坏 |
| Attachments | 图片/文件 admission 与可回放/读取，错误 Content-Type、超限、网络中断 | durable ref 真通过 Host Session API，被模型正确读取 |
| Native UI | client.js/React、sidebar、插件设置、窄屏、rc.3 pinned/unpinned | 浏览器视觉/交互验证，RPC 认证及掉线恢复 |
| Outbound 28 | 每种配置合法/非法、HTTP 2xx/4xx/429/超时/body 卡住、业务码、重试、segment、secret | 提供方真实回执/设备截图或可审计 provider sandbox |
| Inbound 6 | 私聊/群/错误 accountId、重投/掉线、媒体、按钮、撤销账号、配对与命令 | 真实 IM 和 Host 的联动证据，不得由 mock 代替 |

## 12. 给维护者的最小调整边界与依赖顺序（不提供补丁）

**第一层：安装契约与 profile 真值。** 先分别设计 DSH profile 预检/包管理器 peer/Host API 三套兼容判断；为新版本形成与真实审查等级一致的 manifest/矩阵。不以版本豁免替代兼容修复。核心依赖图不能把只属于 Web 的 `connection/webServer` 强迫所有 profile 必须有；需先定义“headless 有哪些功能”及不可用时的明确口径。

**第二层：授权和来源单一权威。** private-only 应由共同 ingress 层统一拦群，覆盖普通文本、斜杠命令、回调按钮、媒体和异常会话；`Control Core` 是所有会话写操作的权威闸，不应有文字前缀导致的旧分支 bypass。身份键必须追踪经配置可信产生的 `(channel,accountId,userId[,chatId])`，同时核对账号替换/迁移，不根据未经证明的双 bot 生产装配宣称已暴露漏洞。

**第三层：事件、工具和持久化结果证据。** 让 notifier 工具 `ok`、provider `accepted`、device `confirmed`、quiet/skipped 严格分离；明确失效场景下 message ack 与业务 settle 的关系；保持 Host `UserMessage` 来源/附件 durable admission，处理 service 生命周期、取消与 replay。

**第四层：网络与每渠道。** 共享 HTTP 层保证完整响应体读取也受有界时限；QQ `2xx` 正确校验成功对象、WxPusher synthetic retry/real repeat 语义分离；对每种 provider 的成功码、发送限制、速率、token、URL/代理、防私网/重定向分别建静态/实测证据。私聊-only 应决定默认目标、群 webhook、全员广播是否仍可展示或启用，但这是产品边界而非自动删除历史用户配置的许可。

**第五层：Web Native 与回归。** 在三个指定 Host 版本分别核对 UI 和 RPC，尤其 rc.3 新导航条目/Pin 行为、浏览器认证、会话审批/提问 race、问答取消、服务重建后的监听注销。最后才可对外宣告对某个 DSH 版本“已支持”。

---

## 13. 本次审查所能负责任作出的最终判断

**源码确定不兼容**：未获精确豁免的新版 DSH profile 版本预检；默认缺 `connection` 的 headless 激活。除此之外，对照三个版本的关键 tools、agents、session events、approval、userQuestions 与附件签名没有发现同等级的直接互斥断点。

**静态形状一致**：工具注册与 disposer、Agent 四种远程控制 API 的参数、核心事件 tuple/payload、原生提问 waterfall、附件 saveImage/saveFile、Web ModuleLoader/slot 名称。形状一致**不是**实测支持。

**条件性重要风险**：成功 HTTP 响应 body 无原有超时保护、QQ 2xx JSON 的假成功判定、WxPusher 合成 ID 与重投去重相矛盾、消息 `ok` 不等于消费者完成、私聊-only 群消息仍可进入业务、账号状态键不完全以 accountId 隔离、自建 Native route method-level 权限由自身负责。均有具体源码依据；对实际提供方行为和生产可达性谨慎不外推。

**无法静态确认**：三版 npm 安装、真实 DSH 启动、headless 的进程最终状态、React 页面能否显示/正确 pin、审批是否真实生效、真实附件能否被模型读取、28 个渠道及六入站的在线正确性、提供方和设备最终收到通知。本次都没有执行。

**综上**：当前适合把这份报告当作**下一阶段修复与更新的静态事实依据**，而不适合宣布 dsh-notifier 0.13.1 已支持 DSH 0.2.0/0.2.1，也不适合把 28+6 渠道说成已全部真实验证。审查范围保持 main 固定 SHA；未修改代码。
