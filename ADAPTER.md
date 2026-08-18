# ADAPTER.md — 适配器接口契约

本文是给贡献者（含 good first issue 认领者）的适配器契约说明。dsh-notifier 的渠道接入分两条路径：
**声明表（spec）**与**代码适配器**。80% 的渠道是同一件事：POST 固定 URL、映射字段名、判定成功——
这类进声明表；需要 token 换取/缓存或多步控制流的，写独立代码适配器。

## 1. 接口契约（所有渠道统一）

每个渠道导出一个模块，注册进 `src/config.mjs` 的 `ADAPTERS`：

```js
export const type = 'channel-id'          // kebab-case，与配置行的 type 字段一致

// 校验并归一化配置。缺失/非法字段抛 NotifyError，message 一律中文并写明
// 「去哪里拿凭证」（参照 dingtalk 310000 的处理方式）。绝不静默吞掉配置错误。
export function resolve(cfg = {}) { ... return resolved }

// 发送一条消息（msg 已经 normalizeMessage 归一化：
//   { title, content, level?, group?, silent?, ...路由覆盖字段 }）。
// 失败抛 NotifyError（带稳定 code），成功 resolve 即视为送达。
export async function send(resolved, msg) { ... }
```

约定：

- `resolved.timeoutMs` 钳制在 1000–60000ms（`num(cfg.timeoutMs, 默认, 1000, 60000)`）。
- 错误 message 中文、含排障指引、**永不回显完整凭证**（secret 字段只出现末 4 位或完全不出现）。
- 每渠道的 secret 字段登记进 `SECRET_FIELDS`（spec 渠道用 `secret: true` 自动登记）。
- 网络请求走 `_shared.mjs` 的 `postJson` / `postForm` / `postText`（统一超时与错误分类）。

## 2. 声明表（spec 渠道，首选路径）

`src/adapters/spec-channels.mjs` 中每渠道 8-15 行纯数据，由 `_engine.mjs` 消费：

```js
slack: {
  label: 'Slack',
  desc: 'Slack Incoming Webhook',
  fields: {
    webhook: { required: true, secret: true, desc: 'Slack Incoming Webhook 完整地址（App 创建后复制）' },
  },
  encode: 'json',                        // json | form | text
  request: (cfg, msg) => ({
    url: cfg.webhook,
    body: { text: msg.title ? `${msg.title}\n${msg.content}` : msg.content },
  }),
  ok: ({ status }) => status === 200,    // Slack 成功只回 200 纯文本 "ok"
},
```

**维护性红线（违反会被 review 打回）：**

1. **spec 渠道禁止写控制流**：超过两个 `if` 就降级为独立代码适配器。
2. `request` 必须是纯函数（同步，无 IO），`ok` 同理。
3. 每渠道中文错误文案必须含「去哪里拿凭证」指引（`fields.*.desc` 提供素材）。
4. 消费 `msg.level` / `msg.silent` 实现渠道原生分级语义（如 ntfy 的 `X-Priority`、
   telegram 的 `disable_notification`），让路由矩阵能落到渠道语义上。
5. 移植代码在文件头标注来源仓库与 commit hash（见 `THIRD_PARTY_NOTICES.md`）。

## 3. 代码适配器（token 型/多步控制流）

需要「换 token → 缓存 → 过期刷新」的渠道共用 `_tokens.mjs` 的 `createTokenManager()`
（qq-bot 与 wecom-app 是现成范例）。其余直接实现第 1 节契约即可（现有 8 渠道即此形态）。

## 4. 契约测试（每渠道交付的一部分）

参数化契约测试取代每渠道手写用例。新增渠道时在 `test/fixtures/channels/<channel>.json`
落一个 fixture：

```json
{
  "validConfig": { "...": "能通过 resolve 的合法配置" },
  "invalidConfig": { "...": "应被 resolve 拒绝的配置" },
  "message": { "title": "t", "content": "c", "level": "active" },
  "expectedRequest": {
    "url": "https://example.com/...",
    "method": "POST",
    "headers": { "content-type": "..." },
    "body": { "…": "与 golden 完全一致的 body" }
  },
  "successResponse": { "status": 200, "body": "{...}" },
  "failResponse": { "status": 200, "body": "{...}" }
}
```

`test/contract.spec.mjs` 自动循环所有 fixture：resolve 校验 / mock fetch 断言
URL·method·body / 成功失败路径 / secret 脱敏。

## 5. 交付定义（DoD）

声明表一段 + fixture 一个 JSON + **真机推送成功一次**。
无法真机验证的渠道不收录——这是 awesome 列表 PR #277 确立的验证标准。
`node scripts/test-channel.mjs --channel <type>` 可在仓库侧完成真机验证。

## 6. good first issue 指引

- 找 `ADAPTER.md` 中未覆盖的渠道，先确认「HTTP POST 即可推送」（需要长连接/SMTP/原始 socket 的不做，见 README「明确不做」）。
- 先提 issue 附上渠道官方文档链接，确认端点与成功判定后再动工。
- 按 spec 模板写声明 + fixture，本地 `node --test` 全绿 + 真机验证截图，即可提 PR。
- README 渠道矩阵由 `node scripts/gen-channel-matrix.mjs` 从声明表生成，勿手改（CI 有漂移检查）。
