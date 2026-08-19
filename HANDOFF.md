# dsh-notifier 交接文档（HANDOFF）

> 写给下一个 agent。本文档是完整的工作上下文快照：设计理念、军规约定、架构地图、
> 版本脉络、审查记录、已知坑、待办清单。读完这一份即可无缝接手。
> 交接时刻：2026-08-19，v0.8.5（交接打包批：npm 发布包文档完整性 + guide.md 远程提问章节 + 仓库文件地图）885/885 全绿，npm 发布位 0.8.4（0.8.5 待发布）。
> 本文上一快照位 v0.8.2（2026-08-18）；v0.8.3/v0.8.4 为安全修复版，0.8.4 的 CHANGELOG 条目由接手 agent 于 2026-08-19 回补（发版时遗漏）。
> 上一稳定发布位 v0.6.5 = `b2d23c0`（npm 与 GitHub 发布位 `0221d1e` 已对齐）。

---

## 0. 一句话

dsh-notifier 是 DSH（一个 agent 宿主，cordis 插件体系）的统一通知推送插件：
一个 `notify()` API 出多个渠道（telegram/feishu/qq/wxpusher/wechat/dingtalk/bark/...27 = 12 专属 adapter + 15 spec 渠道），
外加**远程审批**（agent 请求危险操作时推卡片到手机，点按钮/回复 1/2 远程裁决）、
**远程会话**（手机上回复消息 inject 进 agent 会话）、**远程提问**（v0.8 ask_user 选择题：选项卡+编号兜底，超时永不代答）、**移动指挥中心**（长任务心跳/疑似卡住提醒/停止任务按钮）、
**开放事件源**（其他插件经 notifier 服务推送 + 订阅 `dsh-notifier/sent` 事件）、
**身份体系**（配对码准入/复合键绑定/运行时成员管理，v0.7）、
**本机 Web 管理台**（凭证/路由/成员/扫码授权，移动端适配）。
零运行时依赖（只用 fetch + node:crypto + 原生 WebSocket）。

- 语言/运行时：Node.js ESM（.mjs），无 TypeScript，无构建步骤
- 代码量：src+test+scripts ≈ 35,500 行；46 个测试文件，885 测试
- 文档：README.md / README.zh-CN.md / ADAPTER.md（渠道接入规范）/ PLUGINS.md（插件互操作）/ docs/v0.5-design.md / docs/v0.6-design.md / CHANGELOG.md（最详细的历史）

---

## 1. 当前状态（交接时刻）

| 项 | 状态 |
|---|---|
| 版本 | package.json = 0.8.5（CHANGELOG 已写、admin UI 版本串 v0.8.5、双语 README、HANDOFF 均已同步）；npm 发布位 = 0.8.4，**0.8.5 待发布** |
| git | v0.8.5 已提交（`d7867f9` 打包批 + `e6c40a4` node_modules 出库）；npm 位 0.8.4 = `38e08e5`；v0.7.0 作者位 `0221d1e` |
| 测试 | `npm test` = **885 pass / 0 fail**（node --test；v0.8.2 位 846 → v0.8.3 +16 → v0.8.4 +23 → 0.8.5 纯文档零增） |
| 发布 | **发包前核对四处计数一致——README.md 徽章/正文、README.zh-CN.md 徽章/正文、HANDOFF.md、admin UI 版本串（src/admin/ui.mjs）——任何一处与实际不符先修再发** |
| 真机验证 | v0.6.1 修过 TG 真机事故（见 §5）；v0.7 真机测试通过（2026-08-17，v0.7.0-realtest 包）；内部真机测试文档 TG-TEST.md（Telegram 提问链路）与 WECHAT-TEST.md（微信扫码即配对）随 code/ 保留 |

### 1.5 仓库文件地图（发布文件 vs 工程文件，0.8.5 立）

**规则一句话：README（双语）里链接到的文件必须随 npm 包分发；给装包用户的文档进 `files` 数组，给贡献者的留仓库。**
`npm pack --dry-run` 可随时验证（0.8.5 起 = 143 个文件）；npm 自动包含 `README*`（含 zh-CN）、`LICENSE`、`package.json`。

**npm 发布包内**（package.json `files` + 自动包含）：

| 内容 | 文件 | 为什么随包 |
|---|---|---|
| 运行面 | `src/` · `cordis.patch.yml` | 插件本体 + 装配补丁 |
| 双语 README | `README.md` · `README.zh-CN.md`（自动） | npm 首页渲染 |
| 历史与法律 | `CHANGELOG.md` · `THIRD_PARTY_NOTICES.md` | README 底部链接到后者 |
| 用户文档 | `docs/guide.md` · `docs/upgrade-guide.md` · `docs/upgrade-guide.en.md` | README 双语均链接 guide；升级/回滚是装包用户高频需求 |
| 互操作契约 | `PLUGINS.md` | 其他插件作者消费 notifier 服务时的契约（README 链接） |
| CLI | `scripts/`（channel-login · test-channel · route · gen-channel-matrix 等） | guide.md 教用户直接 `node scripts/...` |
| 测试 | `test/` | 行为契约随包分发是项目惯例（885 用例，装包即可 `npm test`） |

**仅工程仓库（不进 npm 包）**：

| 文件 | 性质 |
|---|---|
| `HANDOFF.md` | 本文档——agent 交接上下文 |
| `ADAPTER.md` | 渠道接入规范——给加渠道的贡献者 |
| `docs/v0.5-design.md` · `docs/v0.6-design.md` | 设计决策存档 |
| `docs/test-notes/`（TG-TEST · WECHAT-TEST） | 内部真机测试记录 |
| `docs/screenshots/`（612K） | README 截图；npm 页面相对路径图片本就不渲染，白占包体 |
| `.github/` · `.gitignore` · `package-lock.json`（untracked） | CI 与仓库卫生 |

> **node_modules 不入库**（0.8.5 清理）：v0.7.1 曾把 947 个文件的 node_modules 误提交进 git（`.gitignore` 拦不住已跟踪文件），0.8.5 已 `git rm --cached` 出库并实证零依赖（移走后 885/885 全绿）。新克隆直接 `npm test` 即可，无需 `npm install`；要跑真机 inbound（飞书 WS / QQ connector 等可选包）才需要装 optionalDependencies。

> 新增文档时先问「给谁看」：装包用户 → `docs/` + `files` 数组 + README 链接；贡献者/内部 → 仓库即可，但要登记进本表。

---

## 2. 设计理念（不可违背的红线）

这些是项目的宪法。任何改动先对照这一节，历次 review 的第一检查项就是它们：

### 2.1 安全红线（审批链）

1. **静默永不批准**：超时/无响应/解析失败/任何异常 → `return next()` 交还桌面决定。
   宁可用户重新点一次，绝不替用户批准。所有 fail 路径的语义都是「回落桌面」。
2. **一次点击只授权一次操作**：token 单次核销（vault verify 即失效）+ 审批账本状态机
   （首达采纳，二次裁决返回 `already-resolved`）。双保险。
3. **A listener never throws**：所有事件处理器/消息处理器/装配段全 try/catch 包裹。
   插件绝不能弄崩宿主。装配段还要**逐通道隔离**（一条通道炸了 warn 并跳过，其余照常——v0.6.1 真机事故的教训）。
4. **白名单默认全拒**：`allowUsers` 为空 → 任何入站消息都被拒绝。授权显式、非隐式。
5. **token 时效**：10min TTL，HMAC 签名；`tokenSecret` 默认进程随机（重启后旧卡全废）。

### 2.2 工程军规（写代码时的约定）

1. **零运行时依赖**：只用 fetch / node:crypto / 原生 WebSocket / node:*。optionalDependencies 仅 @larksuiteoapi/node-sdk（飞书 WS，懒加载，没装给中文指引后静默降级）。
2. **错误双写 stderr**：宿主 logger 在 web profile 下不落 stdout，告警必须同时 `console.error`（v0.6.1 真机事故：出站正常+inbound 全死+零可见，排查数轮）。见 `bus.mjs` 的 `warn()`。
3. **fail 的方向**：读失败 → 回退默认/内存态；写失败 → 保留 dirty 下次再试 + warn 一次（不刷屏）；**损坏的 state 文件绝不覆写**（v0.6.4：save 撞上解析失败 = 中止，只有启动 load 才 fail-open 到空——无记忆好过误清空）。
4. **状态文件权限 0600**：state.json / 账本 / 审计都含凭证或上下文（共享主机不可他账号可读）。
5. **每个「审查发现」的修复都要写进 CHANGELOG 并注明审查编号**（如 R2-P1-2），修复处代码注释同样标注。这是项目的可追溯性文化。
6. **测试是行为契约**：行为变更必须同步改测试并在 CHANGELOG 说明为什么改（例：v0.6.4 损坏文件测试从「fail-open 覆写」改成「写入中止保护现场」）。
7. **注释风格**：中文，先说「为什么」再说「是什么」，版本号+审查编号标注来源。文件头是模块职责总述。照着现有文件写就对了。

### 2.3 并发模型（v0.6.3/v0.6.4 的核心主题）

`state.json` 被**多进程**同写：运行中宿主 + CLI（route/channel-login/wechat-login）。三层防御：

1. **键级合并**（v0.6.3）：每个 store 实例只落自己动过的键（dirty set），写时重读磁盘合并——不互相抹键。
2. **跨进程写锁**（v0.6.4）：`save()` 全程持 `<file>.lock`（`openSync 'wx'` 抢占；mtime>10s 视为陈锁可清；有界自旋 60×4ms；超时强写降级+warn）。堵 last-writer-wins 整文件丢写。
3. **读收敛**（v0.6.4）：`get()/keys()` 节流 stat（≥500ms 一次），mtime 变了就重载合并（dirty 键内存优先）——CLI 写 route:* 对运行中宿主秒级可见。

---

## 3. 架构地图

```
src/
├── index.mjs            # 装配总入口（apply）：装配顺序是刻意的，见注释
├── config.mjs           # 配置解析与默认值
├── notify.mjs           # 出站核心：notify()/notifyAll()，分段、限流、重试
├── routing.mjs          # level → 渠道语义矩阵（active/passive/timeSensitive）
├── rules.mjs            # 通知规则（事件 → 是否/如何通知）
├── ledger.mjs           # 通知账本（append-only + prune）
├── event-listener.mjs   # 宿主事件 → 通知（含 turn 心跳/卡住检测）
├── health.mjs           # 渠道健康/熔断
├── actions.mjs          # v0.5 动作分发器（ac: 回调 → turn/cancel 等，白名单动作面）
├── public.mjs           # v0.6 开放服务面（其他插件 push + dsh-notifier/sent 事件）
├── tool-register.mjs    # notify 工具注册给 agent
├── adapters/            # 出站渠道（_engine 共享引擎；spec-channels.mjs 一个文件吃 15 个 JSON 规范渠道）
├── inbound/             # 入站（双向通道核心）
│   ├── bus.mjs          # 入站总线：白名单+去重+审批 waiter+消息扇出（消费语义：true=停止扇出）
│   ├── store.mjs        # state.json 持久化（§2.3 并发三层防御都在这）
│   ├── tokens.mjs       # token vault（mint/verify，HMAC）
│   ├── callback-refs.mjs# v0.6.2 短引用注册表（TG callback_data 64B 限制）
│   ├── identity.mjs     # v0.7 身份绑定层（复合键绑定表/角色/待确认/迁移）
│   ├── pairing.mjs      # v0.7 配对码状态机（六态/SHA-256/暴力锁出/bootstrap）
│   ├── commands.mjs     # v0.7 注册命令（/help /whoami /pair /unpair）
│   ├── target-guard.mjs # v0.7 目标解析三级优先 + 渠道形状守卫
│   ├── conversation.mjs # 远程会话（入站消息 → agent 会话 inject）
│   ├── telegram-bot.mjs / feishu-bot.mjs / qq-gw.mjs / wechat-ilink.mjs /
│   │   dingtalk-stream.mjs / wxpusher-callback.mjs   # 各通道长连接/轮询实现
│   └── _contract.mjs    # 渠道统一契约（normalizeInbound：新旧形状归一）
├── approval/
│   ├── router.mjs       # 审批瀑布流处理器（§2.1 红线的主要承载者）
│   └── escalation.mjs   # 30s/60s 升级提醒链
├── questions/
│   └── router.mjs       # v0.8 远程提问 ask_user（选项卡+编号兜底；复用审批桥接栈：
│                        #   HMAC 一次性 token / 白名单 / 首达采纳 / 催办升级链 / aq: 账本前缀）
├── routing/             # v0.3.2 路由引擎（与 routing.mjs 互补不冲突）
│   ├── agent-router.mjs # agent/会话 ↔ 渠道 双向解析链（route:agents/sessions）
│   └── session-registry.mjs # agent 生命周期 → route:sessions 台账
├── admin/               # v0.3.3 Web 管理台（server/api/ui/scan/events，SSE）
├── status/turn-tracker.mjs # 任务状态跟踪（心跳源）
└── client/desktop-sound.mjs # 桌面端提示音
```

**装配顺序要点**（index.mjs，改动前先读注释）：notifier → publicFacade/服务注册 → sweep 定时器 → router/registry → event-listener（惰性 getter 拿 actions/interactive）→ 白名单块（vault→bus→actions→逐通道 inbound，每通道独立 try）→ 审批注册。dispose 链全程收集（disposers 数组，卸载逆序语义）。

---

## 4. 版本脉络（为什么会有这些版本）

| 版本 | 主题 | 一句话 |
|---|---|---|
| v0.5 | 动作闭环 | 「停止任务」按钮（ac: 动作）+ turn 追踪 + 心跳/卡住提醒 |
| v0.6.0 | 开放事件源 | notifier 服务注入 + `dsh-notifier/sent` 事件（其他插件可推送/订阅） |
| v0.6.1 | 真机事故#1 | inbound 装配可诊断性：错误双写 stderr + 逐通道装配隔离（web profile 下零可见的教训） |
| v0.6.2 | 真机事故#2 | TG `callback_data` 64B 硬限 → BUTTON_DATA_INVALID 400。短引用注册表（`r:<8字符>`，单次核销+TTL 15min+FIFO 256） |
| v0.6.3 | 首轮三路审查修复 | 11 项：审批 waiter 预注册竞态 / state 键级合并防互抹 / state 定期瘦身 / 空目标可见化 / 分段部分送达不整条重试 / 编号回复收紧到送达渠道 / 账本审计 0600 等 |
| v0.6.4 | 二轮审查修复 | 6 项：跨进程写锁 / 损坏中止 / 读收敛 / 编号回复 intended 兜底（堵「卡片发送失败但广播教回复 1」死路）/ pushedTo 增量落账 / counter 随机起点 + bus.dispose() + dedup 清扫线联动 |
| v0.6.5 | 三轮审查修复 | 20+ 项：ntfy 中文标题/chanify 路径两个 mock 盲区真机必炸 P1、onebot CQ 注入、锁 owner 校验、损坏自愈、putChannel 白名单、SSE 上限、审计轮转 |
| v0.7.0 | 身份体系 | 「谁是家里人」从 YAML 字符串升为运行时对象：配对码六态（SHA-256 落盘+暴力锁出）、复合键绑定（修跨渠道串扰）、引导态启动（空白名单不再死路）、拒绝回执、注册命令 /pair /unpair、管理台成员页、目标解析三级优先+形状守卫。11 项 UX 审查全闭环，733→797（R5 审查修复后） |
| v0.8.0 | 远程提问 | ask_user 工具（issue #3/#5 M1）：1-4 题 × 2-5 选项、选项卡为主编号兜底、超时永不代答；TG editResolved 契约签名错位修复（mock 盲区#4，真机抓出） |
| v0.8.2 | 装配回归修复 | 恢复 questions/router.mjs 装配（v0.7.3 回滚带出的回归，ask_user 曾短暂失联）+ 入站 ENV 解析统一 |
| v0.8.3 | 安全收紧 | 提问编号回复 any→hint（SEC-2）+ 审批已决竞态消费一致性（E-2） |
| v0.8.4 | 安全收敛 | 动作卡/提问来源会话校验（F-08/AUTH-1，转发拒绝）+ 提问 onChannel 收紧 + WxPusher 回调面加固（INJ-1）+ 孤儿 pending 清扫 |

详见 CHANGELOG.md——每条都写了根因和审查编号，是理解「这个项目怕什么」的最好材料。

---

## 5. 已知的坑与教训（下一个 agent 必读）

1. **mock 盲区是本项目最大的质量风险**。三次真机事故全是 mock 测不出的：
   - v0.6.1：mock fetch 不走 cordis 装配，装配段同步抛错被宿主吃掉零可见；
   - v0.6.2：mock fetch 不校验 TG callback_data 64B 长度；
   - v0.6.3 期间发现：mock 不解析 TG legacy markdown，未配对 `_*` 必 400，卡片静默降级纯文本。
   → 结论：**涉及真实 HTTP 形状/长度/解析语义的改动，单测过绿≠没问题，必须真机复验。**
2. **unref 教训（v0.6.4 当场翻车）**：给 `bus.wait` 的超时定时器加 `unref()` 后，
   所有「await 超时 resolve」的测试全炸（事件循环只剩 unref 定时器时直接退出）。
   生产语义也不对：在途审批不该因进程恰好空闲而蒸发。**停机清理由 dispose() 承担，定时器保持 ref。**
   已回退，教训留在 bus.mjs 注释里。
3. **改函数签名必须全文搜调用点**：v0.6.4 开发中途 `pushApproval` 加了第 4 参 `channelTypes`
   但调用点没传，`undefined.includes` 抛错被 handler 的 try/catch 吞掉（"A listener never throws"
   的副作用：**吞错的保护壳会让断线静默化**）→ 整轮推卡夭折，22 测试红。安全壳下的调用链
   断线要靠测试兜底，这正是 718 测试存在的意义。
4. **counterStart 随机化**（v0.6.4）：审批 key `ap:<callId>:<n>` 的 n 起点生产随机
   （防重启后同 callId 撞 key + 旧 token 复现核销路径），**测试必须传 `counterStart: 0`**
   保住确定性断言（approval.test.mjs 的 rig 已加，新测试记得）。
5. **审批不受 quiet 影响**：静音审批 = 审批永远超时回落桌面，违背「沉默永不批准」的可预期性。
6. **审批是全局广播的**（除非 v0.3.2 分流命中）：编号回复匹配优先级 = 送达精确(user) > 送达同渠道 > intended 渠道 > 拒绝。跨渠道裸 1/2 一律拒绝（v0.6.3 收紧，v0.6.4 加 intended 兜底，演进逻辑见 router.mjs 注释）。

---

## 6. 审查记录（多轮 review 的组织方式）

用户的工作模式是「开发 → 打包发版 → 多轮 review → 修复 → 再发版」：

- **第一轮（v0.6.3 修复来源）**：三路并行审查（R1 出站核心 / R2 inbound+审批 / R3 装配+admin+v0.6），
  产出编号问题清单（R1-P2-1 这种格式 = 轮次-优先级-序号），11 项 P1/P2 全修。
- **第二轮（v0.6.4 修复来源）**：修复质量复核 + 并发/边界专项，6 项（R2-P1-2 跨进程锁、
  R2-P2-2 损坏中止、R2-P2-3 读收敛、R1-P2-1 intended 兜底、R1-P1-1 增量落账、R2-P2-4/5 counter+dispose）。
- **审查方法**（下一个 agent 可复用）：按模块分域并行开 2~3 个 review 子代理，
  每个只给一个域的文件清单+红线清单，要求产出「编号+优先级+根因+建议修法」，
  主 agent 汇总去重后逐项修复，每项修复跑全量回归。

---

## 7. 待办清单（下一个 agent 的行动项，按优先级）

1. ~~发布 v0.6.4~~、~~第三轮 review（R4-1/R4-2/R4-3）~~、~~v0.6.5 发布~~：均已完成（见 CHANGELOG 0.6.5 条目）。
2. ~~v0.7 身份体系~~：已发版（`0221d1e`），真机测试通过（2026-08-17）。
3. ~~真机复验 v0.6.2~v0.7~~：**已通过（2026-08-17）**。重点场景备忘（若后续发现未覆盖再回补）——TG 审批按钮点击（callback ref 展开链）、
   CLI 改路由后宿主不重启秒级生效（读收敛）、两进程同时写 state.json（锁）、
   **新装机空 allowUsers 引导态**（stderr bootstrap 码 → IM 里 /pair → 成为 owner 全链路）、
   TG 绑定 id 在飞书发消息被拒并收到拒绝回执（复合键）。
4. ~~v0.8 文档同步~~：~~README 双语/HANDOFF 的 ask_user 覆盖~~ + ~~guide.md 远程提问章节~~ + ~~npm 发布包文档完整性~~——2026-08-19 全部补齐（提交 `f559658` + 0.8.5 交接打包批；发布包文件边界规则见 §1.5）。
5. **发布 v0.8.5**：代码与文档已就绪（纯文档/打包配置批，885 全绿），走正常发版流程（按 §1「发布」行核对四处计数 → `npm publish`）。
6. **可选优化**（审查中提过但未做）：`act:*` 待决动作记录的 TTL 清扫已有（24h），
   但 callback-refs 注册表容量 256 偏保守，高峰期可能 FIFO 挤掉在途引用——真机观察到再调。
   后续评估项：YAML allowUsers 移除（v0.7 已 deprecated 为首次导入）。

---

## 8. 快速上手

```bash
cd dsh-notifier
npm test                    # 885 测试，约 2 分钟
npm run lint 2>/dev/null || node --check src/index.mjs   # 无 lint 配置的话用 node --check
node scripts/route.mjs --help        # 路由 CLI
node scripts/channel-login.mjs --help
node scripts/test-channel.mjs        # 渠道连通测试
```

- 数据目录：`$DSH_HOME/dsh-notifier/state.json`（回退 `~/.dsh/dsh-notifier/`）
- 管理台：配置 admin.enabled 后本机 Web（见 README）
- 完整文档入口：README.zh-CN.md → docs/v0.5-design.md → docs/v0.6-design.md → CHANGELOG.md

---

## 9. 给下一个 agent 的话

这个项目的品味在于：**每一条红线都来自一次真实事故，每一条注释都解释为什么**。
接手后请保持三件事：改动前先读目标文件的文件头注释；修复必须带测试和 CHANGELOG 条目；
对「吞错的保护壳」保持警惕——它让断线静默，只有测试能兜住。

祝顺利。🐾
