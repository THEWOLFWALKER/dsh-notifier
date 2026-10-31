# 行为、数据与失败合同

所有字段形状是目标语义，优先以现有函数扩展实现；写代码前在接口文件或JSDoc明确具体类型。新增字段同步types、projection、UI和测试。不为本任务引入强制TypeScript全仓迁移。

## 身份与数据版本

- AuthorityKey=(channel,accountIdentity,userId)，来源额外含chatId/chatType/sessionId；generation是运行所有权，不等于可跨重启账号身份。
- 信封不得缺失来源后用channel/default冒充已认证主体。provider确无chatType证据时unknown不得执行控制。
- 新存储namespace/schema版本在T03定稿，与已有全局key隔离。未知旧版本不自动加载权限或待执行数据。保留旧文件、不修改其内容；明确提示重新配置，不能静默空状态后宣称已迁移。
- 若选择导入，仅支持明确可验证的纯配置，显式用户动作后逐字段校验；这不是必须功能。不得导入待决、token、游标、会话选择原文或无账号归属成员。
- 新版Store仍原子写、锁与fresh-read merge，保留无关键。事务失败不发布内存新状态，不做旧快照覆盖式补回滚。
- 换账号/删除重加保守建立新授权域，清除或终结旧域待选/待决但不重放；同主体凭据轮换只有证据充分才续用游标。没有真实provider身份接口的模式可以要求重新配对，不制造外部认证保证。

## 命令政策最小表

| 操作 | 最小条件 | 禁止 |
|---|---|---|
| help/whoami | 有效transport、允许chat类型、限流、最少回显 | 全局成员/任务枚举 |
| pair/unpair | 当前账号/来源、单次有期限代码；unpair仅自己或owner管理入口 | 换号后旧配对码扩权 |
| status/tasks/sessions | 已配对且目标可读，范围过滤后分页 | 把list能力当控制能力 |
| ordinary/steer | 已配对+converse+精确会话授权，当前live Agent | 未知slash或无目标回退绕过政策 |
| stop | stop权限+精确目标+来源政策 | 取消所有Agent |
| bind/use | 对该会话有访问/对话授权；选号时复核原始消息账号和权限 | 旧账号taskselect原文继承 |
| quiet/unquiet | 仅允许管理的会话/工作区，明确改变的出站范围 | 任意成员改全局状态 |
| log | owner+功能开启+有界脱敏 | 跨账号owner继承、完整私聊日志 |
| approval/answer/action | live pending+正确来源+有效期+授权+durable单次claim | 自动同意、含糊结果重试、输家覆盖 |

已有策略可更严格，但不能因为构造函数缺control就绕过生产授权。用于测试的fake无权改变生产默认。

## 发送结果

内部SendResult至少表达status(accepted/partial/skipped/failed/uncertain)、受理目标、失败目标、未知目标、分段事实、providerMessageId(若有)、脱敏code。confirmed必须有独立证据；legacy delivered仅映射accepted且明确文档。

工具ok必须有明确定义：调用处理成功与实际受理不混淆，模型返回内容含acceptedCount与skippedReason等。无目标、静音、无配置不得显示“已发送”；partial不得变成all-success。

超时/断流之后不能假设未送达，除非可以证明副作用前失败。无官方幂等合同不自动重发未知请求。分段记录已受理段，后段失败不能整体重发。

共享HTTP总deadline覆盖DNS/连接/响应头/正文消费，并限制正文大小；重定向逐跳网络策略校验。保留超时unknown/noRetry语义。上层消费Response时deadline必须仍有效或由统一有界读取API接管，不能finally提前清timer。

## 渠道专有合同

- QQ：识别数字与字符串错误码；成功需有有效消息标识，timestamp不能凭旧资料限定单一类型。删除“msg_seq+内容保证主动幂等”的无证据宣称；不凭不可达新wiki擅改域名或宣布旧域名废弃。主动通知模式与被动回复分开标支持证据。
- WxPusher：topicIds使用协议数值类型；顶层任务创建不代表各目标受理，检查data逐项状态。上行缺稳定事件ID不承诺完美去重。
- WPS：签名模式显式配置并按官方算法/头实现；未开启签名模式的key-only不能被误判无效。不能猜一个不存在的响应code。
- Feishu：固定1.73.0 SDK源码核对WS卡片回调能力。若不支持则使用受鉴权的HTTP回调或明确按钮不可用+私聊编号fallback，不能保留永远到不了的假按钮；普通消息仍保持。
- DingTalk：与固定官方SDK ACK帧对照字段；ACK在业务处理前后的语义明确，不能假设已ACK失败会重投。
- iLink：缺ret/errcode的空对象不判成功；登录bot id/user id职责分别核对。无公开第一方协议的限制写清。
- 全部28渠道：逐字段/最终body检查长度单位、标题预算、rate限制、Retry-After已证形式、部分成功；不能要求无账号证实时所有在线行为，也不能用“未实测”忽略确定本地偏差。

## RPC与取消

TrustedCallContext含来源(native/recovery/internal)、Peer主体、AbortSignal、运行generation。来源由入口构造，不从payload接受role。内部调用显式可信上下文，禁止默认missing context=owner。

所有Native管理入口在dispatch前验证owner，具体目标仍经业务权限；question admin代答采用明确管理员语义，并保留Control Core/单次结算。Native与Recovery的ownerCount等守卫统一成显式产品规则，不要求owner Host必须拥有某个IM账号才能配置产品。

取消分request取消、operation取消、实例停止。已提交外部副作用不能回滚，记录uncertain/accepted而非cancelled假象。UI断线不自动撤销已经durable提交的管理员变更，但不能继续接纳新动作；操作结果可查询。

## 宿主契约

- engines.dsh精确0.2.1-rc.5；旧peer移除/更新依据直接导入需求，不通过allow-version掩盖。
- Tool exec.signal向下传递到发送/等待/下载，卸载与取消可有界收敛。
- exec.agent是正式身份入口，无agent时只允许明确的无会话通知策略；禁止悄悄扩大目标。
- 精确live Agent在副作用前复核，调用返回void不是处理成功。
- 只保留rc.5实际支持的waterfall，不保留旧registerProvider猜测；保留问题detail/intent/wait上下文，不能用空selected伪造回答。
- RPC disposer Promise必须返回给子Fiber并await；不预设所有宿主HMR路径严格无重叠。
