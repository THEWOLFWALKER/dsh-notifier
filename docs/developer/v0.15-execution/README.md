# v0.15 历史执行追踪

本目录是旧任务包的历史记录，已被 Stage 2 review / Stage 3 final 任务包取代。不要重新执行 WP00–WP23，也不要把此处 SHA 或 planned 状态作为当前基线。当前状态见 [HANDOFF](../HANDOFF.md)。

本目录是 2026-10-02 交接包（`dsh-notifier-v015-detailed-handoff`）在仓库内的执行落点。
它只承担**执行追踪**职责：记录基线、接口映射、范围清单与逐项账本。它不是第二套架构说明，
产品与行为事实仍以 `src/` + `test/` 为准（见 `AGENTS.md`）。

## 基线（WP00）

| 事实 | 值 |
|---|---|
| 仓库 | `THEWOLFWALKER/dsh-notifier`（双分支：`dev` 开发 / `main` 发布） |
| 执行基线 | `dev@c890d2c154f237b255ac925e00ab019016692de0` |
| 包版本 | `package.json` = `0.13.1`（正式发布前不改） |
| 运行时 | Node ESM ≥22，零强制运行时依赖，无构建步骤 |
| 渠道 | 28 出站适配器 / 6 入站控制通道 |
| 测试基线 | `npm test` 2465 项（`dshQuality.testCount`） |
| `dev` 分支保护 | 禁 force、禁删除、`enforce_admins=true`；**无** required checks / required PR reviews |

`dev` 上已存在一轮 v0.15 收口（T01–T23、S1–S23 阶段、Gate 1–3），见
`.agents/workstreams/core-distillation-v015.md` 与 `v015-release-closeout.md`。
本次交接包是**再一轮**收敛，其中多项可能在当前 dev 已部分满足——必须逐项以源码核对后再结案，
不得按交接包状态直接当未修。

## 授权与边界

- 本轮用户授权：按工作包**执行并推送 `dev`**；受阻时按交接包纪律处理（完成本地可做部分、
  写明具体阻塞、继续独立工作，不绕过权限、不 force）。
- 不修改 DSH 宿主，不动 `main`，不 tag、不 GitHub Release、不 npm publish。
- 私聊-only 为硬边界：群业务/群目标/Topic/群 UI 与正向测试移除，只保留拒绝与停用迁移。
- 不猜测平台缺失字段；安全来源未知的细分入口 fail-closed 关闭并如实标注外部证据缺口。

## 账本

`ledger/` 保留交接包全部 546 条来源记录（F251 / S110 / C61 / M124），
`source_id` 全保留，不合并、不删除。状态口径见 `ledger/LEDGER-GUIDE.md` 与
[03-ledger-rebaseline.md](03-ledger-rebaseline.md)。

## 文档索引

| 文件 | 内容 |
|---|---|
| [01-interface-symbol-map.md](01-interface-symbol-map.md) | 目标契约类型 → 现有 dev 符号的接线映射与差距 |
| [02-scope-inventory.md](02-scope-inventory.md) | 出站/入站渠道与目录的个人 vs 群用途清单、退出范围 |
| [03-ledger-rebaseline.md](03-ledger-rebaseline.md) | 546 条账本的再基线口径、工作包分布、结案规则 |
| `ledger/` | 逐项账本与验收用例原始数据 |

## 验证命令

```text
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
```

每个工作包只跑相关测试；WP01/WP05 整合、WP20 整合、WP22 候选时跑全量。
没有实际执行过的命令/断言，在账本中留 `planned`/`not-run`，禁止写通过。