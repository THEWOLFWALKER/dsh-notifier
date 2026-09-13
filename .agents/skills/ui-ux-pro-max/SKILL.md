---
name: ui-ux-pro-max
description: >
  Self-contained design intelligence for the dsh-notifier UI work — a bundled local snapshot of the
  NextLevelBuilder "UI/UX Pro Max" design system database (67+ UI styles, 161+ color palettes,
  57+ font pairings, chart types, UX guidelines, per-stack reference data). Use when choosing a visual
  direction, palette, type scale, layout token, or chart treatment for the admin console or any plugin UI.
  自带本地设计系统知识库：需要给界面选风格/配色/字体/图表/技术栈配方时用。Works without any external
  runtime: reads local CSV/JSON under data/ and templates/. Source: nextlevelbuilder/ui-ux-pro-max-skill.
---

# UI/UX Pro Max（本地快照）

> **自包含版本说明**：官方仓库依赖 `python3 search.py` 运行时。本快照在 dev 仓库内**直接读本地数据表**即可，不装 Python、
> 不跑脚本。数据与官方 v2.13.0 对齐（`data/` 与 `templates/` 来自官方 `src/ui-ux-pro-max/`），仅剥离了 CLI 层。
> 完整用法 / 实时版本见上游：`github.com/nextlevelbuilder/ui-ux-pro-max-skill`。

## 什么时候用这个 skill
当管理台 / 插件 UI 需要：选 UI 风格（极简、玻璃拟态、工业、拟物…）、配一套品牌色、定字体配对、
挑图表类型、按技术栈（html-tailwind / react / nextjs / vue …）拿落地配方时。

## 数据表速查（`data/*.csv`）
每条记录通常含 `name, type, keywords/tags, description, css/ai-prompt, source/url` 等列。用 Grep 按关键词查即可。

| 表 | 内容 | 关键列 |
|---|---|---|
| `styles.csv` | 89 种 UI 风格（含玻璃拟态、极简、布鲁塔利、工业视觉等） | name, ai-prompt, css |
| `colors.csv` | 193 套配色（按产品类型） | name, palette(hex) |
| `typography.csv` | 字体配对（含 Google Fonts import） | font-pair, google-fonts-import |
| `charts.csv` | 图表类型与推荐库 | chart-type, library |
| `landing.csv` | 落地页结构与 CTA 策略 | structure, cta |
| `ux-guidelines.csv` | UX 最佳实践 & 反模式 | guideline |
| `stacks/` | 22 个技术栈配方（含 Tailwind tokens） | token, css |
| `motion.csv` | GSAP 动画骨架（按强度分级） | intensity, gsap-snippet |
| `icons.csv` / `products.csv` / `app-interface.csv` | 图标 / 产品推荐 / 界面规范 | — |

`templates/base/` 有 `quick-reference.md` 与 `skill-content.md`（官方正文），`templates/platforms/*.json` 是各平台安装模板（本仓库仅存档，不适用）。

## 决策流程（贴合 dsh 管理台「宿主对齐」基调）
1. **先定基调**：当前管理台已是蓝白、对齐 DeepSeek Harness 令牌 → 选风格偏向「clean-minimal / dashboard / data-visual」族，别跳去玻璃拟态或拟物。
2. **风格**：Grep `styles.csv` 拿一个风格名 → 取其 `ai-prompt` / `css` 段落当参考。
3. **配色**：Grep `colors.csv` 找适合该产品类型的 palette；如需宿主一致则手动对齐 `--accent=#4176e6` 蓝到干净面板（勿为美观牺牲宿主一致性）。
4. **字体**：Grep `typography.csv` 选配对（本主题用系统字体栈即可，多数场景不需要引 Google Fonts）。
5. **落地验证**：改完在 1440 / 390 两档视口自审，确认不是模板味。

## 护栏
- 本数据库是**素材参考**，不是照抄模板——最终视觉必须对齐宿主 deepseek-harness 的令牌体系。
- 不要引入本 skill 中没有的、依赖 node_modules / 外部 CDN 的生成脚本；本仓库是零外部资源约束。
- 上游是数据快照，若需要更新的风格/配色，回到 `data/*.csv` 手动补一行即可，不要重拉整个 SDK。