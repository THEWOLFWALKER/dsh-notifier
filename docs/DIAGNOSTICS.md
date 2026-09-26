# dsh-notifier 定位与诊断指南

这份文档用于**问题已经过第一轮 AI 排障，但仍然无法解决**的情况。

目标不是收集“越多越好”的日志，而是产出一份维护者能直接复现和判断的 Support Report。

## 先做什么

先完成：

[TROUBLESHOOTING.md](TROUBLESHOOTING.md)

如果问题仍存在，让 AI 按下面顺序收集证据。

## 1. 环境身份

必须记录：

```text
OS:
Node:
DSH/Harness:
DSH profile:
dsh-notifier:
安装来源:
```

安装来源必须明确到：

```text
npm/registry
file:
Git
手工 node_modules
未知
```

不要只写“最新版”。

## 2. 问题范围

记录：

```text
渠道:
方向: outbound / inbound / native-ui / admin / control
能力: notify / approval / question / conversation / attachment / pairing / session
首次出现版本:
是否稳定复现:
```

## 3. 最小复现

只保留能触发问题的最短步骤，例如：

```text
1. 打开 Notify & Control
2. 进入 Telegram
3. 修改 chatId
4. 保存
5. 发送测试
```

不要写整段使用历史。

## 4. 预期与实际

必须分开：

```text
Expected:
Actual:
```

对于消息投递，还要区分：

```text
provider accepted?
confirmed receipt?
client actually displayed?
```

## 5. 安装/版本证据

可用命令示例：

```bash
node -v
npm ls dsh-notifier
pnpm why dsh-notifier
npm view dsh-notifier version
```

DSH CLI / profile 命令按当前环境可用能力执行。

如果无法从 cwd 直接看到实际包，不要猜；定位当前 profile 的实际 dependency tree。

## 6. Native UI 证据

如果问题是侧栏/页面：

记录：

```text
Plugins 是否能看到 dsh-notifier
Sidebar 是否有 Notify & Control
client.js 是否存在于实际安装包
浏览器/Host Client 是否有 slot/module error
页面是空白、报错还是旧版 UI
```

截图优先于一大段描述，但截图前检查有没有 Token / 私聊 / 用户信息。

## 7. 出站证据

记录：

```text
channel type
保存是否成功
测试 API 结果
provider status/code/message（脱敏）
是否 Hot Apply
下一条正式通知是否仍走旧配置
```

不要提交真实 Token、Webhook URL 中的 secret 或完整请求头。

## 8. 入站证据

记录：

```text
channel
configured?
active?
restartPending?
transport 状态
最近一次连接/断开错误
```

如果是 WebSocket/长轮询，记录“是否一直 TCP 存活但业务未 ready”这类状态，而不只写“连接不上”。

## 9. Identity / Pairing

记录：

```text
private/group
channel
accountId 是否存在
userId 是否存在
pair code 是否过期/已用
角色 owner/member
拒绝 reason/code
```

不要提交完整用户标识；Issue 中只保留必要的脱敏后缀/哈希。

## 10. Storage

如果涉及 state：

只报告：

```text
state file exists?
readable?
writable?
bootStatus?
disk full?
permission?
STATE_BUSY / STATE_CORRUPT / STATE_READ_FAILED / STATE_WRITE_FAILED?
```

**不要上传完整 `state.json`。**

如果必须说明某个 key 是否存在，只写 key 名和 value 类型/长度，不写 secret 内容。

## 11. Network

记录：

```text
DNS / proxy / TLS / timeout
目标域名（若本身不是 secret）
HTTP status
provider error code
redirect?
```

不要贴 Authorization header。

## 12. 日志截取

只截：

```text
问题发生前 20~50 行
问题发生后 20~50 行
```

先脱敏：

- token
- secret
- webhook key
- admin token
- bearer
- cookie
- chat content
- user id（非必要时）
- state 路径中的个人目录（如需）

## Support Report 模板

让 AI 最终输出：

```markdown
# dsh-notifier Support Report

## Environment
- OS:
- Node:
- DSH/Harness:
- Profile:
- dsh-notifier:
- Install source:

## Scope
- Channel:
- Direction:
- Capability:
- First known version:
- Reproducible: yes/no

## Expected
...

## Actual
...

## Minimal reproduction
1.
2.
3.

## Evidence
- Provider accepted:
- Confirmed receipt:
- Runtime state:
- Relevant error code:
- Sanitized log excerpt:

## Checks already completed
- [ ] actual package version verified
- [ ] install source checked
- [ ] correct profile confirmed
- [ ] DSH restarted after package upgrade
- [ ] file: / stale install checked
- [ ] relevant restartPending checked
- [ ] secrets redacted

## Local fixes attempted
...

## AI diagnosis
Most likely layer:
Evidence supporting it:
What remains uncertain:

## Attachments
- screenshots:
- sanitized logs:
```

## 上报前最后检查

如果报告里出现以下内容，先删：

```text
token
secret
Authorization:
Bearer
完整 webhook
完整 state.json
完整私聊
```

然后再提交到 GitHub Issue 或联系方式。
