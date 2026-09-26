# Technical debt and release gates

状态更新：2026-09-26。当前开发线 **v0.13.1** 已完成 v0.13 后续收口：canonical outbound config、Native/Admin 服务统一、provider handshake/deadline、durable cursor、epoch/revision 生命周期、结构化 RPC 错误、安全迁移诊断、前端 ErrorBoundary、管理台多语言资源与 npm README 资产白名单均已通过回归。`npm test` 为 **2011/2011 pass**，0 fail、0 skip；`npm run verify:release` 通过。

本次收口没有新增真实 DSH 真机、provider 账号或真实投递回执证据。剩余技术债主要是 QQ HELLO/READY 与 DingTalk Stream soak、Feishu P2P 真实 payload、QQ mention/media/rendering、WxPusher forged UID、DNS rebinding、Native host 回归、dark/light/窄屏视觉回归，以及真实 provider hot-apply delivery；均登记在 `docs/memory/risks.md`，不得误写成 v0.13 合同未实现。

### 已知工具面坑（2026-08-28 登记）

- **裸 `node --test` 会把 `scripts/` 吸进测试扫描**：`scripts/channel-selfcheck.mjs`（G-57：原 `test-channel.mjs` 重命名）是需要 CLI 参数的运维脚本，无参调用退出码 1，被 node test runner 当失败用例。正式测试面是 `npm test`（glob 限定 `test/*.test.mjs`/`*.spec.mjs`）；全量校验一律用 `npm test`，不要裸跑 `node --test`。

## 已完成的维护范围

- 文档、版本和测试基线已对账；历史快照不再作为当前状态。
- Telegram 文本边界、回调容量、渠道 account/source 绑定、Control Core 结算、问题编号回复和 QQ/Feishu/WeChat iLink/DingTalk adapter seam 已有 focused contract coverage。
- 错误可见性、跨进程 state 写入、session control overlay 持久化、公共 notifier facade 预算/冻结和管理台个人模式 UX 已完成代码审查与回归测试。
- `allowUsers` 兼容迁移和 Feishu/QQ 可选 SDK 生命周期已完成兼容性评估，保留原入口；详情见 [compatibility-matrix.md](compatibility-matrix.md)。

## 剩余外部验证门

- 真机/协议：Telegram 4096 边界、Feishu WS、QQ gateway/按钮 ACK、DingTalk stream、WeChat iLink QR/长轮询、WxPusher 回调、图片/文件 payload 与各 provider 限制。
- 宿主/桌面：DSH 真实事件装配、真实浏览器管理台操作、重启读取持久化 overlay、Windows BurntToast/PowerShell toast。桌面 `ask_user` 没有安全宿主接口，不能宣称可用或双端共享。
- 发布：npm `0.13.0` 已发布并通过 registry artifact 校验；`0.13.1` 继续要求 disposable profile 的 registry 安装、Native UI、一次出站 Hot Apply 与至少一条入站路径 smoke。

## 维护规则

新工作仍须遵循 plan → adversarial review → focused tests → full validation；mock 通过不等于 provider/宿主行为已验证。不得以扩大功能、猜测协议字段或放宽 fail-closed 边界来关闭上述门。

### mock 分层原则（G-58，2026-09-05 写入）

入站渠道测试按三层分离，防止「mock 与实现同源共生、协议漂移时 mock 先『对了』」（G-01/G-58 原罪）：

1. **协议合约 fixtures**：协议帧/回执的形状样本放 `test/fixtures/`（如 `channels/qq-bot.json`、`qq-c2c-image.json`），只表达「协议长什么样」，不含驱动逻辑。字段增删先改这里，再谈实现。
2. **传输 fake**：仅模拟「传输层行为」的最小 fake（如 `test/inbound.qq.test.mjs` 的 `FakeWebSocket`），负责 open/message/close/error/半帧/超时等事件驱动，不做业务断言。新增入站通道照抄该结构：fake 只管发事件、收帧，协议语义留在上层。
3. **业务断言**：`test/inbound.*.test.mjs` 里的用例只断言「帧 → bus envelope / 回执 / 重连」的业务结果，不关心 fake 内部实现。去重/归属断言查具体载荷（ack 条数 + ack 归属），不只数条数。

纪律：新渠道入站测试照此结构写；fake 缺支路（如 error/半帧/超时）先补 fake 再写用例，不得绕过 fake 直接 mock 业务层。

完整检查命令：

```text
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
git diff --check
```
