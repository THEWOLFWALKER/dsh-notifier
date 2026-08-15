# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。
DSH 处于 developer preview，0.x 阶段的次版本号提升允许小幅破坏性变更（会在条目中标注）。

## [0.2.0] - 2026-08-15

### Added（阶段 0：仓库基建）

- GitHub Actions CI：`node --test` + 零运行时依赖断言 + 渠道矩阵漂移检查（`.github/workflows/ci.yml`）。
- `README.zh.md` 中文文档（修复「README 英文 / package.json 中文」的 i18n 倒挂）。
- `THIRD_PARTY_NOTICES.md`：移植代码来源声明（push-all-in-one / all-pusher-api）。
- `ADAPTER.md`：适配器接口契约、spec 声明表编写守则、契约测试模板、good first issue 指引。

### Added（阶段 1：渠道扩展）

- spec 引擎 `src/adapters/_engine.mjs`：吃声明表产出 `resolve`/`send`，新渠道 8-15 行纯数据接入。
- 声明表 `src/adapters/spec-channels.mjs`，新增 15 个声明式渠道：
  slack / discord / wecom（企微机器人）/ ntfy / onebot（QQ OneBot 11）/ pushdeer / pushover / chanify / xizhi（息知）/ qmsg / igot / gotify / teams / mattermost / gchat（Google Chat）。
- token 管理器 `src/adapters/_tokens.mjs`（换 token → 缓存 → 过期刷新，QQ 官方与企微应用共用）。
- 代码适配器 `src/adapters/qq-bot.mjs`（QQ 官方机器人，appid+secret 换 access_token）、`src/adapters/wecom-app.mjs`（企微应用消息）。
- 参数化契约测试：`test/fixtures/channels/*.json` + `test/contract.spec.mjs`（resolve 校验 / mock fetch 断言 URL·method·body / 成功失败路径 / secret 脱敏）。
- 密钥环境变量引用：`${ENV:NAME}` 全值替换（先于校验解析），密钥可不落 profile 明文。
- `scripts/gen-channel-matrix.mjs`：从声明表生成 README 渠道矩阵，防文档漂移。

### Added（阶段 3：分级路由矩阵）

- `src/routing.mjs`：`routing: { timeSensitive | active | passive → [{ channel, ...语义覆盖 }] }`。
- 分档重试：timeSensitive 指数退避重试 2 次，active 重试 1 次，passive 不重试。
- 渠道语义对接：telegram `disable_notification`（静默）、ntfy `X-Priority`/静默、bark 原生 `level`（已有）、钉钉/飞书 `atAll`（配置开启）。

### Added（阶段 4：远程审批 inbound 模块，整体可选）

- `src/inbound/tokens.mjs`：HMAC 一次性 token（恒时比较、TTL、伪造/篡改/过期全拒；secret 缺省进程内随机，重启即全部失效）。
- `src/inbound/store.mjs`：JSON 文件持久化（pending 审批账本 / 去重表 / 轮询 cursor，原子写 + 损坏回退空状态，重启可恢复）。
- `src/inbound/bus.mjs`：入站总线（白名单默认全拒、持久去重 + 内存 FIFO 双层、`wait`/`decide`/`decideTrusted`/`abandon`、首达采纳——二次裁决一律 `already-resolved`）。
- `src/inbound/telegram-bot.mjs`：getUpdates 长轮询 + inline keyboard 按钮审批（无公网要求）；`callback_data` 解析容忍审批 key 内含冒号；offset cursor 持久化重启不重复消费；轮询异常只退避重试。
- `src/approval/router.mjs`：`approval/request` 瀑布流处理器（observe / answer 两模式，超时静默交还桌面）；编号回复降级（白名单用户回复 `1`/`2` 裁决最近待决，优先精确匹配推送目标、无匹配回退全局最近）。
- `src/approval/escalation.mjs`：审批升级链状态机（默认 30s/60s 两轮再提醒，任何裁决/超时/异常立即叫停）。
- `apply()` 装配：`inbound.allowUsers` 非空才启动整栈；`inbound.telegram` 未配置时自动复用出站 telegram 渠道的 `botToken`/`chatId`；`approval` 配置块接入 `resolveConfig`。
- 测试 +56 例（`test/inbound.test.mjs` / `test/inbound.telegram.test.mjs` / `test/approval.test.mjs` / index 装配测试），全量 158 例通过。

### Added（阶段 5：远程对话，克制版）

- `src/inbound/conversation.mjs`：followup（空闲唤醒）/ inject（忙碌排队）/ steer（`!` 前缀纠偏）投递语义路由。
- 合并窗（默认 1500ms）聚合手机碎片输入；`..` 立即冲刷、`!!` 立即冲刷并按 steer 投递；`mergeWindowMs: 0` 关闭合并。
- 命令集：`/status`、`/bind <sessionId>`、`/unbind`、`/stop`、`/help`（未知命令当普通文本，不吞消息）。
- `src/inbound/segment.mjs`：出站长消息收敛分段（1200 Unicode 码点预算，`（i/n）` 前缀长度参与递归收敛）；`notify` 出站统一走分段，任一段失败即整体失败（部分送达在错误中说明）。
- 默认投递目标为最近活跃 agent，`/bind` 显式绑定持久化（`bind:<channel>:<userId>`）。
- 测试 +25 例（`test/segment.test.mjs` / `test/conversation.test.mjs`），全量 183 例通过。

### Added（阶段 2：桌面通知规则，host 半）

- `src/rules.mjs`：host 侧规则引擎——关键词 include/exclude（字面量+正则+大小写开关，非法正则降级字面量）与空闲宽限窗 `createGraceQueue`（可注入时钟/定时器，纯函数可单测）。
- 事件粒度分控接入自动推送线：`events.turnEnd` 支持整类开关与按结束原因分控（completed/error/blocked/aborted/max-tokens/interrupted），`events.approval` / `events.agentError` 整类开关；被拦事件不占 dedup 名额。
- 空闲宽限窗接入：turn/end 防抖到期后进 `graceSeconds` 宽限窗，期间任何 `user/*` 会话事件（人在键盘）即取消打扰；approval / agent/error 不进宽限窗（等人决策，晚到等于没到）；dispose 时 flush 送达（headless 退出路径）。
- `bell` 本地渠道（`src/adapters/bell.mjs`）：终端 BEL 响铃（headless/TUI 场景，Codex BEL 等价物），count 钳制 1-5，尊重 `silent`，零凭证。
- `src/client/desktop-sound.mjs`：client 半实验性骨架——分级音色决策（`pickSoundForLevel`）、同会话通知替换键（`buildDesktopNotification` 的 tag）、out-of-view 抑制判定（`shouldSuppressDesktop`）等纯逻辑 + `shell.overlay` 挂载契约说明；宿主仓库不含客户端构建产物。
- 测试 +25 例（`test/rules.test.mjs` + event-listener 集成用例），全量 208 例通过。

### Added（阶段 6：通知账本 + 健康自检 + 工具限流）

- `src/ledger.mjs`：通知账本——每次广播追加一条 JSONL（时间/分级/标题/送达/失败），超 2 倍上限时摊销重写；`summarize`/`compose` 产出昨日摘要；脏行跳过、不可写目录静默，账本失败绝不拖累推送。
- 每日摘要（`digest.enabled`）：启动时对「昨日」窗口汇总推送一次（passive 级走正常路由），同日重启不重发（`ledger-state.json` 记录已发日期）；账本目录复用 `inbound.stateDir`。
- `src/health.mjs` + `scripts/test-channel.mjs`：渠道真机自检（resolve → send 全链路），CLI 支持 `--config` / `--config-file` / stdin 传入配置并解析 `${ENV:NAME}` 引用；退出码 0/1 可脚本化。
- `notify_test` agent 工具：发送固定自检消息验证渠道（与 `notify` 的区别：不改用户语义、结果渲染面向配置排障），省略 `channel` 广播全部已配置渠道；同样受滑动窗口限流（独立计数，测试风暴不能绕过 `notify` 限流刷渠道）。
- `notify` 工具滑动窗口限流（`toolRateLimitPerMinute`，默认 10 次/分钟，0 = 不限）：防 prompt injection 把用户渠道刷成垃圾出口；超限返回 `rateLimited` 结果并中文提示调整方向。
- `createNotifier` 复用钩子 `onSend(record)`：每次广播结束回调（含分级/送达/失败明细），第三方插件可复用 notifier 落自己的账本。
- `npm test` / CI 显式钉到 `test/*.test.mjs` + `test/*.spec.mjs`：默认发现 glob（`test-*`）会误吞 `scripts/test-channel.mjs`。
- 测试 +18 例（`test/ledger.test.mjs` + 限流/notify_test 用例），全量 226 例通过。

### Changed

- `package.json`：description 改为双语对齐；keywords 补充新渠道。
- 既有 8 个适配器零行为变更（仅 telegram 增加 `disable_notification`、钉钉/飞书增加配置门控的 `atAll` 一行语义对接）。

### Security

- 白名单默认全拒；token 单次核销；静默永不批准（超时/无响应/解析失败一律 `next()` 交还桌面）。
- 入站文本只能进会话流（`source.kind = 'plugin'`），永不直接执行 shell。
- secret 脱敏扩展到日志与错误消息全路径；token 不落库。

## [0.1.0] - 2026-08（基线）

首个发布：8 渠道（telegram/dingtalk/feishu/wxpusher/pushplus/serverchan/bark/webhook）单向推送，
双触发线（session/event 自动推送 + `notify` 工具），零运行时依赖，72 个 `node:test` 用例。
