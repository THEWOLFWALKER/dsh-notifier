# 新版架构设计

状态：目标设计；具体模块名可沿用现有实现，不强求整树搬迁。每批保持可运行，避免一次性另造框架。

## 分层与依赖

```text
DSH rc.5 tools / agents / events / approval / questions / attachment
                         ↓ 窄宿主适配
组合根 → 身份政策 → 命令/控制 → 路由 → 交互账本 / 通知服务
                         ↓              ↓
                 账号运行实例       出站运行实例
                         ↓              ↓
                   入站传输       provider HTTP / 本地通知

Native / Recovery → 同一应用服务 → 同一Store和投影
```

组合根只建立依赖与生命周期，不承载业务判定。可渐进抽取，禁止以“先重构全部”为前置条件。

核心静态inject仅保留实际必需tools/agents。connection+webServer、userQuestions等能力由独立子Fiber注册，资源归该Fiber所有。headless不需要UI/sessionController才能通知；缺必需核心服务明确不激活，缺增强服务仅相应功能unsupported。

## 宿主边界

集中封装：活Agent查找与实例身份、事件归一、submit/stop、附件准入、原生审批/问题。不是复制整个DSH SDK。业务不探测旧API、不读私有registry、不monkey patch。

Agent ID是opaque，持久Session不等于活Agent。网络/附件await后重新查找并核对精确实例和当前授权。submit返回只证明调用接纳；模型完成来自关联turn事件，不能靠最近活跃猜归属。

## 账号与传输

每渠道当前仍单运行账号，不在本任务新增多账号产品。即使单实例，所有持久状态按真实账号作用域隔离。

AccountIdentity包含channel、稳定主体标识、标识证据等级和本地instance generation。本地别名default不是主体证明。appId/appKey可按可信配置识别应用；Telegram在隔离fake协议测试与生产初始化流程使用getMe.id取得主体；iLink使用经可信登录确认的bot id，字段冲突未解决不得谎称验证。无权威主体来源的provider：每次凭据保存生成新的本地账号配置身份，保守失效旧绑定，不猜同号续期；不能用明文token当key/日志。

接收信封身份由transport构造，不信任请求payload自报accountId。内部键用结构化tuple编码，避免冒号拼接碰撞；各provider ID仍做长度与类型验证。profile通过独立stateDir隔离，禁止默认多profile共用全局状态目录；同一stateDir多进程使用现有锁/事务。

## 出站配置与运行实例

持久化RawConfig → 校验/解析为不可变ResolvedConfig → ChannelRuntime持有可变token、限速器、序号、probe和生命周期。可用模块内WeakMap过渡实现，但状态必须绑定当前resolved对象，不能把缓存放全局单例或JSON序列化。

OutboundSource只发布不可变配置/稳定快照。不要通过移除freeze暴露共享可变配置。热应用：先解析 → 持久desired → 创建/替换runtime → 发布active revision → 旧实例停止接新工作并收敛。在途发送使用原实例，不得中途读取新凭据。

保存后runtime应用失败保留desired并显示restartPending/error，不假回滚外部动作。删除/撤销不解析不参与结果的fallback；删除本地凭据不宣称provider密钥已吊销。新版不从旧Admin/YAML兼容域复活凭据；显式当前YAML配置与本地覆盖优先级必须只定义一次并在UI说明。

## 入站与统一政策

处理链：transport真实性/大小/解析 → 生命周期准入 → chat政策 → 身份/注册面 → 归一动作 → 具体资源授权 → 幂等/账本 → 副作用。

help/whoami/pair只暴露最少信息；pair也受私聊与账号归属约束。未知slash默认明确拒绝，不作为未授权普通文本透传。若保留文本fallback，必须重新经过ordinary-message全链授权。

bind/use/quiet/log/status/tasks分别声明read/manage/converse/owner条件，不粗暴要求所有命令同一个权限。编号选择、媒体-only、button与文本共享来源政策。notifyTargets按active account过滤，不把旧成员当当前目标。

## 接收与结果

bus admission和业务处理分开，队列有界，使用durable receive记录或现有同Store ledger登记接收事实，不能新增第二Store。记录必须表达received/processing/completed/rejected/uncertain，按动作适配已有账本；重启不自动执行未知控制动作。

平台有稳定eventId时按账号+真实唯一域去重；没有稳定ID的WxPusher不得用内容相同宣称同一消息。每次投递独立接收，审批/按钮依靠一次性token防重复，普通对话披露可能重复，不承诺exactly-once。

Telegram offset只在事件已可靠接收或明确安全拒绝后推进；失败不跨越该条。传输ACK、durable receive、执行成功、providerAccepted与deviceConfirmed是独立状态。

## 生命周期

运行实例active→stopping→stopped；先同步fence所有入口，再取消等待/轮询，终结本地交互，等待已登记工作，有限flush允许的通知，释放路由/监听/transport/Store。部分相互独立资源可并行，依赖必须有阶段屏障。

所有跨await副作用前检查generation、signal、当前账号及资源权限；使用子Fiber所有权处理增强服务重建。返回并await实际disposer Promise。drain必须有期限，超时标记uncertain且旧实例不可继续写入；不能因忽略迟到Promise就称已取消。Store事务提交前也检查实例授权。

原生问题/审批分别实现取消：组合宿主signal、实例stop与本地winner信号；先撤销决定入口/令牌，后best-effort编辑卡片。不假设next()可物理取消；输了的下游结果不再有权结算。本地等待必须能终结，不依赖GUI响应。

## Native / Recovery

优先验证rc.5官方rpc.handle，fallback仅保留确有必要且检查等价的路径；同次激活只能有一个路由owner。Peer进入应用服务入口，当前管理方法明确要求owner；假设未来非owner不影响当前拒绝默认。两条路由共享完整授权/错误/取消语义。

RPC只是调用应用服务，UI不直接改Store或调用SDK。字段模型区分configured、desiredRevision、activeRevision、restartPending、localActive、lastFailure。功能能力与当前账号/Agent可用性分开。

不新建另一套主页面。修复Native与Recovery一致性、错误/空/加载/重连/窄屏，保留宿主React。launch ticket单次短期、session有界、无长期token泄漏。
