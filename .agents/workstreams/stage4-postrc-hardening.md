# Workstream: Stage 4 Post-RC Hardening

- Agent identity: Codex | GPT-6 | Work Mode scratch
- Agent: /root
- Branch: dev (explicit task instruction)
- Status: done
- Start/end: 2026-10-03 -> 2026-10-03
- Scope: Continue Stage 4 from P2 through P5 on the fetched origin/dev baseline, with focused validation and a commit/push after each P.
- Plan:
  1. P2 prune unused browser controller/state/navigation; verify client and DOM; commit/push.
  2. P3 enforce dsh-im checked contract v1 and remove guessed config importer; verify; commit/push.
  3. P4 remove unshipped fake cloud storage, prune package metadata/docs, reconcile project truth; focused package/docs tests 13/13, release guard pass, tarball 211 files with 0 forbidden internal paths; commit/push.
  4. P5 adversarial security, RPC, package, and regression audit; run final gates; commit/push. Complete: forced Recovery server loopback binding, checked packaged-document links, and reconciled project memory/status.
- Owned files: Stage 4 source, tests, package metadata, and developer handoff files.
- Do not touch: main, tags, releases, npm publication.
- Validation: P2 focused client/invariant tests, `npm test` 2468/2468, and DOM 41/41. P3 bridge tests 13/13, acceptance tests 3/3, and `npm test` 2455/2455. P4 package/docs 13/13, release guard pass, and package dry run with 211 files/0 forbidden internal paths. P5 admin server/Origin tests 33/33, `npm test` 2447/2447, DOM 41/41, release guard pass (independent count 2447), 28-channel matrix pass, host compatibility pass, syntax checks and `git diff --check` pass.
- Adversarial review: P2 checks the client controller object for removed legacy capabilities and scans production client source for retired RPC strings; Native epoch replacement still clears stale Native detail. P5 found and closed the Recovery server's caller-supplied public bind override. Package entry-document links now resolve only to files covered by the npm allowlist.
- Handoff: P2 completed and pushed as `6c9e72c6788d0d967adfce58e6c37656bed3f3f5`; P3 completed and pushed as `128ff9a9a33cea90b07ac3c5bfb281989535da91`; P4 completed and pushed as `6b9109b` plus handoff follow-up `6c30396`. P5 final changes are committed and pushed to `dev`.
