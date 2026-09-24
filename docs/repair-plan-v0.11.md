# dsh-notifier v0.11.0 完整修复计划 — Issue / PR 清零版

> **状态：设计稿 / 等批准 / 不写代码**
>
> 仓库：`THEWOLFWALKER/dsh-notifier`  
> 分支：`dev`  
> 审计 HEAD：`9a939105140adc153231f98965c5f4b4be7c16ec`（`9a93910`）  
> 审计日期：2026-09-24  
> 目标版本：`0.11.0`
>
> 本文只做设计与执行排序。**不修改代码、不提交、不推送、不触碰 `main`。**

>
> **v2 增补说明（2026-09-24）：**本版已把仓库当前可见的 **27 个 Issue + 9 个 PR 全量逐项复核**，并继续追到 PR review comment / 后续替代实现 / 当前 `dev` 代码状态。  
> **本版末尾的「最终权威执行顺序 v2」覆盖本文较早章节中的旧执行排序；若两处冲突，以 v2 顺序为准。**
>
> 本版新增的关键发现：
>
> 1. **PR #20 虽已关闭未合并，但核心 Feishu P2P `ou_ → oc_` 来源错配在当前 dev 仍存在**，必须重新纳入修复；
> 2. **PR #34 已合入，但 CodeRabbit 指出的 WPS `http:` webhook 明文泄露凭证问题当前仍存在**，必须作为发布阻断项；
> 3. **Issue #31 只有 QQ / DingTalk 完成有限超时，Feishu SDK 发送仍是明确残余**；
> 4. **Issue #32 代码事实上已经修复，但 GitHub Issue 仍 open，必须验证后收口；**
> 5. **Issue #37 是 taskbook 之后新开的需求**，现有 `lang` 只覆盖主要手机面，管理台与 v0.10 后新增的一批手机文案仍有硬编码中文；
> 6. **Issue #36 可直接利用 DSH rc.1 正式 `FileBlock + AttachmentStore.saveFile()` 做完整文件闭环**，不再接受“把下载 URL 当普通文字扔给模型”的半方案。


---

## 0. 事实来源与裁定顺序

本轮按以下顺序读取：

1. `docs/taskbook-v0.11.md`：当前任务书、现状、红线、已拍板决策、缺失项；
2. `docs/ROADMAP.md`：W1～W10 的功能规格；
3. 当前 `dev@9a93910` 实际源码；
4. `CHANGELOG.md`；
5. `HANDOFF.md`；
6. `docs/protocol-preflight/qq-bot.md`；
7. DSH 宿主事实：`deepseek-ai/deepseek-harness@dsh-v0.1.7-rc.1` 实际源码；
8. 渠道事实：腾讯官方 QQ 插件、Qmsg 3.0 官方文档、Server酱官方 SDK。

若来源冲突：当前源码 > 旧 HANDOFF；taskbook 所有者指令 > ROADMAP/HANDOFF 的旧流程文字；官方实际源码 > 历史设计说明。**已拍板决策若与新官方证据直接冲突，不擅自覆盖，标“待裁决”。**

---

# 1. 当前基线复核

## 1.1 `dev` HEAD

GitHub 实际 HEAD：

```text
9a939105140adc153231f98965c5f4b4be7c16ec
docs: 固化 v0.11 任务书与当前进度快照，供远端重新规划（临时输入）
```

对比 `9edaf41...9a93910`：

```text
ahead_by = 1
唯一变更文件 = docs/taskbook-v0.11.md
```

所以：

- `9edaf41` 之后没有运行时代码提交；
- taskbook 中标为未开始的 W0 / Host 项，在 `9a93910` 仍未被后续代码修掉；
- 本轮接受 taskbook 记载的 **1663 passed / 0 failed** 作为规划基线；
- 但本文不声称本轮重新跑过测试。

## 1.2 CI

仓库有 `.github/workflows/ci.yml`，但触发条件是：

```yaml
push:
  branches: [main, master]
pull_request:
```

因此 `dev` 直接 push 不触发 CI。查询 `9a93910` 也没有对应 Actions run。

**结论：**本文只能写“任务书记载实测 1663 全绿”；不能写“CI 已验证 `9a93910`”。

---

# 2. 执行红线

## 2.1 零运行时依赖

禁止新增 `dependencies` / `optionalDependencies`。宿主适配只使用 Node 22+、现有代码和当前宿主公开 service。不能为了 V4 attachment 引图片处理运行时依赖。

## 2.2 公共面不 breaking

必须保持：

```text
ctx.notifier.version === '0.7'
push(message, options) 签名不变
sent 事件 payload 不变
flush() 语义不变
```

特别注意：`ctx.notifier.push()` 公共返回值中的：

```js
source: { kind: 'plugin', name }
```

是 **dsh-notifier 自己的 v0.7 公共协议**，不是 DSH `UserMessage.source`。P0-A 只允许修改送入 DSH Agent 的 UserMessage source，**不能顺手改公共 notifier source shape**。

## 2.3 双语

新增手机/管理台可见文案必须进入 `src/strings.mjs`，zh/en 成对；内部日志、adapter 技术诊断不机械 i18n，但成为用户回执后必须进 strings。

## 2.4 fail-closed

未知来源、身份不全、附件无法验证、宿主能力缺失、协议事实缺证据，都不得乐观放行。图片 admission 失败时绝不能退回远程 URL 继续塞进 Session。

## 2.5 分支纪律

本轮 taskbook 明确覆盖 ROADMAP/HANDOFF 的旧 `codex/*` 规则：

```text
直接在 dev
一个工作项一个 commit
禁止 codex/*
禁止动 main
```

## 2.6 不顺手优化

一个工作项只处理自己的契约边界，不把 P0 修复变成大重构。

---

# 3. 当前缺口总表

| 项 | 当前 `dev@9a93910` | 结论 | 优先级 |
|---|---|---|---:|
| W0 #26 QQ keyboard | `label` 仍可 >10；仍带 `specify_user_ids` | **未修** | P0/W0 |
| Host P0-A source | `UserMessage.source.kind='plugin'` | 与 DSH V4 当前契约冲突 | P0 |
| Host P0-A image | 仍生成 `type:'image_url'` | 与 DSH durable image block 冲突 | P0 |
| Host P0-B cancel | 仍传字符串 cause | 与 rc.1 `AgentCancelCause` 冲突 | P0 |
| W0 #36 QQ attachments | 官方字段已登记，未统一解析 | 未开始 | W0 |
| W0 #33 QQ outbound markdown | 尚未实施 | 未开始 | W0 |
| Qmsg | 旧 endpoint + `qq/type/bot` | 与 Qmsg 3.0 不一致 | P1 |
| Server酱 SC3 | `sctp.ftqq.com` 拼法 | 与当前 SDK 实现不一致 | P1 |
| DSH peer compatibility | 无 DSH peer | 官方 preflight 对本插件无宿主约束 | P1 |
| `ctx.root` | root-first + `global:true` | 可收敛；root 当前 experimental | P2 |
| native ask_user | runtime 已有 waterfall，部分文档仍旧 | 运行时基本对，口径需收口 | P2 |
| issue #32 history read | assistant cache 已替代 | **已完成，不重复做** | DONE |

---


# 3A. GitHub Issue / PR 全量审计

## 3A.1 数量与状态

以 GitHub API 对 `THEWOLFWALKER/dsh-notifier` 的当前结果为准：

```text
Issues: 27
  closed: 20
  open:    7

PRs: 9
  merged:           5
  closed-unmerged:  4
  open:             0
```

当前 7 个 open Issue：

```text
#25 维护公告（非技术问题）
#26 QQ markdown + keyboard 真机无按钮
#31 Feishu / QQ / DingTalk inbound transport timeout
#32 session.events 移除导致 turn/end 正文为空
#33 qq-bot outbound markdown
#36 QQ attachments / 文件消息被静默丢弃
#37 i18n / English localization
```

**“GitHub closed”不能直接等价于“当前代码无需处理”。**  
本轮已发现两个典型反例：

```text
PR #20 closed-unmerged  → 当前 dev 仍有对应 Feishu P2P 缺陷
PR #34 merged           → 当前 dev 仍保留 review 指出的 WPS HTTP 明文凭证风险
```

因此发布前的判据必须是：

```text
Issue / PR 状态
+ 当前源码
+ 当前测试
+ review findings
+ 后续替代实现
+ 官方协议证据
```

五者一起闭环。

---

## 3A.2 状态标签

本文统一使用：

| 标签 | 含义 |
|---|---|
| `DONE` | 当前 dev 已实现，当前没有新的反证；只保留回归 |
| `DONE-LATE` | Issue 当时关闭并不代表当时真的闭环，但后续 dev 已完成正确修复 |
| `SUPERSEDED` | 被后续 Issue / 修复线完整替代 |
| `VERIFY-CLOSE` | 代码已修，但 GitHub Issue 还开着；验证后评论并关闭 |
| `FIX` | 当前 dev 仍有实际缺陷/缺功能，进入本次修复计划 |
| `PARTIAL` | 一部分已完成，仍有明确剩余 |
| `DOC/HOUSEKEEPING` | 不需要运行时代码，但发布前要收口状态/文档 |
| `NON-BLOCKING` | 非技术事项，不得伪装成产品缺陷 |
| `PENDING-EVIDENCE` | 没有足够官方证据，禁止猜实现 |

---

# 3B. 全部 27 个 Issue 逐项结论

| Issue | 当前状态 | 本轮结论 | 进入计划 |
|---|---|---|---|
| **#1** Feishu `WSClient logger:null` | closed | `DONE`。当前 Feishu SDK logger 已防御处理；与 #4/#6 同族 | 只保留 SDK 生命周期回归 |
| **#2** `inbound.feishu` `${ENV:NAME}` 不解析 | closed | `DONE` | 不重复改 |
| **#3** ask_user_question → 飞书卡片 | closed | `DONE-LATE`。功能已实现；真实宿主 attach 缺陷后来由 #27/#29/PR #30 修正 | PR #30 + P2 ask_user 回归 |
| **#4** inbound / Feishu 三问题 | closed | `DONE` | 不重复改；保留 logger/patch/lifecycle 回归 |
| **#5** ask_user_question 手机桥 | closed | `DONE-LATE`，同 #3 | PR #30 + P2 |
| **#6** Feishu `logger:null` duplicate | closed | `DONE`，与 #1 重叠 | 不重复改 |
| **#7** DSH Directory 收录 | closed | `DONE`，生态事项 | 发布文档只保持当前状态 |
| **#8** 飞书 webhook 加签错误 | closed | `DONE` | 继续协议 fixture |
| **#10** 管理台入口怎么打开 | closed | `DONE`，v0.9.6 零配置管理台已覆盖 | #37 做英文界面时保留 onboarding |
| **#11** qq-bot / qq 通道别名导致编号答题失败 | closed | `DONE` | 回归 alias / Control Core |
| **#13** 管理台 token 并发弹窗/刷新丢失 | closed | `DONE` | #37 不得破坏 token 状态机 |
| **#14** 图片转发视觉模型 | closed | **历史上已做，但 Host V4 已使当前 sink 过时** | **Host P0-A 必须重做 V4 source + durable image** |
| **#15** QQ heartbeat 单周期判死 | closed | `SUPERSEDED` by #23 | 不恢复旧心跳逻辑 |
| **#16** DSH Web profile 收不到 host events | closed | `DONE-LATE`。真正 scope/global 问题后由 PR #28 收口 | P2 ctx.root 收敛时保持 `global:true` |
| **#18** 管理台/安装 UX 强烈反馈 | closed | `DONE`，v0.9.6/0.9.7 后续已实质改造 | W5-W10 + #37 不得倒退 |
| **#19** Web-first 提问升级 | closed | `DONE` | PR #30 的取消/迟到收尾回归必须保留 |
| **#21** Telegram custom/skip 不可发现 | closed | `DONE`，PR #22 功能已重实现 | 不重复 |
| **#23** QQ heartbeat 真机 A/B 根因 | closed | `DONE` | 保留 READY/RESUMED 后起搏回归 |
| **#25** 作者考试公告 | open | `NON-BLOCKING`，不是软件缺陷 | 2026-10-01 后由所有者归档/关闭；不作为发布技术债 |
| **#26** QQ markdown + keyboard 无按钮 | open | **`FIX`** | W0 #26 |
| **#27** `userQuestions` 未声明导致桥装配失败 | closed | `DONE` via PR #30 | P2 只收口新官方 seam 口径 |
| **#29** real DSH 无 `registerProvider` | closed | `DONE` via PR #30 | waterfall 作为 rc.1 当前主 seam |
| **#31** inbound transport 无有限超时 | open | **`PARTIAL`**：QQ + DingTalk 已修，Feishu SDK 发送仍待取证 | **新增 P1-Timeout** |
| **#32** `session.events` 移除正文为空 | open | **`VERIFY-CLOSE`**：当前 dev 已有 assistant text cache，1663 基线来自此线 | focused/full 验证后评论并关闭 |
| **#33** qq-bot outbound markdown | open | **`FIX`** | W0 #33；taskbook 已拍板默认 markdown + opt-out |
| **#36** QQ attachments 静默丢弃 | open | **`FIX`** | W0 #36；升级为 durable image/file 完整闭环 |
| **#37** i18n / English bot + admin | open | **`FIX`**，taskbook 后新增 | **新增 I18N 工作项 + W5/W6/W7/W10 强制接入** |

### 结论

发布前允许仍 open 的仓库 Issue 只有：

```text
#25 — 明确的时限公告（非技术）
```

其余技术 open Issue 必须满足：

```text
已修 + focused/full gate 通过 + GitHub 评论说明 + 关闭
```

或：

```text
所有者明确接受为已知限制，并把 Issue 改成带边界/上游依赖的追踪项
```

**不能以“代码里写了 TODO/risks”代替 Issue 收口。**

---

# 3C. 全部 9 个 PR 逐项结论

| PR | GitHub 状态 | 当前 dev 结论 | 本轮动作 |
|---|---|---|---|
| **#9** Feishu scan-to-register 新 SDK | merged | `DONE` | 保留扫码/SDK 兼容回归 |
| **#12** `approval.parallel` | closed-unmerged | **功能已按当前 Control Core 重新实现**，默认 off，现有 tests 锁定 | 不 cherry-pick；只验证默认 fail-closed |
| **#20** Feishu P2P `ou_` 来源校验 | closed-unmerged | **`FIX`：当前 dev 没吸收核心修复，真实缺陷仍在** | **新增 P0-Feishu-P2P** |
| **#22** Telegram custom/skip | closed-unmerged | **已在后续 dev 重实现并加固** | 不 cherry-pick；保持 refs/token/source 回归 |
| **#24** `lang` / English push | closed-unmerged | **核心手机面已吸收**；但管理台故意没翻译，且 v0.10 后出现新硬编码中文 | **由 #37 继续完成，不回滚 PR24** |
| **#28** host-events global scope | merged | 当前修复有效；其中早期 `snapshotEvents` 思路已被 #32 assistant cache 取代 | 保留 `global:true`，不要复活旧 session history API |
| **#30** native questions waterfall | merged | 主要 review findings 已全部修正；**transport timeout 被拆成 #31** | P2 host seam + #31 |
| **#34** WPS outbound | merged | 功能在，但 **review 的 HTTPS / markdown-test / test-count 三项至少两项仍未闭环** | **新增 P0-WPS + 文档收口** |
| **#35** QQ 长文本句末分段 | merged | `DONE` | 不重复改；#33 markdown 分段复用其 code-point/句末能力 |

当前没有 open PR。  
但发布门禁不能只检查 `is:pr is:open`，还要检查：

```text
所有 merged / closed PR 的 actionable review comment 是否已：
- 在当前 dev 修复；
- 被明确拆成 Issue；
- 或有当前源码证据证明不再成立。
```

---

# 3D. PR review comment 残余审计

## PR #22

Contributor 后续提到的四个草稿风险：

```text
Telegram aq custom/skip 点击链
userId 洗白设计
动作/审批卡 refs 泄漏
store 同毫秒 flake
```

当前可确认：

- custom/skip：已有 `questions.handleCardAction`、token/ledger/source 校验和回归，**已吸收**；
- 其余三项没有形成正式 Issue，当前也没有足够证据支持直接改运行时代码；
- 发布前应在 adversarial review 中针对：
  - source identity 不得被 transport 覆盖；
  - 所有短引用发送失败回收；
  - 时间相等时排序/去重不依赖脆弱“唯一毫秒”；
  做一次定向检查。
- 若能构造当前失败回归，再升格成独立 work item；**不能因为历史评论一句话就猜修。**

## PR #24

CodeRabbit 的：

```text
stringsOf('__proto__'/'constructor') inherited-key bug
```

已经在当前 `stringsOf` own-property 逻辑和 changelog 中收口。  
**#37 是范围扩展，不是重新修这一 bug。**

## PR #30

review 中主要问题均有当前实现/CHANGELOG 回执：

```text
并发同文问题互相清扫
downstream rejection race
ctx.inject lifecycle
GUI 胜出后迟到手机卡
webFirstMs=0 abort 注册时序
terminated 被写成 timeout
late card 终态话术错误
attachError 残留
旧文档仍声称 registerProvider 唯一 seam
```

均已修。

唯一正式拆出的残余：

```text
Issue #31 transport timeout
```

因此 #31 必须真正闭环后，才能说 PR #30 review 全清。

## PR #34

当前仍可复现的 review finding：

1. **Major Security — WPS webhook 允许显式 `http:`**
   - `normalizeWpsWebhookHost()` 接受 `http:`；
   - `normalizeWpsWebhook()` 接受 `http:`；
   - key 在 query 中，明文 HTTP 会泄露完整认证凭证。
2. **Missing regression — markdown payload 无专项 send 断言**
   - 当前 focused send 只锁 `{msgtype:'text', text:{content}}`；
   - 没有锁 `{msgtype:'markdown', markdown:{text}}`。
3. **HANDOFF test total 不自洽**
   - 现有行仍写 `1625 tests / Windows 1621 pass + 2 fail`，只解释了 1623；
   - 而当前 taskbook 基线已是 1663，更说明该行必须在发布收口重写。

=> **PR #34 不能仅因 merged 标 DONE。**

---

# 3E. 新增 P0 — PR #34 WPS HTTPS 凭证保护

## 根因

当前：

```js
if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`
...
if (parsed === null || !WPS_OFFICIAL_HOSTS.has(parsed.hostname)) ...
return `${parsed.origin}...`
```

也就是说用户显式填：

```text
http://woa.wps.cn/...?...key=SECRET
```

会被保留为 HTTP。

WPS webhook 的 `key` 就在 URL query 中，是完整发送凭证。  
这不是“最佳实践”问题，而是实际明文传输风险。

## 改动文件

```text
src/adapters/spec-channels.mjs
test/config-validation.test.mjs
CHANGELOG.md
```

必要时同步：

```text
docs/guide.md / README 渠道说明
```

## 行为边界

只接受：

```text
https:
+ WPS 官方 host whitelist
+ 标准 path
+ key 必填
```

保留：

```text
裸域名 → 自动补 https://
legacy webhookHost → 仍迁移
365.kdocs.cn/woa path → 保留
new webhook 优先于旧字段
```

显式 `http:`：

```text
必须 reject
不能静默升级为 https
```

理由：用户显式输入发生语义变化时，fail-closed 比自动改写更可审计。

## 测试

```text
new webhook http://woa.wps.cn → reject
legacy webhookHost http://xz.wps.cn → reject
bare woa.wps.cn → 自动 https 正常
https 三官方 host → 正常
evil host → 仍 reject
missing key → 仍 reject
text send payload → 原断言保留
markdown send payload → 新增精确断言
```

## 风险 / 回退

风险极低；仅收紧不安全配置。

回退条件只有：

```text
拿到 WPS 官方文档明确要求 HTTP-only 的证据
```

当前没有这种证据。

---

# 3F. 新增 P0 — PR #20 Feishu P2P `ou_ / oc_` 来源标识错配

## 当前 dev 仍存在的根因

当前发送目标：

```text
notifyTargets / allowUsers / binding → ou_<open_id>
```

私聊发送：

```text
receive_id_type = open_id
```

因此卡片 `value.srcChat` 与 `pushedTo[].chatId` 保存的是：

```text
ou_...
```

但飞书回调/私聊消息里的会话 ID 是：

```text
context.open_chat_id / message.chat_id = oc_...
```

当前 `sourceChatAllowed()` 仍直接：

```js
if (String(clicked) !== String(srcChat)) return false
```

于是 P2P：

```text
oc_... !== ou_...
```

天然失败。

而 `latestPendingFor()` 又会把：

```text
pushedTo.chatId = ou_...
incoming chatId  = oc_...
```

视为 wrong-chat。

### 结果

当前 dev 仍可能出现：

```text
Feishu 私聊审批按钮 → “请到原会话操作”
Feishu 私聊提问按钮 → 同上
Feishu 私聊动作按钮 → 同上
Feishu 编号回复 → 只消费不裁决
多选题只有编号 fallback → 实际无法完成
```

这是 closed-unmerged PR 被遗留的真实缺口。

## 设计

新增一个**来源身份 vs 投递寻址分离**的窄 helper。

### P2P `srcChat` 是 `ou_`

验证：

```text
operator.open_id === srcChat
```

也就是：

```text
验证“是不是原接收人”
```

不要拿：

```text
oc_ 会话 id
```

去和：

```text
ou_ 用户 id
```

硬比。

### group / chat target 是 `oc_`

继续：

```text
clickedChat === srcChat
```

保持群聊跨会话转发 fail-closed。

### Control Core 的 `chatId`

对 P2P callback：

```text
用卡片自身 srcChat（ou_）作为“原投递目标 identity”
```

使其与账本/pushedTo 同口径。

但**实际补发文本 / patch fallback** 仍使用：

```text
clickedChatOf(data) = oc_
```

因为那才是真正会话寻址。

### 编号回复

在 `questions/router` 里只为满足以下条件的 target 建 P2P exact-equivalence：

```text
channel === 'feishu'
target.chatId startsWith 'ou_'
target.userId === envelope.userId
accountId exact match
```

此时允许：

```text
incoming oc_ p2p chat
```

与该 open_id 投递证据视为同一私聊。

不能把这一规则泛化到：

```text
QQ / Telegram / group chat
```

## 改动文件

```text
src/inbound/target-guard.mjs   # 可放 isOpenIdTarget，若保持纯 helper
src/inbound/feishu-bot.mjs
src/questions/router.mjs
test/feishu-p2p-source.test.mjs  # 建议恢复独立 focused suite
CHANGELOG.md
docs/memory/risks.md
```

## 测试

```text
1. card sent to ou_A; callback context oc_P2P + operator ou_A → accept
2. same card; operator ou_B → reject
3. group srcChat oc_G; clicked oc_G → accept
4. group srcChat oc_G; clicked oc_OTHER → reject
5. approval callback P2P settles
6. question callback P2P settles
7. action callback P2P dispatches
8. numbered reply from same ou user + oc P2P → exact-equivalent settle
9. group wrong-chat numbered reply → still reject
10. accountId mismatch → reject
11. missing operator/open_chat_id → fail-closed
12. patch/send fallback still uses oc_ clicked chat, not ou_
```

## 证据要求

实施前再取一次：

```text
飞书官方 card action `open_chat_id`
飞书消息事件 `chat_id`
发送 API 的 `receive_id_type=open_id`
```

PR #20 的真机证据可作为项目事故证据，但协议字段仍以官方文档为基准。

---

# 3G. Issue #31 — Feishu 有限请求超时收口

## 当前状态

### 已完成

```text
QQ inbound: AbortController + config.timeoutMs
DingTalk inbound: AbortController + config.timeoutMs
```

### 未完成

Feishu：

```text
client.im.v1.message.create(...)
client.im.v1.message.patch(...)
```

仍没有本项目显式有限 transport timeout。

当前源码自己已经写了：

```text
待验证
```

所以 Issue #31 **不能在 QQ/DingTalk 修完后直接关闭。**

## 官方 SDK 现有可取证方向

当前官方 node-sdk 文档明确暴露：

```text
Client.httpInstance
semantic API 的第二个 request-options 参数
```

但本项目钉的是：

```text
@larksuiteoapi/node-sdk@1.73.0
```

实施必须继续下钻 **1.73.0 对应源码/类型**，确认：

```text
HttpRequestOptions 是否真的有 timeout
semantic message.create/patch 的第二参数是否透传
httpInstance 是否能用公开 API 创建“本 client 独占”的有限 timeout instance
```

拿不到该版本实际源码：

```text
标 PENDING-EVIDENCE
禁止猜字段名
```

## 允许的实现优先级

1. **首选：SDK 公开 per-request timeout**
2. **次选：SDK 公开、可隔离实例的 `httpInstance` timeout**
3. 若两者都不存在：
   - 不接受单纯 `Promise.race` 冒充 transport timeout（底层 IO 仍挂着）；
   - 需要重新设计 Feishu 发送 transport，或者由所有者明确接受上游限制。

## 发布判据

Issue #31 只能在下面二选一后关闭：

```text
A. Feishu create/patch 实际网络请求有真实有限超时；
B. 所有者明确接受“SDK 无公开可取消 timeout”的上游限制，并把 Issue 改为已知上游追踪。
```

默认是：

```text
A；不主动放宽。
```

---

# 3H. Issue #32 — 已修代码的 GitHub 收口

当前 `[Unreleased]` 已写：

```text
createAssistantTextCache
不再读取 session.events
不再 fallback snapshotEvents
全量 1662 → 1663
```

所以本项**不再写运行时代码**。

发布前执行：

```text
focused event-listener tests
full npm test
grep 确认 src 不再读 session.events / snapshotEvents
检查 turn/end + stall excerpt 两路径
```

验证后：

```text
在 #32 评论：
- 修复 commit
- 原因
- focused test
- full count
- 未做真宿主时如实写 contract-tested
然后 close
```

不要把 #32 长期留 open 造成“当前版本仍已知坏”的错误信号。

---

# 3I. Issue #36 — QQ attachments 升级为完整 durable image / file 闭环

## 为什么原来的“文件 URL 文字提示”不够

DSH rc.1 已有正式：

```ts
FileBlock {
  type: 'file'
  attachment: FileAttachmentRef
}
```

以及：

```text
AttachmentStore.saveFile({data: Uint8Array, name?})
AttachmentStore.saveFileStream(...)
```

所以 v0.11 再把 QQ 文件退化为：

```text
“收到文件：https://...”
```

会同时造成：

- 模型没有正式 file attachment 语义；
- URL 可能过期；
- bearer URL 可能进入 session / 日志；
- 无法复用 DSH 自己的 durable attachment / request projection。

## 设计

### QQ transport

解析官方 `attachments`：

```text
image → normalized image attachment
file  → normalized file attachment
unknown type → 不伪装文字；可观测 fail-closed
```

必须支持：

```text
C2C
GROUP（但 group control 权限仍不放宽）
```

### 下载层

新增统一：

```text
downloadInboundFile()
```

要求：

```text
URL SSRF guard
no credentials in URL
redirect:error
finite timeout
bounded byte count
name sanitize
不把远程 URL 写进 Session
```

文件大小上限必须由本插件自己设定；DSH `saveFile` 本身不是远程入口防火墙。

**上限值若 taskbook 没有拍板，不在实现时随手猜一个更大的数。**
可先复用当前远程媒体 5 MiB 安全预算，或由所有者显式决定独立 `MAX_INBOUND_FILE_BYTES`。

### Host P0-A attachment boundary

统一支持：

```text
admitInboundImage(bytes, mediaType)
admitInboundFile(bytes, name)
```

产物：

```js
{ type:'image', attachment: imageRef }
{ type:'file',  attachment: fileRef }
```

### 多附件

不要把 API 设计死成“只能一个附件”。

内部消息结构建议从：

```text
image?
file?
```

兼容扩展为：

```text
attachments: []
```

并继续接受旧 `image` / `file` 单项形状作为过渡。

DSH UserMessage 本身支持多个 content block，因此 transport 不应人为丢掉同一消息的第二个合法附件。

## 改动文件

```text
src/inbound/message.mjs
src/inbound/qq-gw.mjs
src/inbound/conversation.mjs
src/host/messages.mjs
test/inbound.message.test.mjs
test/inbound.qq.test.mjs
test/conversation.image-delivery.test.mjs
新增 file delivery focused test
docs/protocol-preflight/qq-bot.md
CHANGELOG.md
```

## 测试

```text
image attachment → durable ImageBlock
file attachment → durable FileBlock
text + image
text + file
image + file
多附件保持顺序
未知 attachment type → fail-closed
oversize → 不持久化
redirect → 不持久化
private/reserved URL → 不下载
download failure + text → text 仍投递
pure-file failure → 不构造空 UserMessage
Session 中无原 provider URL
file name 不允许路径穿越语义
```

---

# 3J. Issue #37 — 完整 i18n / English localization

## 当前已有基础

PR #24 后：

```text
lang: 'zh' | 'en'
src/strings.mjs
主要手机通知/审批/问题/命令/渠道回执双语
```

这部分不推倒重来。

## 当前明确缺口

### 管理台

`src/admin/ui/client.mjs` 等仍有大量直接中文，例如：

```text
已断开，5 秒后重连
渠道/成员/会话/绑定页文案
首访向导
错误/空态/按钮
```

### v0.10 后新增手机文案

`conversation.mjs` 的 `/tasks` / `/use` 等还有新增硬编码中文。

### W5-W10 未来新增

如果不先把 #37 纳入计划：

```text
W5 /sessions
W6 /log
W7 policy templates
W10 health panel
```

会继续扩大 i18n 债。

## 设计

继续只保留一个用户配置：

```text
lang
```

不要为了 Issue 文字写了 “language” 就机械新增第二套同义配置。

### 手机面

所有当前直接面向用户的剩余文本：

```text
迁入 strings.mjs
```

新增一个 static audit whitelist，防 v0.11 后又回潮。

### 管理台

推荐：

```text
服务端按 resolved lang 取 stringsOf(lang).admin
→ 序列化为只读 bootstrap locale object
→ 浏览器 client 只消费 key
```

这样：

- 不新增前端 i18n runtime；
- 不复制两套 JSON 文件；
- strings.mjs 继续是单一事实源；
- `lang:'zh'` 默认行为不变。

若当前 HTML / client 是纯静态文件：

```text
由 server/template 注入 JSON
```

不要为此引 bundler。

### 渠道配置元数据

管理台会展示 spec 的：

```text
label / desc / field.desc
```

English 模式也必须处理。

推荐新增 strings 的：

```text
admin.channels[type]
admin.channelFields[type][field]
```

provider 品牌名可两语言相同；帮助文案不能继续中文。

### 不自动做的事

本轮不主动加入：

```text
Telegram user.language_code 自动逐人切语言
浏览器 Accept-Language 自动覆盖配置
DSH_NOTIFIER_LANG 环境变量别名
```

这些都是额外产品决策，不是 #37 的必要条件。

## 测试

```text
zh/en key parity
stringsOf inherited-key fallback
lang=en 手机路径无固定中文
管理台六页 en 文案
onboarding en
SSE/重连/error/empty state en
channel form help en
W5/W6/W7/W10 新文案 en
用户内容/错误原文不强翻译
品牌名/协议字段允许保留原文
```

## 发布判据

在 `lang:'en'` 下做静态/行为扫描：

```text
用户可见硬编码中文 = 0
```

允许的白名单只能是：

```text
日志
协议 fixture
测试数据
用户原始内容
品牌/产品专名
历史 changelog/docs
```

不能把管理台中文塞进白名单掩盖。

---

# 3K. PR #34 文档/test-count 收口

该项不需要独立 runtime commit；和 WPS P0 / release docs 分开处理。

发布前必须：

```text
HANDOFF 当前基线重写
package dshQuality.testCount = 最终真实全量
README badge = 同值
CHANGELOG = 同值
```

禁止保留：

```text
1625 total / 1621 pass + 2 fail
```

这种算术不闭合的历史句作为“当前状态”。

如果需要保留历史 Windows 结果：

```text
明确写 pass / fail / skip / not-run 四类之和 = total
```

---

# 3L. “不遗留问题”的定义

v0.11 发布候选不允许出现：

```text
open technical Issue 没有 owner-approved disposition
closed-unmerged PR 的有效修复没有吸收
merged PR 的 Major review finding 仍可复现
review comment 已拆 Issue 但 Issue 没闭环
CHANGELOG/HANDOFF 声称完成而源码相反
docs/protocol-preflight 与 runtime 形状互相打架
```

允许存在的只有：

1. **明确非技术事项**（如 #25 公告）；
2. **平台/上游无法由插件修的限制**，且必须：
   - 有官方证据；
   - 在 Issue 中标明上游边界；
   - 有 owner 明确接受；
   - 不在 README 宣称为已支持；
3. **真机验证 gap**，但只允许对“已经 contract-correct 的功能”保留，不能把已知代码 bug 叫做“待真机”。


# 4. W0 #26 — QQ Markdown + Inline Keyboard

## 根因

当前 `src/inbound/qq-gw.mjs` 仍存在：

```js
render_data: {
  label: `${index + 1}. ${String(label).slice(0, 40)}`
}
```

以及：

```js
permission: { type: 2, specify_user_ids: [String(chatId)] }
```

对应测试还锁定 `specify_user_ids`。因此 #26 **没有修**。

腾讯官方 `dsh-qqbot`：

- `src/features/button-utils.ts`：`BUTTON_LABEL_MAX = 10`、`buttonLabel()`；
- `src/features/question-renderer.ts`：`permission:{type:2}`、`click_limit:1`；
- `src/features/approval-renderer.ts`：同样 `permission:{type:2}`；
- `src/transport/reply-target.ts`：无可用 `msgId/eventId` 时可降 proactive，keyboard 仍可跟随发送。

### 已确定

- `render_data.label` 最终整体必须 `<=10`；
- `permission.type=2` 保留；
- `click_limit=1` 保留；
- 不把 `msg_id` 当 keyboard 前置条件。

### 待裁决冲突

taskbook 当前写死：

```js
{ type: 2, specify_user_ids:[chatId] }
```

但腾讯官方参考实现是：

```js
{ type: 2 }
```

新官方证据支持删除 `specify_user_ids`，但没有证据证明它就是整块 keyboard 不渲染的根因。所以执行前需要所有者明确覆盖旧 taskbook 这一个小决策。

## 改动文件

```text
src/inbound/qq-gw.mjs
test/inbound.qq.test.mjs
CHANGELOG.md
docs/protocol-preflight/qq-bot.md（若补充本轮交叉证据）
```

## 行为边界

保留 C2C buttons、group text fallback、Control Core、token 单次核销、`action.type=1`、`click_limit=1` 和主动/被动回复逻辑。完整选项文字继续放 Markdown 正文，button 只承担短 label。

## 测试计划

```text
1. 中文长 label → 最终 <=10 code points
2. emoji/代理对不被切坏
3. "N. " 前缀计入 10 字预算
4. 恰好 10 不多截
5. approval 短按钮原样
6. group 仍不发可操作 keyboard
7. permission shape 按最终裁决锁定
8. click_limit=1 不回归
9. 不新增 msg_id 作为 keyboard 构造条件
```

Focused：

```text
node --test test/inbound.qq.test.mjs test/approval.qq-buttons.test.mjs
```

## 风险/回退

即使 label 修复，仍可能存在账号能力、客户端版本或灰度因素，所以 CHANGELOG 只能写“修复已确认的协议越界/对齐官方参考实现”，不能写“已证实唯一根因”。单 commit 可独立 revert。

## 证据

- `tencent-connect/dsh-qqbot@0c2541c.../src/features/button-utils.ts::BUTTON_LABEL_MAX/buttonLabel`
- `.../question-renderer.ts::buildKeyboard`
- `.../approval-renderer.ts::buildApprovalKeyboard`
- `.../reply-target.ts::resolveReplyTarget/sendResolvedMarkdown`

---

# 5. Host P0-A — UserMessage V4

此项包含两个互相关联的协议问题：`UserMessage.source` 与图片 durable attachment。建议同一个 commit 完成，因为它们共同构成“外部 IM 输入 → DSH UserMessage V4”这一条宿主边界。

## 5.1 根因 A：`source.kind='plugin'` 已退役

当前：

```js
source: {
  kind: 'plugin',
  plugin: 'dsh-notifier',
  form: 'notice',
  summary: ...
}
```

DSH `dsh-v0.1.7-rc.1`：

`packages/llm/llm/src/message.ts::MessageSourceMap` 明确写明：每个 producer 声明自己的 `kind`，**没有 shared catch-all `plugin` kind**。

`.agents/notes/implemented/architecture/2026-09-09-producer-owned-message-sources.md` 更明确：Native V4 admission 会拒绝 retired `{kind:'plugin'}` wrapper，包括 inbox 中的 durable messages。

而 dsh-notifier 的消息正通过 `followup/inject/steer` 进入 Agent Inbox。

### 设计

改为：

```js
source: {
  kind: 'dsh-notifier',
  form: 'notice',
  summary: ...
}
```

不再保留 `plugin:'dsh-notifier'`。`form:'notice'` 继续使用；summary 继续 `<=120`，与 DSH `CONTEXT_SUMMARY_MAX_CHARS=120` 对齐。

再次强调：**不修改 `ctx.notifier` v0.7 公共返回值的 `{kind:'plugin',name}`。**

## 5.2 根因 B：`image_url` 不是 rc.1 生产图片结构

当前：

```js
{ type:'image_url', image_url:{url} }
```

DSH rc.1：

```ts
interface ImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef
}
```

`ctx.attachments.saveImage()` 接受：

```ts
{
  data: Uint8Array,
  mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif',
  name?: string
}
```

并返回 durable `ImageAttachmentRef`。

### 正确数据流

```text
QQ / WeChat / DingTalk image envelope
  → normalize URL / SSRF guard
  → bounded fetch（timeout / redirect:error / <=5MiB）
  → {data:Uint8Array, mediaType}
  → ctx.attachments.saveImage(...)
  → ImageAttachmentRef
  → UserMessage.content [{type:'text'}?, {type:'image',attachment:ref}]
  → followup / inject / steer
```

Session 不再持有远程图片 URL。

## 5.3 建议新增 `src/host/messages.mjs`

职责仅限：

```text
安全读取 attachments capability
admitInboundImage()
buildRemoteUserMessage()
```

不要把 routing、pairing、Control Core、HTTP transport 塞进去。

## 5.4 attachments capability

不要把整个 notifier 改成 required static inject `attachments`。图片是可选能力，文本通知/控制必须在没有附件 service 的 Profile 继续工作。

建议安全读取：

```text
ctx.get('attachments', false) 或同等级 capability seam
```

行为：

- service 可用 → durable image admission；
- text+image 且 service 不可用/保存失败 → 正文仍投递，图片失败回执走双语；
- image-only 且无法 admission → 不构造空 UserMessage，不注入 URL，明确失败回执；
- `saveImage` reject → 绝不 fallback 到 `image_url`。

## 5.5 media type

现有 `image/*` 粗过滤不等于 DSH 可接受。最终只允许 rc.1 `ImageMediaType`：png/jpeg/webp/gif。`image/svg+xml` 等未知类型 fail-closed。

5 MiB 入口限制继续保留；宿主允许更大不代表远程 IM 入口应该放大攻击面。

## 改动文件

```text
src/host/messages.mjs（新增）
src/inbound/conversation.mjs
src/inbound/message.mjs
src/index.mjs（仅必要 wiring）
src/strings.mjs（若新增手机失败回执）
test/host-messages-v4.test.mjs（新增）
test/conversation.image-delivery.test.mjs
test/inbound.message.test.mjs
CHANGELOG.md
```

## 行为边界

必须保持：text-only 不依赖 attachments；普通 running 消息仍 inject，idle 仍 followup，`!` 仍 steer；图片失败时正文不丢；纯图失败不塞空消息。

必须消失：DSH Session 中的 `source.kind:'plugin'` 和 `type:'image_url'`。

## 测试计划

### host message unit

```text
text-only → kind='dsh-notifier'
form='notice'
summary <=120
无 legacy source.plugin
image ref → type='image'
image block 无 url/image_url
text+image 顺序稳定
image-only 无占位 text block
```

### attachment admission

```text
png/jpeg/webp/gif 正常
svg/未知 type 拒绝
attachments service 缺失安全降级
image-only + service 缺失不调用 agent
saveImage reject fail-closed
>5MiB 不 save
redirect/private/metadata target 不 save
bytes/type mismatch 由宿主拒绝后不注入
```

### routing integration

```text
idle image
running image
steer image
text+image
merge-window image
QQ/WeChat/DingTalk image
```

## 风险/回退

最大风险是旧 Profile 没装 attachment service，所以必须 capability-detect。单 commit 可 revert，但 revert 后不能继续宣称 rc.1 V4 图片契约正确。

## DSH 官方证据

- `packages/llm/llm/src/message.ts::MessageSourceMap/ContextFormed/CONTEXT_SUMMARY_MAX_CHARS`
- `packages/llm/llm/src/types.ts::ImageBlock/ContentBlockMap`
- `packages/attachment/attachment/src/index.ts::AttachmentStore/saveImage/admitPromptContent`
- `packages/attachment/attachment/src/types.ts::SaveImageAttachment/ImageAttachmentRef/ImageMediaType`
- `.agents/notes/implemented/architecture/2026-09-09-producer-owned-message-sources.md`

链接：

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/llm/llm/src/message.ts>

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/llm/llm/src/types.ts>

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/attachment/attachment/src/index.ts>

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/attachment/attachment/src/types.ts>

---

# 6. Host P0-B — `agent.cancel()` structured cause

## 根因

当前两条真实调用：

```text
src/inbound/conversation.mjs → agent.cancel('remote-stop')
src/index.mjs                → agent.cancel('remote-action')
```

DSH rc.1 `packages/core/session/src/types.ts::AgentCancelCause`：

```ts
| { kind:'user' }
| { kind:'parent' }
| { kind:'hook', reason:string }
| { kind:'disposed' }
```

`packages/core/agent-loop/src/agent.ts::ReactLoopAgent.cancel` 接受该结构并直接 `abort(cause)`，后续 turn/end 读取 `cause.kind`。所以字符串是实际 runtime contract mismatch。

## 设计

远程 `/stop` 和通知卡停止按钮都是人类用户请求：

```js
agent.cancel({ kind:'user' })
```

`remote-stop` / `remote-action` 如需区分，只留在插件自己的 ledger/debug，不塞入 DSH cancel vocabulary。

## 改动文件

```text
src/inbound/conversation.mjs
src/index.mjs
相关 stop/action tests
CHANGELOG.md
```

## 行为边界

不改鉴权、session resolution、action token、Control Core、已有回执；只改传给宿主的 cause shape。

## 测试计划

```text
/stop → cancel({kind:'user'})
action turn/cancel → cancel({kind:'user'})
不再传字符串
agent 不存在/抛错保持现有失败语义
真实宿主可用时验证 turn/end aborted reason.kind='user'
```

## 风险/回退

极窄协议修正，一 commit 可回退。

## DSH 官方证据

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/core/session/src/types.ts>  
符号：`AgentCancelCause`、`TurnEndCancelCause`、`TurnEndReasonMap`

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/core/agent-loop/src/agent.ts>  
符号：`ReactLoopAgent.cancel`

---

# 7. W0 #36 — QQ `attachments`

`docs/protocol-preflight/qq-bot.md` 已登记 C2C/GROUP 官方 `attachments`，当前实现仍主要依赖 `extra` 图片段，attachments 未统一映射。

## 设计

- 只解析官方字段白名单；
- image → 现有统一 image envelope；
- 非 image 附件不能伪装文本；
- file 尚无完整能力时 fail-closed + 可观测；
- C2C/GROUP 都接协议解析，但 group control 安全策略不变；
- 最终图片进入 P0-A durable attachment sink。

## 执行依赖

建议 **Host P0-A 先于 #36**：先修“图片进入 DSH 的终点”，再扩 QQ 图片“入口”。这不改变 W0 的相对顺序：仍是 `#26 → #36 → #33`。

---

# 8. W0 #33 — QQ outbound markdown

保持 taskbook 已拍板：默认 markdown、可 opt-out；这是所有者对 fail-closed 默认惯例的明确例外。

边界：`msg_type=2`、`markdown.content`、<=3000 code points、复用已有 code-point splitter；失败仍走现有 structured failure。不要和 #26 inline keyboard 合并成一个 commit。

---

# 9. P1-A — Qmsg 3.0

## 根因

当前：

```text
https://qmsg.zendee.cn/${type}/${key}
type=send/group
body={msg,qq,bot?}
fail=json.reason
```

当前 Qmsg 3.0 官方文档：

```text
GET/POST /v3/send/{key}
msg 必填
group 可选
默认单聊目标 = API Key 已绑定机器人好友
success 判断业务成功
失败描述字段 = message
```

另有 JSON `/v3/jsend/{key}`，但当前 spec engine 已适合 form POST，没必要机械改 JSON。

## 最小实现方向

继续 `encode:'form'`：

```text
POST /v3/send/{key}
单聊 body={msg}
群聊 body={msg,group}
```

`ok = success===true`，`fail = message`。

## 兼容难点

旧 `type=group + qq` 可无损映射：`group=qq`。

旧 `type=send + qq` 无法在 v3 官方 API 等价表示，因为单聊目标由 Key 绑定决定；`bot` 也不是当前公开请求字段。

### 待裁决

不能静默忽略旧 `qq/bot`。推荐：

- 新增 `group` 可选字段；
- legacy group 自动迁；
- legacy single `qq` / `bot` 明确报迁移提示或配置错误；
- 是否过渡期继续调用旧未文档化 endpoint，需要所有者决定。按“官方接口铁律”，更倾向 **不长期依赖旧接口**。

## 改动文件

```text
src/adapters/spec-channels.mjs
test/config-validation.test.mjs
test/fixtures/channels/qmsg.json
README/guide Qmsg 配置说明
CHANGELOG.md
```

若兼容逻辑超过 spec 维护红线（控制流过多），再降级为 `src/adapters/qmsg.mjs`，不要硬塞复杂 if。

## 测试计划

```text
v3 single endpoint/body
v3 group endpoint/body
success true
success false + message
legacy group + qq → group
legacy single qq/bot → 按最终裁决
key URL encode
不允许 type 继续成为任意 URL path
```

## 风险/回退

最大风险是旧单聊配置语义，不是 endpoint。本项必须独立 commit，可单独 revert。

## 官方证据

<https://qmsg.zendee.cn/docs/>

---

# 10. P1-B — Server酱 SC3

## 根因

当前：

```js
const SC3_BASE='https://sctp.ftqq.com'
`${SC3_BASE}/${sendkey}.send`
```

当前 `easychen/serverchan-sdk/npm/src/index.js::scSend`：

```js
sendkey.startsWith('sctp')
 ? `https://${sendkey.match(/^sctp(\d+)t/)[1]}.push.ft07.com/send/${sendkey}.send`
 : `https://sctapi.ftqq.com/${sendkey}.send`
```

因此 SC3 endpoint 确实错误。

## 注意：官方 repo README 内部有陈旧示例

README 底部 prompt 片段仍有简化 URL，但真正 Node/Python SDK 已使用数字子域 + `/send/<key>.send`。本项目应以当前可执行 SDK 源码为更强证据。

## 设计

```text
SCT → 现有 sctapi URL 不变
SC3 → key 必须匹配 /^sctp(\d+)t/
     → https://<捕获数字>.push.ft07.com/send/<key>.send
```

`sctp` 开头但 regex 不匹配时配置阶段 fail-closed，不能 `match()[1]` 直接炸 TypeError。

## Body codec

当前项目用 form，官方 SDK 当前用 JSON。但已确认缺陷是 endpoint，不是 body codec；现有 SCT 路径也在工作。因此本项 **只修 endpoint resolver，不顺手把全部 Server酱改 JSON**。若以后官方明确要求 JSON-only，再单独做。

## 改动文件

```text
src/adapters/serverchan.mjs
相关 config/serverchan tests
CHANGELOG.md
```

## 测试计划

```text
SCT URL 不变
合法 sctp → 数字子域 URL
malformed sctp → resolve fail-closed
alias priority/conflict warn 不变
code=0 success / nonzero failure
```

## 官方证据

<https://github.com/easychen/serverchan-sdk/blob/master/npm/src/index.js>

---

# 11. P1-C — DSH peer compatibility declaration

## 根因

当前只有：

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1"
}
```

无 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`。

DSH rc.1 `packages/boot/app-boot/src/plugin-compatibility.ts::evaluatePluginCompatibility()` 实际只检查这些 DSH peers，并用 `getDshRuntimeVersion()` 比较。官方 README 明确：missing DSH peers impose no constraint；检查 peer declarations，**不是 `engines.dsh`**。

所以当前官方 compatibility preflight 对本插件宿主版本实际上“不设限”。

## 设计

Host P0/P2 全部收口后，再声明真实测试过的 DSH peer range。

### 本轮不能写死 range

当前无法跑真实宿主版本矩阵，而已有事实表明 rc.1 在 Message V4、cancel、questions 等处发生契约变化。不能凭感觉写 `>=rc.6 <0.2`。

- 只能验证一个宿主 → 最保守可精确声明该版本；
- 要扩范围 → 必须有对应版本 matrix/host smoke。

`engines.dsh` 可作为 metadata，但不能冒充 enforcement。

同时检查当前 stale：

```text
dshWorkshop.compatibility.dshVersions = ["0.1.0-rc.6"]
```

它不是 DSH app-boot 的 enforcement，但发布元数据不能继续互相矛盾。

## 改动文件（最终）

```text
package.json
兼容文档/HANDOFF/project-state
CHANGELOG.md
release guard
```

## 测试计划

真实环境需要：supported install/start、incompatible preflight rejection、text path、native question bridge、image capability、reload/unload。

**具体 SemVer 范围：待验证。**

## DSH 官方证据

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/boot/app-boot/src/plugin-compatibility.ts>  
符号：`getDshRuntimeVersion`、`evaluatePluginCompatibility`

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/boot/app-boot/README.md>

---

# 12. P2-A — `ctx.root` 收敛

## 根因/现状

当前 `src/host-events.mjs`：

```text
selectHostEventContext(ctx)
→ 有 root 就优先 root
→ target.ctx.on(...,{global:true})
```

这是历史 Issue #16/#28 逐步修复结果，现在同时使用 root + global。

DSH rc.1 vendored Cordis：

- `vendor/cordis/src/context.ts::Context.root` 标 `@experimental`；
- `vendor/cordis/src/events.ts::EventOptions.global` 是正式事件选项，注释“Receive event regardless of context filter checks”；
- `EventsService.dispatch` 实际判断 `hook.global || !filter || filter.call(...)`。

## 设计

rc.1 modern primary：

```js
ctx.on(event, listener, { global:true })
```

这样避免依赖 experimental root，listener 仍归 plugin fiber，global 负责跨 scope。

但**不立即彻底删除 root fallback**：旧宿主历史上确有 scope 问题，本轮无老版本真实矩阵。

推荐：

```text
current ctx + global = primary
validated root + global = legacy fallback
```

只有 current 无 `.on` 或有明确兼容失败证据才 fallback；不再“只要 root 存在就 root-first”。

## `detectEventsMode`

先保留 `current/root/dual/unsupported`，避免为 P2 制造新的可见 enum breaking。后续 peer minimum 锁定后再清 legacy mode。

## 改动文件

```text
src/host-events.mjs
src/host/capability.mjs（仅必要口径）
test/host-events.test.mjs
test/host-capability.test.mjs
CHANGELOG.md
docs/memory/risks.md
```

## 测试计划

```text
current 可用 → current.on(...,{global:true})
current 成功不碰 root
current 无 on → legacy root fallback
malformed root fail-closed
disposer 属实际注册 ctx
plugin dispose 后不再触发
unrelated scope session/event 仍可收到
payload normalization/dedup 不变
diagnostics 不泄露 sid/text/token
```

## 风险/回退

风险是旧 Cordis global 行为可能不同，所以第一步只改 primary/fallback 顺序，不一刀切删除 root。单 commit 可 revert。

## DSH 官方证据

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/vendor/cordis/src/context.ts>  
符号：`Context.root`

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/vendor/cordis/src/events.ts>  
符号：`EventOptions.global`、`EventsService.dispatch`、`EventsService.on`

---

# 13. P2-B — native `ask_user` / userQuestions 口径

## 当前 runtime

`src/host/native-questions.mjs` 已经基本走对：有 `registerProvider` 时走 future provider path；否则注册：

```js
on('user-questions/request', waterfallHandler, {
  prepend:true,
  global:true
})
```

所以本项重点不是推倒 runtime，而是把“当前官方 seam”和工具可见性说准确。

## DSH rc.1 当前 seam

`packages/interaction/user-questions/src/index.ts::UserQuestionService.ask` 实际调用：

```ts
ctx.waterfall('user-questions/request', request, noAnswerer)
```

有 agent 时使用 `scopeTarget(agent, agent)`。rc.1 的 `UserQuestionService` 没有 `registerProvider()`。

因此：

```text
user-questions/request waterfall = rc.1 当前正式 answerer seam
registerProvider = future/feature probe
```

## `ask_user_question` 工具是另一层

`packages/interaction/tool-ask-user/src/index.ts::apply` 是一个单独 tool package，注入 `tools + userQuestions` 后注册 `ask_user_question`。

`packages/client/ui-user-questions/src/index.ts` 甚至明确说明：把该工具全局挂 tools 会扩张所有 Agent tool list，所以 model-facing tool 归 preset/TUI composition，而不是因为 Web UI / `ctx.userQuestions` 存在就自动全局可见。

### 对本项目的结论

- 保留 waterfall bridge；
- `registerProvider` 只写 future compatibility probe；
- **保留插件自家 `ask_user` fallback**；
- 不能用“`ctx.userQuestions` 存在”推导“当前 Agent 看得到官方 `ask_user_question`”；
- 没取到稳定公开、按目标 Agent scope 查询 model-visible tool 的 API，因此不读 ToolRuntime 私有 `view/layers`；工具去重标待验证、不做。

## 文档收口

优先修当前状态文档：

```text
HANDOFF.md
docs/memory/project-state.md
docs/memory/risks.md
src/host/native-questions.mjs 注释
src/host/capability.mjs 注释
```

历史 CHANGELOG 不大规模重写；最多在当前 `[Unreleased]` 增一条口径校准。

`detectQuestionsMode` 的 `provider-chain/native-event/unsupported` 值先不改，避免新增可见兼容面；只修注释含义。

## 行为边界

保持 `prepend:true/global:true`、手机与 GUI first-answer race、downstream reject 韧性、GUI 胜出 abort 手机侧、`canDeliver=false` 透传、插件 ask_user fallback。禁止全局强插官方工具、私有 registry 读取、monkey patch、第二授权边界。

## 测试计划

```text
rc.1 shape：有 ask 无 registerProvider → waterfall
future shape → provider path
service 缺失 → fallback 不炸
canDeliver=false → next only
GUI/mobile 两侧 race
下游 reject → 手机仍可答
service fiber replay 无重复 listener
capability snapshot 不谎报 tool visibility
自家 ask_user 不因 service 存在被移除
```

## DSH 官方证据

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/interaction/user-questions/src/index.ts>  
符号：`UserQuestionService.ask`

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/interaction/tool-ask-user/src/index.ts>  
符号：`apply`、`ask_user_question`

<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/client/ui-user-questions/src/index.ts>

---

# 14. W1～W10 — 保持 ROADMAP，只补当前约束

## W1 `dsh-notifier/testing`

保持 `src/testing.mjs` / `createFakeNotifier` / `./testing` export / `version='0.7'` / push never reject。Fake 的 `source:{kind:'plugin',name}` 模拟的是公共 notifier v0.7，**不能被 Host P0-A 改掉**。

## W2 TS types

保持 `types/index.d.ts`、`./types` export、files 包含 types。不要新增运行时依赖；tsc 是否作为 dev-only 验证工具按执行阶段裁定。

## W3 consumer demo

保持，不进入 npm payload：`examples/` 必须 pack 排除。

## W4 `PLUGINS.en.md`

保持章节一一对应；同时不能继续复制“registerProvider 是当前唯一 seam”的旧事实。

## W5 `/sessions`

保持现有 task/session projection；新增手机文案全部 strings.mjs 双语；不造第二状态源。

## W6 `/log`

默认 `enabled:false`。**不得为了 `/log` 恢复 `session.events` / `snapshotEvents()`**。Issue #32 已完成迁移；宿主无公开输出 snapshot 时按 ROADMAP 回退 ledger summary。

## W7 policy templates

保持 server-side whitelist，未知 template fail-closed，文案双语。

## W8/W9 reliability

先 W9 再 W8：先形成真实 `test/reliability-*` 可运行入口，再写承诺映射。W9 只移动/重命名，不复制测试，避免测试数虚增。

## W10 channel health

只读 ledger 聚合，不主动 ping 渠道，不新增外发。

---

# 15. 推荐执行顺序

每项一个 commit，直接 `dev`。

## Phase A — 协议硬错误

```text
Commit 1  W0 #26 QQ keyboard（permission 子项先裁决）
Commit 2  Host P0-A UserMessage V4
Commit 3  Host P0-B structured cancel
Commit 4  W0 #36 QQ attachments
Commit 5  W0 #33 outbound QQ markdown
```

W0 相对顺序仍是 `#26 → #36 → #33`，只是在 #26 与 #36 之间插入必要 Host P0。

## Phase B — 渠道/宿主兼容

```text
Commit 6  Qmsg 3.0（legacy single 先裁决）
Commit 7  Server酱 SC3 endpoint
Commit 8  P2 ctx.root modern-primary
Commit 9  P2 ask_user seam/documentation
Commit 10 DSH peer compatibility（最后定 range）
```

Peer 声明放最后，因为它应该描述完成所有宿主迁移后的真实 compatibility state。

## Phase C — ROADMAP

```text
Commit 11 W1 testing fake
Commit 12 W2 types
Commit 13 W3 consumer demo
Commit 14 W4 PLUGINS.en.md
Commit 15 W5 /sessions
Commit 16 W6 /log
Commit 17 W7 policy templates
Commit 18 W9 reliability test entry
Commit 19 W8 reliability.md
Commit 20 W10 health panel
```

---

# 16. 每个 commit 的统一验收模板

```text
1. git status 确认 dev
2. 只改本工作项文件
3. focused tests
4. npm test
5. 必要静态/生成检查
6. git diff --check
7. 新增手机/管理台文案 zh/en 一一对应
8. 无 dependencies/optionalDependencies 新增
9. commit
10. 不 push main
```

Commit/HANDOFF 证据写明：

```text
repo / tag / file / symbol
```

拿不到就标 `pending verification`，禁止把推测写成事实。

---

# 17. 发布收口

所有工作项完成后：

1. `package.json.version` → `0.11.0`；
2. `dshQuality.testCount` → **最终实测通过数**，不能沿用当前 1663；
3. `CHANGELOG.md` 新增 `[0.11.0]`，明确区分“修复 / 协议对齐 / 待真机验证”；
4. 管理台版本显示同步；
5. README.md / README.zh-CN.md 同步最终 test count、`/sessions`、`/log`、生态通知层、28 outbound；
6. HANDOFF 与 `docs/memory/project-state.md` 同步，去掉当前执行入口里的旧 codex 工作流和旧 ask_user seam 口径；
7. 能力描述继续区分 implemented / contract-tested / real-device-verified。

QQ #26 在无真机 A/B 前不能写“唯一根因已证实”。

---

# 18. 六门禁

## Gate 1 — clean dev

```bash
git status --short --branch
```

要求 `dev` + clean；不能 `main`、不能 `codex/*`。

## Gate 2 — full tests

```bash
npm test
```

要求 0 fail；以这次真实数更新 metadata。

## Gate 3 — reliability

```bash
npm run test:reliability
```

W9 完成后必须独立可跑。

## Gate 4 — release invariant

```bash
npm run verify:release
```

## Gate 5 — channel matrix

```bash
node scripts/gen-channel-matrix.mjs --check
```

继续锁 28 渠道与 README 不漂移。

## Gate 6 — npm payload

```bash
npm pack --dry-run --json
```

必须包含：

```text
types/
PLUGINS.en.md
```

必须不含：

```text
examples/
```

同时核对无新增 runtime dependencies。

---

# 19. 发布动作边界

六门禁全过后可准备 `dev` 交付，但按 taskbook 当前指令：

```text
npm publish
tag v0.11.0
dev → main merge
main push
```

都由所有者回来后执行。本计划/后续 agent **不得擅自碰 main**。

---

# 20. 三次失败熔断

任一门禁连续修三次仍不过：停止，写 HANDOFF“待裁决”，记录失败命令、首个稳定错误、三次尝试和当前 HEAD；不得通过放宽测试/安全门槛绕过。

---

# 21. 执行前必须裁决的三项

## 21.1 QQ `specify_user_ids`

旧 taskbook：`{type:2,specify_user_ids:[chatId]}`；腾讯官方 dsh-qqbot：`{type:2}`。

**推荐批准覆盖旧拍板：**删 `specify_user_ids`，来源安全继续由 Control Core + original chat binding 保证；但不要把它写成“已证实 keyboard 根因”。

## 21.2 Qmsg legacy single target

旧配置 `qq/type/bot` 与 Qmsg 3.0 的 Key 绑定单聊模型不等价。

**推荐：**legacy group 可自动映射；legacy single `qq/bot` 不静默忽略，明确要求迁移。是否留一版旧未文档化 endpoint compatibility，由所有者决定。

## 21.3 DSH peer SemVer range

官方机制已确定，但支持范围没运行证据。**推荐 P0/P2 完成 + host matrix 后再定。**不要提前写猜测范围。

---

# 22. 明确待验证清单

| 项 | 状态 |
|---|---|
| QQ label 超长是否必然造成“正文有、整块 keyboard 无” | 待真机 A/B |
| `type=2 + specify_user_ids` 是否影响渲染 | 待验证 |
| QQ 账号/客户端/灰度 keyboard 能力 | 待真机 |
| attachments service 在所有目标 Profile 的实际装配 | 待 host smoke |
| 旧 DSH 是否都可 current ctx + global 收全事件 | 待版本矩阵 |
| dsh-notifier 应声明的精确 DSH peer range | 待版本矩阵 |
| Qmsg 旧 single endpoint 是否仍官方支持 | 当前 v3 文档不支持，不能长期依赖 |
| Server酱 form 是否必须改 JSON | 当前缺陷无此证据，暂不改 |
| 飞书 SDK request timeout 公开入口 | taskbook 已标待验证 |

---

# 23. 不做清单

```text
不把 outbound 全换 SDK
不新增 runtime deps
不把普通 remote text 全改 steer
不恢复 session.events / snapshotEvents
不删除 plugin ask_user fallback
不全局强挂 ask_user_question
不读 ToolRuntime 私有 view/layers
不因 rc.1 新 API 一刀切老宿主 fallback
不把 Qmsg 未文档化旧 API当长期正式接口
不改 ctx.notifier 0.7 公共 source shape
不动 main
不创建 codex/*
```

---

# 24. 证据索引

## dsh-notifier

- <https://github.com/THEWOLFWALKER/dsh-notifier/tree/9a939105140adc153231f98965c5f4b4be7c16ec>
- <https://github.com/THEWOLFWALKER/dsh-notifier/blob/dev/docs/taskbook-v0.11.md>
- <https://github.com/THEWOLFWALKER/dsh-notifier/blob/dev/docs/ROADMAP.md>
- <https://github.com/THEWOLFWALKER/dsh-notifier/blob/dev/docs/protocol-preflight/qq-bot.md>

## DSH `dsh-v0.1.7-rc.1`

- `packages/llm/llm/src/message.ts::MessageSourceMap/ContextFormed`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/llm/llm/src/message.ts>
- `packages/llm/llm/src/types.ts::ImageBlock`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/llm/llm/src/types.ts>
- `packages/attachment/attachment/src/index.ts::AttachmentStore/saveImage`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/attachment/attachment/src/index.ts>
- `packages/attachment/attachment/src/types.ts::SaveImageAttachment/ImageAttachmentRef`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/attachment/attachment/src/types.ts>
- `packages/core/session/src/types.ts::AgentCancelCause`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/core/session/src/types.ts>
- `packages/core/agent-loop/src/agent.ts::ReactLoopAgent.cancel`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/core/agent-loop/src/agent.ts>
- `vendor/cordis/src/context.ts::Context.root`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/vendor/cordis/src/context.ts>
- `vendor/cordis/src/events.ts::EventOptions.global/EventsService.dispatch`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/vendor/cordis/src/events.ts>
- `packages/interaction/user-questions/src/index.ts::UserQuestionService.ask`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/interaction/user-questions/src/index.ts>
- `packages/interaction/tool-ask-user/src/index.ts::apply`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/interaction/tool-ask-user/src/index.ts>
- `packages/client/ui-user-questions/src/index.ts`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/client/ui-user-questions/src/index.ts>
- `packages/boot/app-boot/src/plugin-compatibility.ts::evaluatePluginCompatibility`
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/boot/app-boot/src/plugin-compatibility.ts>

## QQ 官方参考

- <https://github.com/tencent-connect/dsh-qqbot>
- 基准 commit：`0c2541c38e063b1506bb1aa9b61f9cda51ecf5d9`
- `src/features/button-utils.ts::BUTTON_LABEL_MAX/buttonLabel`
- `src/features/question-renderer.ts::buildKeyboard`
- `src/features/approval-renderer.ts::buildApprovalKeyboard`
- `src/transport/reply-target.ts::resolveReplyTarget/sendResolvedMarkdown`

## Qmsg

- <https://qmsg.zendee.cn/docs/>

## Server酱

- <https://github.com/easychen/serverchan-sdk/blob/master/npm/src/index.js>

---

# 25. 批准后第一批建议

如果只批准一个最小批次：

```text
1. 先裁决 QQ permission 是否去 specify_user_ids
2. W0 #26
3. Host P0-A
4. Host P0-B
```

做完这四步暂停一次 review。它们都是已有路径的协议正确性，不新增大产品功能，最适合先把宿主/QQ硬错误收干净。

---

# 26. 最终结论

当前 `dev@9a93910` 的工作分三层：

### 必须先修的协议硬错误

```text
QQ button label >10
DSH V4 legacy MessageSource
DSH image_url
DSH agent.cancel string cause
```

### 接口时效债

```text
Qmsg 3.0
Server酱 SC3
DSH peer compatibility
```

### 宿主适配收口

```text
ctx.root → current ctx + global primary
userQuestions waterfall 口径
保留 plugin ask_user fallback
```

然后才进入 W1～W10。

最重要的两个“不要修错”点：

1. **P0-A 只改 DSH UserMessage source，不能把 `ctx.notifier` 0.7 公共返回值 `{kind:'plugin',name}` 一起改掉。**
2. **`ctx.userQuestions` 存在不等于 `ask_user_question` 对当前 Agent 可见，所以不能机械删除 dsh-notifier 自家的 `ask_user` fallback。**

**本文到此停止。下一步等所有者批准设计，并先裁决 QQ `specify_user_ids`、Qmsg legacy single、DSH peer range 三个点；批准前不写代码。**


---

# 29. 最终权威执行顺序 v2（覆盖前文旧顺序）

> **执行时只看本节顺序。**  
> 每个工作项一个 commit；直接 `dev`；禁止 `codex/*`；禁止动 `main`。

## Phase 0 — 先把当前仓库里的“已知错误”清掉

### Commit 1 — PR #34 WPS HTTPS hardening

范围：

```text
只允许 https WPS webhook
legacy/new 两条归一都收紧
补 markdown payload test
```

理由：

```text
这是已合入代码里的凭证明文传输风险，优先级高于新增功能。
```

### Commit 2 — PR #20 Feishu P2P source identity

范围：

```text
ou_ target / oc_ callback identity reconciliation
approval / question / action / numbered reply
```

理由：

```text
closed PR 未吸收，当前 dev 仍有真实 P2P fail-closed 误拒。
```

### Commit 3 — W0 #26 QQ keyboard protocol bound

范围：

```text
label <= 10 code points（含 "N. "）
type=2
click_limit=1
msg_id 不成为 keyboard 前置条件
permission.specify_user_ids 按所有者最终裁决
```

### Commit 4 — Host P0-A UserMessage V4 + attachment boundary

范围：

```text
producer-owned source
ImageBlock
FileBlock capability groundwork
bounded bytes → durable refs
```

注意：

```text
只改 DSH UserMessage source；
ctx.notifier 0.7 公共 result.source 不动。
```

### Commit 5 — Host P0-B structured cancel cause

```text
'remote-stop' / 'remote-action'
→ {kind:'user'}
```

### Commit 6 — Issue #31 Feishu finite request timeout

先取 pinned SDK 1.73.0 官方源码。

```text
有公开真实 timeout seam → 实现
没有 → 停在 PENDING-EVIDENCE，不能伪装 Promise.race 为 transport timeout
```

**本项默认是 release blocker。**

---

## Phase 1 — W0 协议功能闭环

### Commit 7 — W0 #36 QQ attachments

依赖 Commit 4。

完整：

```text
attachments parse
image
file
multi-attachment
bounded download
DSH durable ref
```

### Commit 8 — W0 #33 qq-bot outbound markdown

按 taskbook 已拍板：

```text
默认 markdown
显式 opt-out
<=3000 code points
复用现有分段器
```

### Commit 9 — Issue #32 verification / closure record

本项原则上不改 runtime。

若 focused/full 验证通过：

```text
只更新必要 changelog / issue closure evidence
```

如果验证意外失败：

```text
立刻升格回 runtime FIX，不得为了“计划说已修”硬关 Issue。
```

---

## Phase 2 — 渠道时效债

### Commit 10 — Qmsg 3.0

```text
/v3/send/{key}
group 参数
success/message
legacy group 兼容
legacy single qq/bot 按所有者裁决
```

### Commit 11 — Server酱 SC3

```text
sctpNNNt...
→ https://NNN.push.ft07.com/send/<key>.send
```

只修 endpoint，不机械重构整个 body codec。

---

## Phase 3 — 宿主兼容收敛

### Commit 12 — P2 `ctx.root`

```text
current ctx + global:true 为 rc.1 primary
root 只 legacy fallback
```

### Commit 13 — P2 native ask_user seam/doc

```text
waterfall = rc.1 当前 seam
registerProvider = feature probe
保留 plugin ask_user fallback
```

### Commit 14 — DSH peer compatibility

前提：

```text
Host P0 / P2 全完成
至少拿到可声明的真实 host matrix
```

拿不到：

```text
不得猜 SemVer range
```

---

## Phase 4 — ROADMAP C1

### Commit 15 — W1 testing fake
### Commit 16 — W2 TS types
### Commit 17 — W3 consumer demo
### Commit 18 — W4 `PLUGINS.en.md`

W1 fake 必须继续模拟：

```js
source: { kind:'plugin', name }
```

因为这是 notifier 0.7 API，不是 DSH V4 UserMessage source。

---

## Phase 5 — ROADMAP A1/A2

### Commit 19 — W5 `/sessions`
### Commit 20 — W6 `/log`
### Commit 21 — W7 policy templates
### Commit 22 — W9 reliability test entry
### Commit 23 — W8 reliability.md
### Commit 24 — W10 health panel

红线：

```text
W5/W6/W7/W10 新用户文案当场进 strings.mjs zh/en
W6 不得复活 session.events/snapshotEvents
W10 不主动 ping 渠道
```

---

## Phase 6 — Issue #37 i18n 总收口

### Commit 25 — i18n / English completion

放在 W5-W10 后的原因：

```text
一次扫净“历史 + v0.11 新增”用户界面
避免先翻译、后新增、再翻译第二遍
```

内容：

```text
剩余手机硬编码
管理台全部页面
onboarding
SSE/error/empty state
channel config labels/help
W5/W6/W7/W10
```

默认：

```text
lang:'zh' 行为不变
lang:'en' 用户面不出现硬编码中文
```

---

## Phase 7 — GitHub / 文档 / release closure

### Commit 26 — current-state docs + issue/pr closure manifest

更新：

```text
CHANGELOG.md
HANDOFF.md
docs/memory/project-state.md
docs/memory/risks.md
docs/protocol-preflight/*
README.md / README.zh-CN.md
```

新增建议：

```text
docs/release-audit-v0.11.md
```

内容必须列：

```text
27 Issues
9 PRs
每条最终 disposition
对应 commit
对应 tests
是否真机
是否仍有上游限制
```

这样以后不会再发生：

```text
Issue closed 了，但修复其实没进
PR merged 了，但 review finding 还活着
```

---

# 30. GitHub Issue 收口顺序

代码完成后，不要一次性盲关。

按每条证据关闭：

```text
#26 → QQ keyboard focused/full 通过后关闭
#31 → Feishu timeout 真闭环或 owner 明确上游接受后关闭
#32 → assistant cache 验证后关闭
#33 → outbound markdown 完成后关闭
#36 → durable attachment 完成后关闭
#37 → en bot + admin 验收后关闭
```

`#25`：

```text
保持公告用途；
2026-10-01 后由所有者按实际情况归档/关闭。
```

已 closed 的：

```text
不机械 reopen。
```

但在 `docs/release-audit-v0.11.md` 里记录：

```text
#14 → Host P0-A 再验证历史承诺
#16 → PR28 才是最终 scope 修复
#15 → superseded by #23
#27/#29 → PR30
```

---

# 31. PR 收口规则

当前无 open PR。

发布前要求：

```text
PR #9  DONE
PR #12 absorbed
PR #20 reimplemented on current dev
PR #22 absorbed
PR #24 absorbed + #37 extension
PR #28 merged + regression kept
PR #30 merged + #31 closed/dispositioned
PR #34 merged + HTTPS/markdown/doc findings fixed
PR #35 merged
```

特别检查：

```text
GitHub review comments 中所有 Major / actionable findings
```

必须能指向：

```text
fix commit
Issue
或“current code makes finding inapplicable”的具体源码证据
```

不能留“没人处理但 PR 已 merge”的灰区。

---

# 32. 发布前六门禁 v2

## Gate 1 — Source / branch / audit state

```bash
git status --short --branch
```

必须：

```text
dev
clean
```

同时：

```text
docs/release-audit-v0.11.md
```

必须覆盖 27 Issues + 9 PRs，无遗漏项。

---

## Gate 2 — Full tests

```bash
npm test
```

要求：

```text
0 fail
```

最终真实总数同步：

```text
package.json dshQuality.testCount
README badge
HANDOFF
CHANGELOG release entry
```

---

## Gate 3 — Reliability package

```bash
npm run test:reliability
```

要求：

```text
独立全绿
无重复测试复制导致虚增
```

---

## Gate 4 — Release + i18n invariants

```bash
npm run verify:release
```

并增加/运行：

```text
i18n user-surface audit
```

至少保证：

```text
zh/en key parity
lang=en 用户可见硬编码中文 = 0（仅白名单例外）
public notifier version = 0.7
zero runtime dependencies
```

---

## Gate 5 — Protocol/channel generated checks

```bash
node scripts/gen-channel-matrix.mjs --check
```

同时 focused protocol suites 至少包含：

```text
QQ keyboard
QQ attachments
Feishu P2P
WPS HTTPS + markdown
Qmsg v3
ServerChan SC3
Host V4 message/cancel
native questions
```

---

## Gate 6 — Package payload

```bash
npm pack --dry-run --json
```

核对：

### 必须包含

```text
types/
PLUGINS.en.md
发布需要的 docs
```

### 必须不包含

```text
examples/
临时 taskbook
秘密/凭证
私有测试产物
```

并再次确认：

```text
dependencies = 0
optionalDependencies 没有因本轮新增
```

---

# 33. 六门禁之后的 GitHub 收口检查

这不是“第七个代码门禁”，而是发布管理动作。

执行：

```text
1. 搜索 is:issue is:open
2. 技术 open issue 必须为 0
   （#25 公告除外）
3. 搜索 is:pr is:open → 0
4. 对 9 个历史 PR 的 review findings 做最终勾销
5. 每个本次关闭 Issue 留：
   - fix commit
   - test command/result
   - real-device / contract evidence 等级
6. 不关闭任何仍标 PENDING-EVIDENCE 的技术 Issue
```

如果 #31 仍因 Feishu SDK 无公开 timeout 无法落地：

```text
v0.11 默认不得宣称“全部问题清零”。
```

只能：

```text
继续取证修
或由所有者明确接受上游限制并改变 Issue 性质
```

---

# 34. 发布候选的“零遗留”验收表

最终必须全部打勾：

```text
[ ] #26 fixed + closed
[ ] #31 fixed/dispositioned + closed/upstream-tracking
[ ] #32 verified + closed
[ ] #33 fixed + closed
[ ] #36 fixed + closed
[ ] #37 fixed + closed

[ ] PR20 Feishu P2P absorbed
[ ] PR34 WPS HTTPS fixed
[ ] PR34 markdown send test added
[ ] PR34 HANDOFF count stale text removed

[ ] Host V4 source fixed
[ ] Host image durable
[ ] Host file durable
[ ] Agent cancel cause structured
[ ] ctx.root modern path收敛
[ ] ask_user seam docs match rc.1
[ ] DSH peer range has real evidence

[ ] Qmsg 3.0
[ ] ServerChan SC3

[ ] W1-W10
[ ] en admin
[ ] en mobile sweep

[ ] 27 Issue audit has no missing row
[ ] 9 PR audit has no missing row
[ ] all actionable PR review comments dispositioned
[ ] no technical open issue left silently
```

---

# 35. 本轮新增的三个 owner 裁决点之外，再加两个

前文已有：

```text
1. QQ type=2 下是否移除 specify_user_ids
2. Qmsg legacy single qq/bot 怎么迁
3. DSH peer SemVer range
```

全量 Issue/PR 审计后还需要：

## 4. Issue #36 远程文件入口字节上限

DSH `saveFile` 是 durable storage，不替插件做公网入口大小防线。

建议：

```text
优先复用 5 MiB 现有远程媒体预算
```

若要单独提高文件上限，需要所有者明确拍板。

## 5. Issue #31 若 pinned Feishu SDK 没有真实可取消 timeout seam

默认：

```text
继续设计可取消 transport，不接受假 timeout
```

若所有者愿意把它作为上游限制发布，必须显式批准；否则保持 release blocker。

---

# 36. 最终结论 v2

全量扫完 Issue / PR 后，v0.11 不能只按原 taskbook 的：

```text
QQ + Host + Qmsg + SC3 + W1-W10
```

执行。

在它们前面还必须补上：

```text
PR34 WPS HTTPS security
PR20 Feishu P2P source identity
Issue31 Feishu timeout
```

后面还必须补：

```text
Issue37 full i18n
Issue/PR closure manifest
GitHub housekeeping
```

而 #36 应与 Host P0-A 合成真正的：

```text
remote IM bytes
→ bounded admission
→ DSH durable ImageBlock / FileBlock
```

而不是继续保存远程 URL。

所以 v0.11 的正确闭环是：

```text
先清当前已知 bug/security
→ 修 Host V4 契约
→ 完成 QQ W0
→ 清渠道时效债
→ 收敛 Host seam/peer
→ W1-W10
→ 全量 i18n
→ Issue/PR 全量证据收口
→ 六门禁
→ owner 发布
```

**批准前仍不写代码。**

---

# 37. Owner 裁决记录（2026-09-24，已批准执行）

> 五项裁决全部拍板，此后不再作为执行中的待确认项。仅保留两个「执行时证据门」：Feishu 1.73.0 timeout 具体调用形态、DSH peer 精确范围（均由源码/验证结果决定，非产品决策）。

| # | 裁决点 | 裁定 |
|---|---|---|
| 1 | QQ keyboard `permission.specify_user_ids` | **移除**。最终形态对齐腾讯官方参考实现：`action:{type:1, permission:{type:2}, click_limit:1, data}`（无 specify_user_ids，证据：tencent-connect/dsh-qqbot `src/features/question-renderer.ts`、`src/features/approval-renderer.ts`）。理由：该字段无必要存在；用户权限已在 Control Core（token / account/user/chat / pending / 一次性裁决）保证，QQ keyboard 层不叠未经证实的 provider 限制。**不得**把「根因就是 specify_user_ids」写进 changelog；措辞限定为「对齐腾讯官方参考实现，移除非必要字段，并同时修正按钮 label 等协议约束」。 |
| 2 | Qmsg legacy single qq/bot | **A（含细化）**：`type=group+qq=<id>` → `group=<id>` 无损自动迁移；`type=send+qq` / `bot` 在配置阶段报具体 migration error（文案示例：「Qmsg 3.0 不再支持通过请求参数指定单聊 QQ / bot。请在 Qmsg 控制台绑定目标机器人和 QQ 后，删除旧 qq/bot 配置。」），不静默忽略、不调用旧 endpoint；仅 key 无目标语义的旧配置自然归一为 v3 默认单聊。不选 B（双协议测试矩阵 + 将来再删）、不选 C（group 可无损迁，不必让用户重配）。 |
| 3 | Issue #36 文件字节上限 | **统一 5 MiB**：`MAX_INBOUND_IMAGE_BYTES = 5*1024*1024`、`MAX_INBOUND_FILE_BYTES = 5*1024*1024`。单附件统一 ≤5 MiB；上限按**实际读取字节**计，不信 Content-Length（Header 仅用于提前拒绝；流读超 5 MiB 立即 cancel）。不做 configurable maxInboundFileBytes（将来真实需要再单独加并重审 SSRF/内存/并发/存储/DoS）。 |
| 4 | Issue #31 Feishu timeout | **A 升级为「优先验证并大概率可直接实现」**：官方当前 `HttpRequestOptions.timeout?: number` + semantic API 第二 request options 参数 + 自定义 httpInstance 均有文档证据。执行合同：① 核 pin 的 `@larksuiteoapi/node-sdk@1.73.0` 实际 types/runtime——若 semantic method 第二参数最终进入 `HttpRequestOptions.timeout` → per-request timeout，覆盖 create/patch 等全部 REST send，正常关闭 #31；② 类型有 timeout 但 semantic 不透传 → 查 httpInstance 隔离方案；③ 两者都不成立 → PENDING-EVIDENCE / release blocker。**仍不接受 Promise.race() 冒充 transport timeout**。 |
| 5 | DSH peer SemVer range | **A（更保守）**：Host P0-A / P0-B / P2 ctx.root / P2 native questions 全部完成后、拿真实 DSH 版本 matrix（contract/smoke 验证）再写。第一版宁窄勿猜（如只声明已验证的 0.1.7-rc.1 与 0.1.7，不拍 `^0.1.7`）。证据：deepseek-ai/deepseek-harness `packages/boot/app-boot/src/plugin-compatibility.ts` 只检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peers，且 `semver.satisfies(..., {includePrerelease:true})`；无 DSH peer 时 checker 不限制宿主版本。不阻塞开发，但阻塞最终 package compatibility 声明。 |

**执行开始条件已满足**：owner 已批准执行顺序 v2 并完成全部裁决。仅 Commit 6（Feishu timeout）与 Commit 14（DSH peer）保留上述两个证据门。
