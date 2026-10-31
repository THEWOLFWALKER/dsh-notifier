# 去重问题与任务映射

本表是工作输入，不是已经修好的清单。source结论与条件性风险分开。8份报告哈希见audit-inputs.json。

| 根因/范围 | 证据与限定 | 负责任务 |
|---|---|---|
| 旧peer与connection强依赖 | rc.5预检/标准headless与当前声明互斥 | T01,T02 |
| exec.signal与非正式exec.session | 取消没有贯穿；无Agent策略须明确；不是所有API签名已坏 | T10,T13 |
| slash提前routeUnsafe | 权限/群来源闸被跳过，unknown继续文本；同根因不双计 | T04 |
| owner/notifyTargets账号过滤 | 成员列表仅channel，需按active主体过滤 | T05 |
| bind/taskselect/dedup/TG offset旧域 | 单profile换号条件成立；不宣称标准装配多bot共存 | T03,T05,T12 |
| 微信登录default配对 | CLI保存真实账号却绑定default，生产准入不一致 | T06 |
| DingTalk robotCode/WxPusher学习旧域 | 当前凭据不应借旧账号缓存 | T06,T24 |
| freeze与runtime缓存 | QQ/WeCom/Desktop/Serverchan有状态适配器冲突 | T07 |
| revoke坏fallback | canonical-only也会解析无关YAML阻断撤销 | T08 |
| Native restartPending丢失 | 保存结果与刷新投影不一致 | T08,T19 |
| HTTP body deadline | 响应头返回后清timer，正文可能越过总期限 | T09 |
| ok/accepted/confirmed误导 | 无目标/静音可显示成功；delivered历史别名 | T10,T19 |
| Native image/control能力过报 | router/query存在不能证明附件/具体Agent写能力 | T13,T19 |
| bus accept不查disposed | 停止后仍可能写dedup/身份；晚回调前提列明 | T11,T12 |
| poll正常返回缺stop复核 | Telegram/iLink的await后控制流缺口 | T12,T24 |
| 附件/选择await后写Agent | 停止/撤权后缺实例授权 | T13 |
| 原生request.signal未传 | 审批/问题各自取消与drain需补，不能混算 | T14,T15 |
| RPC disposer Promise丢失 | 子Fiber所有权和真实await；旧必失败注释无效 | T16,T17 |
| Native Peer被丢弃 | 当前公开HTTP Peer为owner，不是已证非owner利用；明确授权 | T17 |
| Native/Console ownerCount差异 | 管理员代答规则一致，不误把IM身份当Host管理权 | T18 |
| Console同站跨端口Origin | 有条件CSRF；完整Origin与请求格式检查 | T18 |
| QQ数值code/成功形状/幂等 | 官方字段版本有差异，主动推送资料冲突不能冒充已证可用 | T20 |
| WxPusher逐目标/数字topic/无eventId | 顶层成功不等于全部目标；相同payload无法判定事件同一 | T21 |
| WPS签名/各渠道最终预算 | 按模式和最终序列化体，不能统一1200码点包打天下 | T22 |
| Feishu卡片WS可达性 | 固定SDK1.73.0源码未闭合；不得凭main README判必坏 | T23 |
| DingTalk ACK/iLink空回包 | 帧差异需固定SDK/规范；iLink不是已证第一方公开协议 | T24 |
| 任意旧Loader都await假设 | Fiber支持async不等于上层每条路径顺序等待 | T16,T25 |

生命周期报告中的A/B表示源码路径与成立条件，不证明生产发生；不要为了清零风险虚构现场。
