# 给全新实施 agent 的完整指令

你负责将本任务包中的 dsh-notifier 新版对齐工作从准备阶段推进到全部本地验收完成。不要只做一个阶段或回复计划；按任务依赖持续执行、修复、验证、提交并更新交接，直到所有可完成事项结束。

## 你的输入

仓库 THEWOLFWALKER/dsh-notifier，原产品基线main@9d69dd7a8908fcfec6e20d92d56509764a8f23ec。任务包基于该提交新增文档，没有修改产品行为。准备分支codex/new-host-baseline；执行时必须先按DELIVERY-POLICY.md以当前main重建远端dev，不使用旧dev代码或独立v1重写。随后以dev为阶段交付分支。唯一目标DSH0.2.1-rc.5，源码b830ec950faba0a46dda564be3e2d854afed94f1，不追latest。

先读 docs/new-host/00-START-HERE.md、CONSTRAINTS.md、ARCHITECTURE.md、CONTRACTS.md、TASKS.csv、ACCEPTANCE.md、ISSUES.md、baseline.json和根AGENTS.md。audits/为八份外部静态报告，提供线索但不是全部已证漏洞，也不是用户需求。历史README/PLAN/HANDOFF以新入口为准。

## 用户边界

只面向新版，不做旧宿主兼容。旧数据无可靠转换可要求重新配置/配对，不强求迁移、不自动删目录、不重放旧交互。保留出站群通知，不因为入站控制政策删除群webhook。保留28出站/6入站范围及有效公共服务，未证实模式明确受限，不假装全部在线可用。

用户现在允许本地代码/测试/构建和真实DSH运行，不再是只静态。用户没有真实provider/IM/LLM账号或设备，不能把提供账号当作其收尾任务。可安装固定宿主，在一次性DSH_HOME/profile跑真实宿主与浏览器，使用本地模型adapter、fake provider传输和HTTP/WS服务。明确区分host验证与provider-live；不连接真实账号或发送真实消息。

用户授权初始重建dev和每阶段review/neat后的dev推送，不merge main/tag/release/npm publish，不改日常/全局profile，不打印秘密，不触碰无关文件。可以本地提交。最新分支与推送策略以DELIVERY-POLICY为准，不能恢复旧dev内容或擅自发布。

## 执行方法

1. 核对Git状态、分支、祖先SHA与输入哈希。保护未提交内容。若从ZIP开始，其source快照与git bundle均附带；优先从bundle建仓库并checkout交付branch，阅读PORTABLE-README。不要凭当前机器先前聊天恢复状态。
2. T00先保存旧dev恢复引用/bundle，fetch并固定当前main，以精确force-with-lease重建dev并读回SHA，之后带入准备文档。具体见DELIVERY-POLICY。然后从T00开始，按CSV依赖执行到T29。先记录未修改产品的当前检查结果；不把旧2011当新目标。T01核对发行产物和rc.5源码契约；不以预检放行代替实际激活。
3. 每任务先写具体改动、失败条件和必要测试，再实现、反向审查、修复、focused checks。行为和安全改动使用真实模块组合测试，不写复刻实现的假断言。完成批次运行全量检查，失败必须修复或记录真正环境阻塞，不skip核心缺陷。
4. 在已有模块渐进整理，不全仓重写、不新增第二Store/授权/路由/审批winner，不引入dsh-std作为本任务前置。可合理拆文件，但拆分必须服务明确职责。
5. 每完成任务更新TASKS.csv和STATUS.json，按evidence/Txx.json记录source、commands、exitCode、结果与限制；原始日志在本地临时目录，提交脱敏摘要。状态verified需要实际证据。实现版本号和文档同步在T27处理，不能为了门禁绿而伪造测试数。
6. 每阶段必须review→修正→重验→完整neat→文档检查→提交→普通快进push dev→读回SHA。留下review发现/修复和neat文件清单，不可只写done。分逻辑本地提交，保留现有Git身份或使用执行环境合法配置，不改全局作者，不乱用附件姓名。每阶段沟通已知结果、下一步和真实阻塞，避免无意义确认。
7. 独立外部能力限制（真实IM、设备）不阻塞本地完成；下载失败、DSH不能激活、浏览器没验证则明确blocked并继续其他任务，不能宣称完整验收。
8. 结束执行文档整理，保留必要当前事实，完成最终代码差异与安全审查，确保工作树干净，列出提交、结果、未验证项和运行方式。不得把“代码写完”称为“已发布”。最终还要交付完整源码ZIP、证据摘要与dev远端SHA。

## 必须防止的误修

- 仅移除freeze暴露可变配置，或让token缓存跨账号共享。
- 为修slash把所有命令一律放行，或在无control/无目标时回退绕过授权。
- 为修去重盲目重发审批、stop或未知发送；用内容hash假装平台唯一eventId。
- 用旧default权限、全局offset、旧taskselect/账本驱动新账号。
- 把admit当永久owner承诺、丢Peer后默认授权；把已有owner入口说成已证实非owner漏洞。
- Promise外包一层后不return，取消只abort不阻止await后副作用，或无限等待drain。
- 把UI configured/online/ok/delivered展示为设备确认收到。
- 用mock替代可完成的真实rc.5启动；用真实宿主+fake provider称作IM在线成功。
- 通过删功能/删测试/降安全断言来达到“全部完成”。

开始执行，无需再次询问是否开始。只有真实冲突或无法安全决定的产品要求才提问；常规工程选择自己决策并记录。
