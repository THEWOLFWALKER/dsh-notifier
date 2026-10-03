# Stage 4 acceptance record

Updated: 2026-10-03. Branch: `dev`. Package: 0.13.1, unpublished. The previous Stage 3 acceptance summary was stale and is superseded by this record. Stage 4 is being executed in the requested order, P2 through P5; only phases with recorded evidence below are complete.

## Phase record

| Phase | Result |
|---|---|
| P2 | Complete. Removed unused daily browser controller/state/navigation surface and unused Recovery launch RPC. Commit `6c9e72c6788d0d967adfce58e6c37656bed3f3f5`, pushed to `dev`. Focused tests passed; full Node suite 2468/2468 and DOM suite 41/41 passed. |
| P3 | Complete. Enforced checked dsh-im contract v1, validated recipient and account fingerprint before send, removed unsupported guessed config importer, and classified ambiguous sends as unknown. Commit `128ff9a9a33cea90b07ac3c5bfb281989535da91`, pushed to `dev`. Bridge tests 13/13, acceptance tests 3/3, and full Node suite 2455/2455 passed. |
| P4 | Complete. Removed the unshipped cloud-store fake and speculative contract documentation; narrowed package contents and updated product metadata/project status. Focused package/docs tests 13/13; release guard passed; dry-run tarball 211 files, forbidden internal files 0. Committed and pushed to `dev`. |
| P5 | Complete. Adversarial review found that callers could request a public bind address for the Recovery server; the factory now hard-codes loopback and a regression test covers a `0.0.0.0` override. Admin server/Origin tests 33/33, Node suite 2447/2447, DOM 41/41, release guard, 28-channel matrix, and host compatibility guard passed. Committed and pushed to `dev`. |

## Evidence boundaries

- No live Cloudflare account, Telegram/APNs device, or complete DSH host environment is available in this worktree; local tests do not establish public-account or device delivery.
- The dsh-im bridge is limited to the checked v1 contract. The package does not claim generic dsh-im interoperability or config import.
- P2/P3 pass results above describe those commits. They are not evidence that P4/P5 gates have passed.

Only `dev` is in scope. Do not merge `main`, tag, create a GitHub Release, or publish to npm.
