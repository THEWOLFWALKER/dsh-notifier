# workstream: core-distillation-v015

- **identity**: agent `flash`, task pack `dsh-notifier-flash-complete-taskpack` (T01–T30)
- **branch**: `codex/core-distillation-v015` (off `dev`)
- **status**: in progress — T01 done
- **owner scope**: core authority convergence, Native/Recovery UX, local config export/import, dsh-im
  bridge, remote URL, optional CF Tunnel, Workers/Pages extension package, docs/tests/delivery.
- **explicitly out of scope**: `main`, tags, npm publish, real cloud deploy, full encrypted secret
  backup, new multi-account product model, dsh-im bidirectional approval/session interop.

## T01 — baseline & drift

### Baseline (recorded 2026-09-30)

| Fact | Value |
|---|---|
| repo | `THEWOLFWALKER/dsh-notifier`, two-branch (`dev` dev / `main` release) |
| taskpack research baseline | `ae71ef7` (stale — do not lock HEAD to it) |
| current `dev` HEAD | `3326189` (`docs(v0.14): record audit-fixpack Stage G final gate`) |
| `origin/dev` | `3326189` (in sync; tree clean before branch) |
| version authority | `package.json` `0.13.1` (bumped only at release close) |
| test baseline | `npm test` → **2166 tests / 2166 pass / 0 fail / 0 skip** (~178s) |
| gates | `verify:release` ok (documented tests=2166); `gen-channel-matrix --check` ok (28); `npm pack --dry-run` ok (338 files) |
| runtime | Node ESM ≥22, zero mandatory runtime deps, no build step |
| channels | 28 outbound adapters, 6 inbound control channels |

### Drift: taskpack baseline → current dev

The pack's research baseline `ae71ef7` is 7 commits behind current `dev`. Those 7 commits are the
**v0.14 dev audit fixpack** (Stages A–G) already landed:

| commit | stage | concern |
|---|---|---|
| `2978f31` | A | separate adapter live runtime object from frozen projections (fixes #45/#46) |
| `ce150ff` | B | atomic multi-key commits + commit-before-publish session state |
| `f5c6f35` | C | unify outbound runtime truth across projection and diagnostics |
| `3c4ac28` | D | merge caller abort signal with local question race signal |
| `74adde9` | E | native session detail, destructive confirms, redacted identifiers |
| `e309f54` | F | single revision/activity owner + support-report secret audit |
| `3326189` | G | final gate record |

**Consequence for this pack**: several pack tasks are partially pre-satisfied. Per pack rule
("已经修好的问题验证后标 done，不重复实现"), T08 (frozen resolved config via real assembly) and
T04 (narrow transaction semantics) must start from the *post-Stage-A/B* state, not rebuild it.

### Open issues / PRs (remote, 2026-09-30)

| # | kind | title | disposition |
|---|---|---|---|
| 46 | issue | outbound config deep-frozen → qq-bot/wecom-app send fails | root cause fixed in Stage A (`2978f31`); verify + close |
| 45 | issue | v0.12 outbound source JSON-clones + deep-freezes resolved adapter config | same as #46; verify + close |
| 26 | issue | QQ C2C markdown+keyboard real device: buttons not rendered | **stays open** — real-device evidence gap, not a code task |
| 25 | issue | announcement (maintainer exam period) | informational only |
| — | PRs | none open (latest merged PR #44 `release: land v0.13.1 follow-up`) | n/a |

### Host capability drift

- Declared peer: `@deepseek-ai/dsh-session` **exact** allow-list
  `0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2` (optional peer).
- npm registry `dist-tags`: `latest=0.0.1-rc.1`, `alpha=0.1.7-alpha.2`, **`next=0.2.0-rc.2`**.
  So the pack's DSH target `0.2.0-rc.2` exists upstream but is **not** in the declared range.
- Pack rule: **do not auto-widen** the declared range (T13 audits seams; range change only after
  source-seam audit + fixture tests + real-host smoke, and only if explicitly re-verified).
- `@deepseek-ai/cordis` peer `^4.0.1`.

### Writer inventory (store key → production writers)

Baseline store primitive: `src/inbound/store.mjs` `createStore().transact(mutator)` returns
`{ ok, committed, durable, code, value }`; lock is acquired before read, mutator gets a **detached
draft**, disk+memory publish only after atomic `renameSync`. Helpers `setDurable` / `transactDurable`
/ `deleteDurable` (store.mjs L455/L476/L497) normalize the committed judgement. `false` is **not** an
abort signal; only explicit failure is failure; `undefined` from legacy mock stores counts as success.

| store key / record | production writer(s) | owner verdict |
|---|---|---|
| `inbound:bindings` | `inbound/identity.mjs` (`writeBindings` L140, clean L173, migrate L369, redeem L493) | single module — OK |
| `inbound:pending` | `inbound/identity.mjs` (L193, L466, L492, L535) | single module — OK |
| `inbound:migrated` | `inbound/identity.mjs` (L362; same tx as bindings L369) | single module — OK |
| `inbound:pairing` | `inbound/pairing.mjs` (prune L135, redeem tx L304) | single module — OK |
| `inbound:pairing:lockout` | `inbound/pairing.mjs` (L171) | single module — OK |
| `route:agents` | `routing/agent-router.mjs` (`setAgentBinding`), via CLI/admin/router | router is owner |
| `route:channels` | `routing/agent-router.mjs` (`setChannelDefault`) | router is owner |
| **`route:sessions`** | **`routing/agent-router.mjs` (commitSessions L178-197, outbound diff L502-559)** **+** **`routing/session-registry.mjs` (persist L195-254)** | **TWO writers — T14 target** |
| `channel:<type>:outbound` | `control-surface/outbound-config.mjs` (L212/287/294/298/378), `control-surface/channel-config-migration.mjs` (L63) | multi-writer — T08 target |
| inbound `channel:…` / account keys | `inbound/channel-config.mjs` (L179/191/241/249), `inbound/_feishu-register.mjs` (`feishu:account` L158), `inbound/_qq-scan.mjs` (L125) | multi-writer — T08 target |
| `aq:<id>` (questions) | `questions/router.mjs` (L314, L1056) | single — OK |
| approval rows | `approval/router.mjs` (L346, L597) | single — OK |
| action rows | `actions.mjs` (L132, L161) | single — OK |
| interaction ledger rows | `interaction/ledger.mjs` (L65/77/86/141/154) | single — OK |
| inbound dedup rows | `inbound/bus.mjs` (L129, L143) | single — OK |
| conversation bindings | `inbound/conversation.mjs` (L336, L646, L763) | single — OK |
| `taskselect:*` | `routing/task-selection.mjs` (L128) | single — OK |
| `tg:offset` | `inbound/telegram-bot.mjs` (L320) | single — OK |
| `wechat:sync_buf`, wechat ctx token | `channels/wechat-ilink/legacy-core.mjs` (L353, L208) | single — OK |
| `dingtalk:robot-code` | `inbound/dingtalk-stream.mjs` (L360) | single — OK |
| `wxpusher:webhookPath` | `assembly/inbound-signals.mjs` (L108) | single — OK |
| `wxpusher:bind:<uid>` | `inbound/wxpusher-callback.mjs` (L219) | single — OK |
| `admin:token-hash` | `assembly/admin-token.mjs` (L38) | single — OK |
| `state:schema-version` | `control-surface/channel-config-migration.mjs` (L11/L63) | single — OK |

**Highest-priority multi-owner keys**: `route:sessions` (T14), outbound/inbound channel config
(T08). These two are the pack's core convergence targets and are confirmed still multi-writer after
the v0.14 fixpack.

### Risks carried into execution

- `.agents/` is git-ignored but force-tracked (273 files); new workstream files need `git add -f`.
- Pack forbids widening the DSH peer range; 0.2.0-rc.2 seam work is audit-only unless evidence lands.
- Real-device/provider evidence (QQ keyboard #26, Feishu P2P, DingTalk stream, QQ gateway) stays
  `unverified`; must not be relabeled.

## Task status

| Task | Status | Commit | Evidence |
|---|---|---|---|
| T01 | done | (this commit) | baseline table, drift table, writer inventory above |
| T02–T30 | not started | — | — |