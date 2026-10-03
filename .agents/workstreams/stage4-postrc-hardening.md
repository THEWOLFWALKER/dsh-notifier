# Workstream: Stage 4 Post-RC Hardening

- Agent identity: Codex | GPT-6 | Work Mode scratch
- Agent: /root
- Branch: dev (explicit task instruction)
- Status: active
- Start/end: 2026-10-03 -> active
- Scope: Continue Stage 4 from P2 through P5 on the fetched origin/dev baseline, with focused validation and a commit/push after each P.
- Plan:
  1. P2 prune unused browser controller/state/navigation; verify client and DOM; commit/push.
  2. P3 enforce dsh-im checked contract v1 and remove guessed config importer; verify; commit/push.
  3. P4 remove unshipped fake cloud storage, prune package metadata/docs, reconcile project truth; verify; commit/push.
  4. P5 adversarial security, RPC, package, and regression audit; run final gates; commit/push.
- Owned files: Stage 4 source, tests, package metadata, and developer handoff files.
- Do not touch: main, tags, releases, npm publication.
- Validation: P2 focused client/invariant tests, `npm test`, and `npm run test:dom`; later stages use their specified focused tests and final acceptance commands.
- Adversarial review: P2 checks the client controller object for removed legacy capabilities and scans production client source for retired RPC strings; Native epoch replacement still clears stale Native detail. DOM tests verify existing Native and secondary views.
- Handoff: P2 completed and pushed as `6c9e72c6788d0d967adfce58e6c37656bed3f3f5` (full 2468/2468; DOM 41/41). P3 checked bridge/importer removal and full 2455/2455 validation are complete. P4–P5 remain.
