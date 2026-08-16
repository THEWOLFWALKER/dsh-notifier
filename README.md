# dsh-notifier

Unified notification push plugin for DeepSeek Harness (DSH). One minimal `notify()` API in front, many channels behind — both your agent and the harness itself can push to wherever you live.

## Features

- **Dual trigger lines**:
  - **Auto status push** — listens to `session/event` (`turn/end`, `approval/asked`, `agent/error`) and notifies you when tasks finish, fail, or need approval. Debounced 10s, deduped by session.
  - **Agent-initiated** — registers a `notify` tool so the model can call it directly (e.g. when it finishes a long task or needs a decision).
- **26 channels out of the box** (zero runtime deps — only `fetch` + `node:crypto`), from a declarative spec engine (see the [channel matrix](#channels) below):
  - IM webhooks: Telegram / Slack / Discord / Feishu (signed) / DingTalk (HMAC signed) / WeCom / WeCom app / QQ official bot / OneBot 11 / Teams / Mattermost / Google Chat
  - Push apps: Bark / Pushover / PushDeer / Chanify / ntfy / Gotify / iGot
  - China ecosystem: WxPusher / PushPlus / Server酱 / Qmsg / 息知 — plus a generic `webhook` for anything else, and a local terminal `bell`
- **Level-based routing** — `timeSensitive` / `active` / `passive` levels map to per-channel delivery semantics (silent push, priority headers, @-mentions) with tiered retries.
- **Remote approval (optional)** — answer agent approval requests from your phone via Telegram buttons; silence never approves, falls back to the desktop. See [Remote Approval](#remote-approval-双向回传可选).
- **Remote conversation (optional)** — chat with your agent from your phone: plain text is delivered as `followup` (idle) or `inject` (busy), `!` prefix steers mid-turn, and a merge window reassembles rapid-fire mobile typing. See [Conversation](#conversation-远程会话可选).
- **Multi-agent routing (v0.3.2)** — a bidirectional many-to-many matrix between agents and channels: outbound `route:agents` (keyed by workspace name by default, exact agentId as the advanced key) and inbound `route:channels` defaults; sessions auto-register on creation, `quiet` mutes the outbound push only, and approvals split-route to the bound channels — plus an `/agent` command family and a `scripts/route.mjs` CLI. Zero-config setups behave exactly as before. See [Multi-agent routing](#multi-agent-routing-v032).
- **Web admin console (v0.3.3, optional)** — a local web console (127.0.0.1-only + Bearer token): channel health overview, binding matrix, per-session outbound overrides, and credential create/test/QR-scan; YAML is bootstrap-only, runtime state lives in `state.json`. See [Web admin console](#web-admin-console-v033).
- **Long-message segmentation** — outbound messages over the per-channel budget are split into `（i/n）`-prefixed segments, delivered in order; any segment failing fails the whole send.
- **Anti-disturb rules** — per-result event gating, keyword include/exclude (literal or regex), and an idle grace window: if you type within `graceSeconds` after a turn ends, the notification is cancelled. See [Rules](#rules--local-bell-防打扰规则可选).
- **Notification ledger & daily digest (optional)** — every broadcast is appended to a local JSONL ledger; on startup you get one `passive` summary of yesterday's traffic. Ledger failures never affect delivery. See [Ledger](#ledger--daily-digest-通知账本可选).
- **Channel health check** — an agent-facing `notify_test` tool plus a standalone CLI (`scripts/test-channel.mjs`) verify a channel end-to-end (config → resolve → send) without touching your real notification semantics.
- **Tool rate limiting** — the `notify` tool is capped by a sliding window (`toolRateLimitPerMinute`, default 10/min, `0` = off), so a prompt-injected agent can't flood your channels.
- **Secrets safe** — channel keys marked `role('secret')`, redacted everywhere including custom webhook headers; `${ENV:NAME}` references keep secrets out of your profile.
- **Never breaks startup** — misconfigured or missing channels are skipped silently with a log line.

## Install

```bash
dsh plugin add dsh-notifier
```

## Configuration

Add channels to your profile patch (`cordis.patch.yml`):

```yaml
insert:
  - id: dsh-notifier
    name: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "123456:ABC-DEF..."
          chatId: "987654321"
        - type: dingtalk
          webhook: "https://oapi.dingtalk.com/robot/send?access_token=..."
          secret: "SEC..."
        - type: feishu
          webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/..."
        - type: wxpusher
          appToken: "AT_..."
          uids: ["UID_..."]
        - type: pushplus
          token: "..."
        - type: serverchan
          sct: "SCT..."
        - type: bark
          key: "your-device-key"   # or selfHost: "https://your-bark-server"
        - type: webhook
          url: "https://your-webhook"
          headers: { "x-token": "..." }   # optional
```

## Usage

### Auto push

Just enable the plugin. `turn/end` (success/error/cancelled), `approval/asked`, and `agent/error` events are pushed to all configured channels.

### Agent-initiated

The model can call the `notify` tool:

```
notify({ message: "调研完成，结果已写入 docs/", channel: "telegram", title: "任务完成" })
```

A second tool `notify_test` is registered for health checks: it sends a fixed self-test message (omit `channel` to broadcast) and renders results for config debugging — use it when you want to verify a channel is wired up, not to notify yourself. Both tools are rate-limited with their own sliding window (`toolRateLimitPerMinute`, so a test storm can't bypass the notify limit).

### Health check CLI

Verify one channel outside the harness (exit code 0/1, scriptable):

```bash
node scripts/test-channel.mjs telegram '{"botToken":"...","chatId":"..."}'
node scripts/test-channel.mjs bark --config-file cfg.json   # ${ENV:NAME} refs resolved like runtime
echo '{"key":"..."}' | node scripts/test-channel.mjs bark
```

## Ledger & daily digest (通知账本，可选)

Set `digest.enabled` to append every broadcast to `ledger.jsonl` (timestamp, level, title, delivered/failed channels) under `inbound.stateDir`. On startup, if yesterday had traffic and today's digest hasn't been sent, one `passive` summary is pushed through normal routing; same-day restarts never re-send (`ledger-state.json` remembers the last digest date). The ledger is append-only with amortized compaction (`maxEntries`, default 500), skips corrupt lines, and stays silent on any disk error — it can never break delivery.

```yaml
insert:
  - id: dsh-notifier
    config:
      digest:
        enabled: true
        maxEntries: 500      # compact back to this when 2x exceeded
      inbound:
        stateDir: "~/.dsh/dsh-notifier"   # ledger.jsonl lives here too
      channels:
        - type: bark
          key: "your-device-key"
```

## Remote Approval (双向回传，可选)

Approval requests can be answered from your phone. Six inbound channels ship today (telegram / feishu / qq / wxpusher / wechat / dingtalk — see [Inbound channels](#inbound-channels-v030)); all but the wxpusher callback are long-lived connections or long polling — **no public IP required**. The whole stack only starts when `inbound.allowUsers` is non-empty (default-deny whitelist). Since v0.3.2 approval notifications are split-routed — only the channels bound to the requesting agent receive the card (see [Multi-agent routing](#multi-agent-routing-v032)).

```yaml
insert:
  - id: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "123456:ABC-DEF..."
          chatId: "987654321"
      inbound:
        allowUsers: ["987654321"]   # your Telegram user id — empty = inbound disabled
        # telegram:                  # optional; falls back to the outbound telegram channel
        #   botToken: "..."
        #   notifyChatIds: ["987654321"]
        # stateDir: "~/.dsh/dsh-notifier"  # pending approvals / dedup / poll cursor
      approval:
        mode: answer                 # observe = push-only shadowing; answer = remote can decide
        timeoutMs: 120000            # no answer → silently fall back to desktop (never auto-approve)
        numberedReply: true          # reply "1" approve / "2" reject on button-less channels
        # escalation:                # re-remind if nobody answers
        #   enabled: true
        #   stages: [{ afterMs: 30000 }, { afterMs: 60000 }]
```

Security properties (all enforced in tests):

- Whitelist default-deny — inbound messages from unknown users are dropped.
- HMAC one-time tokens in every button; replay / forgery / expiry all rejected, first decision wins.
- **Silence never approves** — timeout, parse failure, or any error returns control to the desktop.
- Pending approvals, dedup table, and the polling cursor survive restarts (atomic JSON store).

## Inbound channels (v0.3.0 + v0.3.1)

Five inbound channels ride alongside telegram — same whitelist / approval / conversation routing (put the matching platform user id into `inbound.allowUsers`). Button-capable channels (telegram / feishu) approve via card buttons; button-less channels (qq / wxpusher / wechat / dingtalk) approve by **replying `1` (approve) / `2` (reject)**.

| Channel | Transport | Credentials | Buttons | Public IP | Notes |
|---|---|---|---|---|---|
| `feishu` | WebSocket long connection (official SDK, lazy-loaded) | appId + appSecret (custom app) | ✅ card | none | Set event subscription to "long connection"; missing SDK degrades with a Chinese hint |
| `qq` | WebSocket gateway, bare protocol (zero SDK) | appId + appSecret (q.qq.com) | ❌ numbered reply | none | C2C DMs + group @; passive replies preferred (separate msg_seq quota) |
| `wxpusher` | HTTP callback (`send_up_cmd`) | appToken | ❌ numbered reply | **required** (frp/proxy → `127.0.0.1:8103`) | Secret path is the credential (random 32B hex); upstream `#{appId} command` |
| `wechat` | iLink long polling (bare protocol, zero deps) | QR login via CLI | ❌ numbered reply | none | Personal account; one token = one instance; circuit breaker (3 hits/60s → open 15s) |
| `dingtalk` | Stream long connection, bare protocol (v0.3.1, zero SDK) | appKey + appSecret (enterprise-internal app) | ❌ numbered reply | none | `robotCode` learned from the first inbound message; proactive push reuses the breaker; passive `sessionWebhook` replies preferred |

```yaml
inbound:
  allowUsers: ["ou_feishu_openid"]        # user ids of the channels you actually enable
  feishu:
    appId: "cli_xxx"
    appSecret: "${ENV:FEISHU_SECRET}"
  qq:
    appId: "102030405"
    appSecret: "${ENV:QQ_SECRET}"
    # notifyUsers: ["openid_xxx"]          # optional approval push targets (fallback: allowUsers)
    # notifyGroups: ["group_openid"]
  wxpusher:
    appToken: "AT_xxx"
    # webhookPath: "/hook/<random secret>" # auto-generated & printed; host/port configurable
    # allowedIps: ["<WxPusher egress IP>"] # optional second gate
    # notifyUids: ["UID_xxx"]
  wechat: {}                               # credentials come from the login CLI (below)
  # wechat:
  #   notifyUsers: ["wxid_xxx"]
  dingtalk: {}                             # v0.3.1; credentials from the scan CLI or filled in below
  # dingtalk:
  #   appKey: "dingxxx"
  #   appSecret: "${ENV:DINGTALK_SECRET}"
  #   notifyUsers: ["staffId_xxx"]
```

### One-command QR login (v0.3.1)

Official scan-based authorization for qq / dingtalk / feishu; wechat keeps its iLink QR login. Credentials land in the local state store (0600); explicit config always wins over scanned credentials.

```bash
node scripts/channel-login.mjs qq        # QQ official QR connect → appId/appSecret (needs @tencent-connect/qqbot-connector)
node scripts/channel-login.mjs dingtalk  # DingTalk one-click app creation (enterprise account required)
node scripts/channel-login.mjs feishu    # Feishu one-click app creation (prints your open_id for the whitelist)
node scripts/channel-login.mjs wechat    # or the legacy node scripts/wechat-login.mjs
```

Engineering notes (all test-backed):

- **qq**: the official Node SDK is effectively unmaintained — this channel is a bare-protocol implementation (IDENTIFY/RESUME/heartbeat/reconnect; automatic token fetch + cache).
- **dingtalk**: bare-protocol Stream client verified field-by-field against the official SDK — subscriptions ride the gateway POST body (not WS frames), heartbeat is protocol-level ping/pong (passive), every frame is acked (60s server re-push absorbed by msgId dedup), passive `sessionWebhook` replies carry the `x-acs-dingtalk-access-token` header, proactive `batchSend` learns `robotCode` from the first inbound message and reuses the circuit breaker.
- **wechat**: `context_token` learned on every inbound message and echoed on send; `ret=-2 + unknown error` masquerading as rate-limit triggers a tokenless retry before being counted; `ret=-14` clears credentials and disables the channel with a re-login hint; proactive-send rate limits trip the breaker, any inbound message resets it. Same iLink protocol proven in production by Hermes / OpenClaw.

## Conversation (远程会话，可选)

Whitelisted users can talk to running agents from their phone. The router rides the same inbound stack as remote approval (all six inbound channels, `inbound.allowUsers` whitelist); enable it simply by filling the whitelist — no extra switch.

Delivery semantics are picked from agent state:

| You send | Agent idle | Agent busy |
|---|---|---|
| plain text | `followup` — starts a new turn | `inject` — queued at the next step boundary, never interrupts |
| `!text` | `steer` (host maps it to followup) | `steer` — redirects the current turn |

Typing on a phone fragments sentences. The **merge window** (default 1500 ms) collects consecutive messages from the same user into one before delivery:

- `something..` — trailing `..` flushes immediately
- `something!!` — trailing `!!` flushes immediately **and** steers

Command set (processed instantly, never merged):

| Command | Effect |
|---|---|
| `/status` | Show your binding and all live agents with status |
| `/bind <sessionId>` | Pin delivery to one session (survives restarts) |
| `/unbind` | Drop the pin; fall back to the channel default agent, or the most recently active one if unset |
| `/stop` | Cancel the bound agent's current turn |
| `/agent` | List workspaces / live sessions and their outbound channels (v0.3.2) |
| `/agent use <workspace \| sid prefix>` | Smart-switch this chat to that agent (v0.3.2) |
| `/agent back` | Return this chat to its channel default agent (v0.3.2) |
| `/route` | Show the current bidirectional resolution for troubleshooting (v0.3.2) |
| `/help` | Command help |

The `/agent` family and `/route` serve v0.3.2 multi-agent routing — see [Multi-agent routing](#multi-agent-routing-v032).

```yaml
inbound:
  allowUsers: ["987654321"]
  conversation:
    mergeWindowMs: 1500   # 0 disables merging (deliver each message as-is)
    steerPrefix: "!"      # single-char prefix that means steer
```

Unknown commands fall through as plain text, so nothing gets swallowed. Replies (command feedback, "no active session" notices) go back through the channel the message arrived on (all six inbound channels).

## Multi-agent routing (v0.3.2)

Agents and channels are no longer welded together: one agent can push to several channels, one channel can default to one agent — a bidirectional many-to-many matrix. The default routing key is the **workspace name** (stable, human-readable, naturally aggregating every session of the same project); an **exact agentId** remains available as the advanced key for session-granular control. Sessions register themselves the moment they are created, the matrix lives in `state.json`, and it is editable from chat commands or the CLI — no YAML required.

### Routing matrix

| Direction | Key | Meaning |
|---|---|---|
| Outbound — agent → channels | `route:agents` | key = workspace name (default) or exact agentId (advanced, session granularity, wins over the workspace entry); value = outbound `channels` + `quiet` |
| Inbound — channel → agent | `route:channels` | `<channel>.defaultAgent` = workspace name or agentId — the default destination for a chat with no explicit binding |

Both directions resolve through explicit fallback chains (first hit wins):

```
outbound  resolveOutbound(sessionId, workspace):
  route:sessions[sessionId].outbound   # session diff override (highest)
  ?? route:agents[sessionId]           # exact agentId entry (advanced key)
  ?? route:agents[workspace]           # workspace entry (default key)
  ?? global channel pool               # v0.3.0 behavior

inbound   resolveInbound(channel, userId):
  bind:<channel>:<userId>              # explicit /bind or /agent use
  ?? route:channels[channel].defaultAgent
       agentId   → that session (if still active)
       workspace → one active session → deliver
                   several active     → most recently active,
                                         receipt names the session id
  ?? exactly one agent running → that agent   # single-agent auto-fallback
  ?? most recently active agent        # final fallback (pre-v0.3.2 behavior)
```

A session is auto-registered on `agent/created` with its workspace name, so new sessions inherit channels and settings immediately — nothing to reconfigure. The agent-initiated `notify` tool rides the same chain (split-routes when its context exposes the agent id, global pool otherwise — tool signature unchanged). `quiet` mutes the outbound push only: the ledger still records every broadcast, and inbound plus approvals are never muted.

### Commands

The `/agent` family joins the conversation command set:

| Command | Effect |
|---|---|
| `/agent` | List workspaces / live sessions and their outbound channels |
| `/agent use <workspace \| sid prefix>` | Smart-switch this chat to that agent — workspace name matches exactly (its most recently active session), a full session id matches exactly, or a ≥ 4-char sid prefix; an ambiguous prefix lists the candidates |
| `/agent back` | Return this chat to its channel default agent |
| `/route` | Show the full bidirectional resolution (session → channels → settings, channel → agent) — built for troubleshooting |

`/bind` / `/unbind` / `/status` / `/stop` keep their session-granularity semantics unchanged.

Example — two workspaces on two channels (`api-server` → dingtalk, `docs` → telegram), chatting from Telegram:

```
you         /agent
notifier    • api-server — 9f2c… → dingtalk
            • docs       — 41ab… → telegram
you         /agent use api-server
notifier    this chat now talks to api-server (9f2c…); its pushes still land on dingtalk
you         rerun the deploy tests
notifier    [delivered to api-server as followup; its turn/end goes to dingtalk only, not here]
you         /route
notifier    chat → api-server (9f2c…)
            api-server → dingtalk · telegram default → docs
you         /agent back
notifier    back to the telegram default: docs (41ab…)
```

### Routing CLI

`scripts/route.mjs` reads and edits the matrix outside the harness (exit code 0/1, scriptable):

```bash
node scripts/route.mjs show                                  # all three tables: agent bindings / channel defaults / session ledger
node scripts/route.mjs show api-server                       # one agent binding entry
node scripts/route.mjs set api-server --channels dingtalk,bark   # workspace outbound channels (validated against channel types)
node scripts/route.mjs set api-server --quiet                # mute its outbound (ledger still records)
node scripts/route.mjs set api-server --no-quiet             # unmute
node scripts/route.mjs set api-server --channels ''          # explicit empty set → this key never pushes
node scripts/route.mjs set 9f2c41ab --channels dingtalk      # advanced: exact agentId entry (session granularity)
node scripts/route.mjs set api-server --reset                # drop the whole entry → global pool
node scripts/route.mjs default telegram docs                 # inbound: telegram defaults to docs
node scripts/route.mjs default telegram --clear              # clear that default
node scripts/route.mjs test 9f2c41ab --workspace api-server  # print the outbound chain (L1 diff → L2 agentId → L3 workspace → L4 global pool)
node scripts/route.mjs test 9f2c41ab --global telegram,bark  # resolve against a custom global pool
node scripts/route.mjs show --state ~/.dsh/dsh-notifier      # non-default stateDir (default $DSH_HOME/dsh-notifier)
```

### Data & config

Three new `state.json` keys (same 0600 store as `bind:*` and scanned credentials). `route:sessions` is written by the plugin and stores **diffs only** — unset fields follow their upstream live, so changing a default applies to every session immediately:

```json
{
  "route:agents": {
    "api-server": { "channels": ["dingtalk", "bark"] },
    "9f2c41ab-…": { "quiet": true }
  },
  "route:channels": {
    "telegram": { "defaultAgent": "docs" }
  },
  "route:sessions": {
    "9f2c41ab-…": {
      "inherit": "api-server",
      "workspace": "api-server",
      "outbound": { "quiet": true },
      "inbound": [{ "channel": "telegram", "userId": "987654321" }],
      "createdAt": 1760000000000,
      "lastActiveAt": 1760000123400
    }
  }
}
```

After `agent/disposed`, a session keeps its record for `route.sessionTtlHours` hours (default 24) so the same id can resume with channels and bindings intact; past the window the entry and its inbound hooks are reaped (`bind:*` survives — a stale bind just gets the usual "session not found" receipt).

```yaml
route:
  sessionTtlHours: 24   # retention window after agent/disposed, in hours (default 24)
```

`quiet: true` (on a session or an agent entry) means: outbound pushes are suppressed but still written to the ledger; inbound messages and approvals are untouched — silencing an approval would mean it always times out back to the desktop, and silence never decides.

### Compatibility

- Existing users with zero `route:*` keys: outbound = global pool, inbound = the pre-v0.3.2 chain — behavior byte-for-byte identical.
- Single-agent users hit the "exactly one agent" layer automatically; nothing to notice, nothing to configure.
- YAML semantics unchanged (bootstrap only); every new key lives in `state.json` (0600).
- `dependencies` stays empty — zero new dependencies.

### Approval routing

- Approval cards / notifications go only to the channels resolved for the requesting agent — no more global broadcast.
- Numbered-reply channels (qq / wxpusher / wechat / dingtalk) automatically append "reply `1` (approve) / `2` (reject)" to the routed notification.
- `quiet` never applies to approvals; replies travel back on the channel they arrived on.

## Web admin console (v0.3.3)

Credentials and routing no longer require hand-editing YAML: a local web console covers channel health overview, the binding matrix, per-session outbound overrides, and credential create/test/QR-scan — all in one page.

### Enable & token

```yaml
insert:
  - id: dsh-notifier
    name: dsh-notifier
    config:
      admin:
        enabled: true
        port: 8104        # default 8104; binds 127.0.0.1 only, host is not configurable
        # token: "..."    # optional; auto-generated and printed once on first start
```

On first start (no explicit token, no stored hash) the access token is printed to the log **once** — save it immediately. Only its SHA-256 hash is persisted (`admin:token-hash` in `state.json`); the plaintext never touches disk. Lose the token? Delete that key and restart to mint a new one. The browser asks for it on first visit (kept in localStorage, cleared automatically on 401).

### Security model

- **127.0.0.1 only** (red line; host is not configurable): exposing the console publicly equals exposing write access to every credential. For remote access, run your own reverse proxy with additional auth.
- Bearer-token auth (constant-time compare; 401 never distinguishes missing vs wrong token); unauthenticated requests never reach business logic.
- Every credential read is masked (string values become `***`); writes are append-only audited (action + channel name only — credential values never hit logs).

### Web QR scan vs CLI

The "扫码授权" button (qq / dingtalk / feishu) on the Channels tab drives the same scan modules and the same `<channel>:account` state key as `node scripts/channel-login.mjs <channel>` — a successful web scan is equivalent to a CLI login. The only difference: the QR content is shown in the page and polled there (copy it into any scanner, or open the link directly); no terminal needed.

### Credential model: YAML bootstrap ⊕ store runtime state

YAML (`cordis.patch.yml`) is bootstrap-only (plus outbound webhook declarations). Credentials saved from the web land in `state.json` (0600); at startup the two are **field-level merged** (store overrides same-named YAML fields) before channel validation. Saved credentials join the runtime on the **next plugin start** — use "测试发送" to verify connectivity right away. With admin enabled, the presence of a stored account is itself the enable signal for the five inbound channels (feishu / qq / dingtalk / wxpusher / wechat) — scan once, no YAML edit needed.

Exception: feishu / dingtalk are dual-domain channels — `<type>:account` belongs to the inbound bot credentials, and their **outbound webhook stays YAML-only** (the web outbound row is read-only, so one click can't wipe scan credentials).

## Rules & local bell (防打扰规则，可选)

Not every event deserves a push. Three gates run on the auto-push line, in order:

1. **Event gating** — turn each trigger off, or gate `turn/end` by result kind.
2. **Keywords** — `exclude` wins over `include`; invalid regex entries degrade to literal matching instead of crashing.
3. **Grace window** — after a debounced `turn/end`, wait `graceSeconds`; if any `user/*` session event arrives (you're at the keyboard), the notification is cancelled. Approvals and errors skip the window — they're waiting on a decision.

```yaml
insert:
  - id: dsh-notifier
    config:
      events:
        turnEnd: true            # or per-result: { completed: false, aborted: false }
        approval: true
        agentError: true
      keywords:
        include: []              # whitelist: text must hit at least one (empty = all pass)
        exclude: ["heartbeat"]   # blacklist: any hit suppresses
        regex: false             # treat entries as RegExp source
        caseSensitive: false
      graceSeconds: 120          # 0 (default) = off; headless one-shots usually want 0
      channels:
        - type: bell             # local terminal bell (BEL), no credentials
          count: 2               # rings 1-5
```

`bell` is the host-half local channel for headless/TUI runs (Codex BEL equivalent) — it rings once per notification, respects `silent`, and needs no credentials. The **client half** (`desktop` system notifications / `sound` cues / out-of-view suppression) ships as an experimental skeleton (`src/client/desktop-sound.mjs`): pure decision logic + a documented mount contract for the DSH client runtime, no fake client code in the host repo.

## Channels

<!-- CHANNEL-MATRIX-START -->

| type | Channel | Auth | Free? |
|---|---|---|---|
| `bark` | Bark (iOS) | device key (or self-host URL) | ✅ |
| `bell` | Terminal bell (local) | — | local |
| `chanify` | Chanify (iOS) | token (or self-host) | ✅ |
| `desktop` | Desktop notification (local) | — (Windows needs BurntToast module) | local |
| `dingtalk` | DingTalk custom robot | webhook + secret (HMAC sign) | ✅ |
| `discord` | Discord webhook | webhook URL | ✅ |
| `feishu` | Feishu custom bot | webhook (+ sign secret) | ✅ |
| `gchat` | Google Chat | space webhook URL | ✅ |
| `gotify` | Gotify | server URL + app token | self-host |
| `igot` | iGot (iOS) | push key | ✅ (limits) |
| `mattermost` | Mattermost | base URL + token (+ channel) | self-host |
| `ntfy` | ntfy | topic (+ server URL) | ✅ (self-host) |
| `onebot` | OneBot 11 (QQ) | HTTP endpoint | self-host |
| `pushdeer` | PushDeer | push key | ✅ |
| `pushover` | Pushover | user key + app token | paid (one-time) |
| `pushplus` | PushPlus (WeChat) | token | ✅ (limits) |
| `qmsg` | Qmsg酱 (QQ) | key + qq number | ✅ (limits) |
| `qq-bot` | QQ official bot | appId + appSecret | ✅ |
| `serverchan` | Server酱 (WeChat) | sendkey | ✅ (limits) |
| `slack` | Slack | incoming webhook URL | ✅ |
| `teams` | Microsoft Teams | Power Automate workflow URL | ✅ |
| `telegram` | Telegram Bot API | bot token + chat id | ✅ |
| `webhook` | Any custom endpoint | — | — |
| `wecom` | WeCom group robot | webhook key | ✅ |
| `wecom-app` | WeCom app message | corpid + agentId + secret | ✅ |
| `wxpusher` | WxPusher (WeChat) | appToken + uid | ✅ (limits) |
| `xizhi` | 息知 Xizhi | sendkey | ✅ (limits) |

<!-- CHANNEL-MATRIX-END -->

## Development

```bash
npm test          # node --test, 329 cases
```

Pure ESM (`.mjs`), zero runtime dependencies. To add a channel: implement the adapter interface (`resolve(cfg)` + `send(msg)`) in `src/adapters/` and register it.

Other plugins can reuse the notifier via `createNotifier(ctx, channels, { routing, segment, onSend })` — `onSend(record)` fires after every broadcast with level/delivered/failed details, ready for custom ledgers or metrics.

## TODO

- DSH web client bundle for desktop/sound (confirmed technically feasible: `dsh.plugin.json` supports `client.platform: web`, per the reference project [dsh-notification](https://github.com/omdsh-dev/dsh-notification); on hold — requires a TS + esbuild build chain and a dsh source checkout, conflicting with this repo's zero-build philosophy; revisit when the plugin client ecosystem matures)

## License

MIT
