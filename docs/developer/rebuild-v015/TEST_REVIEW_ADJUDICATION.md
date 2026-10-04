# 独立测试审查裁定与替换门禁

来源：`sources/independent-test-review-merged.md`，固定审查基线 `2542a3107e7d3795e6ba5b294a7a5b82052c3431`。三路报告给出了实际断言和源代码位置；它们只读审查，没有运行全套，也没有逐条认证所有 2447 个 Node 测试。`test-catalog.json` 的 179 文件与独立报告的 178/115+ 口径来自不同枚举方式，不推导为矛盾的质量结论。最终以 runner 实际发现列表为准。

用户最新裁决：**不做任何旧版本适配**。即使旧迁移测试本身是高质量行为测试，其目标行为也已经退出。保留测试手法，删除旧版本自动转换与对应正向断言；旧文件只安全备份，新状态重新配置。此裁决高于独立报告中“可保留一次性迁移”的建议。

| 测试/位置 | 当前断言和依据 | 裁定与替换门禁 |
|---|---|---|
| `v015-stage-s14-dsh-im-bridge:11,34,53,57` | flat `accountFingerprint`、虚构 `kind:'private'`、本地 route digest 均由当前 bridge/mocks 提供 | **REPLACE**。若 bridge 有真实消费者，固定上游 nested `account.fingerprint`、合法 kind、normalize route 后 digest；私聊来源缺失或 group/topic 均拒绝。无消费者则 bridge 与测试一并 DELETE。 |
| `target-guard:128,148,207`、`inbound.qq:930,1082` | `extraTargets` 群目标无条件并入通知；旧群产品行为 | **DELETE positive / REPLACE negative**。审批、提问、动作通知经过真实 target resolver 与 sender 后，Telegram 负 ID、QQ group、Feishu group 均零发送。 |
| `inbound.telegram:579`、`inbound.feishu:258` | stub bus 接受群或缺 chatType 的事件；当前适配器行为 | **REPLACE**。解析测试只测纯解析器；集成测试使用真实 bus，显式 group 与缺 chatType 均拒绝且消费者零调用。 |
| `actions:289,322,349,360,433` 与 Feishu/TG 旧卡用例 | 来源缺失或持久化 markSource 失败时 10 分钟内仍执行；旧兼容规则 | **DELETE positive / REPLACE negative**。无来源或来源写失败，审批/提问/动作均拒绝、账本不结算、host effect 零次；用户可重新发起。 |
| `interaction.ledger:78`、`v015-stage-s20:166,181` | 单线程终态不可翻、重启不重放；正式安全语义 | **KEEP**，但它们不能证明 terminate/markUncertain 无 stale RMW。另加同 store stale snapshot + transact fresh barrier 双交错、持久重启 oracle。 |
| `approval:392`、`approval.multi:395`、`questions:1504+` | 同账号 owner 或 exact pushedTo 可行；当前授权路径 | **KEEP + ADD**。账号 A owner 对账号 B 同 channel/user 的 fallback 编号回复必须拒绝。不要用 Control Core exact 路径测试代替 router fallback。 |
| `cloudflare-release` rig `yamlRows:new Map()` 与 unbind 用例 | store token 路径、endpoint 还原；本地 rig 假设 | **REPLACE/EXPAND**。YAML-only token 首次 deploy→restart→lost response→reconcile；每个 durable step fault；secret reference 有来源；unbind 撤回 job 拥有的副本、不删用户已有 YAML 值。Wrangler readback 真实性仍 unknown。 |
| `public-testing-fake:49,63,113`、`public-types:72,91`、`public:139` | fake `ok:true`、flush 三形态、unknown 算 failed；各自当前实现 | **REPLACE**。D05 单一 schema table 同时跑 runtime/fake/event，TS consumer 真编译；timeout=unknown、无自动重试；flush 单独 `{drained:boolean}`。 |
| `native-boundary-contracts:178,279`、`test/dom/*` | 缺 ID→default、服务端 synthetic rows 截断；DOM 多测成功空态 | **REPLACE/EXPAND**。缺 ID fail closed；真实 RPC `ok:false`、not-supported、storage-failed、transport failure 在 DOM 呈错误及恢复动作，不呈“暂无数据”；真实可增长列表 total/分页/搜索可达。 |
| `admin-*` 206 点、`admin.expose-tasks-host` | 旧 Admin 函数层仍通过，部分无 HTTP 入口；旧产品 | **DELETE** 旧管理正向测试与代码；Native canonical projection 重建仍需要的行为测试。Recovery 如保留，仅测只读诊断、loopback/no-store/stop；验证 HTTP 旧路由 404 与 pack 无旧 client/API/events/scan。 |
| `wiring.route:286+`、`index` structured cancel grep、`v015-stage2-acceptance:43,100` | 正则搜源码词/注入形状；当前写法 | **REPLACE evidence**。真实装配 owner 权限行为、fake agent 实收 `{kind:'user'}`、真实 Store 仅 authority 改 bind 键；少量源码守卫仅作辅助。 |
| `security-structure:88,106,131,153`、`actions:83` | 前提不存在时条件体不执行/空 catch；过期裁决断言布尔穷举 | **REPLACE**。要求目标行、control 和 audit 文件先存在；`assert.rejects/throws` 明确 422；可控时钟推进 TTL 后断言 expired 与零 effect。旧 Admin 测试里的安全不变量迁入新入口。 |
| `channel-fail-closed:71,103`、`mobile-task-loop-contract:24` | 名称宣称 chat 字段与 4096 分段，实际不调生产函数或自算自证 | **REPLACE/DELETE**。调用真实适配器/segmenter；缺 chat/user 字段拒绝，Unicode 4096 边界不劈 surrogate。 |
| `bounded:148,157`、`pending-bounds:13`、`attachments-bounds:31`、`s3-http-sender:227` | Infinity 无界、字符串 cap；上界 `<=` 可在全丢时通过；sender 数仅下界 | **REPLACE weak**。资源 cap 非有限值默认有界；精确保留最新 N 条/附件序；sender 类型集合对正式渠道逐项覆盖。 |
| `host-compat-matrix`、`host-seam-audit` | manifest、矩阵、文档自洽；Host fake 手写 provider-chain | **KEEP as drift guard**，单独固定支持的上游版本和真实 Host boot/seam 测试。未真测的 registerProvider/root fallback 标 unknown；未来 carrier 不由当前正则永久禁止。 |
| `user-copy-lint`、`package-payload`、`plugins-docs` | 可见词汇、包 allowlist、文档漂移 | **KEEP as supporting guard**；增加真实 DOM 文案和 npm pack 内容；硬编码旧版本号不能压倒正式版本更新。 |
| `v014-persistence-concurrency-hardening`、`channel-config-migration-v013`、`v015-stage-s20` 的 legacy→canonical 用例 | 真 store/故障注入证明旧版自动迁移；过去的产品目标 | **DELETE旧迁移预期，REUSE测试方法**。新断言：备份唯一且权限安全、旧文件零自动读取、新 schema 空启动、用户重设成功、备份失败时不开旧权限。 |

## 门禁顺序

1. S0 固定 runner 枚举：`npm test` 不含 `test/dom`；CI 的文本包含 DOM 命令不是执行证据。Node 与真实 React DOM 分别实际运行、记录结果并阻断失败。
2. S1 先修权限与跨账号/旧卡/ledger；做两账号同 userId、群/缺类型、关闭在途和磁盘故障的真实跨组件测试。
3. S2 固定上游 contract fixture、Cloud YAML-only × durable step × restart、public schema 的 runtime/fake/types/event 一致；保留外部 provider 与 Wrangler 实测 unknown。
4. S3 删除旧 Console 整套生产代码与测试，再做真实 UI call graph、错误与空态、列表可发现性、旧路由/打包残留门禁。
5. S4 运行 full gate；不得用测试总数恢复至 2447 作为质量目标。每个修复的原始 ID 有可定位行为证据，外部缺口保持 unknown。
