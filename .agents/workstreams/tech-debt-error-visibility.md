# Workstream: tech-debt-error-visibility

- Agent identity: `Trae1 | Trae (SOLO) primary agent | Linux sandbox (Ubuntu 22.04, Node v22.16.0)`
- Agent: `Trae1`
- Branch: `codex/tech-debt-error-visibility` (from main @ `c03ffb9`, post-merge of hardening docs + P1-1)
- Status: done
- Start/end: `2026-08-20 -> 2026-08-20`
- Scope: P1-2 错误可见性审计（`docs/TECHNICAL_DEBT.md`）——全量扫描 src/ 的 356 个 catch 块（141 可见 / 139 有注释的刻意静默 / 7 UI 前端 / 61 无注释静默），逐个核实而非先入为主；修复其中「静默掩盖真实故障」的缺口。
- Audit findings (evidence-based, not presumption):
  - `_shared.mjs` 5 处「静默」为误报——catch 后全部分类重抛 NotifyError，可见性由 throw 保证，不动。
  - `ledger.mjs` 静默是文档化设计军规（账本失败绝不影响推送），不动。
  - `tokens.mjs`/`index.mjs verifyToken` 等 fail-closed 静默是安全正确行为，不动。
  - **真实缺口 1**：`approval/router.mjs resolveApprovalChannels` 路由异常静默回落 null → 审批卡广播全渠道；同函数的空集回落有 warn（v0.6.5 R4-1-P3-5），异常路径却没有——不一致，异常路径零可见。
  - **真实缺口 2**：`inbound/store.mjs loadBoot` 启动时状态文件损坏 → 静默 fail-open 空态，绑定表/待审批全部丢失零日志。v0.6.5 已在 save 路径建立 `.corrupt.<ts>` 取证保留惯例，boot 路径不一致。
  - **真实缺口 3**：`rules.mjs compileEntry` 非法正则静默降级字面量匹配——include-regex 规则语义反转（正则模式 vs 子串包含）可能导致通知静默停止或漏拦，用户无感知。模块自身纯函数无日志（设计如此），可见性应由调用方（event-listener）承担。
- Plan:
  1. `approval/router.mjs`：路由异常路径补 warn（与空集 warn 对仗），fail-safe 广播语义不变。
  2. `store.mjs`：`createStore(path, { onWarn })` 可选回调（默认 no-op，CLI 三处调用零改动）；loadBoot 拆分读失败（维持静默 fail-open）与解析失败（取证 copy 到 `.corrupt.<ts>`，非 rename 不破坏并发写者 + onWarn 告警）；index.mjs 装配点接 ctx.logger。
  3. `rules.mjs`：createKeywordFilter 增量返回 `regexFallbacks: string[]`（纯函数、只增不改）；event-listener 创建时非空即 warn。
  4. 聚焦测试：approval 异常分流 warn、boot 损坏取证+告警、regexFallbacks 暴露与 event-listener warn；全量验证；多轮多角度 review（实现者自审 + 攻击者视角 + 可靠性/协议回归视角）。
- Owned files: `src/approval/router.mjs`, `src/inbound/store.mjs`, `src/index.mjs`, `src/rules.mjs`, `src/event-listener.mjs`, `test/approval.test.mjs`, `test/inbound.test.mjs`, `test/rules.test.mjs`, `CHANGELOG.md`, `docs/TECHNICAL_DEBT.md`, `docs/memory/*.md`, `HANDOFF.md`, this workstream.
- Do not touch: ledger 静默军规、tokens fail-closed 语义、admin/ui.mjs 前端 7 处（已有 flash/setStatus 用户可见）、61 处中其余防御性读取（有明确语义、加日志属噪音）、`package.json` 版本、A3-A6 安全计划范围。
- Validation: focused `node --test test/rules.test.mjs test/inbound.test.mjs test/wiring.route.test.mjs` 76/76; full `npm test` 902/902 pass on this Linux host (post-merge main baseline also 897/897 before P1-2); `node scripts/verify-release.mjs` ok (documented tests=902); `node scripts/gen-channel-matrix.mjs --check` ok (27 channels); `node --check` all touched files; `git diff --check` clean.
- Adversarial review (four rounds, multiple angles, no presumptions):
  - Round 1 (attacker / resource exhaustion): found that the boot forensic `copyFileSync` duplicates the whole file (unlike save-path `rename` which is O(1)) — an anomalous multi-GB corrupt file would double disk usage. Fixed with an 8MB cap: oversized corrupt files warn without copying; the original stays in place for manual handling.
  - Round 2 (cross-cutting regression): verified no other tests assert `.corrupt` backup counts; verified `createKeywordFilter` is internal-only (not in public.mjs/PLUGINS.md/README) so the additive `regexFallbacks` field breaks no public contract; reran focused suites after each revision.
  - Round 3 (full-diff fresh re-read): found that an EMPTY state file would be classified as "corrupt" and trigger a loud warning + forensic copy — but an empty file (external touch / interrupted first write) has no memory to lose and no forensic value. Fixed: empty/whitespace-only file silently starts as `{}`; also verified read-failure (EISDIR/EACCES) stays distinct from parse failure (no forensic noise), and that copy does not disturb the source file mtime (read-convergence baseline intact, asserted by test).
  - Round 4 (pre-merge fresh re-read, no presumptions): re-read the complete `main..HEAD` diff as if authored by someone else. Verified `createKeywordFilter` has exactly one production call site (`src/event-listener.mjs:191`), so the fallback warning covers every assembly path. Grepped the whole tree for stale `897` — all remaining hits are historical statements ("891→897", "P1-1 contract was 897"), no stale contract counts. Found ONE real documentation defect: the HANDOFF "当前状态" table still listed the retired `codex/plugin-security-hardening` as the current branch, and the branch-topology line predated the P1-2 merge — fixed in the post-merge calibration commit on `main`.
  - Not fixed / accepted by design: `ledger.mjs` silence (documented module rule "账本失败绝不影响推送"); fail-closed silent catches in token verification (security-correct); `_shared.mjs` rethrow classification (visibility via throw). The remaining 58 uncommented-silent catches were individually verified as parse-fallback or best-effort cleanup paths where logging would be noise.
- Handoff: P1-2 landed on `codex/tech-debt-error-visibility` and was merged back into `main` (merge `1a720ab`; branch commit `fa96463`). Three silent-failure paths now visible: approval routing exception warn (fail-safe broadcast unchanged, tested), store boot corruption forensic copy + warn (copy-not-rename, 8MB cap, empty-file exempt, read-failure distinct, fail-open unchanged, tested x4), keywords regex fallback reporting via pure `regexFallbacks` + listener warn (tested). Test contract 897 -> 902 synced across package.json/READMEs x2/HANDOFF/KNOWLEDGE_BASE/OPERATIONS/TECHNICAL_DEBT/memory. Real-device closure items (TG clamp boundary, long-lived listener reconnect visibility, JSON-card payload evidence, BurntToast host, npm acceptance) recorded in `docs/memory/risks.md` for the next agent. Next local candidates: P1-3 state stress, P1-4 admin UI audit, A3-A6 security plan.
