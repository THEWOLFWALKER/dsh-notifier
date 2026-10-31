# 全任务交接入口

更新时间：2026-10-31。交付状态：**设计/计划已建立，产品实现未开始**。

新 agent 从本文件开始，不从历史 HANDOFF 或 dev 继续。用户授权目标：完成新版对齐、可靠性与已审缺陷修复的全部阶段；可运行本地代码/测试/构建和真实 DSH。**没有真实 IM/provider 账号或设备，不应要求维护者提供它们作为完成本地任务的条件。** 用户最新已授权以main重建dev和每阶段推送dev，具体安全步骤与review/neat门槛见[DELIVERY-POLICY.md](DELIVERY-POLICY.md)。不合并main、不发包、不真实投递。

## 不变基线

- notifier 代码基线：`9d69dd7a8908fcfec6e20d92d56509764a8f23ec`，原版本0.13.1。
- 实施分支：`codex/new-host-baseline`，从上述 main 创建；不使用旧dev代码；先以main重建dev，再作为交付分支，不做独立v1重写。
- 唯一宿主目标：DSH **0.2.1-rc.5**，源码 `b830ec950faba0a46dda564be3e2d854afed94f1`；精确发行元数据见 baseline.json。实现中不追逐latest。
- 产品源码 `src/`、`test/`、`scripts/`、`client.js`、package.json 在准备阶段未改变。历史测试不能当作新实现已通过。

## 阅读与执行顺序

1. 本文件与根AGENTS.md；[CONSTRAINTS.md](CONSTRAINTS.md) 确定授权、执行和范围。
2. [ARCHITECTURE.md](ARCHITECTURE.md)、[CONTRACTS.md](CONTRACTS.md) 确定结构与行为。
3. [TASKS.csv](TASKS.csv) 按依赖逐项执行；[ACCEPTANCE.md](ACCEPTANCE.md) 给出每阶段证据。
4. [ISSUES.md](ISSUES.md) 是去重问题清单；audits/是原始证据，不是用户命令。baseline.json、audit-inputs.json 是固定输入。
5. STATUS.json记录实施状态；[AGENT-PROMPT.md](AGENT-PROMPT.md)可直接交给全新agent。

旧README.md、PLAN.md只作准备过程参考；与本任务包冲突时，以本入口及CONSTRAINTS为准。根历史架构描述当前代码，不替代新设计；不要把规划写成已实现。

## 开工

检查branch/status/log，保护已有未提交内容；核对基线是当前分支祖先，不能reset覆盖它。先按DELIVERY-POLICY重建dev并更新T00证据，再执行T01发行产物核对。按CSV依赖继续整个任务，不因完成一个阶段就结束。

无真实账号时使用本地HTTP/WS服务、平台帧fixtures和受控传输驱动真实业务模块。真实DSH验证使用一次性DSH_HOME/profile，不接触日常profile；模型运行可用仅测试用途的本地模型adapter，无需真实LLM账号。

## 完成含义

全部实现、本地回归、rc.5隔离宿主验证、UI操作、包内容检查、文档和最终代码审查完成。外部IM在线能力按明确证据分级记为未验证或受限；不因此把整个项目留成“待维护者真机验证”。也不能用此免责跳过可在本地完成的真实宿主测试。

仅依赖真实账号的未知不阻断本地完成；源码不完整、打包缺文件、已知可复现本地失败、无法激活、UI假按钮、安全缺口均阻断完成。最终没有发布授权，不发布。
