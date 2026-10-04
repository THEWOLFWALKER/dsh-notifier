# Luna 实施时不得自行改写的决定

本文件把 `PLAN.md` 中的可选路径收敛为执行规则。与旧源码/测试/文档冲突时按本文件、用户最新指令、固定上游契约处理。实现 Agent可选择局部函数命名与小型结构，不得改变下列行为契约；若新证据推翻某项，先在 PROGRESS 记录证据、影响与替代规则，再继续，不等待用户参与。

## D01 产品与删除范围

- 私聊专用。删除所有正向群聊发送/控制配置与路径，包括 QQ `notifyGroups`/`/v2/groups`、Feishu 群目标发送、Qmsg 群目标与相关正向测试。保留“群来源拒绝且零副作用”测试；用户输入旧群配置要明确报不支持，不能静默转私聊。
- 出站目标也必须有私聊证据。`resolveNotifyTargets` 不再无条件并入 `extraTargets`；Telegram 负 chat ID、QQ 群目标、Feishu `group`、topic 及目标类型未知时，审批/提问/动作通知/checked bridge 都不准发送。dsh-im `kind:'chat'` 本身不足以证明 Telegram 私聊，需绑定可信私聊来源记录；没有来源则拒绝。
- 旧 Advanced Console 的整个 UI、JS、API、events/SSE、日常管理路由与默认服务装配全部删除。先在 Native 补齐仍需要的用户任务及只读诊断/离线恢复路径，再删除旧代码；不能为了旧测试让旧服务继续发货。Recovery 如需存在，重新做最小只读入口，不复用旧管理台实现。
- `admin.enabled` 不再参与账号覆盖、入站启用或 Native read model。Native 投影直接读取 canonical channel/account 服务；删掉 `createAdminApi()` 的生产装配、event hub、scan handlers 和浏览器旧 `client.mjs`，再用真实打包与 HTTP 响应检查最终交付内容。
- dsh-im 一键配置导入按用户最新指示跳过，本轮不做导入器，也不以此阻断交付。`dshIm.*` checked-delivery 接口仍独立按真实上游契约核对；不把 `dsh-notifier-config` 备份格式冒充 dsh-im 导出。
- 不维持旧版内部接口和旧用户状态双轨。当前正式公开的插件 API 可破坏性修正并给迁移说明。README/用户文档不得出现旧控制台、群聊支持、内部协议词。

## D02 私聊启停与账号

- 每个可入站 channel/account 有显式 `privateChatEnabled`，默认 false。**有 bot token、保存账号、Admin enabled、YAML 中出现 inbound 对象都不等于授权。** YAML 只有显式 `enabled:true` 才授权；Native 开启写相同 canonical state。Telegram 可以复用通知 Bot Token，但不会因复用自动开启私聊。已有未带 enabled 的配置不自动开启，备份并提示用户重新启用。
- 入口是单一 `admitPrivate(envelope, capturedGeneration)`：要求 enabled、current generation、被 provider 证据明确证明的 private chat、完整 principal 和有效策略。所有命令/配对/审批/提问/对话在进入业务前调用；外部动作前再校验 generation。未知 chatType 和无证明一律拒绝。
- 关闭步骤：先同步 deny 并增加 generation；持久化 deny/关闭意图；成功后 abort/stop 对应 transport 并 drain。在持久化成功、准入已拒绝后可向用户确认“指令已停止接收”；transport 清理若未完成显示“清理中/需要处理”。持久化失败则当前进程保持 deny，显示“关闭未完成”；下次启动对不完整/损坏授权默认 off。不得在保存失败时重新放开当前准入。
- `InboundRegistry` 从整体 dispose 扩展为 per-channel `start/stop/status`，每实例有 generation；异步 start/stop 必须 await/abort，不以 spawn/start 调用当 connected。
- Canonical principal 为 `(channel, stableAccountId, providerUserId)`，结构化 tuple/安全编码。新账号建立时持久生成 stableAccountId；新事件缺 accountId fail closed。不得为旧数据生成 `default` 账号兜底；缺 accountId 的状态不参与新模型，用户在 Native 重设账号。owner 资格只看指定 principal。多 owner Native 仅在歧义时展示选择器，绝不取列表第一个或要求全局只有一位 owner。

## D03 旧状态处置

S0 只读盘点实际 state key 数量和敏感性，不读取或记录明文凭证。实施一次受控备份和新状态初始化：旧状态不自动装配身份、凭证、私聊或路由，不做旧版本解析器/转换器/双写，也不静默删除旧文件。Native 首次启动给简短、可操作的重设步骤；需要取回旧资料时只提供离线人工恢复路径。实施 Agent 自主完成备份、权限检查、重设 UX 与故障恢复测试，在 PROGRESS 记录结果，不中途询问用户。

## D04 Interaction 与导入

- 使用 `src/interaction/ledger.mjs` 已有 `transition()` fresh transaction，把 `terminate()` 与 `markUncertain()` 改为其受控状态转换；删除无 `transact` 的生命周期降级写路径。pending first-winner；resolved/declined/terminated 不回退；uncertain 只在可能产生外部效果、需要 reconciliation 时出现。相同执行的 claimed→resolved 要有执行 ID 验证，不能由任意 caller 的布尔 opts 放行。
- “稍后处理”是真 defer：保持 pending，记 `remindAt`，不延长 `expiresAt`，不触发 decline；重复点击幂等。到时再次展示；过期则明确显示过期。若某类交互无法做到该语义，直接删除“稍后处理”按钮并以准确的“拒绝”文案展示，不实现假 defer。
- import preview 和 commit 对 patch 与 clear 都比较当前字段摘要，在一个 transaction 中零或全提交。commit 已成功但 apply/Activity 失败时返回 `committed-but-not-applied` 或 `observation-gap`，不鼓励重新提交。
- dsh-im 配置导入本轮按用户指示跳过；不新增 guessed source adapter。现有本地配置备份/恢复功能继续按自己的 canonical 格式工作。

## D05 Public notifier 与投递证据

- 公共 `PushResult` 统一为 `{accepted:string[], confirmed:string[], unknown:{channel,reason}[], failed:{channel,reason}[], skipped:{channel,reason}[], source}`，五类互斥。定向与多渠道同形；删除含糊的顶层 `ok` 和旧 `delivered` 别名，不为了 0.x 旧版本兼容继续误导。`unknown` 一律禁止自动重试；`accepted` 不称送达。
- 如保留 dsh-im bridge，fixture 直接取固定上游合法渠道专用 target kind，先按上游 normalize route，再按上游顶层 route 排序计算 digest；虚构 `kind:'private'` 与本地扁平 route mock 不构成契约证据。
- `flush()` 统一返回 `{drained:boolean}`，生产/fake/types 一致；内部错误不能返回 `drained:true`。`dsh-notifier/sent` metadata-only，但五类证据不丢，错误正文和消息正文不进事件。Activity 标题与等级对 unknown 明确提示“不确定”。修改时升级 `PUBLIC_API_VERSION` 到 `0.8` 并更新正式插件文档和 consumer demo。
- dsh-im v1 fixture 直接来自 taskpack 固定上游：nested `account.fingerprint`、`expectedTargetDigest` 按 upstream、前置拒绝和 SDK 后不明分开。现有 Telegram checked mock 不可当上游能力承诺；固定上游首版只说明 Feishu/Lark checked。

## D06 Store/Runtime/Cloud

- Store `get` 不给 live 引用，clone 失败报坏数据；关键多键写必须有 transact。`durable:true` 只有文件及目录 sync 都成功才可返回。rename 后 sync 失败属于 `commit-unknown`，禁止让调用方无条件重试外部副作用。运行时删盘/损坏不可从陈旧内存自动复活。
- Runtime 把 desired revision、live generation、provider evidence 分开；每条异步状态/测试/发送观察必须携当前 generation。配置实质没变不换代；旧/缺/未来代不计入当前健康。撤销凭证或权限优先同步 fence，普通配置热替换失败可显示 diverged。
- Cloud credentialSource 固定为 `state-secret` 或 `yaml-outbound`，claim 不制造不存在的 secret ref。外部请求开始**之前**的确定失败到 `failed`；开始之后无法确定副作用到 `recovery-required`。重启只读 reconcile，不自动继续外部写；retry 不自动复用任意非终态 job。cancel 能处理 durable row，save fault 也先尝试 abort；UI 不把启动进程/Worker healthz 显示为 Telegram 已可用。link/unbind 只在本地 runtime apply 成功后显示完成。

## D07 测试、UX 与自主推进

- 按 `TEST_AUDIT.md` 批量删除旧 Console/群聊正向/历史兼容测试；可疑 mock/自证测试重写。不要逐条修改 201 个问题或为了保持 2447 testCount 复制无意义测试。源 grep 仅辅助。
- `npm test` 的 2447 计数不含 `test/dom`。S0 和最终 gate 分别运行 Node 与真实 React DOM，并让两者在 CI 失败时阻断；发布计数或本地 `npm test` 绿灯不能代替 DOM。优先替换条件空断言、自足重言式和只验证服务端截断的 UX 测试，详见 `TEST_REVIEW_ADJUDICATION.md`。
- S0 就定义 Native 六个核心任务；S1/S2 每阶段交付相应真实 UI 纵向切片，S3 做整体 IA/可访问性与旧代码清理。错误、空态、未知、处理中分开；超过列表上限有分页/搜索和真实 total。
- 实施途中不询问用户 routine 决定。遇真实外部证据缺口，标 unknown、限制对应能力或标实验，不中断其余可做工作；遇不可证明的权限/数据归属则 fail closed 并提供重设路径。若 git 远端冲突，fetch 后安全整合，绝不 force。
- S4 完成后只提供候选发布审查。`package.json` 版本在 S4 设为 `0.15.0` 并更新 CHANGELOG/README/包体，但不 tag/Release/npm publish，等待最终单独授权。Windows/Node 声明只覆盖 CI 实测平台与版本；不能靠一份文档扩大支持范围。
