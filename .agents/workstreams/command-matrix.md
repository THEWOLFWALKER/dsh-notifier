# Workstream: fix-command-matrix

- Agent identity: relay-fix-train | TraeWork parent + subagents | remote sandbox
- Agent: relay-fix-train (R1)
- Branch: `codex/fix-command-matrix`
- Status: done
- Start/end: 2026-08-28 -> 2026-08-28
- Scope: 命令解析矩阵修正（G-04/06 P1 + G-25/33/43/52/65），R1 列车。
- Plan: 1. conversation.mjs /stop 仅精确匹配取消；/stop+尾巴走未知命令回执。2. commands.mjs parseCommand 剥 @botname 后缀（贪心匹配），TG/钉钉入站 envelope 同步剥离。3. 首字符全角 ／ 规范化为 /。4. /agent use needle 改 args.slice(1).join(' ')。5. questions/router.mjs 裸编号多选改分词式解析（split /[,，、;；\s]+/，去重后逐 token 校验），fail-closed 语义不变。6. G-43：缺 chatId 的裸编号消费后补"未能定位提问卡片"回执（仍不落账，消除黑洞）。7. G-25：feishu-bot.mjs 用事件 mentions 映射把 @_user_N 还原为 @提及名（非删空串），命令参数 @ 残片同修。8. 命令矩阵单测逐形态断言。
- Owned files: src/inbound/commands.mjs; src/inbound/conversation.mjs(/stop 分支); src/questions/router.mjs(编号解析+G-43 回执); src/inbound/telegram-bot.mjs(@剥离); src/inbound/dingtalk-stream.mjs(@剥离); src/inbound/feishu-bot.mjs(G-25 @还原); test/commands.test.mjs; test/inbound.feishu.test.mjs(扩展); CHANGELOG.md
- Do not touch: conversation.mjs 合并窗与绑定分支（归 fix-merge-window-keys）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: 命令矩阵：/stopwatch、/stop、/stop 等等、/pair@bot code、／pair、/agent use 含空格、1, 3 / 1、3 / 1 3、越界号回执；缺 chatId 裸编号→回执可见；飞书 mentions 还原 @名字 无双空格、/pair args 干净
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 见下方 2026-08-28 记录。
- 2026-08-28 done: 提交 51ac706+8e99198+7dcfed6+fcee4e2+f8f2a07。G-04/06/25/33/43/52/65 七项全修。审查：四红线未触碰；G-52 只放宽形态识别不放宽授权链（exact/hint 证据→CRACK-004→Control Core 后置原样）。破坏性变化（/stop 收紧等 9 项）已在 CHANGELOG 0.9.1 顶部署名。遗留：飞书 mentions 负载形状未经真机（记 risks.md）；钉钉行首 @ 退化形态剥空不投递（测试注释已知取舍）。
