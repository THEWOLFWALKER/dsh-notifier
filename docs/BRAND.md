# dsh-notifier Brand / README assets

本包里的图片来自本次提供的品牌宣传图，只做了裁剪/缩放，没有重新设计 Logo。

## 推荐用途

### `readme-hero.png`
README 顶部主视觉。

包含：
- dsh-notifier 主 Logo / wordmark
- Agent ↔ User
- 多渠道图标

建议：
```html
<img src="docs/assets/readme-hero.png" width="100%">
```

### `brand-variants.png`
品牌资产展示条：
- icon only
- horizontal lockup
- monochrome

适合：
- BRAND 文档
- 发布稿
- 媒体包

不建议放在 README 首屏，与 hero 重复。

### `brand-lockup.png`
浅色背景主 Logo + wordmark。

适合：
- 文档页
- 收录站
- 发布说明

### `brand-dark.png`
暗底版本。

适合：
- 深色介绍页
- 社交媒体配图

### `qq-group.png`
QQ 群二维码裁剪图，保留群号与扫码区。

README / SUPPORT 中建议宽度：
```html
width="300"
```

## 仓库现有资产

已有：
```text
docs/assets/dsh-notifier-icon.png
docs/assets/dsh-notifier-lockup.png
docs/assets/dsh-notifier-lockup-light.png
```

继续保留。

这些更适合：
- package/plugin icon
- 小尺寸标识
- UI 内品牌

新的 hero 不替换 icon，只解决 README 缺少产品视觉的问题。
