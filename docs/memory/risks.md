# Recurring Risks

- Mock tests do not cover provider payload limits, legacy markdown parsing, callback size limits, or SDK lifecycle behavior. Changes touching those areas need protocol or real-device validation.
- Optional inbound dependencies are lazy-loaded; a missing package must produce a visible diagnostic and leave unrelated channels alive.
- Windows desktop toast cannot run in the headless CI matrix; keep `desktop` validation local when touching that adapter.
- `state.json` is shared by the running host and CLI tools. Direct manual edits or bypassing store setters can reintroduce lost updates and stale route reads.
- Version drift can happen through stale `file:` installs or hand-copied `node_modules/dsh-notifier`; use registry installation for acceptance.
- The current release artifact has a known non-runtime `CHANGELOG.md` difference from the engineering archive; resolve or document it before publishing.
- Historical handoff/test-note documents can retain old versions, commit ids, package counts, or green-test claims; treat documentation drift as an operational defect and reconcile it before delegating work.
- Same-process DSH plugins are trusted code, not an isolation boundary. `ctx.emit`, `ctx.provide`, Cordis fibers/isolate, session permission presets, and `node:vm` dynamic-host wrappers do not protect notifier credentials or event content; see `docs/security/PLUGIN_ATTACK_REVIEW.md` and the official Harness architecture evidence recorded there.
- A1/A2 fixed the public notifier event disclosure and directed-send audit gap on `codex/plugin-security-hardening`: cross-plugin events are metadata-only and directed sends share the internal audit callback. Remaining A3-A6 work is tracked in `docs/security/PLUGIN_SECURITY_FIX_PLAN.md`.
