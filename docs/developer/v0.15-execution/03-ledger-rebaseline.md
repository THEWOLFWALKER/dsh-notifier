# 逐项账本与再基线口径（WP00 / U06）

## 1. 账本事实

`ledger/audit-ledger.csv`（主表）+ `ledger/audit-ledger.json`（同源机器可读）保留交接包
**全部 546 条**来源记录，`source_id` 全保留、不合并、不删除。

| 系列 | 条数 | 来源报告 |
|---|---|---|
| F | 251 | `audits/dsh-notifier-dev-full-audit-2026-10-01.md` |
| S | 110 | `audits/dsh-notifier-dev-second-round-full-audit.md` |
| C | 61 | `audits/dsh-notifier-dev-complete-problem-audit-2026-10-01.md` |
| M | 124 | `audits/dsh-notifier-dev-two-rounds-master-audit.md` |
| 合计 | 546 | 4 份审计报告 |

工作包分布（`source_id` → `work_package`）：

| WP | 条 | WP | 条 | WP | 条 | WP | 条 |
|---|---|---|---|---|---|---|---|
| WP00 | 2 | WP06 | 37 | WP12 | 21 | WP18 | 20 |
| WP01 | 41 | WP07 | 7 | WP13 | 3 | WP19 | 47 |
| WP02 | 30 | WP08 | 17 | WP14 | 32 | WP20 | 37 |
| WP03 | 18 | WP09 | 19 | WP15 | 12 | WP21 | 25 |
| WP04 | 20 | WP10 | 7 | WP16 | 6 | WP22 | 35 |
| WP05 | 24 | WP11 | 14 | WP17 | 16 | WP23 | 56 |

全部 24 个工作包均被覆盖，`scope` 统一为 `source-occurrence-not-unique-bug`——
**546 是含重复的报告记录数，不是 546 个独立 bug**（见 `ledger/LEDGER-GUIDE.md`）。

## 2. 当前状态：全部 planned

546 条当前 `status` 全为 `planned`，`evidence` 全为空。这与交接包口径一致：
“空白证据不等于通过”。**不得**据此声称已完成。

同时，`dev@c890d2c` 上已存在一轮 v0.15 收口（T01–T23 / S1–S23 / Gate 1–3）。
因此部分记录很可能在当前源码**已经满足**，但这必须逐条以
`fixed`/`removed`/`duplicate`/`verified-existing`/`scope-decision`/`external-evidence-gap`
给出**具体证据**后才能结案——不能按交接包状态直接当作未修，也不能凭印象刷绿。

## 3. 再基线规则（本目录在 WP00 采用）

对每条记录，按顺序判定并只落一种状态：

| 状态 | 结案条件 |
|---|---|
| `fixed` | 指向具体提交 SHA + 通过的相关测试命令与结果 |
| `removed` | 群/不安全入口无业务可达路径，且有迁移或文档说明 |
| `duplicate` | 与另一 `source_id` 确为同一问题（注意 `related` 只是相关提示，不等于同一 bug） |
| `verified-existing` | 当前 dev 源码已满足，附文件与行号依据 |
| `scope-decision` | 本包范围裁决（如私聊-only 决定的取舍），附裁决 ID |
| `external-evidence-gap` | 平台/真机证据不可得，附明确安全默认与公开能力限制 |

安全缺陷**不能**仅改为“实验/风险”而保持可达；必须 fail-closed 关闭或真正修复。

## 4. U06 第二遍语义核对状态

交接包 U06 要求“以原始标题核对 work_package/decision，尤其跨报告 related”。
本轮 WP00 已完成：

- 546 条总数与四系列分布核对（F251/S110/C61/M124）；
- 24 个工作包分组完整性核对（无记录落在工作包之外）；
- `scope` 口径统一确认（非独立 bug 计数）。

**未完成**（明确保留，不隐去）：

- 546 条逐条的原始标题 ↔ 工作包/裁决第二遍语义核对（跨报告 `related` 可能只是相关、非同一 bug）；
- 逐条源码复现以判定 `fixed`/`verified-existing`/`duplicate`。

这两项随各工作包实际开工时按包内记录同步完成并回填证据，不做一次性“全量重审”替代推进
（交接包明确禁止用重审替代推进）。

## 5. 验收用例

`ledger/acceptance-cases.json` 共 38 条（AC-01…AC-38），当前状态全为 `planned`，
`execution_evidence` 全为 `null`。它们目前是**规格**，不是可运行测试；
对应工作包开工时须写成可运行的项目测试（生产路径/故障注入），
以实际命令 + assertion + 输出作为 `execution_evidence`。