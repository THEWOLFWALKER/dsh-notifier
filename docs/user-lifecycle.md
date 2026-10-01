# 全用户周期（安装 → 卸载）旅程与验证

> 本文按**真实用户旅程**串起已经交付的能力：安装 → 首次保存 → 复用/迁移 → 日常问题与审批 → 手机 →
> 断线 → 升级 → 导出换机 → 停用/卸载。每一步都给出**实际存在的命令**与**可观察结果**，不描述尚未
> 发布的想象功能。
>
> 教程与截图对应当前 **Native「通知与控制」**，不使用旧管理台截图冒充 Native。

## 0. 先明确两件事

- **能力证据等级**：项目只按真实证据声明能力。`provider accepted`（平台已接收请求）**不等于**
  `confirmed`（有端到端回执）。逐渠道的按钮/附件/回执/重连/额度差异见
  [兼容性矩阵](compatibility-matrix.md)。文档里写"支持"均以该矩阵为准。
- **配置导出不含密钥**：本地配置导出（v1）**永不含**明文 token、URL 内嵌 token、ENV 引用被内联后的值。
  导出只带公开字段 + 凭据 descriptor（"待补充"/"有可解析引用"）+ 外部引用清单。

## 1. 安装

| 步骤 | 命令 / 动作 | 预期可观察结果 |
|---|---|---|
| 安装 | `dsh plugin add dsh-notifier@latest --profile <profile名>` | 包被加入指定 profile |
| 重启 | 重启对应 DSH Host 一次 | 新的 Host 插件与 `client.js` 装载 |
| 打开 | 侧栏 **「通知与控制」**，或 **Plugins → dsh-notifier** | Native 界面加载，九个视图可见 |
| 确认版本 | 见 [升级指南](upgrade-guide.md) 的版本确认步骤 | 实际安装版本 = 期望版本 |

失败排查：先跑 `node scripts/channel-selfcheck.mjs`（见第 6 节）确认装配，再按
[排障指南](TROUBLESHOOTING.md) 做只读诊断。

## 2. 首次保存（first save）

1. 在「通知与控制 → 渠道」选一个已在用的通知渠道；
2. 填凭证；
3. 点 **「保存并测试」**。

可观察结果：

- **保存成立即完成**：保存成功后该渠道即"已完成"，**测试完全可选**。测试只针对**已保存**的配置，
  绝不会"静默保存 + 发送"。
- **保存与测试解耦**：刷新失败**不会**被报成"保存失败"；测试失败/无法确认也**不会**困住用户。
- **证据分级文案**：`confirmed`（有回执）才显示"已送达"；只有平台接收时显示 `accepted`
  （"已发送到提供方，请到客户端确认"）；`unknown` 绝不显示成"失败可重发"。
- **列表三态**：`loading`（尚无响应，不伪装"暂无"）/ `error`（服务或网络失败，不伪装成空）/
  `empty`（已回但为空）；`stale` 数据保留但标注更新时间。

## 3. 复用 / 迁移（导出 → 导入）

| 步骤 | 动作 | 预期结果 |
|---|---|---|
| 导出 | 渠道页 **导出配置** | 下载白名单 versioned JSON（`documentType: dsh-notifier-config`, `formatVersion: 1`）；不含任何密钥 |
| 导入 | 渠道页 **导入配置** | 严格校验 → **dry-run 预览**（add/patch/conflict/skip/unsupported + 缺失凭据 + 机器特定引用） |
| 选择 | 勾选要应用的条目 | 冲突需明确选择；未选择则保持原字段 |
| 提交 | **确认导入** | 单事务 patch；**新渠道默认 `disabled`**（暂存、不活动），绝不自动启用或发测试 |
| 读回 | 见"读回配置" | 提交后配置与预期一致 |

关键语义：

- **取消零写入**；坏文件/超限在预览前拒绝；重复导入幂等。
- **已有渠道默认保留当前启用状态**，只应用明确选中的 patch。
- **已有 secret 默认 keep**；显式 `clear` / `replace` 沿用既有 secret patch 语义；**掩码字符串不能作为导入值**。
- **外部（机器特定）引用不会被导入重绑**——见第 8 节。

## 4. 日常问题 / 审批

- **手机私聊命令**：`/help`、`/whoami`、`/status`、`/tasks`、`/sessions`、`/stop`、`/route`、`/quiet`、`/log`。
- **审批**：收到审批卡后在手机批准/拒绝。
- **提问**：`ask_user` 会推到手机；回答后继续。
- **Native**：「待处理提问」「任务」「活动」视图一步可达。

安全边界：**特权 effect 之前必须先有 durable claim**；claim 提交失败则**零 effect**；effect 后无法
确认标记 `uncertain`，**不自动重放**；多入口（Native / 管理台 / 手机）争答时**最多一次 effect**。

## 5. 手机入口（远程 URL）

在 Native 的**远程入口**视图填入**你自己**的、已经受保护的 **HTTPS** 链接：

- 校验：仅 `https`；拒绝内嵌用户名/密码；拒绝带 `ticket`/`token`/`password` 等秘密参数的 URL。
- 打开 / 复制 / 二维码三选一：**二维码内容与普通链接逐字节相同**（同一规范化字符串）。
- **不猜测** Host 深链；未知 Host 深链只打开公开首页。
- 提示：**连接与权限是两件要分别检查的事**。

## 6. 断线 / 健康

- Native 的**诊断**视图给出脱敏快照；`health` 区分 `accepted` / `delivered` / `unknown`，带时间与 epoch。
- **配置存在不等于 online/healthy**：`configured` 不会被推导成"健康"。
- 入站的 SDK/WebSocket/长轮询若显示 **「等待重启」**，需重启以重建连接（`restartPending` 由真实差异计算）。
- 命令行自检：

```bash
node scripts/channel-selfcheck.mjs
node scripts/route.mjs show
```

## 7. 升级

```bash
dsh plugin add dsh-notifier@latest --profile <profile名>
```

重启后按 [升级指南](upgrade-guide.md) 确认实际版本。升级失败**保留用户数据**，不自动清空恢复。
完整回滚步骤见同一文档。发布/版本不变量由 `node scripts/verify-release.mjs` 门保证。

## 8. 导出换机（新机器）

1. 旧机：导出配置 v1（见第 3 节），拿到 JSON 文件；
2. 新机：安装 → 导入同一文件；
3. **重填凭据**：导入只带 descriptor，**不含任何密钥**；
4. **重绑外部引用**：ENV 引用/机器特定引用**不会**被导入迁移，需在新环境重新指向；
5. 新渠道默认 `disabled`，确认无误后在渠道页显式启用。

> 普通配置导出**不是**灾难恢复快照：成员权限、配对明码、admin 凭据/launch ticket、claims/uncertain、
> dedup/cursor、SDK 资源与 health **都不在**导出范围内。

## 9. 停用 / 卸载

| 目标 | 动作 |
|---|---|
| 停用单个渠道 | 渠道页关闭该渠道 |
| 停用隧道扩展 | `extensions/cloudflare-tunnel` 默认停用；关闭/卸载只停**自有**进程与 listener |
| 卸载插件 | `dsh plugin remove dsh-notifier --profile <profile名>` |

卸载后：本地 Native 入口消失；**不删除**他人 cloud 资源与 credentials；用户数据保留在 state 文件中，
如需彻底清理请显式删除（见 [OPERATIONS](OPERATIONS.md)）。

## 文档命令自检

以下命令会被自动化测试校验"路径真实存在"（防止文档漂移到不存在的命令）：

```bash
dsh plugin add dsh-notifier@latest --profile <profile名>
dsh plugin remove dsh-notifier --profile <profile名>
node scripts/channel-selfcheck.mjs
node scripts/route.mjs show
node scripts/channel-login.mjs <qq|dingtalk|feishu|wechat>
node scripts/wechat-login.mjs
node scripts/verify-release.mjs
node scripts/verify-host-compat.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
npm test
npm run verify:release
```

> 真实手机 / 真实账号 / 真实 provider 回执的旅程证据**不在**默认 CI 范围内（默认测试有 hermetic 网络
> 边界）；这些继续保持 open，见 [risks](memory/risks.md) 与 [兼容性矩阵](compatibility-matrix.md)。