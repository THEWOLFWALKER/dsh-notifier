> 最新分支/交付规则见[DELIVERY-POLICY.md](DELIVERY-POLICY.md)：以main重建dev；每阶段review和neat后推送dev。旧准备阶段不推送限制不适用于执行agent。

> **准备过程历史文档**：当前设计与执行以[00-START-HERE.md](00-START-HERE.md)、CONSTRAINTS.md、TASKS.csv为准；用户已允许真实DSH及本地测试，旧静态执行限制不再用于实施。

# 实施计划与静态基线

本计划只授权准备阶段已完成的文档工作；产品实现状态均为未开始。

## 顺序和受影响文件

| 批次 | 具体范围 | 主要文件/边界 | 完成依据 |
|---|---|---|---|
| B0 | rc.3→rc.5 契约差异收口、profile服务与依赖版本核验 | 官方固定tag的boot/base/headless/web、tools/agent/session、approval/questions、client/attachment；项目manifest/兼容矩阵/验证脚本 | 每个实际调用有rc.5出处；未闭合项显式列出，不能只改peer范围 |
| B1 | 修slash绕过；按动作统一身份、来源、权限；Native与Console管理契约 | inbound/conversation、control/*、control-surface/rpc/service、admin/* | 普通文本/命令/按钮/媒体均有明确准入；不因已认证就丢失主体；不过度宣称已存在非owner漏洞 |
| B2 | 配置与运行状态分离、撤销和投影一致 | runtime/outbound-source、channel-manager、adapters/qq-bot/wecom-app/desktop/serverchan、control-surface/outbound-config/channels | resolve/source/send合同一致；revoke不解析不参与结果的fallback；desired与active及restartPending一致 |
| B3 | 账号所有权与新版状态合同 | identity、pairing、target-guard、task-selection、routing、telegram cursor、login/channel-config | 权限/目标/游标/待选消息按账号归属；登录绑定与runtime账号一致；旧待决不转成新动作 |
| B4 | 停止准入、取消传播、在途工作和卸载次序 | lifecycle、bus、conversation、native-questions、approval/questions、各transport | stopping后无新业务；await后副作用前检查代际；宿主取消传到手机桥；drain与flush有边界 |
| B5 | 共享HTTP和渠道协议 | adapters/_shared/_engine、qq-bot、wxpusher、WPS定义、feishu/dingtalk/iLink | 正文读取有总期限；业务码/逐目标结果正确；不确定发送不盲重试；协议未知不伪装已支持 |
| B6 | 工具/UI/API结果与文档发布合同 | notify、tool-register、control-surface、client、README/guide/compatibility/exports/payload | configured/active/accepted/confirmed/skipped可区分；保留有效公共入口；不改视觉方向掩盖流程问题 |

每批：先列变更和失败条件 → 实现 → 对照审计做反向审查 → 修正 → 静态复核。若用户允许执行，再按变更运行有意义的focused tests与项目要求的全量检查；目前全部执行型检查均为 not-run。

## 合并后的根因清单

- AUTH：slash命令早于来源和Control Core判断返回；未知命令继续作为文本提交。群影响与权限影响同根因，不重复计数。
- STATE：不可变resolved与适配器运行缓存冲突；热更新不等于网络可用；revoke受无关YAML解析阻挡；投影丢失restartPending。
- ACCOUNT：owner/notifyTargets、bind/taskselect/dedup/cursor账号域不一致；Telegram旧offset复用；微信CLI配对缺真实accountId。标准装配每渠道单实例，不把双bot合成输入当默认生产事实。
- LIFE：bus.accept无disposed检查、轮询正常返回后缺stop复核、附件await后提交缺实例授权、request.signal未传手机桥、并行析构无业务drain屏障。
- PROTOCOL：QQ成功形状/数字code与幂等宣称、WxPusher目标类型和逐目标结果、WPS签名模式、正文读取期限、iLink空回包和ID语义。
- RESULT：工具ok不表示已受理；查询agents不表示控制能力；ACK不表示业务提交；HTTP准入不等于任意未来Peer已具管理权限。

## 旧数据处理合同

新格式必须有明确版本与账号归属。无归属旧权限、default身份、旧绑定、待选正文/附件、游标和待决卡片不自动导入；用户重新配置或配对。旧文件保持不动或进入只读备份流程；本阶段不做任何清理。

历史已决/不确定动作不重放；旧审批启动扫描不得驱动新Bot发送失效消息。可保留只读日志，但读取旧日志不能恢复授权或在新实例执行动作。不强求跨旧schema回滚，不影响新版自身的事务与失败收敛。

## rc.3→rc.5 准备观察

GitHub compare显示13个提交，涉及大量统一package版本号，以及UI reasoning block/tooltip、LLM诊断、MCP诊断等修改。此处仅为差异目录观察；不能用“核心文件似乎没改”替代直接检查目标源码和其外部依赖。

优先核验：新版客户端slot变化是否触及client.js；tools/agent/session事件、approval/questions取消；connection的owner假设；profile服务组成；包管理器解析与DSH预检分别处理。无需为rc.2/rc.3维护分支。

## 明确不能静态闭合的事实

rc.5真实激活、浏览器表现、提供方投递、卡片回调在线可达性、SDK所有关停时序均未验证。编码时可以消除本地不受保护的副作用路径，但不能因此宣称厂商或宿主运行验证完成。

QQ最新主动推送/域名公告、Feishu固定1.73.0回调能力、iLink第一方协议不足作为窄范围证据任务。没有证据时限制承诺，不为凑28/6数量伪造成功，也不自动删除整个渠道。

## 准备交付检查

- main源SHA与远端一致；分支从该SHA创建；产品树内容不变。
- 宿主tag SHA、npm版本/integrity及报告SHA256留档。
- 用户要求、技术默认与未决定事项分别记录。
- 当前不执行任何项目脚本/测试/构建；不推送/合并/发布。
- 下一次开工先读README.md与本计划，先完成B0，再逐批修改，禁止边开发边扩大宿主支持范围。
