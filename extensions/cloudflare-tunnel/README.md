# dsh-notifier · 可选 Cloudflare Tunnel 扩展

把受保护的 Host 通知/控制入口通过 **Cloudflare Tunnel** 暴露到公网（手机访问）。本扩展默认
**停用**，且默认采用 **user-managed binary**（用户自行安装 cloudflared），不替用户下载执行。

> 这不是稳定 SSE 生产入口的「一键公开」。Quick Tunnel 是临时入口，不能当稳定入口用；未配置
> Access 保护前，本扩展不会把受信任的 Host 入口自动公开。

## 安全边界

- 只管理**自己 spawn 的 cloudflared 子进程**（自有 PID）；绝不按名字 kill 同名全局进程。
- 不删除 Origin、不改写 localhost、不关闭 Host 信任校验（配置里任何此类意图直接拒绝）。
- 连接凭据只允许来自合法凭据来源；stderr/stdout 经脱敏后才进入状态/报告，**零明文 secret**。
- 凭据校验：自下载路径要求**固定官方版本 + 平台资产 + 可核对 sha256**，验证通过才执行；当前
  user-managed 模式缺失 / 校验不符一律报到 `not-configured`，绝不下载执行。

## 安装引导（user-managed binary）

1. 从 Cloudflare 官方下载对应平台的 `cloudflared`（固定版本），并核对 sha256。
2. 创建命名隧道：`cloudflared tunnel create <name>`，得到 `credentials.json`。
3. 为隧道配置 **Access 保护**（Cloudflare Access 应用），拿到 applicationId。
4. 在本扩展配置里填写：隧道名、`credentialsSource`（凭据文件路径或合法 Host 凭据引用）、Access
   applicationId，并显式把 `enabled` 置为 `true`。
5. Quick Tunnel 仅供临时联调，本扩展会在配置里明确拒绝把它当作稳定入口。

## 生命周期

- `start()` 单飞行；启动有截止（默认 30s），超时只清理自有进程。
- 最多一个重连 timer，退避封顶（默认 30s）；`stop()` 后 epoch 递增，旧回调一律丢弃，不复活。
- `stop()` 先 SIGTERM，drain 截止（默认 5s）后 SIGKILL 强清自有进程。

## 运行门槛

无 cloudflared 二进制 / 无 CF 账户时，本地 Native 功能不受影响；本扩展 `status()` 如实返回
`not-configured`，管理代码可用假进程完成验收（R05）。