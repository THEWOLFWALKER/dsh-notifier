# 当前交接

更新：2026-10-03。当前仅在 `dev` 开发，远端 4066cf4 为起点；离线 Stage 2 工作先以 830d7b5 导入远端历史。唯一当前任务包是 DSH-NOTIFIER-V015-STAGE2-REVIEW-STAGE3-FINAL-V1。旧 WP00–WP23 追踪属于历史，不作为当前执行计划。包版本保持 0.13.1，本阶段不发布。

## 当前实现

- 当前任务按渠道、账户、用户隔离；旧记录仅在账户唯一可证时事务迁移，否则重新选择。Native 选择写入同一事实源。
- 实例替换只增加一次世代；状态观察不增加，退出和重建隔离迟到结果。订阅、实例和健康历史有容量与清理路径。
- Cloud 任务持久化身份、步骤、回执、取消和恢复状态，重启按资源名称读回。任务和资源行不再持有第二份 Bot Token。
- 日常 Native 收口为通知与私聊，旧内部管理页面已删除；高级页面只显示恢复报告。旧 API 能力隔离在 compatibility adapter。
- 六种接收入口在身份、配对和任务路由前拒绝群消息、群回调。群通知的出站协议保留。
- 用户文档使用操作语言，打包仅保留当前 Native 截图；截图渲染实际 `client.js`，数据是固定示例，不等同真实宿主证据。

## 检查

| 检查 | 结果 |
|---|---|
| 测试 | `npm test` **2527 tests** 为当前预期 leaf 数；P5 将以全量执行核实 |
| P0 | focused 56/56；首次全量 2510 项中的 5 项旧世代断言已更新 |
| P1 | focused 52/52；相关 DOM 17/17 |
| P2 | focused 92/92；全部 DOM 41/41 |
| P3 | focused 故障与容量行为 166/166 |
| P4 | focused 47/47；DOM 41/41；打包禁入路径 0 |
| P5 | 最终全量和全部验收门待当前阶段完成 |

[删除账本](v015-deletion-ledger.md) · [故障/容量证据](v015-fault-capacity.md) · [架构](architecture.md) · [状态写入归属](state-writer-registry.md)。

## BLOCKED 与证据边界

- 本次没有公网 Cloudflare 账号、真实 Telegram/APNs 设备或完整 DSH 宿主环境。已有契约和本地 workerd 证据不能冒充新增真实账号/设备证据。
- Wrangler 版本列表不保证返回地址。创建响应及本地回执同时丢失、读回又无地址时，安全停留在待恢复状态，不重复创建。这一路径有否定行为保证，完整公网恢复证明仍 BLOCKED。
- dsh-im 现有桥接仅是模拟服务契约；上游提供面板嵌入接口，未证实 `ctx.dshIm.send/listBots/listTargets`，不宣传互通。

下一步进入 P5；仅推 dev，不合并 main，不建 tag，不做 GitHub Release 或 npm publish。
