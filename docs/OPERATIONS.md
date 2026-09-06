# Operations Runbook

## Local Checks

```text
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
```

The current development baseline is `1531` tests (`1531` pass) on the v0.9.5 line (R1–R5 closed 2026-09-05). The published npm `latest` remains `0.9.0` (1352-test artifact) until v0.9.5 is published; the v0.8.6 artifact historically records `909`. Do not change `package.json`'s release count to make these baselines look identical. The public GitHub source mirror (`main`) is synced to v0.9.5. Desktop/host and provider protocol behavior still require real-device validation where noted below.

The project has no install step for runtime tests. Optional packages are needed only for the corresponding real inbound flows: Feishu SDK, QQ connector, or QR terminal rendering.

## State Directory

Use `$DSH_HOME/dsh-notifier` when `DSH_HOME` is set; otherwise the plugin falls back to `~/.dsh/dsh-notifier`. Keep `state.json`, ledger files, audit files, and lock/corrupt backups private. On a guided-bootstrap start the directory also holds `bootstrap-paircode.txt` (mode `0600`) carrying the one-shot pairing code — the startup log prints only its path. It is removed automatically once the code is redeemed, expires, or is revoked, and on any later start that is no longer in the guided state; delete it by hand if you abandon a first-time setup. Do not manually edit a live state file while DSH is running; use the admin API or route CLI so the store merge/lock protocol is preserved.

## First-Time Setup

1. Install the registry package with the DSH plugin command and select the real profile.
2. Enable the loopback admin UI if browser configuration is desired; open the exact URL printed in the `Web 管理台已就绪` startup line rather than guessing a port.
3. In the default personal-mode console, configure one outbound channel and use its per-channel test action. A failed channel reports its reason and does not hide other channel results.
4. Configure one inbound channel, pair the intended `(channel, userId)`, and verify `/whoami`.
5. Exercise one notification, one approval fallback, and one `ask_user` timeout before enabling unattended workflows. Use the console's **打开高级设置** only when session or binding controls are needed.

The Web admin console is the only control console and the full install-to-daily-use flow is in `docs/guide.md`. YAML remains an advanced/automation entry for operators who need it. The CLI-only upgrade and rollback procedure is in `docs/upgrade-guide.md` and its English counterpart.

## Diagnostics

| Symptom | First checks |
|---|---|
| No outbound delivery | Admin channel status, `channel-selfcheck.mjs`, adapter config resolution, stderr warnings |
| Inbound silent | Optional dependency installed, token/account fallback, paired composite identity, provider long-poll/WS logs |
| Approval did not apply | Original chat/channel, token age, first-arrival state, desktop fallback; never treat timeout as approval |
| Ask-user missing | Installed package version, `questions.enabled`, startup assembly log, `npm ls dsh-notifier` |
| `/pair` rejected as locked | Five failed attempts (wrong **or expired** code) lock that `(channel, userId)` for 10 minutes; wait it out or mint a fresh code from the admin members page |
| Bootstrap code unavailable | Read the path printed at startup (`bootstrap-paircode.txt`); if the write failed the log says so — mint a code from the admin members page instead. Re-mint is throttled to once per 10 minutes per process |
| Route seems ignored | `node scripts/route.mjs show`, then `route.mjs test <sessionId>`; check enabled channel filtering |
| Admin unavailable | `admin.enabled`, loopback port, Bearer token, 1 MiB request limit, SSE connection cap |
| Behavior differs on phone | Run protocol/real-device validation; mocks do not model provider payload limits, callback parsing, or QQ/WeChat iLink/DingTalk image payloads |

QQ single-chat native buttons, QQ group text fallback, and QQ/WeChat iLink/DingTalk image handling are contract-tested only. The loopback Web/admin UI now has a 阶段 2A `ask_user` settlement entry (`/api/questions` list + `/api/questions/:ref/settle` choose/reject, Bearer-gated, masked, through Control Core); desktop has no safe host interface for `ask_user`, so it has no settlement entry and dual-end sharing is not claimed. Issue #16/#14 remain pending real-device/host validation.

## Release Smoke Test

Before publishing, use a clean checkout or clean working tree, run `npm test`, run the release guard, regenerate the channel matrix in check mode, and compare the generated package manifest with the repository files. Then install the registry artifact in a disposable DSH profile, restart once, and verify the package version, `ask_user` assembly log, one outbound test, and one inbound command.
