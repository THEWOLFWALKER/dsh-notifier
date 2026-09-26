# dsh-notifier 升级指南

> 面向 DSH 用户：更新、确认版本、排查残留、v0.12.1 → v0.13 迁移、降级回滚。
>
> 英文版：[`upgrade-guide.en.md`](upgrade-guide.en.md)

## 一、更新到最新版

推荐：

```bash
dsh plugin add dsh-notifier@latest --profile <profile名>
```

如果你的 DSH CLI 不接受 `@latest`：

```bash
dsh plugin add dsh-notifier --profile <profile名>
```

也可以在 DSH 根目录走包管理器：

```bash
npm install dsh-notifier@latest
# 或
pnpm add dsh-notifier@latest
```

### 更新后必须重启一次

升级包以后先重启一次 DSH，让新的 Host 插件和 `client.js` 装载。

**这次重启是“加载新版本”需要的，不代表 v0.13 的出站配置仍然要靠重启生效。**

v0.13 装载完成后，后续修改出站渠道是 Hot Apply；Native 与 Advanced Console 共享 canonical runtime truth。

## 二、v0.11 → v0.12 有什么变化

### 1. 主入口换了

以前：

```text
启动日志
→ 找 Web 管理台 URL/#token
→ 浏览器配置
```

现在优先：

```text
DSH Sidebar「通知与控制」
或 Plugins → dsh-notifier
→ 配渠道
→ 保存并真实测试
```

Standalone Web 管理台没有删除，但变成 **Advanced / Recovery**。

### 2. 出站配置保存后立即生效

v0.11 的「视图热、投递冷 / 重启后生效」对 v0.12 出站已经失效。

v0.12：

```text
save
→ validate / resolve
→ persist
→ OutboundSource 原子替换
→ 下一次发送直接使用
```

如果升级后你仍看到“出站必须重启才能生效”，先怀疑实际运行的不是 registry `0.13.0` 或更高版本。

### 3. 出站 state key 迁移

v0.12 新写：

```text
channel:<type>:outbound
```

旧：

```text
admin:channel:<type>:outbound
<type>:account
```

只保留兼容读取，不会自动删除。

canonical key 与 `admin.enabled` 无关；关闭 Advanced Console 不会让 Native 保存的出站配置失效。

### 4. 入站仍可能需要重启

入站 SDK/WS/长轮询 transport 没有在 v0.12 被统一热重载。

以 UI 显示为准：

- `hot`：立即生效；
- `restart`：重启后重新建立 transport；
- `readonly`：走既有授权/CLI。

## 三、确认你真的装到了 v0.12

优先看三证：

| 证据 | 怎么看 | v0.12 正常表现 |
|---|---|---|
| DSH Native | 左侧栏 / Plugins | 有「通知与控制」与 dsh-notifier 设置入口 |
| CLI | `npm ls dsh-notifier` / `pnpm ls dsh-notifier` | `0.13.0`（或更高） |
| Registry | `npm view dsh-notifier version` | 与你期望的发布版一致 |

也可以核包：

```bash
node -p "require('./node_modules/dsh-notifier/package.json').version"
```

开发者/排障还可确认：

```text
exports["./client"] = "./client.js"
dshQuality.testCount = 1985    # 对 v0.13.0 收敛线
```

## 四、版本对，但功能像旧版

最常见：旧 `file:` 安装、手工覆盖 node_modules、pnpm 重新回滚了你手拷的文件。

排查：

```bash
pnpm why dsh-notifier
# 或
npm ls dsh-notifier
```

看到 `file:` / 本地绝对路径，说明你不是在测 registry 正式包。

最稳的处理：

```bash
dsh plugin remove dsh-notifier --profile <profile名>
dsh plugin add dsh-notifier@latest --profile <profile名>
```

然后重启 DSH。

不要靠“复制新源码覆盖 node_modules”做长期验证。

## 五、v0.12 常见排障

### Native 入口没出现

检查：

1. 实际版本 `0.13.0+`；
2. DSH 已重启；
3. Host 在声明范围；
4. `client.js` 确实在已安装包里；
5. web profile 的 Client Module/slot 没报错。

声明范围：

```text
0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2
```

### 保存出站后仍要重启才生效

这是 v0.12 的异常表现。核：

- 是否真的运行 `0.13.0` 或更高 registry 包；
- 是否是**出站**而不是 inbound；
- 页面/运行时是否都读 canonical `channel:<type>:outbound`；
- 是否有旧 `file:` 包残留。

### Advanced Console 打不开

v0.12 不会为了打开它偷偷启用 `admin.enabled`。

如果你显式关闭 Admin，Native 会显示 unavailable。需要恢复时重新启用 Admin 或使用 YAML/CLI。

## 六、降级到 v0.11

```bash
dsh plugin add dsh-notifier@0.11.0 --profile <profile名>
```

### 降级前先备份 state

v0.11 不认识 v0.12 的 canonical：

```text
channel:<type>:outbound
```

因此：**只在 v0.12 Native 里新保存、又没有 YAML/旧 overlay 的渠道，降回 v0.11 后可能看不到。**

建议：

1. 备份 `state.json`；
2. 记录关键渠道配置（不要把 secret 发到 issue/log）；
3. 降级；
4. 必要时在 v0.11 的 Web 管理台或 YAML 重新配置出站。

不要为了兼容降级手改运行中的 state 文件。

## 七、开发者：真机基准用 registry 包

`file:` 只适合临时开发。

发布前/问题复现基准应当是：

```bash
dsh plugin add dsh-notifier@latest --profile <profile名>
```

并核：

- registry 版本；
- package payload；
- Native client module；
- 一次真实 save/test；
- 一次 Hot Apply 后的真实下一次发送。

mock/contract 全绿不等于 provider/device 已验证。
