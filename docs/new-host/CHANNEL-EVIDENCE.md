# 渠道证据台账（实施前）

当前表格状态均为planned，不能把报告中的内部逻辑自洽写成provider已验证。实施者逐行补充规范固定来源、实现任务、fixture检查、宿主旅程关联、限制。provider-live全部为out-of-scope。

| 出站type | source/local-contract | provider-live |
|---|---|---|
| bark | planned | out-of-scope |
| bell | planned；本地终端行为单列 | n/a |
| chanify | planned | out-of-scope |
| desktop | planned；本机OS与跨平台构造分开 | n/a；设备展示未验证 |
| dingtalk | planned | out-of-scope |
| discord | planned | out-of-scope |
| feishu | planned | out-of-scope |
| gchat | planned | out-of-scope |
| gotify | planned | out-of-scope |
| igot | planned | out-of-scope |
| mattermost | planned | out-of-scope |
| ntfy | planned | out-of-scope |
| onebot | planned | out-of-scope |
| pushdeer | planned | out-of-scope |
| pushover | planned | out-of-scope |
| pushplus | planned | out-of-scope |
| qmsg | planned | out-of-scope |
| qq-bot | planned；主动与被动分开 | out-of-scope |
| serverchan | planned | out-of-scope |
| slack | planned | out-of-scope |
| teams | planned；Workflow受理与实际发布分开 | out-of-scope |
| telegram | planned | out-of-scope |
| webhook | planned；本地receiver可真实HTTP检查 | endpoint自身语义 |
| wecom | planned | out-of-scope |
| wecom-app | planned | out-of-scope |
| wps-bot | planned；签名模式分开 | out-of-scope |
| wxpusher | planned | out-of-scope |
| xizhi | planned | out-of-scope |

| 入站 | source/local-contract/host | provider-live |
|---|---|---|
| telegram | planned | out-of-scope |
| feishu | planned；SDK消息与按钮分开 | out-of-scope |
| qq | planned | out-of-scope |
| wxpusher | planned；无稳定事件ID限制 | out-of-scope |
| wechat | planned；正式type名称按registry核对 | out-of-scope |
| dingtalk | planned | out-of-scope |
