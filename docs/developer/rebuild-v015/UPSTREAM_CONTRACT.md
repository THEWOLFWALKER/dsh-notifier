# 固定上游契约证据（不是本地 mock）

本文件基于只读下载的固定提交。原始文件保存在 `sources/upstream-*`，实现 Agent 可直接据此生成 fixture，不需重新猜字段。真实运行集成仍需单独执行并标证据。

## dsh-im checked delivery v1

来源：`xmanrui/dsh-im@ecf6c85b72b213bcc937e379cf125d210d447401` 的 `plugin-src/host/delivery-service.mjs` 与 `PROACTIVE_DELIVERY.md`。下载文件 SHA-256 分别为 `5feb0364997ef27c666947c507e3d75728212e37205c7ee3ba77ccb31d478440`、`098216fab8b152cb20c5f6568a2a0d1ee1385b352bb04acf7cd91b1bafced6f9`。

- `describeBot(botId)` 返回 adapter 的 account description；文档约定 `{version:1,botId,channel,account:{fingerprint,name?},connected,capabilities}`。fingerprint **嵌套在 account 下**，不在 `accountFingerprint` 或根 `fingerprint`。
- `sendChecked(botId,targetId,text,{expectedFingerprint,expectedTargetDigest,signal,format})` 要求两个 64 位小写 hex digest；只认已保存 target。`expectedTargetDigest=SHA256(UTF8(JSON.stringify({kind,route})))`，route keys 按 JS 字符串 code-unit 升序，名称/alias 不计。`account.account?.fingerprint !== expectedFingerprint` 抛 `account-changed`，目标摘要不符抛 `target-changed`。
- `account-unverified/account-changed/target-changed/capability-unavailable` 在发送前拒绝，可按确定失败处理。`{sent:true}` 只代表平台接受，不代表送达/已读。SDK 开始后的取消、超时、网络含糊失败不能证明未发送，应为 unknown，不能盲重试。当前 upstream 文档写首版 checked 实现只支持 Feishu/Lark；其他渠道若未实现，返回 `capability-unavailable`。因此不应只凭本地 bridge mock 认定 Telegram checked 可用。
- upstream service 对 registration 在发送前再次校验，并调用 adapter 的 `beforeSend`；notifier 不应自行绕开这些检查或降级到 unchecked send。

来源还包括 `plugin-src/host/delivery-adapter.mjs`，SHA-256 `a2140e080a58a3b798f88b9e7eb05ff26e6f4b82e04d6954fd2feb88bed3070f`。Feishu 的合法 target kind 是 `user` / `group`；`user` route 只含 `openId`，`group` route 只含 `chatId`。本产品私聊约束下，桥只列出并接受 `kind:'user'`；现有测试里曾用的 `kind:'private'` 和 `{chatId}` 是本地臆造形状，不能继续作为 contract fixture。其他 provider 只有实现并声明 checked capability 后才可用。

建议 fixture 集合：nested fingerprint 正常、flat-only 应拒绝、account-changed、target-changed、capability-unavailable、`{sent:true}` accepted、SDK 后 timeout/Abort unknown、route key 顺序不同但摘要相同、alias 修改不影响摘要。Fixture 文件写明上述固定提交、原始路径、行/函数和 hash；不得从 notifier 实现反向生成预期。

## DSH Host operator admission

来源：`deepseek-ai/deepseek-harness@5badb15009ae1756c3afe0ae0cef1faafc290ccc` 的 `packages/client/connection/src/rpc-host.ts`，SHA-256 `bf305c21998f65d605c22ca01646a7ce277ea4e298cc34abaf13832f789f01c3`。该文件 `admit()` 注释为通过 fence 和 authentication 的请求代表 operator，并返回 `{peer:this.operator}`；上一轮 DSH-D10 把缺 notifier 独立 role gate 直接定漏洞属于过重判断。实施仍需严格 method allowlist 和真实 Host boot/版本验证；不能把本地类型一致当作真实宿主证据。

## dsh-im host bridge 与 client panel 是两条不同接口

2026-10-03 复核 `xmanrui/dsh-im` 当前 `HEAD`：`dd2cda2cdd3ad3d6e7363a556254cad4abbfde3c`。`plugin-src/host/delivery-service.mjs` 的 SHA-256 仍为 `5feb0364997ef27c666947c507e3d75728212e37205c7ee3ba77ccb31d478440`，与上方已固定的 checked-delivery 源码一致。`docs/client-integration.md` SHA-256 为 `a32d108a5c6c0b73aeed46a547d43c20d7ee31616e51a2786dd0cc7902a29908`，原文存于 `sources/upstream-client-integration.md`。

| 接口 | 真实用途 | 公开方法 | 可否作为配置导入 API |
|---|---|---|---|
| Host `dshIm` | bot/target 发现与主动投递 | `contractVersion:1`、`listBots()`、`describeBot(botId)`、`listTargets(botId)`、`sendChecked(...)` | 否；不暴露凭证读取、配置导出或导入 |
| Client `dshImClient` | 在同一 DSH 客户端嵌入 dsh-im 完整管理面板 | `version:1`、`render({preferredSectionId?})`、`setSettingsVisible(boolean)`、`settingsVisible()` | 否；返回 React element / 面板可见性，没有配置数据读写方法 |

因此本仓库 `portability.*` 的文件导入目前只认 `dsh-notifier-config` 格式，不能宣称它会读取 dsh-im 配置。用户提到的“一键导入 dsh-im 配置”需求已确认存在，但其输入来源尚未映射到 dsh-im 的公开 API；在确认它是配置文件、宿主侧可访问状态，还是另有约定接口前，不应猜字段或读取私有状态文件。
