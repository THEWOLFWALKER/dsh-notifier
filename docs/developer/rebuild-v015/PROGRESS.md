# v0.15 implementation and evidence

Planning baseline and current remote `dev`: `2542a3107e7d3795e6ba5b294a7a5b82052c3431`. The local branch is `dev`; the v0.15 implementation is committed locally as `ac84973` by `THEWOLFWALKER`.

## Stage status

| Stage | Status | Local outcome | Evidence limit |
|---|---|---|---|
| S0 contract and product facts | complete | Fixed-source DSH Host and dsh-im interface evidence; baseline and source crosswalk captured | Does not prove a live Host boot or external delivery |
| S1 private access and atomicity | complete | Private-only admission, `(channel, accountId, userId)` authority, immediate revocation, account-scoped task and interaction state, durable old-state backup/reset | Real provider identity and device behavior unknown |
| S2 delivery, runtime and Cloud | complete | Public API 0.8 evidence buckets and `{ drained }` flush; runtime generation fences; durable Cloud deployment checkpoint/readback and explicit retry | Real provider receipt and Cloud account effects unknown |
| S3 Native and retired product cleanup | complete | Native-first user journey and bounded RPC; removed standalone Admin Console, recovery listener, guessed dsh-im importer and automatic old-state conversion | A fresh real DSH Host boot and visual walkthrough remain unknown |
| S4 candidate evidence | local checks complete | Final local gates recorded below; package version is 0.15.0; no release or publish made | GitHub rejected the push with HTTP 403; real Host/provider/device/Cloud evidence remains unknown |

The user's one-click dsh-im configuration importer instruction was to skip that importer and continue the remaining work. Other fixed-source dsh-im delivery interface checks remain in scope.

## Final local gate run

| Gate | Result |
|---|---|
| Node | `npm test`: **2103/2103** |
| DOM | `npm run test:dom`: **43/43** |
| Release guard | `npm run verify:release`: pass (count 2103; package files/exports, package contents and documentation markers checked) |
| Channel matrix | `node scripts/gen-channel-matrix.mjs --check`: pass (28 channels) |
| Host compatibility | `node scripts/verify-host-compat.mjs`: pass (declared 0.1.7 peer range) |
| Syntax | `node --check src/index.mjs`; `node --check client.js`: pass |
| Package | `npm pack --dry-run --json`: **198 files**, `dsh-notifier-0.15.0.tgz`, 2,322,558 bytes |
| Diff | `git diff --check`: pass before final documentation changes; rerun before commit |

The first final Node run found only one stale test assertion that still named the deleted Admin Console; after updating it to check the Native member-page recovery path, the final Node suite passed 2103/2103. The release guard no longer imports the retired `src/admin/ui.mjs` or reads a removed HANDOFF count row; it checks the current Native vocabulary/client and the authoritative progress count. Its first rerun exposed that the Native source carries a major/minor contract marker (`v0.15`), not a package patch marker (`v0.15.0`); after correcting that contract check, `npm run verify:release` passed with 2103 discovered tests.

## Source-ID disposition

Every source record in `issue-crosswalk.json` now has a `v015_disposition`, grouped by its primary root. See [SOURCE_ID_DISPOSITIONS.md](SOURCE_ID_DISPOSITIONS.md). The original `status` values are planning-baseline review labels, not current implementation results. The guessed dsh-im importer is the sole feature explicitly skipped by user direction.

## External evidence still unknown

- Real DSH Host startup, Native rendering and Host-mediated RPC lifecycle.
- Real provider delivery receipts, private-chat identity evidence and device workflows.
- Real Cloud account deployment/recovery effects and Cloudflare tunnel lifecycle.
- Remote `dev` push: the final commit is local; HTTPS push returned `Permission to THEWOLFWALKER/dsh-notifier.git denied to THEWOLFWALKER` (HTTP 403), and the connected GitHub API write endpoint returned `Resource not accessible by integration` (HTTP 403). Remote `dev` remains at the planning baseline; the supplied credential currently cannot write this repository.

No `main` change, tag, GitHub Release or npm publish is included in this work.
