# Workstream: issue14-images

- Agent identity: `terra_issue14_images | gpt-5.6-sol | shared Windows workspace`
- Agent: `terra_issue14_images`
- Branch: `codex/issue16-host-events` (shared parent branch; no checkout during parallel work)
- Status: done
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Wire fail-closed inbound image envelopes for QQ, WeChat iLink, and DingTalk without claiming real-device support.
- Plan: 1. Map each transport's existing parsed payload to the shared inbound message model. 2. Add bounded optional image attachment/download handling that cannot block text/control handling. 3. Add adversarial tests for malformed media, source binding, replay, and resource bounds. 4. Review diffs, run focused and full validation, then commit/push the isolated change.
- Owned files: `src/inbound/message.mjs`, `src/inbound/qq-gw.mjs`, `src/inbound/dingtalk-stream.mjs`, `src/channels/wechat-ilink/{protocol,legacy-core,index}.mjs`, relevant inbound/channel image tests
- Do not touch: `src/index.mjs`, `src/admin/**`, `src/control/**`, release/docs handoff surfaces, other agents' workstreams
- Validation: focused image/inbound suites 108 pass; `npm test` 1151 pass + 1 skip; `node scripts/verify-release.mjs` pass; `node scripts/gen-channel-matrix.mjs --check` pass; syntax and diff checks pass
- Adversarial review: rejected unknown image fields from the shared normalizer as a control-envelope bypass; URL scheme/credentials, dimensions, missing URL, over-limit body/header, timeout, replay, and sender whitelist paths have focused coverage. Optional iLink media adapters receive AbortSignal, timeout, and 5 MiB maximum; their result is never persisted.
- Handoff: Issue #14 is code-level complete and contract-tested for QQ C2C `extra`, iLink item_list, and DingTalk picture/image URL shapes. Real provider payload variants, signed/media-id download semantics, and on-device rendering remain unverified; no real-device claim is made. End-of-task documentation audit found stale statements in `docs/architecture.md`, `docs/memory/risks.md`, `HANDOFF.md`, and `CHANGELOG.md`; the assigned scope explicitly forbids touching them, so the parent must reconcile them before release. Code commit `3042bd6`.
