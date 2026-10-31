# 验收与无真实账号执行方案

用户允许运行DSH与本地检查。本文件替代历史静态阶段禁执行限制。真实IM/provider/LLM账号及设备不在验收依赖中；不得要求维护者真机收尾。

## 四类证据

1. source：固定代码/公开规范的静态结论。
2. local-contract：真实模块+受控IO/平台fixtures验证；不等于平台在线。
3. host-rc5：真实发行DSH/真实Cordis装配、事件、工具、RPC、卸载和浏览器验证，外部IO仍受控。
4. provider-live：真实提供方账号或设备，本任务不执行、不宣称通过、不把它列为维护者阻塞任务。

为每项记录command、退出码、开始结束时间、source commit/diff摘要、环境、sanitized结果、未验证边界。状态planned/in_progress/implemented/verified/blocked/external-unverified分开，只有执行对应检查才verified。不冻结测试数量，旧2011不作为目标。

## 本地隔离

- 固定rc.5安装到临时工作区，校验发行integrity/入口和实际依赖版本；不用浮动npx latest或日常全局配置。
- DSH_HOME和profile路径显式指向临时目录；启动前检查其位于sandbox/workspace，未知路径不写入。结束仅清理本任务明确创建的资源。
- 清除测试子进程对真实账号配置的读取能力，环境allowlist；不dump env、不读取秘密。不能全局unset代理绕过网络政策。
- 默认禁止provider外网；仅依赖下载/官方源码抓取及loopback测试服务器有明确例外。应用网络私网策略不得为了本地webhook测试永久放宽；使用既有显式自托管策略或仅测试注入，生产默认保持。
- 测试SDK、HTTP/WS fake只替换外部IO，不替换授权、Store、路由、业务sender、winner逻辑。

## 阶段门槛

| 阶段 | 必须执行的检查 |
|---|---|
| 基线 | 未改产品源码前记录原测试与release guard，结果失败可作为缺陷基线，不伪称新改动回归；固定宿主发行产物检查 |
| 安装/宿主 | 原包预检阻挡作为对照；新包无需豁免可安装；Web/headless实际激活；无connection核心通知/工具仍可用；core服务缺失明确失败 |
| 授权/账号 | converse关闭的普通/未知slash均不提交；群敏感入口拒绝；全部命令矩阵；A→B同Store旧owner/targets/bind/taskselect/offset不继承；微信CLI→identity→实际facade→bus贯通 |
| 出站/配置 | 每有状态adapter走resolve→source→notify；首发/连发/热替换/并发；revoke坏YAML；desired失败投影；断头/慢body/大小/429/部分段/未知结果不盲重试 |
| 入站 | 真实bus+授权+命令+Store+router；稳定eventId去重与失败接收；Telegram批次不跨失败推进；WxPusher两次真实相同文本不被内容hash吞掉 |
| 生命周期 | Deferred附件跨dispose、stop后poll正常返回、重复卸载、请求取消、服务替换、旧generation写事务、超时后业务仍运行均可控验证；句柄和端口可释放 |
| 交互 | GUI先答/手机先答/Host取消/超时/卸载/推卡迟到/重复回调；只有一个durable winner；next输家无权覆盖；无幽灵pending；审批与问题各测 |
| Native/Recovery | 真实owner认证→RPC→服务→Store；未认证/非owner受控Peer拒绝；Origin跨端口/CSRF；launch ticket单次；配置/错误/无目标/partial/restart状态真实刷新 |
| UI | 真实rc.5 Web与宿主React；四slots可用；首次配置、错误、重连、账户更换、任务/问题、窄屏和键盘访问；有行为的截图，不以源字符串测试替代 |
| 发布准备 | npm test、verify:release、channel matrix、host compat、node --check相关文件、git diff --check、npm pack dry-run与真实本地tarball安装验证；不publish；最终完整源码ZIP |

## 无模型密钥的真实宿主旅程

创建仅用于测试的本地模型adapter（DSH公开模型入口）或确定性工具/事件驱动器，在真实DSH Agent生命周期中触发turn start/output/end/error、审批/提问。必须区分：实际Agent驱动旅程与人工emit的事件合同，后者不能替代前者。不得在产品加入“测试模式自动批准”。

最小端到端旅程：
1. 新profile安装tarball→无配置安全启动→Native/Recovery真实可达。
2. 保存本地测试webhook→本地接收器看到真实HTTP→修改配置热应用→真实任务结束发往当前目标。
3. 受控IM传输送入平台fixture→生产准入/身份/路由→真实Agent接纳→真实turn输出回原chat的受控sender。此为host+local transport，不是provider-live。
4. 原生审批与问题通过真实服务进入手机桥、受控回调结算、宿主返回；GUI并发用真实浏览器操作或真实官方answerer受控驱动。
5. 未配对、错误账号、禁用对话、未知slash、错误来源按钮全部无副作用。
6. 换号/重启/停机/依赖服务替换→旧工作不能对新账号/Agent产生副作用，实例回收后端口和监听可复用。

## 受限与完成

提供方协议能力若有证据冲突：实现可验证的模式，对未证能力给明确限制；每个渠道在CHANNEL-EVIDENCE.md记录source/local-contract/host/provider-live状态。所有28/6必须有一行，不用笼统“全部通过”。

若无法下载/启动DSH或浏览器，记录具体环境错误并尝试合理替代，继续其余任务；该项保留blocked，最终只能“代码完成，宿主/GUI验收受阻”，不能完整完成。缺真实账号本身不是blocked，是预定external-unverified。

所有执行结果结束时汇总，不把整个任务停在“还需要你提供账号”。每阶段review与neat通过后普通push dev并读回SHA；初始dev重建仅按DELIVERY-POLICY。不得merge main或publish。
