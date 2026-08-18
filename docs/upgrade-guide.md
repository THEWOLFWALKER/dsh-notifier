# dsh-notifier 升级指南（更新 · 确认版本 · 排查版本错位 · 降级回滚）

> 给 **DSH 用户**的升级说明：怎么把 dsh-notifier 更新到最新、怎么确认装对了版本、
> 功能没生效时怎么判断是「版本错位 / 残留」、以及怎么降级回滚。
> 全程命令行，基于 **npm registry 正式发布版**；开发者的 `file:` 提醒见文末。
> 英文版：[`upgrade-guide.en.md`](upgrade-guide.en.md)

---

## 一、怎么更新 dsh-notifier

### 方式 A：DSH 插件命令（推荐，registry 版）

在 DSH 安装根目录执行：

```bash
dsh plugin add dsh-notifier@latest --profile <profile名>
```

> 对 dsh-notifier 来说，重新 `dsh plugin add` 同一包就是更新：会从 npm registry 拉最新
> 发布版覆盖旧装。`--profile` 必须填你实际跑的 profile（README：DSH 0.1.0-rc.6 起必需）。
> 若你的 DSH 版本 CLI 不接受 `@latest` 后缀，直接 `dsh plugin add dsh-notifier --profile <profile名>`。

### 方式 B：DSH 根目录直接走包管理器

npm 宿主：

```bash
npm update dsh-notifier          # 或 npm install dsh-notifier@latest
```

pnpm 宿主：

```bash
pnpm update dsh-notifier         # 或 pnpm add dsh-notifier@latest
```

### 更新后必须做

**重启一次 DSH**。通道连接在启动时拉起，只装包不重启，新版本的连接 / 工具装配不会生效。

---

## 二、怎么确认装的版本正确

三处可查，任选其一：

| 方法 | 命令 / 位置 | 看到什么算对 |
|---|---|---|
| 管理台版本角标 | 打开 Web 管理台，页首标题 | `dsh-notifier 管理台 v0.8.x`（对齐当前发布版） |
| 启动日志装配标识 | DSH 启动日志，搜 `远程提问已启用` | v0.8+ 有 `远程提问已启用：ask_user 工具…` 行（v0.8.2 起该装配恢复；缺失 = 旧包或装配被跳过） |
| 命令行查已装版本 | DSH 根目录：`npm ls dsh-notifier`（npm）或 `pnpm ls dsh-notifier`（pnpm） | 显示的版本号 = 实际装配的版本 |

再联网对照最新发布版：

```bash
npm view dsh-notifier version
```

「已装版本 ≥ 你期望的版本」且与「你想要验证的发布版一致」才算到位。

> 注意：启动日志的 `远程提问已启用` 是**功能装配标识**，不是版本号——它只能证明
> 「≥ v0.8.2 且 questions 桥装配正常」，具体 patch 号以命令行 / 管理台角标为准。

---

## 三、遇到「特征功能没生效」怎么排查版本错位 / 残留

典型症状（发布过后功能却像不存在）：

- 该有的新工具没有（如 `ask_user` 远程提问、`远程提问已启用` 日志缺失）；
- 管理台版本角标落后于最新发布版；
- 新版本的配置项在配置里不生效。

排查顺序：

**第 1 步：确认实际版本** —— 用第二节三证之一看装的是哪个版本。

- 落后 → 直接走第一节「更新」。

**第 2 步：版本对但功能仍不生效 → 怀疑版本错位 / 残留**

残留最常见的来源：装包时用了 `file:` 本地路径，或手动拷贝文件覆盖过
`node_modules/dsh-notifier`。本地源码一变，node_modules 里的包就**静默偏离 registry
发布版**——长相和官方包不一致，测试结果不能代表发布版。这个环境差曾经制造过
「`ask_user` 工具名为空」的假象（详见交接文档 `17-toolname-bug.md`）。

1. 换成 registry 版重装覆盖：

   ```bash
   dsh plugin add dsh-notifier@latest --profile <profile名>
   ```

2. 顽固残留就卸载清缓存再装：

   ```bash
   dsh plugin remove dsh-notifier --profile <profile名>
   ```

   回到 DSH 根目录清掉旧包（pnpm 宿主用 pnpm 命令删，别手动删 node_modules，会被 pnpm 回滚）：

   ```bash
   npm uninstall dsh-notifier       # npm 宿主
   # 或
   pnpm remove dsh-notifier         # pnpm 宿主
   ```

   再装回 registry 版：`dsh plugin add dsh-notifier@latest --profile <profile名>`。

3. 确认解析源是 registry 而不是 `file:`：

   ```bash
   pnpm why dsh-notifier            # pnpm 宿主
   # 或
   npm ls dsh-notifier              # npm 宿主
   ```

   解析路径里出现 `file:` / 本地绝对路径就是残留；出现 registry 地址 / 纯净版本号才是正常。

4. **重启 DSH**，回到第二节三证复验：角标 / 日志 / 命令行三者指向同一版本。

**第 3 步：还不行** —— 回到 [使用指南](guide.md) 的「出问题了」表和 Web 管理台「总览」实时事件流。

---

## 四、怎么降级回滚

想回退到上一个版本（例如最新版有你不想要的行为）：

```bash
dsh plugin add dsh-notifier@0.8.1 --profile <profile名>
```

pnpm 宿主：

```bash
pnpm add dsh-notifier@0.8.1
```

装完同样要**重启 DSH**，并用第二节三证确认版本回到目标版本。

> 降级注意：`state.json` 若被新版本写过，旧版本可能不认某些新键。
> 降级前如担心，先从 DSH 数据目录备份一份 `state.json`。

---

## 五、开发者提醒：别让 `file:` 长期残留，真机基准用 registry 版

- `file:` 装包只适合**临时**开发验证。长期驻留 = 在 node_modules 里躺着一个「会随本地
  源码漂移的包」，与 registry 发布版长相不同。**发布前必须换回 registry 版重装 + 重启**。
- **真机验收基准必须是 registry 版**：`dsh plugin add dsh-notifier@latest --profile <profile名>`
  装出来的包。mock 全绿 ≠ 真机正确（项目宪法第 8 条：真机验收门）。
- 宿主用 pnpm 时，手动覆盖 `node_modules/dsh-notifier` 会被 pnpm 在下次操作时回滚
  （见 `PLUGINS.md` 安装注意）——别用拷贝大法，一律走 `dsh plugin add` / pnpm 命令。
- 曾看到过的「`ask_user` 工具名为空」现象，很可能就是真机残留旧 build / 旧包导致的版本
  错位假象，未必跟源码相关——先按第三节三证核对版本，再怀疑代码。