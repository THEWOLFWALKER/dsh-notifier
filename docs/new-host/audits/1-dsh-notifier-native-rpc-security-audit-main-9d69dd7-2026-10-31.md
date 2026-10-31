# dsh-notifier Native RPC 专项静态安全审查

> **审查日期：** 2026-10-31  
> **审查仓库：** `THEWOLFWALKER/dsh-notifier`  
> **固定提交：** `main@9d69dd7a8908fcfec6e20d92d56509764a8f23ec`  
> **宿主对照：** `deepseek-ai/deepseek-harness` 的 `dsh-v0.2.1-rc.2`、`dsh-v0.2.1-rc.3`  
> **方式：** 只读静态审查；阅读源码、类型、配置、发行元数据和已有测试。未运行程序、测试、探针、安装脚本或宿主；未修改仓库、profile 或远端状态；忽略 notifier dev 与重写分支。  
> **证据级别说明：** “已确认”仅表示源码控制流可静态确认，不表示已动态复现。所有风险结论均以本报告列明的成立条件为边界。

## 一、核心结论

**Native RPC 在 `connection.admit()` 成功后，没有继续执行独立的、基于 Peer 身份的业务方法级授权。** 两条 Native 注册路径均未将 Peer 交给业务层，`service.call` 内也没有 `remoteAccess.decide`、主体身份判断或资源归属策略。

但进一步核对两个固定 DSH 版本后，不能因此直接认定存在“普通已认证用户调用 owner 管理接口”的生产越权漏洞：**当前 Host 公开 HTTP 准入的成功分支生成的都是 `principal: { kind: 'owner' }` 的 Peer**，包括浏览器 Peer 与 `/connect` 发布的 API Peer。`interactions: 'none'` 仅限制交互能力，不将 API Peer 降权为只读用户。

因此，固定版本现有生产模型是：**持有 DSH Host 有效登录凭据的 HTTP 客户端，被宿主视为 Host owner；notifier 依赖这一边界提供其 Native 管理能力。** 标准 Typert Gateway 对 owner 也直接放行，因此不能仅凭跳过 `remoteAccess.decide` 宣称它绕过了本应拒绝 owner 的策略。

| 编号 | 发现 | 分类 | 当前判定 |
| --- | --- | --- | --- |
| NRP-01 | Native RPC 丢弃 Peer，业务层无独立方法级授权 | 授权架构依赖 | 代码事实确认；当前不能证明非 owner 越权 |
| NRP-02 | Native 问题结算绕过 Advanced Console 的 `ownerCount()` 前置守卫 | 授权策略不一致 | 路径差异确认；安全影响需满足特定状态条件 |
| NRP-03 | Advanced Console 对无端口 loopback Origin 的放行，与缺少 Content-Type 限制组合，形成受限同站跨端口 CSRF 条件 | 浏览器安全边界 | 条件性风险；不是任意外站可利用 |

还确认：未认证请求不能通过当前 Host `connection.admit()`；没有匿名或 localhost 自动认证例外；没有证据证明非 owner Peer 可通过这两个版本的公开 HTTP 入口进入 notifier；Native 不直接提供成员管理、配对码管理或任务 stop/pause/resume 方法；Advanced Console 的 ticket 不直接泄漏长期管理员 token；渠道投影不会直接返回已配置的明文 secret。

## 二、固定版本及证据范围

### 2.1 notifier

固定提交的 `package.json` 指明版本 `0.13.1`，Host 入口 `src/plugin-entry.mjs`，Native Client `client.js`，Node 运行要求 `>=22`。`src/plugin-entry.mjs` 转出 `src/index.mjs` 的 `name`、`inject`、`apply`。

- [notifier `package.json` L1–99](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/package.json#L1-L99)
- [notifier `src/plugin-entry.mjs`](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/plugin-entry.mjs)

### 2.2 宿主固定版本

| Tag | Commit |
| --- | --- |
| `dsh-v0.2.1-rc.2` | `687f282e8625c6b8d11ff58211a90524be2e4317` |
| `dsh-v0.2.1-rc.3` | `1f81c047fc48fa190a683e469daa699857e9afe8` |

已逐文件比较两版本下列文件的 Git Blob SHA，结果相同：

- `packages/client/connection/src/rpc-host.ts`
- `packages/client/connection/src/browser-auth.ts`
- `packages/client/connection/src/api-request-trust.ts`
- `packages/client/connection/src/index.ts`
- `packages/api/gateway/src/index.ts`
- `packages/api/remote-access/src/index.ts`
- `packages/host/webserver/src/index.ts`

因此，针对以上实现的源码结论可同时应用于两个固定版本。没有将其他文件未经验证地概括为完全相同。

## 三、Native RPC 所有注册路径

### 3.1 生产装配

`src/index.mjs:770–859`：

```text
plugin apply()
  → createControlSurfaceService(...)
  → ctx.inject(['connection', 'webServer'], ...)
  → mountSurfaceRpc(webCtx)
  → registerControlSurfaceRpc(webCtx, surfaceService)
```

Native 装配需要同时具备 `connection` 和 `webServer`，不受 `admin.enabled` 控制。关闭独立 Advanced Console 并不禁止 Native 入站或出站配置写入。

- [notifier `src/index.mjs` L770–859](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/index.mjs#L770-L859)

### 3.2 注册路径矩阵

| 注册入口 | 实际注册情况 | 选择条件 | Peer 是否传入业务层 | 独立业务授权 |
| --- | --- | --- | --- | --- |
| `connection.rpc.handle('/dsh-notifier', handler)` | 优先尝试 | 宿主提供方法且注册成功返回 disposer | 否 | 无 |
| `webServer.register({kind:'prefix', path:'/dsh-notifier'})` | 回退路径 | 前一接缝抛错或未返回 disposer | 否 | 无 |
| `connection.rpc.intercept('/api', ...)` | notifier 不注册 | 不适用 | 不适用 | 标准 Gateway 独立管理 |
| `connection.fetch.register(...)` | notifier 不注册 | 不适用 | 不适用 | 不适用 |
| Advanced Console HTTP | 独立注册，不是 Native RPC | `admin.enabled===true` | 不使用 DSH Peer | Bearer / 独立 session cookie |

`registerControlSurfaceRpc` 在 `rpc.handle()` 成功并返回函数时立即返回；只有失败才尝试 `mountOnWebServer`。二者**不是有意同时工作的双入口**。

- [notifier `src/control-surface/rpc.mjs` L95–159](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/rpc.mjs#L95-L159)

### 3.3 为什么 webServer 回退是有依据的预期路径

固定 DSH 宿主的 `HostConnectionService.rpc` getter 将注册上下文固定为 `this.ctx`，其 `register()` 最终访问 `owner.webServer.register(route)`；而 Connection 插件的静态 `inject` 只包含 `credentials`，`webServer` 由可选注入回调使用。调用方在自己的上下文取得 `webServer` 并不自动使 Connection 内部 owner 上下文获得该访问权限。notifier 注释与已有回归测试均记录过 `cannot get property "webServer" without inject`。

据此，**回退为固定版本源码下的合理预期**；但本次没有在 rc.2、rc.3 动态执行，不能伪称两版本均经过运行复现。Peer 丢失的结论与具体哪条注册路径成功无关。

- [DSH `rpc-host.ts` L104–111](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/rpc-host.ts#L104-L111)
- [DSH `rpc-host.ts` L253–277](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/rpc-host.ts#L253-L277)
- [DSH `connection/index.ts` L92–165](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/index.ts#L92-L165)
- [notifier `test/control-surface-rpc-v012.test.mjs` L47–89](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/test/control-surface-rpc-v012.test.mjs#L47-L89)

### 3.4 两条路径的检查差异

| 检查项 | Host `rpc.handle` | notifier `webServer` 回退 |
| --- | --- | --- |
| `connection.admit` | 是 | 是 |
| POST | 是 | 是 |
| JSON Content-Type | 是 | 是 |
| 路径 endpoint 与信封 method 一致 | 是 | 是 |
| 请求 envelope | `clientRequestSchema` | 简化 `isRequestEnvelope` |
| 传输层最大 body | Host bridge 规则 | notifier 自定 1 MB |
| 向注册 handler 传 Peer | 是，第 4 参数 | 未传给 `service.call` |
| notifier handler 向业务传 Peer | 否 | 否 |

回退的 envelope 检查较宿主 schema 简化，但没有证据证明由此可以绕过 Host 准入认证。

- [DSH `rpc-host.ts` L304–348](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/rpc-host.ts#L304-L348)
- [notifier `rpc.mjs` L52–159](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/rpc.mjs#L52-L159)

## 四、DSH `connection.admit()` 全部成功分支

### 4.1 请求准入

```text
connection.admit(request)
  ├─ !isTrusted(request)              → 403
  ├─ connection disposed              → 401
  ├─ browserAuth.isAuthenticated(req) → browserPeer
  └─ browserAuth.authenticateApi(req)
       ├─ peer ID 存在于 peers map    → 对应 API Peer
       └─ 不存在                      → 401
```

**没有匿名成功分支，没有 localhost 免身份认证分支。** Loopback 只影响来源可信性检查，不替代 cookie 认证。

- [DSH `rpc-host.ts` L122–173](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/rpc-host.ts#L122-L173)

### 4.2 Browser Peer

宿主创建：

```ts
this.browserPeer = new Peer(ctx, { principal: { kind: 'owner' } })
```

该 Peer 属于 Host owner，而非 Telegram / QQ / Feishu 等 IM 通道身份记录中的 owner。这两个身份系统不可混淆。

### 4.3 API Peer 与 `/connect`

```text
GET /connect?token=<Host process token>
  → 验证 method、authority、process token
  → publishPeer(interactions)
  → 建立 owner principal 的 API Peer
  → 签发 API cookie
  → 后续 admit() 依据 cookie 的 Peer ID 找回注册表 Peer
```

`publishPeer` 也固定创建 `{ principal: { kind: 'owner' } }`。`interactions:'none'` 与 `interactions:'answer'` 都不会改变 owner 身份；前者不是只读/低权限身份。

- [DSH `browser-auth.ts` L307–382](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/browser-auth.ts#L307-L382)
- [DSH `rpc-host.ts` L169–188](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/rpc-host.ts#L169-L188)

### 4.4 凭据与限制来源

| 凭据 | 来源 | 能否直接通过 Native `admit` |
| --- | --- | --- |
| Host process launch token | Host 进程启动认证入口 | 否；需要先完成索引或 `/connect` 认证流程 |
| Host 浏览器签名 cookie | BrowserAuth 登录流程 | 是，映射 browserPeer |
| Host API 签名 cookie | `/connect` + `publishPeer` | 是，仅当 Peer ID 仍存在于注册表 |
| 任意 `Authorization: Bearer` 头 | 通用 HTTP 请求 | 当前 `admit` 不以此直接生成 Peer |

BrowserAuth 的校验包括签名、authority、版本、签发时间、有效期；API cookie 还依赖已发布的活动 Peer。HTTP 层没有因本地地址自动降权或授权。

### 4.5 其他 Peer 类型

宿主暴露 `createPeer({principal, interactions})`，类型体系支持非 owner Peer；但这种内部创建路径不会自动使它进入 `admit` 查找的 API HTTP Peer Map。当前公开 HTTP 发布路径 `publishPeer` 创建的仍为 owner。因此：**“DSH 支持非 owner Peer”不能推导出“当前 Native HTTP 可被非 owner Peer 调用”。**

- [DSH `peer.ts` L13–51](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/peer.ts#L13-L51)

## 五、Peer 身份到业务副作用的传递链

### 5.1 webServer 回退

```text
HTTP POST /dsh-notifier/channels.save
 → webServer prefix route
 → connection.admit(req)
 → { peer: HostOwnerPeer }
 → 仅检查 admission.rejection
 → 丢弃 admission.peer
 → 路径 / Content-Type / envelope 校验
 → service.call(endpoint, message.payload, abort.signal)
 → outboundConfig.save 或 saveInbound
 → Store 持久化 / 运行时配置更新
```

`rpc.mjs:106` 获得 admission，`rpc.mjs:132` 调用 `service.call`，未传 `admission.peer`。

### 5.2 官方 `rpc.handle` 路径

Host `ConnectionRpcHandler` 声明 4 参数 `(endpoint, payload, signal, peer)`，但 notifier 的包装器只有 `(endpoint, payload, signal) => service.call(endpoint,payload,signal)`。即使未来官方接缝可用，Peer 仍丢失。

- [DSH `rpc.ts` L132–141](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/rpc.ts#L132-L141)
- [notifier `rpc.mjs` L150–158](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/rpc.mjs#L150-L158)

### 5.3 `service.call`

`createControlSurfaceService` 只接收 `(method, payload={}, signal)`。它实施方法白名单、输入校验、状态机和存储检查，但没有 Peer/principal、`remoteAccess.decide`、每方法角色授权或调用者资源归属检查。

需区分：非法字段拒绝属于**输入校验**；未落盘时不报成功属于**持久化完整性**；过期问题不重复结算属于**状态机约束**；“该调用者是否有权执行该方法”才是**授权**。前三者不能代替第四者。

- [notifier `service.mjs` L99–259](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/service.mjs#L99-L259)

## 六、Native Endpoint 授权矩阵（全集）

Native 总计 **11 个方法**，HTTP 路径均为 `POST /dsh-notifier/<method>`。“Owner*”特指固定版本成功 HTTP 准入的 Browser Peer/API Peer，均为 Host owner，不代表任意已认证的非 owner 身份。

| Endpoint | 类别 | 可达 Peer | 独立 Peer 授权 | 最终函数与副作用 |
| --- | --- | --- | --- | --- |
| `surface.home` | 综合查询 | Owner* | 无 | 聚合 channels/tasks/questions/activity 状态；只读 |
| `surface.wait` | 状态订阅 | Owner* | 无 | `revision.wait`，无持久化写入 |
| `channels.list` | 读取配置 | Owner* | 无 | `channels.list`，所有可展示渠道投影 |
| `channels.get` | 读取配置 | Owner* | 无 | `channels.get(type)`，单渠道投影 |
| `channels.save` | **保存/清除凭据** | Owner* | 无 | `outboundConfig.save` / `saveInbound`，持久化并可能热更新 |
| `channels.test` | **外部发送** | Owner* | 无 | `runChannelTest`，真实向 provider 发测试消息；更新健康与活动记录 |
| `tasks.list` | 任务查询 | Owner* | 无 | `tasks.list`，只读任务投影 |
| `questions.list` | 问题查询 | Owner* | 无 | `questions.list`，读取问题与选项 |
| `questions.settle` | **问答结算** | Owner* | 无 Peer 授权；有 Control Core 来源与策略约束 | `questions.adminSettle` → Control Core → ledger/bus |
| `activity.list` | 活动查询 | Owner* | 无 | `activity.list`，只读活动记录 |
| `standalone.createLaunch` | **权限转换** | Owner* | 无 | `launchTickets.mint`，返回可兑换 Console session 的短期 ticket |

**未注册 Native 方法：** `channels.delete`、`members.*`、`pairing.*`、`bindings.*`、`sessions.patch`、`tasks.stop`、`tasks.pause`、`tasks.resume`、`approvals.settle`。然而 `standalone.createLaunch` 可间接进入包含更多写操作的 Advanced Console，不能仅据 Native 方法表低估其整体权限范围。

## 七、各类最终服务与业务副作用

### 7.1 读取渠道配置与 secret

```text
channels.list/get
 → createChannelProjection
 → outboundConfig.raw / describe + inboundConfig.rows
 → fieldViews / editableValues
 → Native response
```

`editableValues` 只收集 `isPublicExposure` 判为公共的字段。对于秘密字段主要暴露 configured/secret/required 等元数据，不回显明文 secret。在已检查投影路径下，“渠道列表直接返回已配置明文 token”的疑点**可静态关闭**；但输出脱敏并不等于调用者授权。

- [notifier `channels.mjs` L17–104](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/channels.mjs#L17-L104)

### 7.2 出站渠道配置写入、清除、热更新

```text
channels.save(direction=outbound)
 → outboundConfig.save(type,patch)
 → splitSecretPatch → validatePatch → resolveCandidate
 → setDurable(canonicalKey,nextCanonical)
 → source.replace(type,resolved)
 → revision.touch + activity.record
```

已查得渠道/字段白名单、保留键过滤、输入量限制、secret 清除语义、配置解析、持久化结果检查、热更新失败与保存失败分离。**没有基于 Peer 的具体渠道资源归属检查。** 这些是 Host 全局配置资源，当前 Host owner 的访问与产品 owner 模型一致。

返回 `configRevision`，但 Native 写请求不要求 `expectedRevision`；具 owner 凭据的多管理者对同一配置写入会形成并发一致性边界。此事实不等于越权。

- [notifier `outbound-config.mjs` L95–126](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/outbound-config.mjs#L95-L126)
- [notifier `outbound-config.mjs` L218–299](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/outbound-config.mjs#L218-L299)

### 7.3 入站渠道凭据写入

```text
channels.save(direction=inbound)
 → saveInbound
 → surfaceAdminApi.putInboundChannel
 → inboundConfigPort.put
 → splitSecretPatch / 字段白名单 / 危险键过滤
 → setDurable(`${normalized}:account`,next)
 → version++
```

`admin.enabled=false` 时 `surfaceAdminApi` 仍有入站写入基础实现，不构成关闭 Native 写权限的开关。该路径有字段和持久化检查，但无调用 Peer 身份判断。

- [notifier `index.mjs` L233–252](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/index.mjs#L233-L252)
- [notifier `inbound/channel-config.mjs` L116–205](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/channel-config.mjs#L116-L205)

### 7.4 测试发送

```text
channels.test → outboundConfig.raw(type)
 → runChannelTest({type,rawConfig})
 → ADAPTERS[type].resolve(...)
 → ADAPTERS[type].send(...)
 → health.recordTest / revision.touch / activity.record
```

`channels.test` 是真实外部发送，不是只读健康检查。要求渠道合法、已配置并能解析；Native 不提供任意外部目标参数。其权限依旧依赖 Host owner 准入。

- [notifier `health.mjs` L22–49](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/health.mjs#L22-L49)

## 八、问答结算：Host 调用者与 IM 来源的区别

### 8.1 生产路径

```text
POST /dsh-notifier/questions.settle
 → connection.admit → Host Owner Peer → 丢弃 Peer
 → surfaceService.call('questions.settle',payload)
 → createQuestionProjection.settle
 → questionsBridge.adminSettle
 → 解析 question ref → 读取真实待决 ledger
 → 校验 action/options → 从 pushedTo 选择现有目标
 → 生成 trusted:true 内部事件
 → Control Core handle
 → paired(identity,event)
 → source / policy / question-specific authorize
 → Session Arbiter
 → ledger.resolve / bus.settle
```

该路径**未绕过 Control Core**：只有真实待决问题和合法选项才能继续；原始发送目标、渠道、账号、聊天、用户仍受到来源约束；过期和已决问题不能无条件重复结算。

- [notifier `questions/router.mjs` L238–279](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/questions/router.mjs#L238-L279)
- [notifier `questions/router.mjs` L716–798](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/questions/router.mjs#L716-L798)
- [notifier `control/entry.mjs` L136–289](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control/entry.mjs#L136-L289)

### 8.2 两类主体不能混淆

- **主体 A：** 发起 Native RPC 的 DSH Host Peer。
- **主体 B：** 问题原本推送目标中的 IM 用户。

Native 只凭上游准入授权主体 A；`adminSettle` 依据 `pushedTo` 构造主体 B 的可信来源事件并交给 Control Core。它证明**已有问题来源是否可以结算**，不证明**当前 HTTP 调用者的 IM 身份等于来源用户**。

在 Host owner 管理员代答模式下，这可以是有意设计，不应将其武断判定为身份冒充漏洞。

### 8.3 NRP-02：Console 额外的 `ownerCount()` 守卫

`src/admin/api.mjs:1346–1364` 的 `settleQuestion()` 在调用桥前要求身份层存在且 `identity.ownerCount()>=1`；不满足时返回 501/403。

Native 没有经过该 API，而是直接调用 `questionsBridge.adminSettle`。所以：

| 条件 | Advanced Console | Native |
| --- | --- | --- |
| 无 question bridge | 拒绝 | 拒绝 |
| 无 Control Core | 拒绝 | 拒绝 |
| 未知问题/非法选项 | 拒绝 | 拒绝 |
| 问题已处理 | 拒绝 | 拒绝 |
| `ownerCount()==0` | 前置拒绝 | **未做相同前置拒绝** |
| 真实来源与 Control Core 检查 | 执行 | 执行 |

成员管理 API 对最后一个 owner 的删除或降级有限制（`admin/api.mjs:1146–1205`），但底层身份操作本身没有在所有调用层重复这一策略（`identity.mjs:382–404`）。仍需区分正常管理流程与旧状态/其他内部调用产生的不一致状态。

**成立条件：** owner 数为 0，仍存在可被 Control Core 接受的成员及待决问题来源，且调用者持有 Host owner 凭据。此时 Native 缺少 Console 的同一拒绝条件。现有静态材料证明策略差异，但不证明非 owner 网络用户可以越权结算。

此外，Console 的 `settleQuestion()` 包含对应管理员审计；Native 走 Control Surface activity，没有通过相同的 `auditGuard('settleQuestion',...)`。这也是审计路径差异。

- [notifier `admin/api.mjs` L1346–1399](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/admin/api.mjs#L1346-L1399)
- [notifier `admin/api.mjs` L1146–1205](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/admin/api.mjs#L1146-L1205)
- [notifier `inbound/identity.mjs` L382–404](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound/identity.mjs#L382-L404)

## 九、与 DSH 标准 Gateway / Remote Access 对照

```text
标准 /api/<remote method>
 → Connection admission → Peer
 → Typert 参数/资源校验
 → principal.kind === 'owner' ? allow
 : remoteAccess.decide({principal, action, resources, args})
 → 方法执行 / 拒绝
```

标准 Gateway 对非 owner 调用执行 `callResources`、`remoteAccess.decide`，缺乏 resource binding、资源非法、策略失败时拒绝；其授权发生在真正执行业务方法之前。notifier 自建 `/dsh-notifier` 不通过这套 Gateway，因此**不会自动获得这些 method/resource 检查**。

但标准 Gateway 对 `owner` 也直接放行。因此，只能说 notifier **缺失了标准 API 在非 owner 情况下的防护设计**，不能在当前 owner-only HTTP 准入条件下说它越过了本应对 owner 生效的拒绝。

- [DSH `gateway/index.ts` L781–807](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/gateway/src/index.ts#L781-L807)
- [DSH `remote-access/index.ts` L183–221](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/remote-access/src/index.ts#L183-L221)

## 十、Advanced Console 完整 HTTP endpoint 矩阵

独立 HTTP 服务只在 `admin.enabled===true` 时启动，生产装配强制绑定 `127.0.0.1`。它不是 Native RPC，而是通过独立 Bearer / 管理员短 cookie 认证。不过 Native 的 `standalone.createLaunch` 可间接进入，因此应计入权限转换链。除公开的 `POST /api/auth/exchange-ticket` 以 ticket 认证外，下表 `/api/*` 都经过 Origin/Host 请求闸和 Bearer 或短 session cookie 验证。

| HTTP Endpoint | 最终服务方法 | 操作类别和副作用 |
| --- | --- | --- |
| `GET /` | UI handler | 静态页面；无需登录但过来源闸 |
| `POST /api/auth/exchange-ticket` | `verifyLaunchTicket` → `createSession` | 消耗票据；签发管理员 session cookie |
| `GET /api/overview` | `overview` | 综合状态查询 |
| `GET /api/bindings` | `getBindings` | 读取路由绑定 |
| `PUT /api/bindings` | `putBindings` | 更新 Agent 绑定、通道默认路由 |
| `GET /api/sessions` | `getSessions` | 会话查询 |
| `PATCH /api/sessions/:id` | `patchSession` | 修改指定会话出站渠道与静默配置 |
| `PATCH /api/sessions/:id/control` | `patchSessionControl` | 修改会话 mode、owner、审批成员等策略 |
| `GET /api/channels` | `getChannels` | 读取渠道配置，秘密字段脱敏 |
| `PUT /api/channels/:type` | `putChannel` | 写入旧通道配置键域 |
| `POST /api/channels/:type/test` | `testChannel` | 实际发测试消息 |
| `PUT /api/channels/outbound/:type` | `putOutboundChannel` | 保存出站配置，可能热生效 |
| `DELETE /api/channels/outbound/:type` | `deleteOutboundChannel` | 删除出站配置 |
| `POST /api/channels/outbound/:type/test` | `testOutboundChannel` | 实际发测试消息 |
| `PUT /api/channels/inbound/:type` | `putInboundChannel` | 保存入站凭据 |
| `DELETE /api/channels/inbound/:type` | `deleteInboundChannel` | 删除入站凭据 |
| `POST /api/scan/:channel` | `scanChannel` | 启动/推进扫码，可能持久化新凭据 |
| `GET /api/members` | `getMembers` | 成员、待确认身份、配对码摘要查询 |
| `PUT /api/members/:key` | `putMember` | 修改成员标签/角色 |
| `DELETE /api/members/:key` | `deleteMember` | 删除成员绑定 |
| `POST /api/members/:key/confirm` | `confirmPendingMember` | 待确认身份转正 |
| `POST /api/members/:key/dismiss` | `dismissPendingMember` | 清除待确认身份 |
| `POST /api/pairing` | `mintPairingCode` | 铸造配对码 |
| `DELETE /api/pairing/:id` | `revokePairingCode` | 撤销配对码 |
| `GET /api/audit` | `getAudit` | 审计日志查询 |
| `GET /api/questions` | `getPendingQuestions` | 待决问题查询 |
| `POST /api/questions/:ref/settle` | `settleQuestion` | 通过额外 ownerCount 守卫与 Control Core 结算 |
| `GET /api/tasks` | `getTasks` | 任务状态查询 |
| `GET /api/host` | `getHostCapabilities` | 宿主能力查询 |
| `GET /api/events` | SSE event hub | 事件流读取 |

**成员/配对：** 末位 owner 不可通过常规管理 API 删除或降级；`confirmPendingMember`/`dismissPendingMember` 使用身份层；配对码由独立状态机管理。没有每个管理员仅能修改自己创建的成员的资源归属策略，符合全权管理员 Console 模型。

**路由/会话：** `putBindings()` 更新路由；`patchSession()` 调用 `router.setSessionOutbound`；`patchSessionControl()` 调用 `router.setSessionControl`，明确拒绝 `channel/accountId/userId/chatId/sessionId/policyVersion/expiresAt/revoked` 等来源字段，防止管理台策略字段直接伪造会话来源。

**任务控制：** 已登记 HTTP endpoint 里没有直接执行 stop/pause/resume 的方法。任务查询、会话路由修改和问题结算不可混称为 Agent 停止 API。

- [notifier `admin/server.mjs` L133–192](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/admin/server.mjs#L133-L192)
- [notifier `admin/api.mjs` L595–735](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/admin/api.mjs#L595-L735)
- [notifier `admin/api.mjs` L795–945](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/admin/api.mjs#L795-L945)
- [notifier `admin/api.mjs` L1109–1289](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/admin/api.mjs#L1109-L1289)

## 十一、浏览器请求：Origin / CSRF / CORS / Content-Type

### 11.1 Native RPC 继承 Host 的请求来源检查

Native 回退路由的 `connection.admit(req)` 进入 `isTrustedApiRequest`。固定宿主会检查：Host 是否为允许的 loopback、绑定地址或受信 authority；拒绝 `Sec-Fetch-Site: cross-site`；Origin 存在时要求与 Host authority 一致；不允许不可信 Host；本地地址不绕过 cookie 认证。

Native 路由还要求 POST、`application/json` Content-Type、路径与 envelope method 一致、正文 ≤1MB。当前静态证据不能建立普通外站通过浏览器 cookie 发起 Native CSRF 的生产链。

- [DSH `api-request-trust.ts` L121–176](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/api-request-trust.ts#L121-L176)
- [notifier `rpc.mjs` L95–132](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/rpc.mjs#L95-L132)

### 11.2 Advanced Console 请求闸

独立 Console 要求有效 Bearer 或 `HttpOnly; SameSite=Strict` 短会话 cookie，并检查 Origin（存在时）与 Host 白名单；精确匹配路由方法和 1 MB body 上限。未见它给任意跨域来源提供开放 CORS 授权。不能仅凭使用 cookie 就断言普通外站 CSRF 可成功。

### 11.3 NRP-03：受限同站跨端口风险

Loopback 绑定时的 Origin 白名单包含 `http://127.0.0.1`、`http://localhost` 等**无端口**值，而真实管理台通常监听如 `127.0.0.1:8104`。同时 `readBody()` 会直接 `JSON.parse`，**不校验 Content-Type 必须为 application/json**。

静态上存在以下条件组合：

1. Console 运行于 `127.0.0.1:<管理端口>`，用户有尚未过期的管理员 cookie。
2. 另一个主体能够控制浏览器中被白名单接受的同站、不同端口的 loopback 页面（如 `http://127.0.0.1` 默认端口）。
3. 页面发出浏览器允许的简单表单请求，且正文恰可被目标 JSON 解析器解释为有效对象。
4. 该请求命中接受相应字段的有副作用方法。

浏览器 Cookie SameSite 不按端口隔离；Origin 白名单又允许该无端口来源；服务器不要求 JSON media type。CORS 不能防止普通表单产生服务器端副作用（它主要限制跨源响应读取）。

**限制：** 这不是“任意互联网恶意站点可以操作管理台”。需要攻击者控制受害设备上特定可接受的 loopback 页面来源或等价局部条件；也不证明可绕过 Host Native RPC 的来源闸。

- [notifier `admin/server.mjs` L86–131](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/admin/server.mjs#L86-L131)
- [notifier `admin/server.mjs` L224–298](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/admin/server.mjs#L224-L298)

## 十二、Launch Ticket → Admin Session → Advanced Console

### 12.1 权限转换链

```text
DSH Native Client（Host owner）
 → standalone.createLaunch
 → surfaceService 检查 adminListenInfo
 → launchTickets.mint()
 → 返回 http://127.0.0.1:<port>/#ticket=...
 → 浏览器读取 fragment 并清除地址栏
 → POST /api/auth/exchange-ticket
 → launchTickets.consume(ticket)
 → adminSessions.mint()
 → Set-Cookie: dsh_notifier_session=...
 → Advanced Console 全权管理接口
```

`launch-ticket.mjs` 使用随机秘密与摘要存储；默认 60 秒、容量有限、单次使用，消费后删除。`admin-session.mjs` 使用独立随机 session、摘要存储，默认有效期 5 分钟，支持撤销和生命周期清理。

**未发现长期管理员 Bearer token 被此链直接泄露。** Native 返回一次性 ticket；兑换返回独立短期 session cookie，并非长期 `admin.token`。浏览器会先清除 fragment。

**能力范围确实扩大：** Native 直接只有 11 个方法；Console 还提供成员角色、配对、路由绑定、会话策略、配置删除、扫码和审计。当前 Host HTTP 调用者本来就是 Host owner，故该转换应被描述为 owner 到独立管理员会话的能力转换，而不是已证实的低权限用户提权。若未来允许非 owner 使用 Native，必须重新评估此入口。

- [notifier `service.mjs` L242–249](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/service.mjs#L242-L249)
- [notifier `launch-ticket.mjs` L1–47](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/launch-ticket.mjs#L1-L47)
- [notifier `admin-session.mjs` L10–61](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/control-surface/admin-session.mjs#L10-L61)
- [notifier `admin/server.mjs` L134–156](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/admin/server.mjs#L134-L156)
- [notifier `admin/ui/client.mjs` L234–268](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/admin/ui/client.mjs#L234-L268)

## 十三、疑点关闭矩阵

| 疑点 | 静态结论 | 状态 |
| --- | --- | --- |
| Native 回退路径是否缺失认证 | 使用 `connection.admit` | 可静态关闭 |
| localhost 是否自动匿名放行 | Host 没有此成功分支 | 可静态关闭 |
| API Peer 是否天然低权限 | 当前 HTTP 发布 API Peer 为 owner | 可静态关闭这一假设 |
| `interactions:none` 是否只读 | 不改变 owner principal | 可静态关闭这一假设 |
| Native 是否传递 Peer | 两条注册路径均未传入 `service.call` | 已确认缺失 |
| Native 是否应用 `remoteAccess.decide` | 自建路径不通过 Gateway | 已确认缺失 |
| 是否已构成非 owner 越权 | 未证明非 owner 可到达当前 HTTP 入口 | 不能成立为已证实缺陷 |
| 渠道列表是否直接泄露已存明文 secret | 投影只返回公共字段值 | 已检查路径可静态关闭 |
| `channels.save` 是否实际写全局配置 | 是，持久化并可能热更新 | 已确认 |
| Native 是否直接删除整个渠道配置 | 无直接 delete endpoint | 可静态关闭 |
| Native 是否直接管理成员/配对 | 无直接 endpoint | 可静态关闭 |
| Native 是否能间接进入成员管理 | 可通过 Console launch | 已确认 |
| 问题结算是否绕开 Control Core | 未绕开 | 可静态关闭 |
| 问题结算是否验证 Host Peer 的 IM 身份 | 没有，采用管理员代答语义 | 已确认产品策略 |
| Native 与 Console 的结算守卫是否完全相同 | 不同，Native 无 `ownerCount` 前置门槛 | 已确认 |
| Launch Ticket 是否可重放 | 单次消费后失效 | 可静态关闭 |
| Native 是否直接返回长期管理员 token | 未发现 | 可静态关闭 |
| Native 是否存在普通外站 CSRF | 固定 Host 来源检查阻断所检查条件 | 已检查条件可关闭 |
| Standalone 是否存在同站跨端口 CSRF 条件 | 有受限条件 | 已确认条件性风险 |
| Native 写入是否要求 expected revision | 未见请求级版本匹配 | 已确认并发设计缺口，非越权 |

### 尚需材料才能完全关闭

**A. `rpc.handle` 在 rc.2 / rc.3 的运行时实际注册结果。** 源码与历史回归记录足以支持回退预期，但要宣称两个版本“运行时一定失败”，需进一步确认对应 Cordis Context 服务访问细节；本次未运行宿主。不影响 Peer 丢失结论。

**B. `ownerCount()==0` 的所有可达生产状态。** 需覆盖底层身份写入口、旧状态加载、迁移异常状态及非管理台调用者。已确认两入口守卫不同，尚不能断言正常生产状态一定可利用。

**C. 未来非 owner Peer 接入。** 两固定版本公开 HTTP 成功 Peer 都为 owner。若宿主或 notifier 未来增加局部权限调用者，现有授权结论不自动延续。

## 十四、已有测试覆盖与缺口

> 下列只表示**仓库内已有测试源码位置**，本次未运行，不能报告“本次通过”。

### 14.1 notifier

| 文件 | 行号 | 所覆盖的现有场景 |
| --- | --- | --- |
| `test/control-surface-rpc-v012.test.mjs` | 47–74 | `rpc.handle` 失败后回退 |
| 同上 | 76–89 | `rpc.handle` 可用时优先使用 |
| 同上 | 91–120 | admission 拒绝、路径、Content-Type、信封 |
| 同上 | 122–147 | 内部错误脱敏 |
| `test/control-surface-service-v012.test.mjs` | 10–49 | Native 问答服务委托 |
| 同上 | 113–144 | 入站保存失败、等待容量 |
| 同上 | 145–174 | Native 投影不回显 secret |
| `test/launch-ticket-v012.test.mjs` | 5–28 | ticket 单次消费、过期、容量 |
| `test/admin-server.test.mjs` | 159–191 | ticket 兑换、cookie、Bearer |
| 同上 | 244–274 | 缺失/错误认证 |
| `test/admin-origin.test.mjs` | 73–145 | Origin/Host 白名单 |
| `test/admin-questions.test.mjs` | 131–139 | 管理台正常结算 |
| 同上 | 247–275 | 缺依赖、无 owner 拒绝 |
| `test/questions-admin-settlement.test.mjs` | 68–158 | 正常、重复、驳回、非法选项 |
| `test/control-entry.integration.test.mjs` | 218–287 | owner 来源、账号和渠道绑定 |
| `test/security-structure.test.mjs` | 88–128 | 配置与会话敏感字段脱敏 |

### 14.2 DSH 宿主

| 文件 | 行号 | 已有测试主题 |
| --- | --- | --- |
| `packages/client/connection/tests/node-half.host.spec.ts` | 569 | 已认证浏览器 Peer 为 owner 并传入通用 RPC |
| 同上 | 687–854 | API Operator、交互模式、生命周期 |
| `packages/client/connection/tests/browser-auth.host.spec.ts` | 95–161 | API 凭据签名、篡改、authority、过期 |
| `packages/client/connection/tests/api-request-trust.host.spec.ts` | 10–162 | Host、Origin、跨站来源 |
| `packages/api/gateway/tests/gateway-access.host.spec.ts` | 254–387 | owner / 非 owner、方法和资源授权 |
| `packages/api/remote-access/tests/remote-access.host.spec.ts` | 202–335 | policy、resource、binding |

### 14.3 未见直接覆盖的组合

- 非 owner Peer 被人工交入 notifier 的 RPC handler 后是否还能调用写方法；现有 notifier RPC 测试主要使用 `{ peer: {} }` 模拟准入结果，未模拟真实 principal。
- 相同 `ownerCount=0` 且仍存在有效问答来源状态下，Native 与 Console 结算的行为对照。
- 有有效管理 cookie 时，同站跨端口 loopback 页面的简单表单请求边界。
- Admin API 与 Native 对同一渠道配置并发修改时的版本冲突行为。

## 十五、正式问题记录

### NRP-01 — Native RPC 缺少独立方法级授权

**类型：** 授权架构依赖。**当前判定：** 已确认代码事实，但不是已证实的生产越权。

**完整调用链：**

```text
Host HTTP
 → connection.admit → Owner Peer
 → notifier RPC wrapper 丢弃 Peer
 → service.call
 → channels.save / channels.test / questions.settle / createLaunch
 → 持久化 / 外部发送 / 控制结算 / 管理员会话票据
```

**成立条件：** 要构成非 owner 越权，还需有不具备对应方法权限的 Peer 到达此入口；在两个固定 Host 的公开 HTTP 成功分支下未找到该条件。不可将一切已认证 Peer 假设为 owner，但可据此固定源码确认**这些实际 HTTP 成功 Peer**为 owner。

**性质：** 配置可信假设、未来扩展约束；不是当前认证缺失。

### NRP-02 — Native 与 Console 的问题结算守卫不一致

**类型：** 授权策略不一致。**当前判定：** 可确认路径差异，越权影响有条件。

```text
Native questions.settle
 → surfaceQuestions.settle
 → questionsBridge.adminSettle
 → Control Core → ledger/bus
```

对照：

```text
Console /api/questions/:ref/settle
 → adminApi.settleQuestion
 → identity.ownerCount() >= 1
 → questionsBridge.adminSettle
 → Control Core → ledger/bus
```

**成立条件：** owner 数为零但仍有可经 Core 接受的问答目标，且具有 Host owner 的 Native 调用者触发。Native 缺少 Console 同一前置拒绝；仍有其他 Core 来源和状态约束。不是已证明低权限提权。

### NRP-03 — Advanced Console 的受限同站跨端口 CSRF

**类型：** 浏览器会话与请求来源策略。**当前判定：** 条件性风险。

```text
同站但跨端口的可控 loopback 页面
 → admin/server Origin/Host gate
 → 浏览器附带有效的管理员 session cookie
 → authorized(request)
 → 不检查媒体类型的 JSON.parse
 → 写业务方法
 → 持久化或外部副作用
```

**成立条件：** 攻击者控制浏览器所访问的白名单 loopback 来源页面，有有效管理 cookie，且请求正文能够构成业务接受的 JSON。不得扩大成任意公网恶意站可以利用。

## 十六、最终判断

1. **宿主准入：** 固定 DSH Connection 会验证来源与凭据，公开 HTTP 成功分支产生 Host owner Peer；未证实匿名准入或非 owner HTTP Peer。
2. **Native 业务授权：** notifier 没有独立方法级、资源级或主体级权限机制，依赖 Host 的 owner-only 准入。这是源码事实。
3. **真实业务能力：** Native 能保存凭据、热更新配置、向 provider 发测试消息、结算问题并铸造 Console ticket；通过 Console 间接获得成员/路由/配对管理能力。
4. **实际安全疑点：** 问题结算两入口的前置授权守卫不一致；独立 Console 存在受限的同站跨端口 CSRF 条件。
5. **不可宣称：** 没有证据支持“任意已认证的非 owner 可通过该 Native HTTP RPC 修改配置、管理成员或代答他人问题”。

**总评：当前 Native RPC 可解释为 Host-owner-only 管理面，但这是建立在固定宿主具体准入实现上的授权保证，而不是 notifier 自身完整的业务方法授权。** 不应将“调用了 `connection.admit`”等同于将来所有部署与 Peer 类型下都安全，也不应将“未透传 Peer”直接等同于已经证明的生产越权。

---

*本报告为既有专项静态审查结果的 Markdown 归档，严格区分已确认控制流、条件性风险和仍缺证据的判断。*
