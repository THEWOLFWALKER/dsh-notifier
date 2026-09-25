# ROADMAP.md — dsh-notifier v0.11.0 执行规格

> 更新：2026-09-25 · **v0.12.0 开发中、未发布**（1828 tests；Native Control Surface + 出站热生效 + 出站状态迁移；真机 DSH 宿主 `0.1.7-rc.2` 视觉/交互验证与 `alpha.1` 冒烟仍待做）· 上一发布线 **v0.11.0**（1816 tests；W0 + 宿主 P0/P1/P2 + W1~W6 已发布）· 基线曾为 v0.10.2（1616 tests）· 目标版本 **v0.12.0**
> **状态：W1~W6 已完成并随 v0.11.0 发布；W7（管理台策略模板）/ W8（`docs/reliability.md`）/ W9（`test/reliability-*` 契约包）/ W10（管理台渠道健康面板）顺延下一版，规格保留于本文件。**
> 本文档是**交给执行 agent 的实施规格**。产品定位与战略论证见文末「背景」；技术形态演进见 [architecture-roadmap.md](architecture-roadmap.md)。
> 执行 agent 通读全文后再动手；所有工作项完成后按「发布收口」统一走门禁。

## 执行红线（任何工作项不得违反）

1. **零运行时依赖**：不新增 `dependencies`/`optionalDependencies`。只用了 Node 22+ 标准库与既有代码。
2. **公共面无 breaking**：`ctx.notifier` 服务形态、`push(message, options)` 签名、`sent` 事件 payload、`flush()` 语义全部不变，`ctx.notifier.version` 保持 `0.7`。只做**新增**，不做修改/删除。
3. **双语**：所有面向手机/管理台的新增文案必须进 `src/strings.mjs`，zh 与 en 键一一对应，禁止硬编码字符串进 UI/命令回执。
4. **fail-closed 默认**：新能力默认关闭或最小权限，需显式开启；未知来源/未配对身份一律拒绝。
5. **分支纪律**（[VERSIONING.md](VERSIONING.md)）：每个工作项用 `codex/<topic>` 分支，测试全绿后合入 `dev`。不从 dirty tree 发布。
6. **测试不变式**：`npm test` 全绿；`dshQuality.testCount`、README 徽章、`HANDOFF.md` 与实际测试数一致（见「发布收口」）。

## 工作项总览

| # | 战略线 | 工作项 | 主要改动面 |
|---|---|---|---|
| W1 | C1 | `dsh-notifier/testing` 消费方测试工具 | 新增 `src/testing.mjs` + exports |
| W2 | C1 | 公共面 TypeScript 类型声明 | 新增 `types/` + exports types |
| W3 | C1 | 最小消费示例插件 | 新增 `examples/consumer-demo/` |
| W4 | C1 | `PLUGINS.en.md` 英文契约 | 新增文档 |
| W5 | A1 | `/sessions` 遥控命令 | `src/inbound/conversation.mjs` + strings |
| W6 | A1 | `/log` 日志回传命令（默认关） | conversation + config + redact + strings |
| W7 | A1 | 管理台策略模板（心跳/审批） | `src/admin/` |
| W8 | A2 | `docs/reliability.md` 承诺↔测试映射 | 新增文档 |
| W9 | A2 | 可靠性契约包 `test/reliability-*.test.mjs` | 测试命名约定 + script |
| W10 | A2 | 管理台渠道健康面板（只读） | `src/admin/` + ledger |

依赖关系：W1/W2/W3/W4 相互独立可并行；W5 先于 W6（同文件）；W8/W9 依赖现有测试盘点；W10 依赖 ledger 数据口径确认。建议顺序：W1→W2→W3→W4→W5→W6→W7→W9→W8→W10。

---

## W1 — `dsh-notifier/testing` 消费方测试工具（C1）

**目标**：消费方插件（声明 `inject: ['notifier']` 的作者）单测时不必手写 stub，直接从本包导入一个行为与公共面一致的 fake。

**改动**：
- 新增 `src/testing.mjs`，导出 `createFakeNotifier(options?)`。
- `package.json` `exports` 增加：`"./testing": "./src/testing.mjs"`（`files` 已含 `src`，无需改）。

**行为规格**（与 PLUGINS.md 公共面逐项对齐）：
- `version` 属性 = `'0.7'`。
- `push(message, options)`：**永不 reject**；记录调用到 `fake.calls`；返回 `{ ok: true, delivered: ['fake'], skipped: [], failed: [], source: { kind: 'plugin', name } }`。
  - `message.title`/`content` 双空（非字符串按空）→ `{ ok: true, delivered: [], skipped: ['(malformed)'], ... }`，与真服务一致。
  - `options.simulate: 'rate-limited' | 'disabled' | 'budget' | 'busy'` 时返回对应 `skipped` 值，供消费方测失败分支。
- `flush()`：resolve `undefined`，记录调用。
- `calls`：只读数组（返回深拷贝），元素 `{ message, options, at }`。
- 不提供 `sent` 事件发射（事件走 `ctx.on`，不在本工具面内）；文档注明消费方自测事件侧用自有 `ctx` stub。

**测试**：`test/public-testing-fake.test.mjs`——逐项断言上述行为（含永不 reject、malformed、各 simulate 分支、calls 深拷贝隔离）。

## W2 — 公共面 TypeScript 类型声明（C1）

**目标**：TS 插件作者 `import type { Notifier } from 'dsh-notifier/types'` 即得完整公共面类型。

**改动**：
- 新增 `types/index.d.ts`，声明：`NotifierFacade`（`version: '0.7'`、`push`、`flush`）、`NotifyMessage`、`NotifyOptions`、`PushResult`、`SentEventRecord`、`NotifierTesting`（对应 W1 fake）。
- `package.json`：`exports` 增加 `"./types": "./types/index.d.ts"`；`files` 增加 `"types"`。
- 类型与 PLUGINS.md 字段一一对应：`PushResult.ok/delivered/skipped/failed/source`；`skipped` 用字面量联合 `'(malformed)' | '(disabled)' | '(rate-limited)' | '(quiet)' | '(budget)' | '(busy)' | (string & {})`。
- `SentEventRecord` 不含 title/content（隐私面，与实现一致）。

**测试**：`test/public-types.test.mjs`——用 `node --experimental-strip-types` 不做（零依赖红线）；改为在 `examples/consumer-demo` 内放一个 `.ts` 文件并用 `tsc --noEmit` 校验（见 W3 验收，tsc 作为 devDependency 不违反红线；若决定零 devDep 则降级为人工核对清单写入 PLUGINS.md）。

## W3 — 最小消费示例插件（C1）

**目标**：`examples/consumer-demo/` 一个 30 行内的示例，演示 inject + push + 订阅 sent。

**改动**：
- `examples/consumer-demo/package.json`（`"name": "dsh-notifier-consumer-demo"`，private: true）
- `examples/consumer-demo/src/index.mjs`：
  - `export const inject = ['notifier']`
  - `apply(ctx)`：`ctx.notifier.push({...}, { sourceName: 'consumer-demo' })`，`ctx.on('dsh-notifier/sent', rec => ...)`（O(1) 监听器）
- `examples/consumer-demo/README.md`：安装前置说明（dsh-notifier 必须先装，否则 inject 等待阻塞启动——引用 PLUGINS.md 真机裁定）。
- **不进** `package.json` `files`（示例不进 npm payload）。

**验收**：`node --check` 示例全部 `.mjs`；示例内 `consumer.ts` 通过 `tsc --noEmit`（与 W2 联动）。

## W4 — `PLUGINS.en.md`（C1）

**目标**：PLUGINS.md 的英文对照版，段落一一对应（章标题、表格行、代码块注释）。

**改动**：新增 `PLUGINS.en.md`；`PLUGINS.md` 顶部互加语言链接；`files` 增加 `"PLUGINS.en.md"`（npm payload 附带）。

**验收**：两文档章节数一致；`scripts/verify-release.mjs` 若校验文档清单则同步更新。

## W5 — `/sessions` 遥控命令（A1）

**目标**：手机端列出活跃会话与当前绑定，可切换观察对象。

**改动**：
- `src/inbound/conversation.mjs` 命令分发新增 `/sessions`（复用 `/tasks` 的注册与鉴权路径）。
- 数据来源：`src/routing/task-projection.mjs` 的任务/会话投影，复用其快照，不新建状态。
- 回执格式：编号列表（序号 + 会话名 + agent + 状态 + 是否当前绑定），超出单条长度走既有分段。
- `src/strings.mjs`：zh/en 各键成对新增（键名沿用现有命令回执命名风格，如 `cmdSessionsTitle` 等）。

**红线**：仅配对身份可见；未配对/未知来源 fail-closed 拒绝（复用现有白名单判定，不新开鉴权逻辑）。

**测试**：`test/inbound-sessions-command.test.mjs`——配对/未配对、空会话、多会话分页（如有）、双语回执各一组。

## W6 — `/log` 日志回传命令（A1）

**目标**：`arg` 回传当前绑定会话最近 N 行输出（`/log`、`/log 50`）。

**改动**：
- `src/config.mjs`：新增 `remoteLog: { enabled: false, maxLines: 200, maxBytes: 8192 }`——**默认 `enabled: false`**。
- `src/inbound/conversation.mjs`：`/log` 处理；`enabled === false` 时回执「未开启」并提示管理台开关位置。
- 输出来源：宿主会话输出快照（走 `src/host/` 既有宿主能力面；若宿主不暴露输出快照，则**降级为回传账本中该会话最近事件摘要**，并在回执注明口径）。
- 脱敏：必经 `src/redact.mjs`（token/密钥/路径规则），再经 maxLines/maxBytes 双重有界截断。
- `src/strings.mjs`：双语键。

**红线**：默认关闭；仅配对身份；脱敏不可旁路；有界不可被参数放大（`N` clamp 到 maxLines）。

**测试**：`test/inbound-log-command.test.mjs`——默认关闭拒绝、开启后回传、脱敏命中用例（构造含 token 样文本）、clamp、双语。

## W7 — 管理台策略模板（A1）

**目标**：心跳与审批策略在管理台一键套用，不写 YAML。

**改动**：
- `src/admin/api.mjs`：`POST /api/policy-template`（`{ template: 'heartbeat-quiet-hours' | 'heartbeat-longtask' | 'approval-owner-only' | 'approval-all-paired' }`），服务端映射到既有配置键，复用现有配置写入与校验。
- `src/admin/ui/`：设置区新增模板按钮组，套用后显示生效摘要。
- 模板内容：
  - `heartbeat-quiet-hours`：23:00–08:00 静默（时区取本机）
  - `heartbeat-longtask`：长任务心跳间隔与卡住阈值预设值（取现有默认推荐档）
  - `approval-owner-only` / `approval-all-paired`：映射成员系统现有作用域
- `src/strings.mjs`：双语。

**测试**：`test/admin-policy-templates.test.mjs`——四套模板写入后的配置 diff 断言、非法模板名 400、未授权访问拒绝。

## W8 — `docs/reliability.md`（A2）

**目标**：README 每条可靠性承诺映射到可运行证据。

**格式**：表格 `承诺 | 语义 | 对应测试文件 | 关键场景`。覆盖：不漏一回合（turn/end 防抖去重）、沉默永不批准（超时≠通过）、单次裁决、fail-closed 未知来源、分档重试、分段、防打扰、账本。

**验收**：表中每个测试文件真实存在；W9 完成后表内标注 `test/reliability-*` 入口。

## W9 — 可靠性契约包（A2）

**目标**：可靠性用例可单独运行、可对外展示。

**改动**：
- **不新建子目录**（`npm test` 的 glob 是 `test/*.test.mjs` 扁平匹配）。采用命名约定：将既有可靠性用例**原位重命名/聚合**为 `test/reliability-*.test.mjs`（移动而非复制，避免重复计数）。
- `package.json` `scripts` 增加：`"test:reliability": "node --test \"test/reliability-*.test.mjs\""`。
- 被移动用例的 import 路径同步修正。

**红线**：重命名不得改变用例内容与通过数；迁移后全量 `npm test` 通过数的变化只能来自新增用例。

## W10 — 管理台渠道健康面板（A2）

**目标**：各渠道近期送达率/重试/最近失败原因只读展示。

**改动**：
- 数据源：`src/ledger.mjs` 既有账本记录（不新增外发、不新建存储）。
- `src/admin/api.mjs`：`GET /api/health/channels` 返回聚合（每渠道：近 N 次 delivered/skipped/failed 计数、最近失败 reason、最近成功时间）。
- `src/admin/ui/`：健康面板区块，只读表格 + 失败 reason 摘要。
- `src/strings.mjs`：双语。

**测试**：`test/admin-health-channels.test.mjs`——空账本、混合结果聚合、reason 截断。

---

## 发布收口（全部工作项完成后，按序执行）

版本 **v0.11.0**（功能 = minor）。逐项完成：

1. `package.json.version` → `0.11.0`；`dshQuality.testCount` → 实际全量通过数。
2. `CHANGELOG.md` 新增 `## [0.11.0]`，按 W1~W10 分条（双语项目惯例从其旧例）。
3. `src/admin/ui.mjs` 版本显示同步（verify-release 不变式）。
4. README.md / README.zh-CN.md：徽章测试数、能力段落新增 `/sessions` `/log` 与「生态通知层」一句；不破坏现有精简风格。
5. `HANDOFF.md` 发布线描述更新；`docs/memory/project-state.md` 同步。
6. 门禁全过（任一失败不得发布）：
   ```text
   git status --short --branch        # clean
   npm test                           # 全绿
   npm run test:reliability           # 契约包单独可跑
   npm run verify:release
   node scripts/gen-channel-matrix.mjs --check
   npm pack --dry-run --json          # 核对 payload：含 types/、PLUGINS.en.md；不含 examples/
   ```
7. `npm publish`；打 tag `v0.11.0`（不 retag）；`dev → main` 合并推送；`public` 远端两分支同步。
8. awesome 等目录站描述更新到 v0.11.0（走既有 PR 流程，仅 description 段）。

## 版本外任务（不阻塞 v0.11.0 发布，发布后由所有者择机启动）

| 任务 | 内容 | 成功判据 |
|---|---|---|
| E1 升级卡回馈 | 向 `oh-my-dsh/dsh-plugin-upgrade-skill` 提交 2~3 张真实迁移卡（静态 inject 裁定、`ctx.userQuestions` seam、QQ 网关心跳时序） | PR 合并 |
| E2 生态邀约 | 给 2~3 个有出站需求的生态插件提 issue/示例 PR | ≥1 个外部插件 `inject: ['notifier']` |
| E3 曝光（暂缓） | LINUX DO 发帖（需所有者本人）、README 演示 GIF、博客投稿 | 所有者显式启动 |

## 不做清单（防漂移）

1. 不做流式聊天卡片（dsh-im 主场）。2. 不做单渠道多机器人实例。3. 不新增入站渠道。4. 不做手机同屏/Web 远程桌面（dsh-pocket 主场）。5. 公共面不做 breaking（`ctx.notifier.version` 锁 0.7）。

## 背景（战略论证，执行可略读）

赛道现实：IM 聊天入站被 dsh-im（1283⭐，官方认可）占据，手机同屏被 dsh-pocket（1095⭐）占据；正面追赶投入产出比最差。我们的资产是 27 出站渠道、审批/提问/任务接管闭环、零依赖、双语，以及 v0.6 起已开放但尚未推广的 `ctx.notifier` 公共面。A 线把「通知 + 遥控」主场做绝，C 线把公共面卡位成生态通知层——竞品壮大反而扩大我们的潜在消费方。北极星指标：声明 `inject: ['notifier']` 的外部插件数（现 0）。
