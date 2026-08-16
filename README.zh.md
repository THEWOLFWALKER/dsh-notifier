# dsh-notifier

DeepSeek Harness（DSH）的统一通知推送插件。前端一个极简 `notify()` API，背后多个渠道 —— 你的 agent 和宿主本身都能把消息推到你所在的地方。

[English](README.md) | 中文

## 特性

- **双触发线**：
  - **自动状态推送** —— 监听 `session/event`（`turn/end`、`approval/asked`、`agent/error`），任务完成 / 失败 / 需要审批时通知你。10 秒防抖，按会话去重。
  - **Agent 主动触发** —— 注册 `notify` 工具，模型可直接调用（例如完成长任务后、或需要你决策时）。
- **26 个开箱即用渠道**（零运行时依赖 —— 仅 `fetch` + `node:crypto`），全部由声明式 spec 引擎驱动（见下方[渠道矩阵](#渠道)）：
  - IM webhook：Telegram / Slack / Discord / 飞书（加签）/ 钉钉（HMAC 加签）/ 企业微信群机器人 / 企业微信应用 / QQ 官方机器人 / OneBot 11 / Teams / Mattermost / Google Chat
  - 推送 App：Bark / Pushover / PushDeer / Chanify / ntfy / Gotify / iGot
  - 国内生态：WxPusher / PushPlus / Server酱 / Qmsg / 息知 —— 以及一个通吃一切的 `webhook`，和本地终端 `bell` 响铃
- **分级路由** —— `timeSensitive` / `active` / `passive` 三级映射到各渠道原生送达语义（静默推送、优先级标头、@提醒），并配分档重试。
- **远程审批（可选）** —— 在手机上通过 Telegram 按钮回答 agent 的审批请求；沉默永远不会批准，超时自动回落到桌面。见[远程审批](#远程审批可选)。
- **远程会话（可选）** —— 在手机上和你的 agent 对话：纯文本按 agent 状态以 `followup`（空闲）或 `inject`（忙碌）投递，`!` 前缀中途纠偏（steer），合并窗把手机上的碎片输入拼回整句。见[远程会话](#远程会话可选)。
- **多 agent 路由（v0.3.2）** —— agent × 通道构成双向多对多矩阵：出站 `route:agents`（默认以 workspace 名为键，精确 agentId 为高级键）、入站 `route:channels` 通道默认 agent；会话创建即自动建档，`quiet` 仅静音出站推送，审批按 agent 分流 —— 另有 `/agent` 命令族与 `scripts/route.mjs` CLI。零配置用户行为完全不变。见[多 agent 路由](#多-agent-路由v032)。
- **Web 管理台（v0.3.3，可选）** —— 本机网页控制台（仅绑 127.0.0.1 + Bearer token）：通道健康总览、绑定矩阵、会话出站覆盖、凭证建单/测试/网页扫码授权；YAML 只做首次 bootstrap，运行时态全落 `state.json`。见[Web 管理台](#web-管理台v033)。
- **长消息分段** —— 超出渠道预算的出站消息自动切成带 `（i/n）` 前缀的多段按序送达；任一段失败即整体失败。
- **防打扰规则** —— 事件按结果分控、关键词 include/exclude（字面量或正则）、空闲宽限窗：turn 结束后 `graceSeconds` 秒内你在键盘上输入，通知即取消。见[防打扰规则](#防打扰规则与本地响铃可选)。
- **通知账本 + 每日摘要（可选）** —— 每次广播追加落账到本地 JSONL；启动时对昨日流量推送一条 `passive` 摘要。账本任何失败绝不影响送达。见[通知账本](#通知账本与每日摘要可选)。
- **渠道健康自检** —— agent 侧 `notify_test` 工具 + 独立 CLI（`scripts/test-channel.mjs`），端到端验证一个渠道（配置 → resolve → send），不碰真实通知语义。
- **工具限流** —— `notify` 工具受滑动窗口限制（`toolRateLimitPerMinute`，默认 10 次/分钟，`0` = 不限），prompt 注入的 agent 刷不动你的渠道。
- **密钥安全** —— 渠道密钥标记 `role('secret')`，处处脱敏（含自定义 webhook 头）；`${ENV:NAME}` 引用让密钥不落 profile。
- **绝不搞崩启动** —— 配错 / 缺配置的渠道静默跳过并留一行日志。

## 安装

```bash
dsh plugin add dsh-notifier
```

## 配置

把渠道加进你的 profile patch（`cordis.patch.yml`）：

```yaml
insert:
  - id: dsh-notifier
    name: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "123456:ABC-DEF..."
          chatId: "987654321"
        - type: dingtalk
          webhook: "https://oapi.dingtalk.com/robot/send?access_token=..."
          secret: "SEC..."
        - type: feishu
          webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/..."
        - type: wxpusher
          appToken: "AT_..."
          uids: ["UID_..."]
        - type: pushplus
          token: "..."
        - type: serverchan
          sct: "SCT..."
        - type: bark
          key: "your-device-key"   # 或 selfHost: "https://your-bark-server"
        - type: webhook
          url: "https://your-webhook"
          headers: { "x-token": "..." }   # 可选
```

## 用法

### 自动推送

启用插件即可。`turn/end`（success/error/cancelled）、`approval/asked`、`agent/error` 事件会推送到所有已配置渠道。

### Agent 主动触发

模型可以调用 `notify` 工具：

```
notify({ message: "调研完成，结果已写入 docs/", channel: "telegram", title: "任务完成" })
```

另注册 `notify_test` 工具用于健康自检：发送固定自检消息（省略 `channel` 广播全部渠道），结果渲染面向配置排障 —— 用于验证渠道是否接通，而不是通知你自己。两个工具各自独立滑动窗口限流（`toolRateLimitPerMinute`，测试风暴绕不过 notify 的限流）。

### 健康自检 CLI

在宿主之外单独验证一个渠道（退出码 0/1，可脚本化）：

```bash
node scripts/test-channel.mjs telegram '{"botToken":"...","chatId":"..."}'
node scripts/test-channel.mjs bark --config-file cfg.json   # ${ENV:NAME} 引用与运行时一致
echo '{"key":"..."}' | node scripts/test-channel.mjs bark
```

## 通知账本与每日摘要（可选）

开启 `digest.enabled` 后，每次广播追加一条到 `inbound.stateDir` 下的 `ledger.jsonl`（时间、分级、标题、送达/失败渠道）。启动时若昨日有流量且今天还没发过摘要，则按正常路由推送一条 `passive` 摘要；同日重启不重发（`ledger-state.json` 记录已发日期）。账本只追加、超限摊销压缩（`maxEntries`，默认 500），脏行跳过、磁盘错误静默 —— 绝不影响推送。

```yaml
insert:
  - id: dsh-notifier
    config:
      digest:
        enabled: true
        maxEntries: 500      # 超过 2 倍上限时压缩回该值
      inbound:
        stateDir: "~/.dsh/dsh-notifier"   # ledger.jsonl 也落在这里
      channels:
        - type: bark
          key: "your-device-key"
```

## 远程审批（可选）

审批请求可以在手机上回答。v0.3.0 起支持 5 个入站通道（telegram / feishu / qq / wxpusher / wechat，见[入站通道](#入站通道v030)）；telegram / feishu / qq / wechat 均为长连接或长轮询 —— **不需要公网 IP**（仅 wxpusher 回调需要公网可达）。整个回传栈仅在 `inbound.allowUsers` 非空时启动（默认全拒白名单）。v0.3.2 起审批通知按 agent 分流 —— 只发该 agent 绑定的通道（见[多 agent 路由](#多-agent-路由v032)）。

```yaml
insert:
  - id: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "123456:ABC-DEF..."
          chatId: "987654321"
      inbound:
        allowUsers: ["987654321"]   # 你的 Telegram user id —— 留空 = 回传不启动
        # telegram:                  # 可选；缺省回退到出站 telegram 渠道
        #   botToken: "..."
        #   notifyChatIds: ["987654321"]
        # stateDir: "~/.dsh/dsh-notifier"  # 待审批 / 去重 / 轮询游标
      approval:
        mode: answer                 # observe = 只推送影子模式；answer = 远程可决策
        timeoutMs: 120000            # 无人应答 → 静默回落桌面（绝不自动批准）
        numberedReply: true          # 无按钮渠道用回复 "1" 批准 / "2" 拒绝
        # escalation:                # 无人应答时升级再提醒
        #   enabled: true
        #   stages: [{ afterMs: 30000 }, { afterMs: 60000 }]
```

安全性质（全部有测试兜底）：

- 白名单默认全拒 —— 未知用户的回传消息直接丢弃。
- 每个按钮内嵌 HMAC 一次性 token；重放 / 伪造 / 过期一律拒绝，先到的决策生效。
- **沉默永不批准** —— 超时、解析失败、任何错误都把控制权交还桌面。
- 待审批、去重表、轮询游标跨重启持久化（原子 JSON store）。

## 入站通道（v0.3.0 + v0.3.1）

五条新入站通道与 telegram 并存，全部走同一套白名单 / 审批 / 会话路由（`inbound.allowUsers` 里填对应平台的用户标识）。有按钮的通道（telegram / feishu）直接点卡片批准；无按钮的通道（qq / wxpusher / wechat / dingtalk）收到审批通知后**回复 `1` 批准 / `2` 拒绝**。

| 通道 | 传输 | 凭证 | 按钮 | 公网要求 | 备注 |
|---|---|---|---|---|---|
| `feishu` | WebSocket 长连接（官方 SDK 懒加载） | appId + appSecret（自建应用） | ✅ 卡片 | 无 | 事件订阅选「长连接」模式；SDK 未装时启动即中文指引降级 |
| `qq` | WebSocket 网关裸协议（零 SDK） | appId + appSecret（q.qq.com） | ❌ 编号回复 | 无 | C2C 单聊 + 群 @；被动回复优先（带 msg_seq 独立配额） |
| `wxpusher` | HTTP 回调（`send_up_cmd` 上行） | appToken | ❌ 编号回复 | **需要**（frp/反代到 `127.0.0.1:8103`） | 密径即凭证（随机 32B hex）；上行 `#{appId} 指令` |
| `wechat` | iLink 长轮询（裸协议，零依赖） | 扫码登录（CLI 落盘） | ❌ 编号回复 | 无 | 个人号；单 token 单实例；带熔断器（3 次/60s → 开路 15s） |
| `dingtalk` | Stream 长连接裸协议（v0.3.1，零 SDK） | appKey + appSecret（企业内部应用） | ❌ 编号回复 | 无 | `robotCode` 从首条入站消息学习；主动推送复用熔断器；被动 `sessionWebhook` 回复优先 |

```yaml
inbound:
  allowUsers: ["ou_feishu_openid"]        # 各通道白名单取交集语义：填你实际启用通道的用户标识
  feishu:
    appId: "cli_xxx"
    appSecret: "${ENV:FEISHU_SECRET}"
  qq:
    appId: "102030405"
    appSecret: "${ENV:QQ_SECRET}"
    # notifyUsers: ["openid_xxx"]          # 可选：审批推送目标（缺省回落 allowUsers）
    # notifyGroups: ["group_openid"]       # 可选：群推送目标
  wxpusher:
    appToken: "AT_xxx"
    # webhookPath: "/hook/<随机密径>"      # 缺省自动生成并打印；host/port 可改
    # allowedIps: ["<WxPusher 出口 IP>"]   # 可选第二道闸
    # notifyUids: ["UID_xxx"]              # 可选：审批推送目标
  wechat: {}                               # 凭证来自登录 CLI（见下）
  # wechat:
  #   notifyUsers: ["wxid_xxx"]            # 可选：审批推送目标
  dingtalk: {}                             # v0.3.1；扫码 CLI 落盘或如下手填
  # dingtalk:
  #   appKey: "dingxxx"
  #   appSecret: "${ENV:DINGTALK_SECRET}"
  #   notifyUsers: ["staffId_xxx"]         # 可选：审批推送目标
```

### 一条命令扫码授权（v0.3.1）

qq / 钉钉 / 飞书走官方扫码授权，微信保持 iLink 扫码登录；凭证统一落本地 state（0600），config 显式配置永远优先于扫码落盘值：

```bash
node scripts/channel-login.mjs qq        # QQ 官方扫码创建/绑定机器人（需装 @tencent-connect/qqbot-connector）
node scripts/channel-login.mjs dingtalk  # 钉钉一键创建企业内部应用（需已加入组织的钉钉账号）
node scripts/channel-login.mjs feishu    # 飞书一键创建自建应用（成功打印扫码者 open_id 供白名单）
node scripts/channel-login.mjs wechat    # 等价 node scripts/wechat-login.mjs
```

工程细节（全部有测试兜底）：

- **qq**：官方 Node SDK 事实弃维，本通道为裸协议实现（IDENTIFY/RESUME/心跳/断线重连；token 自动换取缓存）。
- **dingtalk**：对照官方 SDK 逐字段核对的 Stream 裸协议——订阅写在网关 POST body（非 WS 帧）、心跳走协议层 ping/pong 被动应答、每帧 ack（服务端 60s 重推由 msgId 去重吸收）、被动 `sessionWebhook` 回复带 `x-acs-dingtalk-access-token` 头、主动 `batchSend` 从首条入站消息学习 `robotCode` 并复用熔断器。
- **wechat**：`context_token` 入站即学习、发送回显；`ret=-2 + unknown error` 伪装限流时剥 token 重试一次再定性；`ret=-14` 会话过期自动清凭证停用并告警重新扫码；主动消息限流触发熔断，收到新消息即复位。与 Hermes / OpenClaw 生产验证的同套 iLink 协议。

## 远程会话（可选）

白名单用户可以在手机上和运行中的 agent 对话。会话路由器和远程审批共用同一套回传栈（v0.3.0 起支持全部 5 个入站通道、`inbound.allowUsers` 白名单）；填上白名单即启用，没有额外开关。

投递语义按 agent 状态自动选择：

| 你发送 | Agent 空闲 | Agent 忙碌 |
|---|---|---|
| 纯文本 | `followup` —— 开启新 turn | `inject` —— 排队到下一个步骤边界，绝不打断 |
| `!文本` | `steer`（宿主内部等价 followup） | `steer` —— 重定向当前 turn |

手机打字容易把一句话拆成好几条。**合并窗**（默认 1500 毫秒）把同一用户的连续消息拼成一条再投递：

- `something..` —— 结尾 `..` 立即冲刷
- `something!!` —— 结尾 `!!` 立即冲刷**并**按 steer 投递

命令集（即时处理，不进合并窗）：

| 命令 | 作用 |
|---|---|
| `/status` | 查看绑定关系与所有活跃 agent 状态 |
| `/bind <sessionId>` | 固定投递到某个会话（跨重启保留） |
| `/unbind` | 解除固定；回到通道默认 agent（未配置则最近活跃） |
| `/stop` | 取消所绑定 agent 的当前 turn |
| `/agent` | 列出 workspace / 活跃会话及出站通道（v0.3.2） |
| `/agent use <workspace \| sid 前缀>` | 智能切换当前对话到该 agent（v0.3.2） |
| `/agent back` | 当前对话回到通道默认 agent（v0.3.2） |
| `/route` | 显示当前双向解析结果，排障用（v0.3.2） |
| `/help` | 命令帮助 |

`/agent` 命令族与 `/route` 服务 v0.3.2 多 agent 路由，详见[多 agent 路由](#多-agent-路由v032)。

```yaml
inbound:
  allowUsers: ["987654321"]
  conversation:
    mergeWindowMs: 1500   # 0 = 关闭合并（每条消息原样投递）
    steerPrefix: "!"      # 表示 steer 的单字符前缀
```

未知命令会当普通文本处理，不会吞消息。回执（命令反馈、「无活跃会话」提示）目前仅支持 Telegram。

## 多 agent 路由（v0.3.2）

agent 与通道不再绑死：一个 agent 可以推多个通道，一个通道可以默认指向一个 agent —— 双向多对多矩阵。默认路由键是 **workspace 名**（稳定、人类可读，同项目的多个会话天然聚合）；**精确 agentId** 作为高级键保留，供会话粒度控制。会话创建即自动建档，矩阵落在 `state.json`，聊天命令与 CLI 都能改 —— 不碰 YAML。

### 路由矩阵

| 方向 | 键 | 含义 |
|---|---|---|
| 出站：agent → 通道 | `route:agents` | 键 = workspace 名（默认）或精确 agentId（高级、会话粒度，优先于 workspace 条目）；值 = 出站 `channels` + `quiet` |
| 入站：通道 → agent | `route:channels` | `<channel>.defaultAgent` = workspace 名或 agentId —— 对话没有显式绑定时的默认去向 |

两个方向都走显式兜底链（先命中先得）：

```
出站  resolveOutbound(sessionId, workspace):
  route:sessions[sessionId].outbound   # 会话覆盖 diff（最高）
  ?? route:agents[sessionId]           # 精确 agentId 条目（高级键）
  ?? route:agents[workspace]           # workspace 条目（默认键）
  ?? 全局渠道池                          # v0.3.0 行为

入站  resolveInbound(channel, userId):
  bind:<channel>:<userId>              # 显式 /bind 或 /agent use
  ?? route:channels[channel].defaultAgent
       agentId   → 该会话（若仍活跃）
       workspace → 1 个活跃会话 → 直接投递
                   多个活跃会话 → 投最近活跃，回执附目标会话 id
  ?? 仅一个 agent 在跑 → 该 agent      # 单 agent 自动兜底
  ?? 最近活跃 agent                     # 最后兜底（v0.3.2 之前的行为）
```

会话在 `agent/created` 时以 workspace 名自动建档，新会话即刻继承通道与设置 —— 无需任何配置。Agent 主动调用的 `notify` 工具走同一条链（上下文拿得到 agent id 就按 agent 分流，否则全局池，工具签名不变）。`quiet` 只静音出站推送：账本照常记账，入站与审批永不被静音。

### 命令族

`/agent` 命令族加入会话命令集：

| 命令 | 作用 |
|---|---|
| `/agent` | 列出 workspace / 活跃会话及各自出站通道 |
| `/agent use <workspace \| sid 前缀>` | 智能切换当前对话到该 agent —— workspace 名精确匹配（该 workspace 多活跃会话取最近活跃）、sessionId 精确匹配、或 ≥ 4 位 sid 前缀；前缀歧义时列出候选 |
| `/agent back` | 当前对话回到通道默认 agent |
| `/route` | 显示双向完整解析结果（会话 → 通道 → 设置、通道 → agent），排障专用 |

`/bind` `/unbind` `/status` `/stop` 保留原语义（sessionId 级精细操作）不变。

示例 —— 两个 workspace、两条通道（`api-server` → dingtalk，`docs` → telegram），从 Telegram 对话：

```
你          /agent
通知        • api-server — 9f2c… → dingtalk
            • docs       — 41ab… → telegram
你          /agent use api-server
通知        当前对话已切到 api-server（9f2c…）；它的推送仍只发 dingtalk
你          重跑部署测试
通知        [已按 followup 投给 api-server；其 turn/end 只推 dingtalk，不进本对话]
你          /route
通知        对话 → api-server（9f2c…）
            api-server → dingtalk · telegram 默认 → docs
你          /agent back
通知        已回到 telegram 默认：docs（41ab…）
```

### 路由 CLI

`scripts/route.mjs` 在宿主之外查看 / 修改路由矩阵（退出码 0/1，可脚本化）：

```bash
node scripts/route.mjs show                                  # 三张表全量：agent 绑定 / 通道默认 / 会话台账
node scripts/route.mjs show api-server                       # 单个 agent 绑定条目
node scripts/route.mjs set api-server --channels dingtalk,bark   # workspace 出站通道（渠道类型白名单校验）
node scripts/route.mjs set api-server --quiet                # 静音其出站（账本照记）
node scripts/route.mjs set api-server --no-quiet             # 取消静音
node scripts/route.mjs set api-server --channels ''          # 显式空集 → 该键出站全静默
node scripts/route.mjs set 9f2c41ab --channels dingtalk      # 高级：精确 agentId 条目（会话粒度）
node scripts/route.mjs set api-server --reset                # 删除整条绑定 → 回落全局池
node scripts/route.mjs default telegram docs                 # 入站：telegram 默认进 docs
node scripts/route.mjs default telegram --clear              # 清除该默认
node scripts/route.mjs test 9f2c41ab --workspace api-server  # 打印出站解析链（L1 diff → L2 agentId → L3 workspace → L4 全局池）
node scripts/route.mjs test 9f2c41ab --global telegram,bark  # 按自定义全局池解析
node scripts/route.mjs show --state ~/.dsh/dsh-notifier      # 指定非默认 stateDir（默认 $DSH_HOME/dsh-notifier）
```

### 数据与配置

`state.json` 新增三个键（与 `bind:*`、扫码凭证同一个 0600 store）。`route:sessions` 由插件写入，只存 **diff** —— 未覆盖字段实时跟随上游，改默认后所有会话立即生效：

```json
{
  "route:agents": {
    "api-server": { "channels": ["dingtalk", "bark"] },
    "9f2c41ab-…": { "quiet": true }
  },
  "route:channels": {
    "telegram": { "defaultAgent": "docs" }
  },
  "route:sessions": {
    "9f2c41ab-…": {
      "inherit": "api-server",
      "workspace": "api-server",
      "outbound": { "quiet": true },
      "inbound": [{ "channel": "telegram", "userId": "987654321" }],
      "createdAt": 1760000000000,
      "lastActiveAt": 1760000123400
    }
  }
}
```

`agent/disposed` 后会话记录保留 `route.sessionTtlHours` 小时（默认 24）供同 id 重连（通道与绑定原样恢复）；窗口过后条目与入站挂钩一起回收（`bind:*` 不清 —— 过期绑定只会收到既有的「会话不存在」回执）。

```yaml
route:
  sessionTtlHours: 24   # dispose 后会话记录保留窗，单位小时（默认 24）
```

`quiet: true`（会话或 agent 条目）的语义：出站不推但照常写账本；入站消息与审批不受影响 —— 静音审批等于审批永远超时回落桌面，而沉默永不批准。

### 兼容性

- 未配置任何 `route:*` 的存量用户：出站走全局池、入站走原有链路，行为逐字节不变。
- 单 agent 用户：解析链在「唯一 agent」层自动命中，零感知、零配置。
- YAML 语义不变（仍只做 bootstrap）；一切新状态都在 `state.json`（0600）。
- `dependencies` 保持为空，零新增依赖。

### 审批分流

- 审批卡片 / 通知只发该 agent 解析出的通道集合，不再全局广播。
- 编号回复通道（qq / wxpusher / wechat / dingtalk）自动附带「回复 `1` 批准 / `2` 拒绝」。
- `quiet` 对审批不生效；回执走消息到达的原通道。

## Web 管理台（v0.3.3）

凭证与路由不再必须手改 YAML：本机网页控制台一站式搞定——通道健康总览、绑定矩阵、会话出站覆盖、凭证建单/测试/扫码授权。

### 开启与 token

```yaml
insert:
  - id: dsh-notifier
    name: dsh-notifier
    config:
      admin:
        enabled: true
        port: 8104        # 缺省 8104；只绑 127.0.0.1，不可配 host
        # token: "..."    # 可选；缺省首启自动生成并打印一次
```

首次启动（未显式配 token 且 state 无哈希）会在日志打印一次访问 token——**仅此一次，请立即保存**。token 的 SHA-256 哈希落在 `state.json` 的 `admin:token-hash`，明文绝不落盘；忘记 token 就删掉该键重启重新生成。浏览器首次访问时输入 token（localStorage 持久化，401 自动清除重询）。

### 安全模型

- **只绑 127.0.0.1**（红线，host 不开放配置）：公网暴露管理台 = 暴露全部凭证写权限；需要远程访问请自行加反向代理与额外鉴权。
- Bearer token 鉴权（恒时比对，401 不区分缺/错 token，防探测）；未鉴权请求绝不触达业务逻辑。
- 所有凭证读接口全脱敏（字符串值一律 `***`）；写操作 append-only 审计（只记动作与通道名，凭证内容绝不进日志）。

### 网页扫码与 CLI 的关系

通道页的「扫码授权」（qq / dingtalk / feishu）与 `node scripts/channel-login.mjs <channel>` 走同一批扫码模块与同一个 `<channel>:account` 落盘键——网页扫码成功后凭证即写 state，效果等同 CLI 登录；区别只是二维码内容展示在网页上轮询（复制后贴到任意扫码工具，或直接打开链接），无需终端。

### 凭证模型：YAML bootstrap ⊕ store 运行时态

YAML（`cordis.patch.yml`）只做首次 bootstrap 与出站 webhook 声明；网页保存的凭证落 `state.json`（0600），admin 开启时启动装配做**字段级合并**（store 覆盖 YAML 同名字段）后过渠道校验。保存成功后**下次插件启动**并入运行时——可先点「测试发送」即时验通。入站五通道（feishu/qq/dingtalk/wxpusher/wechat）在 admin 开启时，store 存在账号本身即启用信号（扫码授权完无需再改 YAML）。

例外：feishu / dingtalk 是双域通道——`<type>:account` 键域归入站机器人凭证，其**出站 webhook 仍只走 YAML**（网页出站行只读，防一键抹掉扫码凭证）。

## 防打扰规则与本地响铃（可选）

不是每个事件都值得一条推送。自动推送线上依次跑三道闸：

1. **事件分控** —— 关掉整条触发线，或按结束原因分控 `turn/end`。
2. **关键词** —— `exclude` 黑名单优先于 `include` 白名单；非法正则降级为字面量匹配，绝不炸启动。
3. **宽限窗** —— 防抖合并后的 `turn/end` 先等 `graceSeconds` 秒；期间任何 `user/*` 会话事件（你在键盘上）到达即取消通知。审批与错误不进宽限窗——它们在等人决策。

```yaml
insert:
  - id: dsh-notifier
    config:
      events:
        turnEnd: true            # 或按结果分控：{ completed: false, aborted: false }
        approval: true
        agentError: true
      keywords:
        include: []              # 白名单：命中至少一条才放行（空 = 全放行）
        exclude: ["heartbeat"]   # 黑名单：命中任意一条即拦截
        regex: false             # 条目按 RegExp 源码解释
        caseSensitive: false
      graceSeconds: 120          # 0（默认）= 关闭；headless 一次性任务通常配 0
      channels:
        - type: bell             # 本地终端响铃（BEL），无需凭证
          count: 2               # 响 1-5 声
```

`bell` 是 host 半的本地渠道，服务 headless/TUI 场景（Codex BEL 等价物）——每条通知响一次、尊重 `silent`、零凭证。**client 半**（`desktop` 系统通知 / `sound` 提示音 / out-of-view 抑制）以实验性骨架形式交付（`src/client/desktop-sound.mjs`）：纯决策逻辑 + 面向 DSH 客户端运行时的挂载契约说明，宿主仓库绝不 ship 假的客户端代码。

## 渠道

<!-- CHANNEL-MATRIX-START -->

| type | 渠道 | 凭证 | 免费? |
|---|---|---|---|
| `bark` | Bark (iOS) | device key（或自架 URL） | ✅ |
| `bell` | 终端响铃（本地） | — | 本地 |
| `chanify` | Chanify (iOS) | token（或自架） | ✅ |
| `dingtalk` | 钉钉自定义机器人 | webhook + secret（HMAC 加签） | ✅ |
| `discord` | Discord webhook | webhook URL | ✅ |
| `feishu` | 飞书自定义机器人 | webhook（+ 加签 secret） | ✅ |
| `gchat` | Google Chat | space webhook URL | ✅ |
| `gotify` | Gotify | 服务器 URL + app token | 自架 |
| `igot` | iGot (iOS) | push key | ✅（限量） |
| `mattermost` | Mattermost | base URL + token（+ channel） | 自架 |
| `ntfy` | ntfy | topic（+ 服务器 URL） | ✅（可自架） |
| `onebot` | OneBot 11 (QQ) | HTTP endpoint | 自架 |
| `pushdeer` | PushDeer | push key | ✅ |
| `pushover` | Pushover | user key + app token | 付费（一次性） |
| `pushplus` | PushPlus（微信） | token | ✅（限量） |
| `qmsg` | Qmsg酱 (QQ) | key + QQ 号 | ✅（限量） |
| `qq-bot` | QQ 官方机器人 | appId + appSecret | ✅ |
| `serverchan` | Server酱（微信） | sendkey | ✅（限量） |
| `slack` | Slack | incoming webhook URL | ✅ |
| `teams` | Microsoft Teams | Power Automate workflow URL | ✅ |
| `telegram` | Telegram Bot API | bot token + chat id | ✅ |
| `webhook` | 任意自定义端点 | — | — |
| `wecom` | 企业微信群机器人 | webhook key | ✅ |
| `wecom-app` | 企业微信应用消息 | corpid + agentId + secret | ✅ |
| `wxpusher` | WxPusher（微信） | appToken + uid | ✅（限量） |
| `xizhi` | 息知 | sendkey | ✅（限量） |

<!-- CHANNEL-MATRIX-END -->

## 开发

```bash
npm test          # node --test，329 个用例
```

纯 ESM（`.mjs`），零运行时依赖。新增渠道：在 `src/adapters/` 实现适配器接口（`resolve(cfg)` + `send(msg)`）并注册。

其它插件可复用 `createNotifier(ctx, channels, { routing, segment, onSend })` —— 每次广播结束触发 `onSend(record)`（含分级/送达/失败明细），可直接接自定义账本或指标。

## TODO

- desktop/sound 渠道的完整 client 半（Web Notification / Web Audio）

## License

MIT
