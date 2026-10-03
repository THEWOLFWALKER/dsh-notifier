# v0.15 Stage 3 final acceptance

Date: 2026-10-03. Branch: dev. Package: 0.13.1 (unpublished development work).
Author/committer: THEWOLFWALKER, existing repository email. Baseline: remote 4066cf4e33b44681b3be3da290ac3444790b9a6e, followed by user-authorized offline import 830d7b58781859dc50916c3764d85a4425e6ea09. No old snapshot replaced remote history.

## Phase commits

| Phase | Commit |
|---|---|
| P0 corrective | 6f33b87e6e4ef96723f549f76f534fa6125d8b6d |
| P1 cleanup | afb069add18d27372723944d91dbfa85fa47b609 |
| P2 private/copy | 7d2cc85c86791bae259b1d47831d726c9597bb06 |
| P3 failure/capacity | 845699b3307a3e39664ca5e55ecfe21847faa631 |
| P4 docs/package | 0925359cf32019aa8e3689f77a3cda5764304f92 |
| P5 final gate | The commit containing this record; see git log. |

Every phase ran focused tests and diff review before commit/push. Gate failures in P5 exposed obsolete recovery/group fixtures and a real group-rejection reply backlog. The fixtures were replaced with public behavior tests; group rejection no longer queues a group reply, and recovery startup only reads diagnostics. Initial failed P5 run was stopped because failed QQ tests retained connections. Final results below refer to the repaired tree, not that interrupted run.

## Acceptance cases

| ID | Result and proof |
|---|---|
| F01 | PASS: account-isolated selection, restart/router/Native action and uniquely proven legacy migration; `v015-p0-corrective` |
| F02 | PASS: replacement allocates one generation, observations preserve it; runtime/core behavior tests |
| F03 | PASS within deterministic service/disk evidence: readback resume, lost response, failed receipt write, every durable step, failed apply; `cloudflare-release`. Public account evidence BLOCKED below. |
| F04 | PASS: jobs/deployment rows contain references/fingerprints, no Bot Token copy; durable row assertions |
| F05 | PASS: cancel persists intent, retains created resources across restart; Cloud behavior tests |
| F06 | PASS: manual endpoint changes survive unbind; Cloud tests, credential generation guards |
| F07 | PASS: Node summary reports 2498 leaf tests; independent reporter/release guard also reports 2498; metadata equals both |
| F08 | PASS: no daily Sessions/Bindings/Members pages; S2–S5 React navigation tests and deletion ledger |
| F09 | PASS: six ingress types reject group messages/callbacks before routing; provider tests plus shared admission tests |
| F10 | PASS: registered dictionaries, vocabulary, inline words and user docs pass forbidden vocabulary lint |
| F11 | PASS: captured old generations never update current health; runtime/health tests |
| F12 | PASS: accepted and confirmed remain distinct in data and visible results; delivery/DOM tests |
| F13 | PASS: unknown/partial sends are not blindly replayed; notify/segment/interaction tests |
| F14 | PASS within owned service evidence: bounded histories/waiters/previews/maps, runtime disposal and Cloud startup terminal sweep; 1000 sends, 500 private events, 1000 replacements/status reads and provider group flood |
| F15 | PASS: dry-run contains 223 files, forbidden paths 0; all six obsolete screenshots removed, four current captures included |
| F16 | PASS: recovery HTML has only the report page; authenticated startup requests only diagnostics, never old daily APIs |
| F17 | PASS: all final gates green; results below |
| F18 | PASS: only dev commits/pushes; no main/tag/release/npm publish |

## Final gate

| Check | Final result |
|---|---|
| `npm test` | 2498/2498 pass; 10 suites; 0 fail/cancel/skip/todo; 43.485 s |
| `npm run test:dom` | 41/41 pass; 0 fail/cancel/skip/todo; 8.137 s; includes local workerd and real React assembly |
| `npm run verify:release` | PASS; v0.13.1, independently counted 2498 leaf tests |
| `node scripts/gen-channel-matrix.mjs --check` | PASS; 28 channels |
| `node scripts/verify-host-compat.mjs` | PASS; alpha.1 / alpha.2 / rc.1 / rc.2 exact declared versions |
| `npm pack --dry-run --json --ignore-scripts` | PASS; 223 files; only four current Native screenshots |
| User copy / local docs / package focused | 11/11 pass after documentation reconciliation |
| Package forbidden scan | 0 test/node_modules/.agents/.wrangler/.env/cache/coverage/obsolete-screenshot paths |
| `git diff --check` | PASS |
| Git identity / branch | THEWOLFWALKER for author and committer; dev only |

No source change followed the green full/DOM tests. Subsequent edits update developer documentation and gate records; their focused checks passed. P5 is committed and pushed after diff review. Final branch cleanliness and remote alignment are checked after push.

## BLOCKED

- No public Cloudflare account, live Telegram/APNs device, or complete real DSH Host environment is supplied. This run adds local workerd, fixture protocol/service and actual React behavior evidence; it does not claim fresh public account/device/host verification.
- If the create response and durable receipt are both unavailable, Wrangler deployment-list output may contain only versions. With no endpoint, recovery stays `recovery-required`, retains ownership, and never blindly recreates. The explicit negative test proves this safe behavior. Complete real-account endpoint recovery remains BLOCKED.
- Current upstream dsh-im public delivery service is unproven; existing bridge/import stays experimental and is not marketed as supported interoperability.

## Change volume

Production code means `src/**` plus `client.js`, measured by Git text numstat.

| Scope | Added | Deleted |
|---|---:|---:|
| Stage 3 only, after offline import 830d7b5 | 882 | 2272 |
| Entire authorized dev work, from remote 4066cf4 including Stage 2 import | 3711 | 2494 |

Six obsolete screenshot files were removed and four actual Native captures added. Counts exclude binary pixels; added/deleted lines are diff volume, not a claim about changed logical statements.

## Native screenshots

Rendered production `client.js` through its real module-loader/apply entry using React 18, Chromium, fixed public read-model examples and DSH token values. No secret values. This is Native UI rendering evidence, not an installed DSH Host walkthrough.

[Desktop](../screenshots/native-v2-desktop.png) · [390px mobile](../screenshots/native-v2-mobile.png) · [Channel settings](../screenshots/native-v2-channel.png) · [Private chat](../screenshots/native-v2-private.png)
