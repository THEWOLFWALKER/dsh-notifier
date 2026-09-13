# Workstream: p1-3-state-stress

- Agent identity: `ox-alpha / span/ox-alpha / Linux sandbox x64 (root, Node v22.23.2, kernel 6.8.0-136-generic)`
- Branch: `codex/p1-3-state-stress`
- Status: `done`
- Start/end: `2026-08-23 -> 2026-08-23`
- Scope: P1-3 跨进程状态压力——真实多进程实测 state.json 并发写、锁恢复、mtime 读收敛、损坏取证自愈与崩溃注入；确认缺陷则最小修复。
- Plan（实际执行）:
  1. 基线核验：接管时 `main@5d9fdfa`，npm test 902/902 全过（66s）。
  2. 通读 `src/inbound/store.mjs` 锁/合并/收敛实现与既有 store 测试。
  3. 一次性多进程 harness（`scripts/tmp-p13-stress.mjs`，验证后已删除）跑 9 个场景。
  4. 对抗性 review 确认 1 个缺陷并修复；+4 回归测试。
  5. 全量验证 + 文档同步。
- Stress evidence（一次性 harness 实测，非 mock）:
  - S1/S1b/S1c 不相交键并发：6 写者×10 键×10 轮=60 键全在盘（253ms）；8 写者×25 键×20 轮=200 键全在盘（2055ms，~4000 次抢锁零丢失）。
  - S2 高碰撞：4 写者×15 键×30 轮=60 键全在盘（583ms）。
  - S3 读收敛：CLI 写入后宿主 50ms 轮询内 ~3ms 收敛可见，既有键不丢。
  - S4 损坏自愈：同实例运行中文件被外部写坏 → save 双取证（boot copy + save rename）、内存全量重建、凭证键存活。
  - S5 崩溃注入：15 个写者 SIGKILL 风暴，文件始终可解析（原子 rename 生效），300 键无损。
  - S6 陈锁回收（mtime>10s）：当场恢复，0ms。
  - S7 新鲜活锁：两轮等待 488ms 后降级强写，他人锁内容不被触碰——**暴露缺陷**。
  - S8-clean 脏键优先级：host dirty 键被 CLI 覆写后收敛以 CLI 为准（设计语义：收敛时 dirty 仅保护「本实例未再写」场景；同键双活写 = 每键 last-writer-wins，v0.6.3 设计如此）。S9 同键交替写入验证一致。
- Adversarial review:
  - **确认缺陷（已修）**：陈锁判据只有 mtime>10s。持锁进程 kill -9/断电/OOM 后，新鲜残锁最长 10s 不被判回收——窗口内每次 save 白等两轮 ~480ms 再降级无锁写入（丢写保护失效；S7+S8 污染实测两进程双双降级）。修复：属主落章 `pid:random` 格式 + 锁龄>500ms 宽限后 `kill(pid,0)` 探测，ESRCH 当场回收；存活/EPERM/畸形内容维持旧行为，方向保守绝不提前抢活锁。三个回收点统一走 `recoverableLock()`。
  - 复核为设计语义（不动）：同键双活写 last-writer-wins（键级合并只保证不相交键不丢）；refreshIfChanged 节流 500ms（可接受延迟，非丢数据）；锁超时降级保留（持锁者活但极慢时的可用性保底）。
  - 攻击面检查：探测只读锁文件内容且永不写/删外来格式锁；pid 探测无注入面；无新增凭据/日志泄露；失败方向与原实现一致。
- Owned files: `.agents/workstreams/p1-3-state-stress.md` · `src/inbound/store.mjs` · `test/inbound.test.mjs` · `CHANGELOG.md` · `HANDOFF.md` · `README.md` · `README.zh-CN.md` · `package.json`(testCount) · `docs/KNOWLEDGE_BASE.md` · `docs/TECHNICAL_DEBT.md` · `docs/memory/project-state.md`
- Do not touch: 其他 workstream 保留文件；admin UI；渠道 adapter 协议面——均未触碰。
- Validation: `npm test` 906/906（67s）· `node scripts/verify-release.mjs` ok(tests=906) · `node scripts/gen-channel-matrix.mjs --check` ok(27 渠道) · `node --check src/index.mjs` ok · `git diff --check` ok
- Known gaps: P1-3 余项——stale `file:`/copied-install 行为归 P0-2 registry 验收流程；SDK 重连/销毁生命周期归 P2-3 兼容矩阵；防御性 catch 覆盖已在 P1-2 完成。Windows 主机未复跑（pid 探测在 Node 全平台可用，EPERM→视同存活保守正确，但建议下一位在有条件时复验 4 项新测试）。
- Handoff: 1 个逻辑 commit `8f442f1` 推送至私有仓库；测试契约 902→906（四处引用同步：双 README 徽章/正文、HANDOFF、package.json dshQuality）。2026-08-23 已 no-ff 合并回 `main`（merge `52c467a`），分支退役。下一步见 HANDOFF 当前接力交代。
