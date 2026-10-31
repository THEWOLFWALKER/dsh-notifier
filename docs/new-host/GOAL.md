# 可直接交给全新 agent 的 Goal

请接管本任务包并自主完成 dsh-notifier 新版升级的全部阶段和任务，不要只做分析、计划或某一个阶段。先阅读 PORTABLE-README、docs/new-host/00-START-HERE.md、DELIVERY-POLICY.md、CONSTRAINTS.md、ARCHITECTURE.md、CONTRACTS.md、TASKS.csv、ACCEPTANCE.md、ISSUES.md及AGENT-PROMPT.md，并以它们作为当前任务约束。

用户明确：旧dev已经损坏。先fetch官方main/dev并记录SHA，为旧dev建立可恢复引用与Git bundle；以执行时核实的当前main重建远端dev，不merge或复用旧dev重写代码。固定审计main为9d69dd7，若main已变化先审查增量并更新基线。只有初始重建允许对refs/heads/dev使用绑定已记录旧SHA的force-with-lease，禁止裸force、禁止自动覆盖并发更新。读回dev验证精确等于选定main，再把准备文档提交带入新dev。随后开发与阶段交付只普通快进推送dev；不修改main、不创建tag、不发GitHub Release、不npm publish。

唯一宿主目标为DSH0.2.1-rc.5，源码b830ec950faba0a46dda564be3e2d854afed94f1，不追浮动latest，不为旧宿主保留适配层。旧数据不能明确安全转换就要求重新配置/配对，不强求复杂迁移、不删除用户目录、不恢复旧权限或重放旧待决动作。保留28出站/6入站功能范围、合法出站群通知、公共ctx.notifier和Native/Recovery角色；不以SDK接入为理由再造核心或第二Store/路由/审批权威，暂缓整体dsh-std接入。

按TASKS.csv的30项依赖执行到最终完成：核对rc.5发行产物与安装激活，修复授权旁路、账号隔离、配置与运行状态、取消和生命周期、渠道协议与结果、Native/RPC安全及UI，完成全部本地验收、文档与打包。每个阶段强制实现→验证→review→修复→重验→完整执行neat-freak→文档一致性检查→提交→普通推送dev→读回SHA。记录review发现及处理、neat文件清单、检查结果、提交和远端SHA，不能只写review/neat done；持续执行全部阶段，不在完成一个阶段后结束。常规工程选择自主决策并记录，真正阻塞才询问且继续其他独立工作。

用户允许本地代码/测试/构建、浏览器及真实DSH在一次性DSH_HOME/profile运行，但没有真实IM/provider/LLM账号或设备。使用真实rc.5宿主与本地模型adapter、HTTP/WS receiver、平台fixtures和受控传输验证真实业务模块；禁止接触日常profile或真实账号，不能以缺账号要求维护者收尾，也不能把fake provider当真实在线送达。真实宿主可验证部分必须做，provider-live明确标为任务外；本地失败不得skip、降低安全断言或删功能掩盖。

结束时所有可完成任务需有源版本关联的证据，工作树干净、dev已推送且读回验证；交付完整源码ZIP、开工/运行说明、测试与真实DSH及UI结果、28/6渠道证据分级、提交/远端SHA和实际限制。不打包凭据、状态、node_modules、私聊或原始日志。不把代码完成说成已发布，不要求维护者再做真实账号验证。
