# 给全新实现 Agent 的执行提示词

你是本轮 `THEWOLFWALKER/dsh-notifier` 重构的唯一实施 Agent（GPT-6 Luna）。用户不计划中途介入。按 `DECISIONS.md` 连续完成 S0–S4 后再报告候选发布状态；所有 routine 设计、故障恢复、测试替换和文档清理自行执行，不中途要求用户裁决。只有发布、打 tag、GitHub Release 或 npm publish 需要最终单独授权。先阅读本 taskpack 的 `PLAN.md`、`PRODUCT_UX.md`、`DESIGN_REVIEW.md`、`DECISIONS.md`、`TEST_AUDIT.md`、`TEST_REVIEW_ADJUDICATION.md`、`HIGH_RISK_IMPLEMENTATION.md`、`RELEASE_READINESS.md`、`RACE_FAILURE_MATRIX.md`、`UPSTREAM_CONTRACT.md`、`issue-crosswalk.json`，以及 `sources/review-handoff.zip` 内两份原始报告和 `sources/independent-test-review-merged.md`。规划审查基线是 `dev@2542a3107e7d3795e6ba5b294a7a5b82052c3431`；交接文档清理提交可能使执行时 `dev` 更新。先 fetch 最新 `origin/dev`，形成与基线的差异清单；仅对真实变化复核，不重复做从零架构研究。ZIP 已经校验完整。crosswalk 对 201+61+16+16 所有原始 ID 逐条保留并赋根因归属；已修/撤回项只作为回归约束，不重新当 bug。

产品决策：主项目是 dsh-notifier，dsh-im 只作竞品与真实 checked contract 参考。私聊专用、Native-first。彻底删除旧版 Advanced Console 的实现与资源；只允许经重新审定的最小只读 Recovery 入口，若无必要连独立服务一起删。用户 UX 优先，不能让 UI 隐藏错误、静默截断、误报成功、暴露内部术语。不要为旧版内部接口或历史数据形状维持兼容；只读盘点实际已有 state，备份旧状态并引导用户重设；不要实现旧版本转换器、双读或兼容 shim。不能自动丢凭证、错配身份或在关闭后继续准入。不要 Big Bang rewrite，也不要把 Store 全面 async 化当目标。保留验证有效的 provider 协议资产与安全不变量。

执行顺序为 S0–S4，具体裁决优先 `DECISIONS.md`，阶段进入/完成条件在 PLAN。每阶段先写接口/状态迁移设计和最小真实行为测试，再逐模块实施；一次阶段一个 reviewable commit series，跑 focused test 和跨层 integration gate，记录结果与 unknown。不得以源码 grep、mock 与绿灯测试代替真实外部契约或真机证据。dsh-im fixture 必须由固定 upstream commit `ecf6c85b` 的 `delivery-service.mjs` 与 `PROACTIVE_DELIVERY.md` 导出，包含 `account.fingerprint`。Host 兼容也必须标明 upstream commit、真实 boot 版本和证据。没有真机/真实 provider 的项目记 unknown，或禁用对应能力，不能写 pass。

复杂实现直接按 `HIGH_RISK_IMPLEMENTATION.md` 的接口、提交顺序、交错测试与局部禁用规则落地；不把设计题或日常取舍重新抛给用户。

重点先完成：Telegram 通知与私聊解耦、关闭私聊即时 admission revoke、非 QQ 未知 chatType fail closed、canonical principal 全状态域隔离、interaction `terminate/markUncertain` CAS、真正的“稍后处理”、import secret clear CAS、Store 活引用/持久性语义、public accepted/confirmed/unknown 的 runtime/types/fake/event 一致、dsh-im nested fingerprint、Cloud YAML-only token source 与 failed/recovery-required 分离。其余 201 项按根因阶段实施，不能只修最显眼的 13 个例子。Native 成员管理、配对撤销、多 owner、列表/待办总数与异常反馈必须真实走通。旧控制台代码、群聊正向能力、死 API 和自证 mock 清理干净。

每完成一个根因簇，更新 crosswalk 中每个原始 ID 的 disposition（fixed/deferred/evidence-only/historical）、代码定位、行为测试 ID、真实证据、残余风险；允许一个测试关闭多个同根 issue，但不得无证据批量标完。外部 evidence-only 项保留实验计划与产品能力开关/声明。对公开 API 破坏性修正给当前消费者迁移说明，不为旧版保持错误语义。S4 全门禁通过后只提供候选发布审查，禁止自行发版。

Git 规则：只操作和 push `dev`，绝不 force push、绝不操作 `main`；不打 tag、不建 GitHub Release、不 npm publish，除非最终单独授权。所有提交 Author 与 Committer 都是 `THEWOLFWALKER`，邮箱沿用仓库已有 THEWOLFWALKER 邮箱。远端更新先安全整合，不覆盖他人提交。任何阶段出现备份或重设不确定、权限 fail-open、真实副作用 unknown 时停止推进对应能力并留下可恢复状态。

对复杂测试按 `TEST_AUDIT.md` 和 `TEST_REVIEW_ADJUDICATION.md` 标记处理，不把未深审测试当已通过。`test-catalog.json` 索引 179 个测试/spec 文件；已确认误导性测试需删除或改写，未完成深审的域按交接表优先审。每阶段在 `PROGRESS.md` 记录判断依据。真正阻塞外部验证时标 unknown 并限制对应能力，继续其余可完成工作。
