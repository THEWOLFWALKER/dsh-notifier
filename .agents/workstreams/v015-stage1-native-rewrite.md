# Workstream: v015-stage1-native-rewrite

- TASKPACK_ID: `DSH-NOTIFIER-V015-STAGE1-NATIVE-REWRITE-V2`
- Agent identity: `trae | TRAE SOLO CN | local offline`
- Agent: `trae`
- Branch: `dev` (owner authorized direct push to `dev`; no force, no main/tag/npm)
- Status: `active`
- Start/end: `2026-10-02 -> active`
- Baseline: `dev @ 4066cf4e33b44681b3be3da290ac3444790b9a6e` (offline source snapshot; local commit `snapshot: dev 4066cf4e`)
- Scope: execute TASKPACK `DSH-NOTIFIER-V015-STAGE1-NATIVE-REWRITE-V2` — rebuild the Native management UI and its user control surface. Supersedes `dsh-notifier-v015-detailed-handoff`, WP00–WP23, and `.agents/workstreams/v015-execution-handoff.md`.
- Plan: S0 cut legacy task line -> S1 new native read/action boundary -> S2 channel-centered responsive shell -> S3 channel detail + account cards -> S4 private chat + pending -> S5 secondary settings -> S6 user docs -> S7 stage gate. See the task pack `08_STAGE_PLAN.md`.
- Owned files: `src/native/**`, `client.js`, `test/native/**`, `test/dom/**` (native UI), `README.md`, `README.zh-CN.md`, `docs/user/**`, `.agents/workstreams/v015-stage1-native-rewrite.md`
- Do not touch: `main`, tags, npm publish, DSH host source, other agents' workstream files, `src/adapters/**`, real channel inbound implementations.
- Validation: focused tests per stage; S3/S5 focused native + control-surface suite; S7 full `npm test` + `npm run test:dom` + `node scripts/verify-release.mjs`.
- Adversarial review: secret never returned to browser; `accepted` never rendered as `confirmed`; no second store writer; no internal object shape leaked; irreversible effects keep durable guard.
- Handoff: S0 in progress — workstream created, legacy handoff marked superseded.