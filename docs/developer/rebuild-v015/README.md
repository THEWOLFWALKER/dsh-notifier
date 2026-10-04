# dsh-notifier v0.15 重构 taskpack

本目录保留 v0.15 的实施依据、审查裁定和逐项来源记录。规划审查基线为
`dev@2542a3107e7d3795e6ba5b294a7a5b82052c3431`。任务包中的目标状态不代表当前源码状态；
当前阶段结果以 [PROGRESS.md](PROGRESS.md)、`CHANGELOG.md`、实现源码和最新门禁记录为准。

阅读顺序：

1. `PLAN.md`：综合根因、优先级、架构与阶段门禁。
2. `PRODUCT_UX.md`：竞品视角、用户旅程和 Native UX 验收。
3. `DESIGN_REVIEW.md`：开发与用户视角的设计批判及规划修正。
4. `DECISIONS.md`：实现 Agent 不得猜测的产品、接口和故障决策。
5. `HIGH_RISK_IMPLEMENTATION.md`：复杂接口、状态机、交错和局部禁用规则。
6. `TEST_AUDIT.md`、`TEST_REVIEW_ADJUDICATION.md` 与 `test-catalog.json`：测试索引、独立审查裁定和替换清单。
7. `RELEASE_READINESS.md`：排除真实账号验证后的候选发布差距。
8. `RACE_FAILURE_MATRIX.md`：Interaction、Runtime、Cloud Job、Import、Identity/Account 故障矩阵。
9. `UPSTREAM_CONTRACT.md`：固定 dsh-im/Host 原始契约与校验。
10. `issue-crosswalk.json`：201 当前项、61 复验、F01–F16、MY-R01–R16 完整逐条原文和主根因归属。
11. `IMPLEMENTER_PROMPT.md`：直接给新实现 Agent 的执行提示词。
12. `sources/independent-test-review-merged.md`：独立环境三路测试审查原文；覆盖率为估算，不能把未逐断言核对的测试写成通过。
13. `SOURCE_ID_DISPOSITIONS.md`：逐条 source ID 对应的 v0.15 disposition 与证据边界。

crosswalk 的主归属只用于实施 owner，交叉依赖在 PLAN 与矩阵中说明。不要把 294 条来源记录当 294 个独立缺陷；也不要删除已修/撤回 ID，它们是回归条件。

交付定义：每条来源记录有 disposition、对应实现/测试/证据或明确延后理由；每阶段 focused + integration gate；最终 full gate 和真实证据矩阵。旧控制台全部退出，用户日常任务统一 Native。实际完成情况、未验证的真实环境证据及已跳过的 dsh-im 导入器见 [PROGRESS.md](PROGRESS.md)。
