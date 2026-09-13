# Workstream: task-10-tombstone-durability

- Agent identity: `codex | volcengine/deepseek-v4-flash | Windows`
- Agent: `codex/task-10-tombstone-durability`
- Branch: `codex/stage5-wechat-ilink-hardening`
- Status: done
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: 收官 Stage-4 P1 的回收墓碑持久化——持久化 durable 布尔（store.set 返回 false）时保留墓碑、失败写后再补删；补回归测试，最小 P2 清理补齐仅按需。
- Plan:
  1. 检视当前 session-registry 未提交 diff，确认墓碑持久化语义：`store.set` 显式返回 `false`（createStore 的 durable 布尔，v0.8.7 起 save() 传播写未到盘）时不清 `removedIds`，返回 `undefined` 的既有 store 照常清，set 抛错由外层 catch 保留。
  2. 确认 `false`/兼容 `undefined` 两条回归测试已在位，判断是否存在「缺失的最小 P2 清理测试」。
  3. 运行 focused/full validation 并按需记录（本任务只提交自有文件，不触碰 channel/admin/docs/CHANGELOG/HANDOFF/公共远端）。
- Owned files: `src/routing/session-registry.mjs`, `test/session-registry.test.mjs`, this workstream
- Do not touch: channel 适配器（telegram/feishu/wechat-ilink/legacy-core）、admin、docs、CHANGELOG、HANDOFF、公共 release 远端、inbound 测试与宿主。
- Validation: `node --test test/session-registry.test.mjs`; `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`
- Adversarial review: 挑战「失败的 sweep 写 + 后续生命周期写把过期会话从盘上基底复活」这条持久化级病根；核对 `false`、`undefined`、`set 抛`三条路径语义分叉是否都正确。结论：复活只由 `durable=false` 静默失败引入（createStore 新语义，本 diff 新增处理）；`undefined` 是既有兼容路径、`set 抛`本是外层 catch 预存在的防御行为（diff 注释明确指出不复删），未引入新行为，故无需新增 throw 回归测试——对应 P2 的 `normalizeControlOverlay` 生命周期写前规范化已由既有 `'not-an-object'` control 测试覆盖，无缺失项。
- Handoff: persist 仅在 `writeResult !== false` 时清 `removedIds`；durable=false 时墓碑保留、下次成功写（ensure/touch 触发 persist）从盘上基底补删过期记录，杜绝重启复活。新增两条回归测试：① durable-fake store（`set` 返回 durable 布尔且 false 不改盘）演示「sweep 写 durable=false → 后续成功 touch 补删、无关记录/兄弟字段保留」；② 既有 makeStore（`set` 返回 undefined）兼容——墓碑照清、行为不破坏。session-registry 聚焦测试 36/36 通过；npm test 1234 通过/1 失败，那唯一失败在 `test/inbound.telegram.test.mjs`（审批卡 ref 单次核销、时序相关的轮询投喂），属另一并行 workstream 的 channel 文件、与本提交隔离、超出本任务所有权，故不修复（按任务约束不触碰）。verify-release / channel-matrix --check / node --check / git diff --check 全绿。只提交自有三文件，暂停于 commit。