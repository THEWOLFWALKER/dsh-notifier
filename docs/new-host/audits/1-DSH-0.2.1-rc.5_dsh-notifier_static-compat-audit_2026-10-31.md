# DSH 0.2.1-rc.5 × dsh-notifier 0.13.1：实施前专项静态兼容审查

> 日期：2026-10-31  
> 性质：**固定提交、只读源码、未运行验证**；这是 rc.5 实施契约，不是“已兼容”声明。  
> 审查对象：仅 `THEWOLFWALKER/dsh-notifier` **main@`9d69dd7a8908fcfec6e20d92d56509764a8f23ec`**，以及 `deepseek-ai/deepseek-harness` **`dsh-v0.2.1-rc.5`@`b830ec950faba0a46dda564be3e2d854afed94f1`**。历史比较仅 `dsh-v0.2.1-rc.3`@`1f81c047fc48fa190a683e469daa699857e9afe8`。  
> **范围排除**：notifier dev/重写分支、rc.5 以外的适配目标、dsh-std 替代方案。没有运行代码、测试、构建、安装、探针、Host、Provider、账号或消息；没有改动仓库、profile、远端状态，没有提交或推送。已有测试仅用于理解覆盖意图。

## 0. 执行摘要

**结论：不能直接宣布 `notifier 0.13.1` 兼容 DSH rc.5；但 rc.5 已公开的核心 Tool / Agent / Session / Approval / Question / Attachment / Client Slot 接口，足以形成直接实施的固定目标，不需要维护 rc.3 兼容层。**

最关键的判断：

- **源码确定冲突**：原始 manifest 的 `@deepseek-ai/dsh-session` peer 不包含 rc.5，预检可能禁用插件；`connection` 全局硬注入使非 Web 的核心通知无法激活；`notify/notify_test` 未按 rc.5 工具执行契约将 `exec.signal` 传到异步副作用；原生审批与提问的宿主取消信号未完整下传；当前 RPC 业务入口未实际按 `Peer` 进行方法级授权；Native RPC 注销的返回 Promise 被包装器丢弃。
- **静态契约一致**：`tools.register({parameters,output:{schema,render},execute})` 的总体形状；`agents.get/list/roots`、`followup/inject/steer/cancel` 的公开签名；`session/event(session,event)`、`agent/error` 和 `agent/disposed({agent})` 的载荷；标准 Base 的 `attachments` 服务及基本 durable ref 形状；`client.js` 的 `__ModuleLoader__.load` 及四个现有 Slot；Cordis Fiber 底层能够等待异步 disposer。
- **条件成立，列明条件**：rc.5 `connection.rpc.handle` 可以在已拥有 `connection + webServer` 的调用方 Context 注册官方路由，不能再简单沿用旧版本“必定不可用”的说法；真正能否接管路径还依赖注册时的 Context、已有路由占用和初始化顺序。当前公开 HTTP 认证路径产生的成功 `Peer` 是 `owner`，但不等于接口永久承诺所有 `Peer` 均为 owner，也不代替业务方法授权。
- **证据不足，列明缺失材料**：npm rc.5 实际 tarball 的逐包发行依赖闭包及用户安装解析结果；浏览器最终渲染/交互与 GUI 卡片自动撤销；所有 Loader/Registry/HMR 路径严格先 drain 旧实例再激活新实例；第三方 provider 实际收发及持久附件模型读取。不得写成“通过”。

**实施优先级**：A 安装/预检 → B 核心依赖拆分及注册所有权 → C Tool/Agent/Approval/Question/Attachment 语义 → D Native RPC 授权及取消 → E 生命周期/drain → F 静态覆盖矩阵更新。此次**不写补丁**。

## 1. 精确基线与来源

### 1.1 不浮动的源码与发行信息

| 层次 | 精确标识 | 核验对象 | 结论 |
|---|---|---|---|
| notifier 源码 | `main@9d69dd7a8908fcfec6e20d92d56509764a8f23ec` | `package.json:1-4,85-100` | 包名 `dsh-notifier`、源码版本 `0.13.1` |
| DSH 目标源码 | `dsh-v0.2.1-rc.5` → `b830ec950faba0a46dda564be3e2d854afed94f1` | tag/ref、GitHub release、固定提交 | 与指定 SHA 一致 |
| 历史比较 | `dsh-v0.2.1-rc.3` → `1f81c047fc48fa190a683e469daa699857e9afe8` | 固定提交 compare | 仅用作定位差异 |
| CLI 源码 manifest | `apps/cli/package.json:1-4` | `@deepseek-ai/dsh` | `0.2.1-rc.5` |
| App Boot 源码 manifest | `packages/boot/app-boot/package.json:1-4` | `@deepseek-ai/dsh-app-boot` | `0.2.1-rc.5` |
| Session/Tools/Connection | 对应 `packages/**/package.json` | `dsh-session`、`dsh-tools`、`dsh-client-connection` | 源码各为 `0.2.1-rc.5` |
| Approval/Questions/Attachment Local | 对应 `packages/**/package.json` | `dsh-user-approval`、`dsh-user-questions`、`dsh-attachment-local` | 源码各为 `0.2.1-rc.5` |
| Cordis | `vendor/cordis/package.json` | `@deepseek-ai/cordis` | `4.0.5`（不是 rc.5） |
| Cordis Loader | `vendor/loader/package.json` | `@deepseek-ai/cordis-plugin-loader` | `1.0.6`（不是 rc.5） |
| 第三方依赖 | `apps/cli/package.json:90-94`，`packages/boot/app-boot/package.json:34-43` | `commander ^15.0.0`、`js-yaml ^4.3.2`、`node-addon-require-builtin ^0.1.9`、`semver ^7.8.5` 等 | **版本范围，不是实际解析版本** |
| notifier 可选 SDK | `package.json:94-97` | `@larksuiteoapi/node-sdk 1.73.0`、`qrcode-terminal 0.12.0` | 插件的 optionalDependencies，与宿主 rc.5 核心兼容性不同 |

源码永久引用：
- [N / package.json](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/package.json#L1-L100)
- [H / apps/cli/package.json](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/apps/cli/package.json#L1-L109)
- [H / app-boot/package.json](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/boot/app-boot/package.json#L1-L66)
- [H / Cordis manifest](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/cordis/package.json)
- [H / Loader manifest](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/loader/package.json)
- [H / rc.5 正式发行页](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5)
- [npm / CLI 版本列表](https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions)

核对时 npm 的 `@deepseek-ai/dsh` **latest 与 next 均显示 `0.2.1-rc.5`**；这是此时公共发行元数据观察，不是用于未来跟踪的浮动目标。官方发行页记录 2026-10-30 的 rc.5 发布及 `b830ec9`。`alpha` 指向其他版本，不纳入本报告。

**来源层级界限**：仓库 `workspace:*` / `workspace:~` 是工作区的依赖关系，不能直接引用为用户 npm 安装后最终的依赖版本；`CLI` 的版本也不能代替 `Cordis` 的版本。rc.5 发布 tarball 的**完整依赖清单、打包后依赖范围、lock/解析实例**并未逐项取得，故对“实际发行包依赖闭包全部与源码一致”判为 **证据不足，缺失 rc.5 对应 tarball 的最终 package.json 与相关依赖 tarball 的清单**。本结论不依赖假设它们一致。

### 1.2 标注约定

下文链接中 `H` 代表固定 `b830ec...`，`N` 代表固定 `9d69dd...`；每个表格行的路径和行号均可通过固定 commit 的 GitHub Blob 页面复核。判断**仅**使用以下四个标签：**源码确定冲突／静态契约一致／条件成立，列明条件／证据不足，列明缺失材料**。这些不是动态测试评级。

## 2. rc.3 → rc.5 差异定位，以及对真实 rc.5 调用的核查

固定比较：[rc.3 ... rc.5](https://github.com/deepseek-ai/deepseek-harness/compare/1f81c047fc48fa190a683e469daa699857e9afe8...b830ec950faba0a46dda564be3e2d854afed94f1)。比较返回相隔 **13 commits**；GitHub Compare 的一次文件列表显示前 300 项，**不能宣称它是完整变更全集**。以下与 notifier 直接相关的接口，另读取了 rc.5 当前源码，不以“没有改动”作为兼容依据。

| 变化线索 | 固定 rc.5 代码 / 变化位置 | notifier 实际调用覆盖到的层次 | 判断 |
|---|---|---|---|
| reasoning 文本/展开体 | `packages/client/ui-chat/src/client/chat/ReasoningRow.tsx`、`reasoning-text.ts`、`contract/slots.ts:78-95,431-435` | notifier 只挂 `main/sidebar.panellist/plugins.bundle.*`，没有注册 `conversation.chat.reasoning.body`，不存在新增 `rawText` 必填参数的直接调用 | **静态契约一致** |
| 会话标签 Tooltip | `packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx:54-65` | 此为官方会话标题组件，notifier 自有 sidebar icon 不调用该组件；只核到 Slot 与 import 关系，没有浏览器 CSS 结果 | **条件成立，列明条件**：仅声明无直接 API 冲突，不声明视觉通过 |
| Client slot catalog 更新 | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2180,2310,2350,3695` | 对四个 notifier 实际 Slot 的 kind、scope、key/id 做了 rc.5 直接复核 | **静态契约一致** |
| DeepSeek account 改动 | `packages/llm/llm-deepseek-account/src/index.ts` | notifier 不直接调用此私有实现；provider/agent 事件的业务结果不在静态兼容范围 | **条件成立，列明条件**：不得把无直接导入扩大为全链路无影响 |
| MCP Client 改动 | `packages/mcp/mcp-client/src/connection.ts` | notifier 不直接调用；Agent 事件和工具回执仍可能受到上游 MCP 运行结果影响 | **条件成立，列明条件**：当前 notifier seam 无直接变更证据 |
| package manifests | `apps/cli/package.json`、多个 `packages/**/package.json` | 直接查 rc.5 的版本与依赖范围，而非按 rc.3 目录推断 | **静态契约一致**（仅指源码声明身份） |

rc.5 [官方发行说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5) 将此次主要用户可见调整描述为思考内容的展示。**这不等于上游所有底层契约自动兼容**；下文分别核查实际源码、导出类型、装配、调用与所有权。

## 3. 安装/激活和分发门禁

### 3.1 rc.5 的真实匹配规则

`H packages/boot/app-boot/src/plugin-compatibility.ts:51-80`：

```ts
function satisfies(runtimeVersion: string, range: string): boolean {
  return range.trim() !== '' && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
}
// 若 manifest 自有 engines.dsh，**仅**该字段决定 DSH 预检；
// 否则再检查 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* peers。
```

`peerDependenciesMeta.optional` **不会从此 DSH 版本预检中豁免对应 peer**：预检读 `peerDependencies` 的范围，不按 npm optional 标记跳过。只有声明了 `engines.dsh`，宿主预检才优先以该字段取代 DSH peers 的判定。[H compatibility L51-L101](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/boot/app-boot/src/plugin-compatibility.ts#L51-L101)

notifier [N package.json:85-100](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/package.json#L85-L100)：

```json
"@deepseek-ai/dsh-session": "0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2"
```

`0.2.1-rc.5` 不在该集合，当前未声明 `engines.dsh`；**源码确定冲突**。`@deepseek-ai/cordis: ^4.0.1` 与 rc.5 源码中的 Cordis `4.0.5` 范围兼容，但不等于所有安装环境都解析到同一实例。

`H compatibility-preflight.ts:63-136`：在插件导入前，若 manifest 可以被定位且版本不匹配，普通 row 会标 `disabled`；Include 遇到冲突可能整块被拒绝；无法解析 manifest 时并不伪装成“兼容”，交 Loader 自己报导入错误。 [H preflight L63-L136](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/boot/app-boot/src/compatibility-preflight.ts#L63-L136)

### 3.2 仅 rc.5 的精确声明及依赖拆分

**建议的声明含义**：`engines.dsh` 使用精确 `0.2.1-rc.5`；不要 `>=0.2.1`、`*`、长期 `allow-version`、也不要继续把 rc.3 视为必须支持。配置思路（**非补丁**）：

```json
"engines": { "node": ">=22", "dsh": "0.2.1-rc.5" }
```

`includePrerelease: true` 允许准确识别这一 prerelease，**不会令精确版本等同未来 `rc.6`**。

**包管理器 peer 与 DSH preflight 独立**：`engines.dsh` 解决 DSH 自身的准入，不会自动消灭 npm 安装时旧 `dsh-session` peer 的依赖冲突。`dsh-session` 若不是 notifier 必须直接解析/导入的依赖，可以移除过时 optional peer；若仍需要，则应基于 rc.5 真正发行的依赖约束声明，不能只为了通过预检保留旧值。公共 `@deepseek-ai/cordis` peer 可基于准确版本与宿主共实例要求保留。

notifier 还保留旧的机器门禁：`scripts/verify-host-compat.mjs:2-5,42-87` 强制 peer、`docs/compatibility-matrix.md` 的机器可读块、`dshWorkshop.compatibility.dshVersions` 一致，而 [N package.json:159-165](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/package.json#L159-L165) 明列旧版本。**源码确定冲突**：不能只改 `engines.dsh` 而留下会拒绝新基线的项目自检；需要重新定义以 `engines.dsh` 为一手来源的静态检查，更新矩阵与文档，不虚报 `verified/host smoke`。

### 3.3 Loader 和服务依赖停止语义

- `H vendor/cordis/src/registry.ts:65-85,163-176,293-301`：inject 声明依赖，`ctx.inject(...)` 是一个从属于上层的 Fiber，当依赖缺失/替换会卸载并重做 callback；**这不是一次性 EventEmitter 回调**。[H registry](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/cordis/src/registry.ts#L163-L185)
- `H vendor/cordis/src/fiber.ts:597-636`：依赖提供实例 epoch 变化会触发 unload/reload；旧依赖相关 effect 需要停止/释放。[H fiber](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/cordis/src/fiber.ts#L597-L636)
- `H vendor/loader/src/config/entry.ts:135-155` 和 `H vendor/cordis/src/registry.ts:258-265` 存在**没有 `await fiber.dispose()` 的生产路径**。因此“底层 disposer 是异步可等待”与“所有 Loader 操作保证旧实例 drain 完再上新实例”是两件事。[H Loader](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/loader/src/config/entry.ts#L135-L155)

## 4. Profile 装配事实（模板 → base → 模式 patch → 其他覆盖）

官方模板 `H packages/boot/app-boot/src/profile.ts:179-195`：

```text
web         = dsh-base + dsh-web-app
headless    = dsh-base + dsh-headless
acp         = dsh-base + dsh-acp-app
sdk         = dsh-base + dsh-sdk-app
sdk-minimal = dsh-sdk-minimal（不是 base + Web）
```

**没有官方 `tui` 模板**。`H profile.ts:197-200` 还处理已有安装中的 headless 组合；`H apps/cli/src/profile-boot.ts:202-235` 表明具体加载会叠加 profile/home/额外 patch。不能以单个模板名称证明用户最终服务始终存在。[H profile](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/boot/app-boot/src/profile.ts#L179-L200) · [H profile boot](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/apps/cli/src/profile-boot.ts#L202-L235)

| 服务/能力 | rc.5 标准来源 | Web | Headless | 其他官方模板界限 |
|---|---|---|---|---|
| `tools` | `base/cordis.patch.yml:499-500` | 标准有 | 标准有 | ACP/SDK 由 base 获得；sdk-minimal 不可按 base 推断 |
| `agents` / Agent Loop | `base:82-83,511-514` | 标准有 | 标准有 | 同上 |
| `session` | `base:40-41` | 标准有 | 标准有 | 同上 |
| `userQuestions` | `base:79-80` | 标准有服务 | 标准有服务 | 有服务≠有 GUI answerer |
| `approval` | `base:259-260` | 标准有服务 | 标准有服务 | `never` policy 可直接拒绝，不触发 GUI |
| `attachments` | `base:146-147` (`attachment-local`) | 标准有 | 标准有 | 仍受实际 provider 覆盖影响 |
| `connection` | `web-app:234-241` | Web 专有 | headless 不保证 | 不得由 Base 推断 |
| `webServer` | `web-app:179-188` | Web 专有 | headless 不保证 | 不得由 Base 推断 |
| `sessionController` | `web-app:121-122` | Web 专有 | headless 不保证 | 不应被核心通知硬依赖 |
| Client Modules / Slots / Locale / Layout | `web-app:227-280,318-330,459-460` | Web 客户端装配 | headless 不保证 | 由 mode、实际启用和浏览器图决定 |

[H base patch](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/bundle/base/cordis.patch.yml#L35-L83) · [H base tools](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/bundle/base/cordis.patch.yml#L495-L514) · [H Web patch](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/bundle/web-app/cordis.patch.yml#L117-L330) · [H headless patch](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/bundle/headless/cordis.patch.yml#L1-L44)

`N src/index.mjs:62-63` 目前 `inject = ['tools','agents','connection']`；在 headless 这样的无 Web 装配下，**即便核心 Tool/Agent 存在，整插件也不激活：源码确定冲突**。[N index](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/index.mjs#L62-L63)

**最小设计边界**：核心通知只以真实必需的 `tools/agents` 及事件接口为基础；Web 增强部分通过 `ctx.inject(['connection','webServer'], ...)` 独立装配，拥有自身 RPC/资源/注销；原生提问通过 `userQuestions` 的生命周期装配。不能为了兼容 headless 把真正的核心依赖也一律默默变成可选，造成能力未激活却报告成功。

## 5. rc.5 逐调用兼容矩阵

**标注**：`N` = notifier 固定提交文件行号；`H` = rc.5 固定提交文件行号。行尾的文件跳转链接已在本报告第 11 节按路径集中给出；所有路径均为固定 commit 下的路径。

| ID | notifier 调用位置 | rc.5 定义/实现 | Profile 依赖 | 判断 | 最小调整边界 |
|---|---|---|---|---|---|
| T01 | `N src/tool-register.mjs:108-120` `ctx.tools.register` | `H packages/core/tools/src/index.ts:223-237,1065-1095` | Base tools | **静态契约一致** | 保留注册形状；确保精确 disposer 属于注册 Fiber |
| T02 | `N tool-register.mjs:38-49,51-84,111-119,195-200` | `H tools/index.ts:214-237,1071-1079` 检查 `output.schema/render`，参数使用 JSON Schema | Base tools | **静态契约一致** | 保留 canonical value → output render；成功结果必须符合 schema |
| T03 | `N tool-register.mjs:120-172,202-229` | `H tools/index.ts:227-235,327-352,419-436` `exec.signal` 必须传递并收敛 | Base tools | **源码确定冲突** | `notify`、`notify_test` 的在途发送/取消/drain 必须明确归属 |
| T04 | `N tool-register.mjs:143-161` 从 `execContext` 取 Agent | `H tools/index.ts:327-352` 公开 `exec.agent?`、没有公开 `exec.session` | Base tools+agents | **条件成立，列明条件**：有真实 live Agent 才能做 Agent 定向路由 | 不再依赖未声明的 session 属性作权威身份；没有身份时不能静默扩大广播权限 |
| T05 | `N index.mjs:90-107` `ctx.provide('notifier', ...)` | `H vendor/cordis/src/service.ts:32-58` 服务注册及 fiber 收尾 | Cordis | **静态契约一致** | 公共 service 与 `tools.register` 是不同命名空间和拥有者；保持公共 API |
| T06 | `N index.mjs:402-409,979-982` disposer 汇总 | `H tools/index.ts:1065-1095` 精确注销；`H fiber.ts:675-686` 异步等待 | tools+Cordis | **条件成立，列明条件**：注销函数真正返回/await 异步收尾 | 重载时同名 Tool 不能在旧异步工作未 drain 前误认为已无副作用 |
| A01 | `N index.mjs:353-354,588-594` `agents.list/get` | `H agent/index.ts:562-589` 只读 live registry | Base agents | **静态契约一致** | 不把持久 Session 当活 Agent |
| A02 | `N inbound/conversation.mjs:1134-1158` `roots()` | `H agent/index.ts:592-602` 按运行时 owner，而非 Session lineage | Base agents | **静态契约一致** | 使用 rc.5 `roots` 过滤；旧宿主 fallback 可删除 |
| A03 | `N inbound/conversation.mjs:864-875` `steer/inject/followup` | `H agent/runtime-types.ts:204-241` 消息入队和唤醒语义，返回 void | Base agents+session | **静态契约一致** | 回执只代表调用/接纳，不代表模型执行与效果 |
| A04 | `N index.mjs:588-595`, `inbound/conversation.mjs:370-371` `agent.cancel({kind:'user'})` | `H session/types.ts:189-197`、`agent/runtime-types.ts:176-191` | Base agents | **静态契约一致** | 取消请求≠已停止；如需停止确认只能跟踪 `whenIdle` 且注意新工作替换 |
| A05 | `N inbound/conversation.mjs:827-879` 依 `status` 选投递 | `H agent/runtime-types.ts:109,164-174,193-215` status 仅 `idle/running`，`disposed` 不属于枚举 | Base agents | **条件成立，列明条件**：投递前精确校验 `agents.get(id) === agent` | 异步下载后要重验；维护期即便 `idle` 也可能有被占用的非 turn 工作 |
| E01 | `N event-listener.mjs:543-554`, `host-events.mjs:137-147` | `H session/index.ts:43-74,872-889` `(session,event)`，scopeTarget，global 监听 | Base session+scope | **静态契约一致** | global 只是可见性，仍须校验 Session/Agent 归属并注销 |
| E02 | `N event-listener.mjs:525-554`、`inbound/conversation.mjs:1153-1158` | `H agent/runtime-types.ts:261-280,393` `agent/disposed({agent})`、`agent/error({agent,turn,step,error})` | Base agents | **静态契约一致** | 监听按当前实例去重；卸载时 listener 与 timer 都清理 |
| M01 | `N host/messages.mjs:105-123` 自定义 user source | `H llm/message.ts:103-147,161-164` SourceMap 可扩展、`UserMessage` 需 id/content/source | Base llm+session | **条件成立，列明条件**：内容块合法且 source 能持久化 | 保留 source.kind 与 summary 有界；未知自定义来源在消费者处需降级处理 |
| P01 | `N approval/router.mjs:537-675,707-719` `approval/request` | `H approval/types.ts:62-91` 和 `approval/index.ts:215-233,267-305` waterfall、四态返回、宿主审计 | Base approval+agents | **条件成立，列明条件**：有效 outcome、正确调用 `next()`、不篡改宿主审计 | 当前缺宿主取消联动，见 P02 |
| P02 | `N approval/router.mjs:537-675` 不传 `request.signal` | `H approval/index.ts:267-305` 对 signal race，宿主完成后晚答被丢弃 | Base approval | **源码确定冲突** | 手机 waiter/升级链/旧卡/持久 ledger 的取消、迟答和终态一致收口 |
| P03 | `N approval/router.mjs:612-636` 手机与 GUI race | `H approval/types.ts:78-91` `next()` 委托，下游 outcome 竞争 | Base approval+Web GUI（有则） | **条件成立，列明条件**：首达结果只在宿主请求有效期间提交 | `Promise.race` 不等于输家副作用清理；禁止二次批准 |
| Q01 | `N host/native-questions.mjs:168-206,256` `user-questions/request` | `H user-questions/types.ts:128-161` waterfall `questions,agent?,signal?,wait?` | Base userQuestions+Web answerer（可选） | **静态契约一致**（注册 seam） | 用 rc.5 waterfall；保留 scoped 订阅及注销 |
| Q02 | `N host/native-questions.mjs:177-199` 本地 `AbortController` | `H user-questions/index.ts:287-339` 请求 signal、exact live root；Web 客户端 `ui-user-questions/client/index.ts:208-275` claim signal | Base questions+agents | **源码确定冲突** | `request.signal` 必须进入本地 race/桥；GUI 先答、宿主取消均收尾 |
| Q03 | `N host/native-questions.mjs:88-135` 丢弃 intent/wait、失败映射空 selected | `H user-questions/types.ts:10-68,128-145`; `H user-questions/index.ts:294-316` 验证 `plan-review` intent | Base questions | **条件成立，列明条件**：旧选项卡语义适用，未丢失必须展示的 plan/detail | 避免把无答案结果伪装成正常用户已回答；保留 id/选项/必要 detail 与 timed-wait 边界 |
| Q04 | `N host/native-questions.mjs:232-246` `registerProvider` 探测 | `H user-questions/index.ts:78-87,287-339` 当前正式服务 `ask`，无该公开注册 API | Base questions | **静态契约一致**（rc.5 waterfall） | 可删除旧的 provider 探测分支，但不能删除 waterfall 能力和卸载机制 |
| F01 | `N host/messages.mjs:60-93` `saveImage/saveFile` | `H attachment/index.ts:150-228`；`H attachment-local/index.ts:217-240` | Base attachments | **条件成立，列明条件**：实际 provider 为可写且可读的 rc.5 LocalAttachmentStore | 注意抽象基类 `saveFile` 可能存在但默认拒绝；判断成功以 resolved ref 为准 |
| F02 | `N inbound/conversation.mjs:827-909` 先 admission 再 message | `H attachment/types.ts:7-46,114-126` durable image/file ref 内容块 | Base attachments+agents | **条件成立，列明条件**：真实字节入库、Agent 仍 live、ref 合法 | 下载成功≠保存成功≠Session 入队≠模型读取；取消时不承诺回滚 |
| C01 | `N client.js:1-8,1034-1088` ModuleLoader/React | `H client/modules/client/manifest.ts:348-369` factory require；`H web-app patch:227-280` | Web Client | **条件成立，列明条件**：browser graph 已提供 React、slots、connection、locale、layout | 无 Web 时不激活；模块装配/真正渲染未执行验证 |
| C02 | `N client.js:1064-1084` 四个 Slot | `H cordis-client-runner/client/slot-catalog.ts:2180,2310,2350,3695` | Web Client slot owners | **静态契约一致** | 不需要因 reasoning body / tooltip 改四个注册键 |
| R01 | `N control-surface/rpc.mjs:150-159` `connection.rpc.handle` | `H connection/rpc.ts:131-141,178-189` 4参 handler、async disposer；`H rpc-host.ts:104-110,253-276` | Web connection+webServer | **条件成立，列明条件**：调用方追踪 Context 具双依赖且 route 未占用 | 官方 seam 优先；不硬编码“rc.5 不可用” |
| R02 | `N control-surface/rpc.mjs:95-143` fallback `admit(req)` | `H rpc-host.ts:122-136`、`api-request-trust.ts:1-13` | Web connection+webServer | **条件成立，列明条件**：请求通过 Host/Origin fence 和身份认证 | `admit` ≠ 方法授权；fallback 要独立审核 Peer principal |
| R03 | `N rpc.mjs:151-154` handler 只转三参 | `H connection/rpc.ts:131-141` 第 4 参 `peer` | Web connection | **源码确定冲突**（授权传播缺口） | 业务入口完整传 Peer 并检查 owner/资源/动作；不能假借 Gateway 自动加权 |
| R04 | `N index.mjs:845-855` optional inject RPC | `H registry.ts:163-176,293-301` child fiber 依赖重装 | Web connection+webServer | **条件成立，列明条件**：旧子实例 effect 由自身释放 | 不要把老 RPC 的 dispose 留到整个根插件卸载才执行 |
| R05 | `N index.mjs:847-848` 以 `() => { disposeSurfaceRpc() }` 包装 | `H connection/rpc.ts:179-189` 返回 `() => Promise<void>` | Web connection | **源码确定冲突** | 不能吞掉异步 disposer 的 Promise；绑定实际子 Fiber 生命周期 |
| R06 | `N control-surface/service.mjs:117-259` 各 RPC 方法 | `H rpc-host.ts:304-348` handler 可取得可信 Peer；`H api-remote-access/src/index.ts:1-6` 方法级控制只由显式网关链实施 | Web connection | **源码确定冲突**（方法级授权未显式实施） | 读取、写配置、真测试、结算问题、签发管理票据分别明确授权 |
| L01 | `N index.mjs:979-982` async aggregate cleanup | `H fiber.ts:675-686,704-709` 确实等待 async disposer | Cordis | **静态契约一致**（Fiber 原语） | 聚合函数必须正确 return 清理 Promise |
| L02 | `N index.mjs:291-...` 本地资源/任务统一释放 | `H loader/config/entry.ts:135-155`、`H registry.ts:258-265` 存在 fire-and-forget dispose 路径 | Loader/Registry | **条件成立，列明条件**：实施自有 fencing、drain，不假设所有上层路径 await | 新旧实例副作用不得叠加/误接旧结果 |

### 5.1 Tool 两条注册与 `ctx.notifier` 的区别

rc.5 `H tools/index.ts:223-237,327-352,1065-1095`：

```ts
interface ToolDefinition extends ToolSchema {
  readonly output: { schema: JsonSchemaNode; render(args: unknown, value: JsonValue): ContentBlock[] }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}
register(definition: ToolDefinition): () => void
```

`N tool-register.mjs:108-120,192-202` 符合定义；`N tool-register.mjs:38-64` 的 JSON Schema 生成及 `output.render` 的形态一致。rc.5 execution 上下文是 `exec.agent?` 和 `exec.signal`，不存在公开 `exec.session`。工具调用成功的 canonical result 要经 schema 验证及渲染；方法可返回 `ok:false` 的业务结果，但不得把“调用 Promise 完成”直接作为对外渠道送达证据。[H tools API](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/tools/src/index.ts#L214-L237)

`N index.mjs:90-107` 的 `ctx.provide('notifier',facade)` 是公共服务；**不是**注册 LLM 工具。将 `connection` 从核心硬 inject 移走，**不意味着删除这一公共 API**。其消费者和服务撤销顺序要继续维护。

### 5.2 Agent/Session 的真实语义

`H agent/index.ts:562-602`：`get`、`list`、`roots` 只访问当前运行时 registry；`roots()` 以当前 owner 判定，不靠 Session 历史 parent。`H agent/runtime-types.ts:109,176-241`：状态只有 `idle|running`；`cancel({kind:'user'})` 来自 `H session/types.ts:189-197`，返回 `void`；`followup/steer/inject` 也返回 `void`，分别表示下一 turn、最近 step、下一个 pre-step（其中 inject 不唤醒）。[H Agent Runtime](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/agent/src/runtime-types.ts#L163-L241)

**关键对外术语**：消息“提交到 Agent API / 已入队”与“模型已读 / 执行成功 / 操作停止”是不同承诺。`whenIdle()` 代表整体活动收敛，不是特定投递 item 的完成证明。获取 Agent 之后可能经过网络下载等多个异步间隙，每次真正投递前应再查 registry 中是否还是那个实例。

`H session/index.ts:43-74,872-889` 定义 `session/event(session,event)` 并使用带 scope 的事件发布；`H agent/runtime-types.ts:261-280,393` 的 `agent/disposed({agent})` 和 `agent/error({agent,turn,step,error})` 与 notifier 的解包形状一致。`N host-events.mjs:137-147` 的 `{global:true}` 允许跨 agent scope 订阅但不产生操作授权；事件采样、绑定、Session 归属和生命周期注销仍由插件负责。[H Session Events](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/session/src/index.ts#L43-L74)

### 5.3 Approval：host guarantee vs plugin responsibility

`H user-approval/types.ts:62-91` 给出 `agent/toolName/callId?/reason?/displayReason?/signal?`，waterfall 返回 `allowed-once | rejected | cancelled | unavailable`。`H user-approval/index.ts:215-233` 把 ask/decided 写入 Session，要求 turn 处于开放状态；`index.ts:267-305` 对 `request.signal` 做取消 race，迟到下游 outcome 不能修改已 settle 的宿主结果。[H Approval Types](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/interaction/user-approval/src/types.ts#L62-L91) · [H Approval Service](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/interaction/user-approval/src/index.ts#L215-L233)

`N approval/router.mjs:537-675` 使用 `bus.wait` / escalation / 自有 ledger，几乎未使用 `request.signal`。宿主已返回 cancelled 后，移动端卡片和 notifier 持久待决不会自动终止；**必须把 host abort 传播到本侧等待和最终状态**，且优先关闭决定入口、再进行可能失败的 best-effort 卡片编辑。`N approval/router.mjs:612-636` 的 GUI/手机 race 只提供竞争结果，不对败方取消、副作用 drain 提供保证。宿主审计事件由宿主负责，notifier ledger 负责手机送达、远端答复身份和一次性裁决；两者不能互相冒充。[N approval](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/approval/router.mjs#L537-L675)

**三种先后次序**：

| 顺序 | rc.5 宿主已保证 | notifier 必须补齐 | 静态未知 |
|---|---|---|---|
| 手机先答 | waterfall 的合法结果可返回调用方；ApprovalService 归一并写审计 | 关闭 GUI 输家后仍可能到达的状态、远端重复答复与 ledger | GUI 视觉上是否立即移除卡片 |
| GUI 先答 | `next()` 下游 outcome 能作为 waterfall 结果 | 停止等待/升级/推卡；取消并收口移动端待决 | 浏览器实际动画、卡片残留 |
| Host 取消 | ApprovalService 对 signal 返回 `cancelled`，迟到结果无权覆盖 | `request.signal` 驱动全链终止，不留有效旧 token | 外部 HTTP 已发送的消息能否撤回 |

### 5.4 Questions：尤其不要误读 `ask()` 的取消行为

`H user-questions/types.ts:10-68,128-161` 给出 Question ID、选项 label、`multiSelect`、`detail`、可选 `intent:plan-review`、`wait:{callId,timed?}`，返回 `{answers:[{id,selected,custom?}]}`。`H user-questions/index.ts:271-339` 要求 `request.agent`（如果存在）必须是**精确 live root**，其 `ask()` 先检查 signal 并执行 waterfall，异常后再检查 aborted。

**必须特别区分 Approval 与 Questions**：在 `H user-questions/index.ts:287-339` 中，`ask()` 没有像 ApprovalService 那样显式以 `AbortSignal` race 强制结束一个永不 settle 的 answerer。它依赖被调用的 answerer/GUI 实际响应取消；不能宣称“Host 一 abort，所有 questions Promise 自动同步完成”。官方 Web answerer 则单独在 `H client/ui-user-questions/src/client/index.ts:208-275` 合并 signal、维护 timed claim 并处理委托/清理。[H UserQuestion ask](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/interaction/user-questions/src/index.ts#L271-L339) · [H Web answerer](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/ui-user-questions/src/client/index.ts#L208-L275)

`N host/native-questions.mjs:168-206` 的本地 Controller 仅在 GUI 首答后 abort，**未组合宿主 `request.signal`**，导致宿主取消时本侧 `questionBridge.askQuestions()` 可能继续等待；`hostAsk:88-135` 把错误/未回答映射为 `selected:[]` 的普通 `AskUserQuestionAnswer`，不能把这个结构简单解释成“回答真实存在”。rc.5 的 `plan-review intent` 也不只是普通选项文字：若需让手机侧承接此类题目，应保留 detail 和批准 label 的呈现语义。否则应委托下游而非静默吃掉重要上下文。[N Native Questions](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/native-questions.mjs#L88-L206)

`N native-questions.mjs:232-246` 的 `registerProvider` 是给未来/旧宿主的能力探测；rc.5 固定 `UserQuestionService` 公开的是 `ask()`/waterfall，不要求这一分支。**可以删除此分支**，但需保留 `{prepend:true,global:true}` 的必要性论证、作用域过滤、注册在有效 subCtx、以及取消/drain。

## 6. 附件：durable admission 而非“下载就等于模型读取”

`H attachment/index.ts:150-228`：`saveImage({data,mediaType,name?})`、`readImage(ref,signal?)`、`saveFile({data,name?})`、`readFileStream(ref,signal?)`。**抽象基类** `saveFile` 可以返回 `ATTACHMENT_FILES_UNSUPPORTED`；但官方 rc.5 `attachment-local` 在 `H attachment-local/index.ts:217-240` 覆盖 `saveFile` 和读取能力。`H attachment/types.ts:7-46,114-126` 定义不可变 ImageRef、FileRef 及其内容块。[H Attachment Service](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/attachment/attachment/src/index.ts#L150-L228) · [H Attachment Local](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/attachment/attachment-local/src/index.ts#L217-L240)

notifier `N inbound/conversation.mjs:827-909` 先下载有界字节、再 saveImage/saveFile、再填入 `N host/messages.mjs:105-123`：

```js
content: [
  { type: 'text', text: '...' },
  { type: 'image', attachment: imageRef },
  { type: 'file', attachment: fileRef }
]
```

形状符合 `H attachment/types.ts`，自定义 `source.kind` 依赖 `H llm/message.ts:103-164` 的可扩展来源约定；但实际模型请求转换和附件存储恢复仍有独立责任。[N Message Builder](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/messages.mjs#L105-L123)

**五级状态不得混淆**：网络下载成功 → 存储服务 resolved durable ref → ref 可被对应 provider 读取 → UserMessage 经当前 Agent 入队/Session 记录 → 模型请求真实消费。这五级不等价。取消后持久化引用可能仍存在；没有证据证明“取消即撤销远端下载/已写 blob”。同一异步间隙内 Agent 也可能 disposed，所以重新验证精确 Agent 实例是必要条件。

## 7. Native、RPC、Peer、Origin 和管理台

### 7.1 ModuleLoader 和四个 Slot

`N client.js:1-8`：

```js
window.__ModuleLoader__.load({ id: 'dsh-notifier', factory(require) { const React = require('react'); ... } })
```

对应 `H packages/client/modules/src/client/manifest.ts:348-369` 的注册协议。React 来自 **Client ModuleLoader 的模块表 `require`**，不是插件自带全局 `window.React`，也不是 Node 服务端 import。需要 Web 模式的 client graph/externals 已正确装配。[H Client manifest](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/modules/src/client/manifest.ts#L348-L369)

| N `client.js:1064-1084` | rc.5 `slot-catalog.ts` | 关系 | 判断 |
|---|---|---|---|
| `main`，`key:'dsh-notifier'` | `2180+`，keyed/root | 主面板 | **静态契约一致** |
| `sidebar.panellist`，`id:'dsh-notifier'` | `3695+`，list/root | 左导航 | **静态契约一致** |
| `plugins.bundle.config`，`key:'dsh-notifier'` | `2350+`，keyed/root | 插件详情设置 | **静态契约一致** |
| `plugins.bundle.activation`，`key:'dsh-notifier'` | `2310+`，keyed/root | 安装/启用引导 | **静态契约一致** |

[H Slot Catalog](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts#L2177-L2198) · [N slots](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/client.js#L1064-L1084)

`N client.js:1034-1042` 中客户端 `inject:['slots','connection','locale','layout']` 依赖 Web client 上的服务，不得混同为 Host root 的 `connection` 实例。rc.4/rc.5 reasoning 变更不被上述 Slot 直接使用；Tooltip 组件改动也不构成对四个 Slot 的参数更改。**视觉尺寸、CSS、页面切换、卡片是否撤回**：**证据不足，缺失 rc.5 正式 Web bundle 的实际浏览器呈现记录**，本任务没有运行。

### 7.2 `rpc.handle` 在 rc.5 的真实契约

rc.5 `H packages/client/connection/src/rpc.ts:131-141,178-189`：

```ts
type ConnectionRpcHandler = (
  endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope
) => Promise<ConnectionRpcHandlerResult>
// rpc.handle 返回 () => Promise<void>，而不是“必须同步结束”的注销器
```

`H connection/rpc-host.ts:104-110,253-276` 的 `rpc` getter 取 `this.ctx` 作为 owner，随后 `owner.effect(() => owner.webServer.register(route))`。要一起读取 `H vendor/cordis/src/utils.ts:116-124,165-196`：Cordis `getTraceable` 会针对**调用方 Context**追踪服务及其方法，不能机械认为 `this.ctx` 永远只能是最初的 Connection 服务 Context。[H Connection RPC](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/rpc.ts#L131-L141) · [H RPC Host](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/rpc-host.ts#L104-L110) · [H Cordis Traceable](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/cordis/src/utils.ts#L165-L196)

`N index.mjs:845-855` 通过 `ctx.inject(['connection','webServer'], webCtx => ...)` 将两个服务置于可用 Context 下。因此 rc.5 **官方 `rpc.handle` 的调用条件已有源码支撑**，旧 `N rpc.mjs:3-15` 中基于 0.1.7-rc.2 的“永不可用”注释，不应继续作为 rc.5 设计定论。然而，没有真正调用它，路径占用/初始化先后/具体 Context 串联仍是静态条件，不能宣布已挂载成功。

`N index.mjs:847-848` 对官方 disposer 包装成：

```js
disposers.push(() => { try { disposeSurfaceRpc() } catch {} })
```

而官方定义返回 `() => Promise<void>`；该包装丢弃 Promise，根组件 `disposeAll()` 无法真正等待 RPC 注销。**源码确定冲突**。另外此注销存进根 `disposers`，而不是直接让双依赖子 Fiber 持有所有资源，服务热替换存在旧 route 释放与新 route 注册交叠的风险。`webServer` fallback 只应是带有相同授权、取消、生命周期约束的保底，而不是因为旧版本注释继续默认选择。[N RPC registration](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/index.mjs#L840-L855)

### 7.3 重新核对 rc.5 HTTP 成功 Peer 的 principal

实际链路：

```text
BrowserAuth 验证浏览器/API 凭据
→ connection.admit(request)
→ browserPeer 或 peers.get(authenticatedPeerId).peer
→ Peer.principal
```

`H connection/rpc-host.ts:87-100,128-136,169-172`：

```ts
this.browserPeer = new Peer(ctx, { principal: { kind: 'owner' } })
// 公开 Connect 发布 API Peer 的分支：
const peer = new Peer(this.owner, { principal: { kind: 'owner' }, interactions })
```

`admit()` 对其他请求返回拒绝，对成功身份返回上述公开路径登记的 Peer。**因此 rc.5 当前公开 HTTP admission 的成功 Peer 都是 owner（在这组已核对的浏览器/API Connect 生产路径内）**。这是 rc.5 直接源码结论，非继承 rc.2/rc.3。`H connection/peer.ts:14-18,26-45` 和 `H connection/rpc-host.ts:139-142` 仍有接受其他 `Principal` 的一般 `createPeer` API；不能把“当前公开 HTTP 生产路径是 owner”扩大为“RPC 类型上永远只支持 owner”。[H admit](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/rpc-host.ts#L122-L142) · [H publishPeer](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/rpc-host.ts#L169-L172)

`H connection/api-request-trust.ts:1-13,113+` 是 Host/Origin/Fetch-Metadata fence：保护 Host authority/DNS rebinding/跨站请求，**不负责建立业务身份和方法授权**。`H connection/rpc-host.ts:304-348` 对官方 channel 调用 handler 并提供 peer，但不自动为 notifier 的 `service.call` 执行自定义资源权限检查。`H api-remote-access/src/index.ts:1-6` 的 Gateway 方法权限也不能自动罩住独立 `/dsh-notifier` 自建路由。[H Host-Origin trust](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/api-request-trust.ts#L1-L13)

当前 `N control-surface/rpc.mjs:95-143,150-159` 在 fallback `admit` 后丢掉 Peer，在官方 RPC handler 接受前 3 个参数也丢掉 Peer；`N control-surface/service.mjs:117-259` 继续只按 method/payload 执行。**源码确定冲突：方法级 Peer 授权链缺失。** 实施时应明确 owner 检查及资源权限的唯一入口，保留 Control Core 对问题作答来源、一次性结算和持久化的约束。

| 业务方法（`N service.mjs`） | 影响 | 授权边界 |
|---|---|---|
| `surface.home/surface.wait`、`channels.list/get`、`tasks.list`、`questions.list`、`activity.list` | 敏感状态/配置读取、长轮询 | 通过 admit 的 Peer；授权读、连接取消、数据脱敏 |
| `channels.save` | 配置写入 | owner + 有效渠道/操作范围 + durable 结果 |
| `channels.test` | 实际发出测试消息 | owner + 显式用户意图/额度控制，不能因“测试”越权 |
| `questions.settle` | 人类选择/宿主操作结果 | owner + Control Core 权限/待决资源归属/只结算一次 |
| `standalone.createLaunch` | 创建独立管理台访问票据 | owner + 短期一次性凭证和对应作用域 |

### 7.4 Launch Ticket / Admin Session 的宿主假设

`N control-surface/launch-ticket.mjs:5-48`：进程本地随机一次性票据，校验即消费；`N control-surface/admin-session.mjs:10-63`：另一种进程本地短期 admin token。它们不是 rc.5 Host Connection 在 `H connection/browser-auth.ts` 中生成的 browser/API cookie，也不是 Peer 身份来源。[N launch-ticket](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/launch-ticket.mjs#L5-L48) · [N admin-session](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/admin-session.mjs#L10-L63)

**静态契约一致**：rc.5 并未要求 notifier 将这两类内部票据改成宿主 cookie；同时**证据不足，缺失** standalone 浏览器打开时的安全上下文、票据交换/认证请求和恢复路线在 rc.5 Web Browser 中的完整动态行为。无需因此强制删除既有 Recovery 能力，也不得用 standalone token 绕过 Native 的 owner 授权。

## 8. 生命周期：底层可 await，不代表上层所有路径都 await

- `H vendor/cordis/src/fiber.ts:675-686` 中 `_unload()` **实际 `await runDisposable(dispose)`**；`fiber.ts:704-709` 的 `fiber.await()` 等待当下 inertia。**静态契约一致（底层）**。[H Fiber unload](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/cordis/src/fiber.ts#L675-L709)
- `H vendor/cordis/src/fiber.ts:265-296,625-675` child Fiber 的停/重新装配有 epoch 驱动，包含 async 清理；**静态契约一致（Fiber 内机制）**。[H Fiber lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/cordis/src/fiber.ts#L625-L675)
- 但 `H vendor/loader/src/config/entry.ts:135-155` 的 disabled 分支和 `H vendor/cordis/src/registry.ts:258-265` 删除 runtime 路径直接调用 `fiber.dispose()` **没有 await**；`H vendor/loader/src/config/tree.ts:35-49` 另提供 `await()` 来汇聚 pending task。不能推论所有生产路径总是完整阻塞新实例激活。[H Tree await](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/loader/src/config/tree.ts#L35-L49)
- `N src/assembly/lifecycle.mjs:14-25` 用 `Promise.allSettled` 聚合，确保返回的异步清理被等待，但**无法表达严格的先后停止顺序**；`N index.mjs:979-982` 将该聚合交给 Cordis；`N index.mjs:845-855` 的 RPC 包装没有 return Promise，破坏了这条 await 链。[N lifecycle](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/assembly/lifecycle.mjs#L1-L25)
- `N index.mjs:712-714` 已以 `ctx.inject(['userQuestions'], subCtx => nativeBridge.attach(subCtx))` 观察服务替换；但旧注册是否已通过绑定到子 Fiber 的 disposer 有序清理、本地 `nativeBridge.disposeProvider` 是否与新实例重叠，仍须按实际子 Fiber epoch/所有权设计，不可依赖旧 token 失效自动收口。

**rc.5 推荐的生命周期契约（设计边界，非补丁）**：

```text
每个能力的独立 owner / generation
→ 注册精确资源与取消入口
→ 停止接纳新请求（fence）
→ abort 当前等待/推送/长轮询
→ drain 可控 in-flight 工作
→ await 工具、事件、RPC、server 的真实 disposer Promise
→ 旧代资源全部撤权
→ 新代才能对外宣称 ready
```

这不是声称宿主提供上述完整顺序。**它是 notifier 在宿主不承诺完整强顺序时自己必须持有的保证。** 在服务替换、配置变化、HMR、根卸载四条路径上均不能复用已失效的 Context、旧 Peer 或旧 Agent 引用。中途失败应停在不可写/不可答的安全状态，不将“请求已接受”误报为“副作用全部完成”。

## 9. 仅面向 rc.5 的最小实施清单（按依赖顺序；不提供代码补丁）

| 先后 | 分组 | 受影响文件（notifier 固定主分支） | 最小调整、前置条件与不该触碰之处 |
|---|---|---|---|
| A1 | 安装激活 | `package.json` | 精确 `engines.dsh=0.2.1-rc.5`；对 `dsh-session` optional peer 作删除或 rc.5 正确声明的单独决定；保留必要 Cordis peer。 |
| A2 | 安装激活 | `scripts/verify-host-compat.mjs`、`docs/compatibility-matrix.md`、`package.json:dshWorkshop.compatibility`、相关安装文档 | 把旧“peer 是唯一来源”的门禁改为以新精确声明为主；历史认证状态从 `verified` 重写成**未运行 rc.5 的源码基线**；不要将旧 rc.1/rc.2 真机记录挪用给 rc.5。依赖 A1。 |
| A3 | 安装激活 | `src/index.mjs`、`src/plugin-entry.mjs`（仅确认导出，无需必改） | 取消核心 `connection` 硬注入，明确核心 Agent/Tools 与 Web UI/RPC 的能力切分；缺少关键核心服务时 fail-closed，缺 Web 不妨碍纯出站。依赖 A1/A2。 |
| B1 | 宿主接口 | `src/tool-register.mjs`、通知发送封装及调用侧 | `exec.agent` 为权威执行身份；处理缺 Agent 的路由边界；`exec.signal` 连通 notifier 底层发送并等待自身可控任务收敛；`notify_test` 同样受约束。依赖 A3。 |
| B2 | 宿主接口 | `src/inbound/conversation.mjs`、`src/host/messages.mjs`、`src/routing/session-registry.mjs` | `list/get/roots` 只当活 Agent；附件完成时重新验证精确 live Agent；区分 `followup/inject/steer/cancel` 接纳与最终处理；保留 durable ref 和消息 source。依赖 A3。 |
| B3 | 宿主接口 | `src/approval/router.mjs`、审批 bus/ledger/escalation 与 Control Core | 接 `request.signal`；手机/GUI/host-cancel 三向输家清理；只接受有效授权的一次最终决定，宿主审计仍由 Host 写入。依赖 A3、B2。 |
| B4 | 宿主接口 | `src/host/native-questions.mjs`、`src/questions/router.mjs`、对应等待账本 | 只用 rc.5 waterfall；组合请求 signal；保留 `wait`、`intent/detail` 适用语义；错误/取消不能冒充用户回答；可删除旧 provider 探测。依赖 B3 约定的取消/裁决原则。 |
| C1 | Native/RPC | `src/control-surface/rpc.mjs`、`src/index.mjs` | 以 rc.5 官方 `rpc.handle` 为第一候选；带双依赖 Context 注册；保留可审计 fallback 仅在需要时；官方 `() => Promise<void>` 返回值必须 await。依赖 A3。 |
| C2 | Native/RPC | `src/control-surface/service.mjs`、`src/control-surface/rpc.mjs`、Control Core 相关入口 | 可信 Peer 实际进入 service，并明确 owner principal + 方法级/资源级授权；`questions.settle` 保留既有完整安全校验；读和写分开。依赖 C1。 |
| C3 | Native/RPC | `client.js`、`package.json:dsh.client.inject` | 四个 Slot、ModuleLoader 无需因 rc.4/rc.5 reasoning 变更而重写；仅校验能力缺失/重连/fallback 状态语义，避免不必要 UI 重构。依赖 C1/C2。 |
| D1 | 生命周期 | `src/index.mjs`、`src/assembly/lifecycle.mjs`、Approval/Questions/Conversation、Native RPC/长轮询及控制面各 disposer | 给可选服务注册其自身 owner/generation；旧实例停止接纳→取消→drain→await 释放；修掉被包装吞掉的异步 disposer；拒绝假定 Loader 总按强顺序停止。依赖 B/C。 |
| D2 | 文档收口 | `docs/compatibility-matrix.md`、适用安装/排障文档 | 新版矩阵只写“源码确定/条件/证据不足”；不将既有测试或旧宿主真机记录当作本次验证。依赖以上契约完成。 |

### 9.1 可删除的旧兼容分支——有依据，但不能误删功能

| 候选 | 来源依据 | 是否可在 rc.5-only 实施中删除 | 保留什么 |
|---|---|---|---|
| `native-questions.mjs:232-246` 旧 `registerProvider` capability branch | rc.5 固定 `UserQuestionService` 无公开该方法，正式 seam 是 `user-questions/request` | **可删除旧分支** | `ctx.on` waterfall、signal、next、scope、disposer、Host 失效降级 |
| `inbound/conversation.mjs:1134-1136` “老宿主无 roots() 时全量追踪” fallback | rc.5 `AgentRegistry.roots()` 已明确导出 | **可删除旧宿主兼容 fallback** | 根 Agent 隔离、独立 Session 权限检查 |
| `tool-register.mjs:143-149` 非正式 `execContext.session` 兼容猜测 | rc.5 的 `ToolExecutionInput` 有 `agent?`，没有该字段 | **可删旧猜测**，但要定义 agent 缺失时的安全语义 | 正式 Agent 分流和显式的无 Agent 路径 |
| `control-surface/rpc.mjs:3-15` 以旧 0.1.7-rc.2 断言 `rpc.handle` 一定失败的文案/逻辑优先级 | rc.5 `getTraceable` + `rpc.handle` + 双依赖 inject 支持新评估 | **可删除旧“必失败”的判断/注释**；不能在无静态证明前无条件删除 Web fallback | 官方注册、鉴权、失效安全降级、async disposer |
| 旧 DSH peer 列表、历史机器兼容列表 | 新目标明确不维护旧宿主，且新版匹配规则使用 `engines.dsh` 优先 | **可删除旧版本作为当前支持范围的条目** | 历史发布说明、真实旧验证记录可以作为历史资料，不能冒充 rc.5 |

**不能借 rc.5-only 直接删除**：`ctx.notifier` 公共 API、出站群通知、合法的 Recovery 管理能力、数据读写与失败安全、Agent/Session 范围隔离、现有 Control Core 权限/审计、对第三方 SDK 的必要功能性降级。此任务不要求群通知删除；**出站群通知和入站群控制不是同一个功能**。旧数据缺乏可信迁移依据时允许要求用户重新配置，但不等于随意清空现有数据。

## 10. 尚不能静态确认的事项：精确证据边界

| 事项 | 已有的代码证据 | 尚缺什么；不能推出什么 |
|---|---|---|
| rc.5 npm tarball 最终依赖图 | CLI / app-boot / vendored Cordis 各源码 manifest、npm 页面 dist-tags | **缺失**按精确版本提取的 CLI tarball `package.json` 和关联包 tarball/lock 解析树；不能说 workspace 占位在最终安装中一定如何映射 |
| rc.5 新装、重装、更新的 npm peer 冲突表现 | DSH preflight 与 notifier 旧 peer 确定不匹配 | **缺失**具体 npm/pnpm 用户环境和最终解析树；不要混成“必定 npm install 失败” |
| 所有生产 Loader/HMR 路径严格新旧无重叠 | Fiber await 机制及 Loader/Registry 未 await 的路径都已查到 | **缺失**整个上层 HMR/Plugin Manager 各转换点的跨组件同步证明；现有源码足以否定“所有路径 await”的一刀切说法 |
| `rpc.handle` 实际路由可用与优先级 | rc.5 RPC `owner.effect`、Cordis traceable、notifier 双依赖 ctx | **缺失**当前目标 profile 的最终 route table/注册顺序；静态只可判断“调用契约具备，受条件约束”，不能宣布实际注册成功 |
| Native 浏览器 React 与四 Slot 的真实可视行为 | 模块格式与 Slot Catalog 签名一致 | **缺失**rc.5 浏览器模块图实际 materialization 和页面布局截图；不能承诺手机端无遮挡或卡片立即收起 |
| Host 取消原生提问是否立即结束所有 answerer | `ask()` 检查 abort，但不强制 race 永久悬置的 answerer；GUI 合成 claimSignal | **缺失**所有 answerer 的取消传播/完成证明；不能从 `signal.aborted` 推出 Promise 自动 settle |
| 附件持久恢复与模型最终读取 | rc.5 LocalStore `save/read`，notifier durable ref block | **缺失**具体存储实例、Session 恢复/模型输入转换的实际跨重启路径证据；下载/保存/入队不能直接推断模型已消费 |
| Provider 渠道外部送达 | notifier 渠道 API 与状态代码 | **缺失**外部服务响应、真实账号、设备投递证据，且本次明令不得调用 | 
| 用户既有数据能否自动转换 | notifier 自有版本/账本/配置结构 | **缺失**旧 profile 样本和字段映射的安全证明；可以按本任务约束采用重新配置，而不是设计复杂兼容层 |
| 官方 Profile 实际启用服务 | base/web/headless 源码模板和 patch | **缺失**被用户 profile patch 禁用/替换后的最终配置树；可声明标准模板能力，不能声明任意自定义 profile 都有 |

## 11. 固定 commit 证据导航（重要判断索引）

> 为减少动态 GitHub 链接的歧义，以下 URL 全部固定完整 SHA。示例片段均取自当前固定源码；不是执行输出。

### DSH 宿主

- 安装预检优先级、`includePrerelease`：[plugin-compatibility.ts:51-101](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/boot/app-boot/src/plugin-compatibility.ts#L51-L101)
- Profile 预检的 disabled / Include 行为：[compatibility-preflight.ts:63-136](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/boot/app-boot/src/compatibility-preflight.ts#L63-L136)
- 官方模板：[profile.ts:179-200](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/boot/app-boot/src/profile.ts#L179-L200)
- Base services：[base/cordis.patch.yml](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/bundle/base/cordis.patch.yml)
- Web services：[web-app/cordis.patch.yml](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/bundle/web-app/cordis.patch.yml)
- Headless mode：[headless/cordis.patch.yml](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/bundle/headless/cordis.patch.yml)
- Tool definition/Execution/Register：[tools/index.ts:214-237](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/tools/src/index.ts#L214-L237)、[tools/index.ts:327-352](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/tools/src/index.ts#L327-L352)、[tools/index.ts:1065-1095](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/tools/src/index.ts#L1065-L1095)
- Agent Registry：[agent/index.ts:562-602](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/agent/src/index.ts#L562-L602)
- Agent 行为和事件：[agent/runtime-types.ts:163-280](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/agent/src/runtime-types.ts#L163-L280)、[agent/runtime-types.ts:393](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/agent/src/runtime-types.ts#L393)
- Session 事件：[session/index.ts:43-74](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/session/src/index.ts#L43-L74)
- UserMessage Source：[llm/message.ts:103-164](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/llm/llm/src/message.ts#L103-L164)
- Approval waterfall/audit：[user-approval/types.ts:62-91](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/interaction/user-approval/src/types.ts#L62-L91)、[user-approval/index.ts:215-305](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/interaction/user-approval/src/index.ts#L215-L305)
- Questions waterfall、time/intent、signal：[user-questions/types.ts:10-68](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/interaction/user-questions/src/types.ts#L10-L68)、[user-questions/index.ts:271-339](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/interaction/user-questions/src/index.ts#L271-L339)、[ui-user-questions/client/index.ts:208-275](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/ui-user-questions/src/client/index.ts#L208-L275)
- Attachment 抽象、local 实现与 ref：[attachment/index.ts:150-228](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/attachment/attachment/src/index.ts#L150-L228)、[attachment-local/index.ts:217-240](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/attachment/attachment-local/src/index.ts#L217-L240)、[attachment/types.ts:7-46](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/attachment/attachment/src/types.ts#L7-L46)
- ModuleLoader/Slots：[client/modules/manifest.ts:348-369](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/modules/src/client/manifest.ts#L348-L369)、[cordis-client-runner/slot-catalog.ts](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts)
- RPC 与 Peer：[connection/rpc.ts:131-189](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/rpc.ts#L131-L189)、[rpc-host.ts:87-142](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/rpc-host.ts#L87-L142)、[rpc-host.ts:169-172](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/rpc-host.ts#L169-L172)、[rpc-host.ts:253-276](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/rpc-host.ts#L253-L276)、[peer.ts:14-54](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/peer.ts#L14-L54)
- Cordis caller tracing：[utils.ts:116-124,165-196](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/cordis/src/utils.ts#L165-L196)
- Origin/Host fence：[api-request-trust.ts:1-13](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/api-request-trust.ts#L1-L13)
- Fiber unload 和 Loader 路径：[fiber.ts:675-709](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/cordis/src/fiber.ts#L675-L709)、[loader/config/entry.ts:135-155](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/loader/src/config/entry.ts#L135-L155)、[registry.ts:258-265](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/cordis/src/registry.ts#L258-L265)、[loader/config/tree.ts:35-49](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/vendor/loader/src/config/tree.ts#L35-L49)

### notifier

- [package.json:1-100,131-165](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/package.json)
- [scripts/verify-host-compat.mjs:2-87](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/scripts/verify-host-compat.mjs#L2-L87)
- [src/index.mjs:62-107,682-720,840-855,979-982](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/index.mjs)
- [src/tool-register.mjs:38-84,108-172,187-230](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/tool-register.mjs)
- [src/host-events.mjs:137-147](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host-events.mjs#L137-L147)
- [src/event-listener.mjs:525-554](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/event-listener.mjs#L525-L554)
- [src/inbound/conversation.mjs:827-909,1125-1174](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/conversation.mjs)
- [src/approval/router.mjs:537-675,707-719](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/approval/router.mjs)
- [src/questions/router.mjs:975-1153,1209-1268](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/questions/router.mjs)
- [src/host/native-questions.mjs:88-206,217-265](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/native-questions.mjs)
- [src/host/messages.mjs:60-123](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/host/messages.mjs)
- [src/control-surface/rpc.mjs:95-159](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/rpc.mjs)
- [src/control-surface/service.mjs:117-259](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/service.mjs)
- [src/assembly/lifecycle.mjs:1-25](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/assembly/lifecycle.mjs)
- [client.js:1-8,1034-1088](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/client.js)

## 12. 最终判定

**当前 `main@9d69dd7` 对 rc.5 的整体验证结果：不可声明“兼容通过”。** 但 rc.5 固定源码已给出实施所需核心契约：可以在不维护 rc.3 的情况下，围绕精确版本门禁、核心服务隔离、Tool signal、Agent 运行身份、审批提问取消、Native Peer 方法授权及异步生命周期做最小改动。尤其要避免两个错误：把 DSH 预检与 npm peer 视为同一个门禁；把 Fiber 底层支持 await 当成所有 Loader 路径都已完整 drain。

本报告只建立**rc.5 实施契约**。未运行代码、测试、构建或真机；未修改任何项目内容。
