# Workstream: v015-release-closeout

- Agent: Codex / root
- Branch: codex/v015-release-closeout (integrate dev at each milestone)
- Status: active
- Start: 2026-10-01
- Scope: Gate 4–9, including CF per owner instruction 2026-10-01.
- Plan: Native portability with explicit selection and staged drafts; downgrade unverified dsh-im integration; pin and inspect Wrangler/upstream Worker sources; implement opt-in deployment authority and shared Telegram gateway seam; wire Native deploy/link/unbind; copy cleanup; adversarial review; core/DOM/protocol/local Worker/pack/install checks; dev CI; release metadata; main CI/tag/release/npm/install.
- Owned files: client.js, src/control-plane/config-portability.mjs, src/cloudflare/, src/adapters/telegram.mjs, src/inbound/telegram-bot.mjs, config schemas, src/index.mjs, src/control-surface/service.mjs, test/, .github/workflows/ci.yml, release docs/metadata.
- Risks: cloud resource creation and local save are separate; preserve owned resource metadata before retry; credentials never argv/logs; single job and disposal cancellation; new import channels remain inert; real CF/APNs evidence pending and documented.
- Validation: focused tests + npm test + test:dom + local Wrangler/D1 + verify:release + matrix + host + perf + tar install + CI.
- Review: pending.
- Handoff: in progress.

- Owner update 2026-10-01: TG one-click deploy -> structured endpoint readback -> automatic fill/save; shared bot token for cloud authentication and both directions; custom base supports ordinary Bot API reverse proxy. No independently generated gateway key.
- Focused evidence: 14 gateway/deployment tests, 8 real React release UI tests, 3 local workerd/D1 tests, 60 admin/CI/writer-fitness tests passed before token-rotation guard. Full release validation pending.

- Review: fixed deployment activation/readback separation, same-token rotation guard, subprocess abort/output ownership, staged import lifecycle, custom gateway compatibility, and docs/package relocation. dsh-im upstream does not certify experimental fixture interfaces.
- Validation: full core 2462 pass / 0 fail / 0 skip; DOM/workerd 32 pass; host-compat, channel matrix, release guard, perf and package dry-run pass. npm identity unavailable (ENEEDAUTH); registry publish remains blocked.
- Implementation commit: f7bae5f. Documentation relocation and release synchronization follow separately.

- Latest owner direction: only push dev; main remains unchanged. No tag/GitHub Release/npm publication in this closeout. GitHub credential usage for this repo push explicitly authorized on 2026-10-01.
- Final local validation: core 2465 pass / 0 fail / 0 skip; DOM/workerd 33 pass. Added Native named-tunnel configure/start/stop/status with real authority DOM coverage, no downloader or automatic startup.
