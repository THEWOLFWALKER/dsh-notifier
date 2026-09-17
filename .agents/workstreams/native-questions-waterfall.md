# Workstream: native-questions-waterfall

- Agent identity: `captain-dsh | glm-5.3 (zai) | mcaipgx02 (chinto's Mac)`
- Agent: `captain-dsh`
- Branch: `codex/native-questions-waterfall`
- Status: `done`
- Start/end: `2026-09-17 -> 2026-09-17`
- Scope: make the native questions bridge attach on real DSH hosts (waterfall seam), fix #27's probe crash, and give askQuestions interception-scoped cancellation with terminal-faithful late cleanup.
- Plan: (1) defensive service reads + ctx.inject optional-dep attach + waterfall interceptor; (2) AbortSignal into askQuestions with delivery guards and late-delivery reconciliation; (3) contract tests + deterministic regressions; (4) docs sync.
- Owned files: `src/host/native-questions.mjs`, `src/host/capability.mjs`, `src/index.mjs` (native bridge block), `src/questions/router.mjs`, `test/native-questions.test.mjs`, `test/host-capability.test.mjs`, `test/questions-web-first.test.mjs`, `CHANGELOG.md`, `docs/memory/risks.md`, `HANDOFF.md`, this file.
- Do not touch: approval paths, channel adapters, `src/control/*`.
- Validation: `npm test` (1636 pass), `node scripts/verify-release.mjs`, `node scripts/gen-channel-matrix.mjs --check`, `node --check src/index.mjs`.
- Adversarial review: CodeRabbit rounds on PR #30 (base-branch convention, race/lifecycle findings, late-delivery semantics — all addressed and confirmed); independent external design critique before implementation (cordis waterfall semantics, gateway retraction triggers, inject footgun).
- Handoff: `done`. Squashed history: 0a4cfac (fix(host): bridge attach — defensive reads, ctx.inject optional dep, waterfall interceptor) + 452b42a (fix(questions): interception-scoped cancellation, delivery guards, finalTextOf terminal presentation) + docs commit (CHANGELOG/risks/HANDOFF/this record). Real-host canary passed on the contributor's daily profile (boot line 宿主原生提问桥 已 attach（waterfall）, dual-surface ask_user_question end to end, single-select button card + multi-select numbered fallback parity). PR #30 (base main) awaiting maintainer review; known host-side limitation: GUI card not retracted when the bridge answers first (DSH-core ask() signal semantics — sketch in risks.md and the #27 discussion).
