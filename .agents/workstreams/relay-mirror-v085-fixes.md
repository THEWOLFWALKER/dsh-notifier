# Workstream: relay-mirror-v085-fixes

- Agent identity: `ox-alpha / span/ox-alpha / Linux sandbox x64 (root, Node v22.23.2, kernel 6.8.0-136-generic)`
- Branch: `codex/relay-mirror-v085-fixes`
- Status: `done`
- Start/end: `2026-08-23 -> 2026-08-23`
- Scope: 把公共镜像 v0.8.5 发布内容（issue #11 修复 + PR #9 飞书 SDK 适配）接力合入私有 main——两条无关历史，按内容 cherry-pick，不 git merge。
- Plan（实际执行）:
  1. 盘点镜像 delta：镜像 main=`20bfff9` 相对 v0.8.4 净差异仅 4 个实质源码/测试文件（router/questions.test/_feishu-register/channel-login.test）+ CHANGELOG/HANDOFF/package.json 版本串；镜像另提交了 node_modules(947 文件)+package-lock.json（军规违例，未带入）。
  2. cherry-pick 镜像 `74e5d54`（issue #11）→ 冲突仅在 CHANGELOG/HANDOFF 文档行；代码文件干净应用。手工解决冲突：保留私有线 Unreleased 结构，issue #11 条目并入。
  3. cherry-pick 镜像 `cbaab26`（PR #9）→ 干净应用。
  4. CHANGELOG 校正：issue #11/PR #9 条目归位 Unreleased（cherry-pick 曾把 issue 条目带进 0.8.4 段），补 PR9 完整条目。
  5. 计数同步：契约 906→909（issue #11 +3 用例），四处引用（双 README 徽章/正文、HANDOFF、package.json dshQuality）。
- Adversarial review:
  - issue #11 修复与私有线 P1-1/P1-2/P1-3 无语义交集（我们从未改 router.mjs，diff 基线干净）；SEC-2 fail-closed 保持（只补目标用户已绑定通道进 hintChannels）。
  - sendText 合约核对：qq-gw/wechat-ilink 均暴露 contract sendText；contract 层吞异常返 false（回执尽力而为语义一致）；`void` 不等待与既有回执路径一致。
  - PR9 权限集与 feishu-bot 长连接实际订阅（im.message.receive_v1 / card.action.trigger）一一对应，注释逐权限解释。
  - 其余开放 issue 对照核验：#1/#6（logger:null）、#2（ENV 解析）、#4（飞书三问）、#8（加签 19021）私有 main 均已修并有代码注释为证——无需接力。#3/#5/#7 为功能请求，当前周期挂起。
- Owned files: `.agents/workstreams/relay-mirror-v085-fixes.md` · `src/questions/router.mjs` · `test/questions.test.mjs` · `src/inbound/_feishu-register.mjs` · `test/channel-login.test.mjs` · `CHANGELOG.md` · `HANDOFF.md` · 双 README · `package.json`(testCount) · `docs/memory/project-state.md`
- Do not touch: 公共镜像仓库（只读消费）；其他 workstream 保留文件——均未触碰。
- Validation: 聚焦 questions+channel-login 49/49 → 全量 `npm test` **909/909**（66s）· `verify-release.mjs` ok(tests=909) · `node --check` ×3 ok
- Known gaps: PR9 的真机验证缺口（扫码建应用走一遍新 SDK 协议）继承自镜像侧——贡献者称实测通过但本沙箱无法复验；已属 P1-1 真机清单同类。镜像侧 npm 已发布 0.8.5 含此二修复；私有侧发布仍走独立 release gate。
- Handoff: 3 个 commit 推送至私有仓库（`4a1b8f7` issue11、`5e42768` PR9、docs/calibration）；随后 no-ff 合并回 main、分支退役。下一步见 HANDOFF 当前接力交代。
