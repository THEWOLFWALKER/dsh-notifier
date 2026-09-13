- Workstream: control-core-wiring-personal
- Agent identity: Codex | GPT-5 | Windows shared workspace
- Branch: codex/control-core-wiring
- Status: done
- Start/end: 2026-08-26 -> 2026-08-26
- Scope: 接入 provider-neutral Control Core 到 approval/action/question 回调与会话控制，并把 personal 默认收紧为已配对私聊、converse 默认关闭。
- Plan:
  1. 画出现有 adapter -> bus/router/dispatcher 调用图，确定最小接线点。
  2. 新增统一 control entry：normalize -> source/policy/paired check -> settle；保留旧 API 作为无接线单测兼容层。
  3. 将 Telegram/Feishu 回调、approval/questions 编号回复、actions dispatch、conversation stop/steer/ordinary 接入 entry。
  4. 强化 personal 默认策略：群 chat/group chatId fail-closed，converse 默认关闭，显式 team 才可开启。
  5. 补跨渠道运行时集成测试，做独立 adversarial review 后修订。
  6. 运行 focused/full/release/channel-matrix/syntax 验证，提交窄 commit，尝试 push private 并记录原始结果。
- Owned files: src/control/entry.mjs; src/control/contract.mjs; src/control/session-arbiter.mjs; src/index.mjs; src/actions.mjs; src/approval/router.mjs; src/questions/router.mjs; src/inbound/conversation.mjs; src/inbound/telegram-bot.mjs; src/inbound/feishu-bot.mjs; src/inbound/_contract.mjs; corresponding tests; this workstream.
- Do not touch: CHANGELOG.md, HANDOFF.md, README*.md, docs/memory/*, public remotes, unrelated adapters.
- Validation: focused control/inbound/action/question tests; npm test; node scripts/verify-release.mjs; node scripts/gen-channel-matrix.mjs --check; node --check src/index.mjs.
- Adversarial review: wrong chat/source, old token/callback, duplicate event, expired policy, unpaired user, group chat/group-shaped chat id, converse default off, two channels using one entry, settlement exception and no control bypass.
- Handoff: runtime entry is now injected by `src/index.mjs`; Telegram/Feishu approval, question, and action callbacks plus numbered replies and conversation control pass through it. Personal mode requires the paired identity and rejects group/supergroup or provider-neutral group-shaped chats; converse remains opt-in. QQ/WxPusher/Wechat/DingTalk have no separate native button callback adapter in this batch, but their text-number paths remain behind the approval/questions control gate.
- Review: fixed action ledger lookup (`store.get`), preserved action handler receipt messages, added pre-settlement source checks for action/approval/question callbacks, and accepted both legacy `{ ok: true }` and Control receipt `{ status: 'accepted' }` responses.
- Tests: focused control/action/question/inbound suites pass; `npm test` = 1021 pass / 8 existing Windows environment failures (desktop/BurntToast, state-lock timing, file mode/symlink permissions); release guard, channel matrix, syntax, and diff checks pass. No real-device validation performed.
- Commit: `36add80` (`feat: wire control core into inbound callbacks`); pushed to private as `codex/control-core-wiring`.
