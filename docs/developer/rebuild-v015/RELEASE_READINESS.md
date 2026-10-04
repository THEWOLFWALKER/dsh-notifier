# 距离以“全新面貌”公开还差什么（暂不计真实账号/真机验证）

> This is the initial gap audit for the planning baseline, not a live completion checklist. The
> v0.15 implementation and local gate results are recorded in `PROGRESS.md`; external Host,
> provider, device and Cloud evidence remains unknown where that file says so.

当前基线不能仅靠 2447/2447 Node 和 41/41 DOM 宣称完成。即使把真实账号与真机试验全部暂置为 unknown，仍须完成以下**本地可验证的**产品、代码与发布闭环。这里的“发布”指候选发布审查；没有最终单独授权不得 tag、GitHub Release 或 npm publish。

| Gate | 要交付的结果 | 可核验证据 |
|---|---|---|
| G1 权限可信 | 通知不会启动私聊；关闭私聊立即撤权且重启不回开；所有 provider 未证明 private 即拒绝；secret clear 同步封旧 runtime | assembly+Native+bus 真实集成、inflight barrier、重启/落盘故障用例 |
| G2 数据与账号可信 | ledger 终态单调、defer 真语义、导入 clear CAS；账号键覆盖 pending/owner/dedup/throttle；Store 不活引用、不误报 durable | 并发顺序枚举、A/B 账号交叉测试、真实 store 磁盘故障与备份重设试验 |
| G3 结果可信 | 公共 API/runtime/types/fake/event/Activity 同一发送证据；unknown 不自动重试；Cloud failed 与 recovery-required 可退出 | 固定 upstream dsh-im fixture，公共 consumer compile/runtime suite，Cloud checkpoint fault matrix |
| G4 完整 Native 产品 | 首次配置、身份、当前任务、待办、成员管理、撤销配对、关闭私聊、Cloud 恢复都能走完；无后台有前台无；超量列表可查 | 真 DSH Host 的不带真实 provider 的 UI 装配；DOM 完整用户任务、窄屏/明暗/键盘/读屏走查 |
| G5 旧产品退场 | 旧 Advanced Console 代码/资源/路由、群聊正向能力、旧版兼容 shim、不可达 daily 方法和过时文档确实删除 | source/package exports/call graph/pack 检查，拒绝群聊行为测试 |
| G6 工程门禁闭环 | Node+DOM+发布 guard+Host compat+package exports+渠道矩阵在同一 CI 必过；`--count` 失败不能绿；DOM 依赖可复现 | CI workflow 实际运行结果、pack 文件清单、TS consumer compile、依赖安装 smoke |
| G7 支持边界与版本 | `package.json`、README、CHANGELOG、用户指南、兼容矩阵和实际行为一致；Windows/Node 支持声明与 CI 一致；新旧 API 破坏性调整有明确说明 | 文档与包体审查、支持矩阵，dev/main 分叉单独处理但本阶段不动 main |
| G8 性能与恢复 | state 增长、同步 IO、Cloud/Tunnel/Telegram 长运行不超设定预算；失败可自救、无无限恢复循环 | event-loop p95/p99、state 大小基准、重启和故障恢复演练，资源清单 |

“全新面貌”由用户体验和一致行为组成，而不只是换皮：Native 入口和词汇简洁，通知/私聊各有独立状态，用户知道下一步；旧控制台和旧群能力不再出现在 UI、文档、包体。S0–S3 还未实施，因此即使不计真实账号验证，离公开仍有上述实质工作。

真实账号/真机暂不纳入本清单，但任何未经验证的具体平台能力不得宣传为已通过。若希望公开前不做这些试验，就把对应能力明确限制、标“实验性”或关闭；否则需要补实证后才可宣称完整支持。
