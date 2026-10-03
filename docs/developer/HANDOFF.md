# Current handoff

Updated: 2026-10-03. Work is on `dev`, based on `3135257936d4bf4350c18e0abad9dc4ee213b424`. The requested sequence is Stage 4 P2 through P5. Package version remains 0.13.1; this work does not publish it.

## Completed

- **P2** removed unused daily browser controllers and their state/navigation wiring, plus the unused Recovery launch RPC. Commit `6c9e72c6788d0d967adfce58e6c37656bed3f3f5`; pushed to `origin/dev`.
- **P3** requires dsh-im checked contract v1, validates the target and account fingerprint before delivery, removes the guessed config importer, and treats ambiguous sends as unknown. Commit `128ff9a9a33cea90b07ac3c5bfb281989535da91`; pushed to `origin/dev`.
- **P4** removed the unshipped cloud-store fake and future-contract documentation, narrowed the npm package contents, and reconciled the handoff and deletion record. Focused package/docs tests passed 13/13; `npm run verify:release` passed; the dry-run package contains 211 files and no internal execution artifacts. Commit `6b9109b` is pushed to `origin/dev`.

## Current implementation notes

- Native daily controls are limited to notification and private chat; the Advanced Console is a read-only recovery report.
- Inbound group traffic is rejected before identity, pairing, or task routing. Outbound group notifications remain supported.
- dsh-im sends require the checked v1 contract and do not fall back to ordinary sends. Config-file import is not supported because no matching public export contract is available.
- No cloud-storage provider or cloud-storage placeholder is part of the product.

## Validation state

| Phase | Status |
|---|---|
| P2 | focused tests, full `npm test` (2468/2468), DOM tests (41/41), commit and push complete |
| P3 | bridge tests (13/13), acceptance tests (3/3), full `npm test` (2455/2455), commit and push complete |
| P4 | package/docs tests 13/13; release guard passed; dry-run package 211 files, forbidden internal files 0 |
| P5 | pending adversarial review and final gates |
| 测试 | `npm test` **2446 tests**（P4 runner count；P5 full run pending） |

P0/P1 details are in repository history. See [architecture](architecture.md), [deletion ledger](v015-deletion-ledger.md), and [Stage 4 acceptance record](v015-final-acceptance.md) for the current scope and evidence. Push only to `dev`; do not merge `main`, tag, create a release, or publish to npm.
