# 持续有效的决定

- 主项目是 `dsh-notifier`；`dsh-im` 只作竞品与真实上游 checked contract 参考。
- 产品仅支持私聊，Native 是日常唯一入口。旧 Advanced Console 实现整套删除；如仍需诊断，重新审定最小只读 Recovery 入口。
- 通知与私聊分别显式授权；凭证存在不构成私聊授权。关闭私聊要当前进程立即撤权，重启不得回开。
- Canonical principal 是 `(channel, accountId, userId)`；来源不明不得借用 default 或其他账号权限。
- 现存旧状态只在安全且简单时一次转换；否则备份后要求重设。新设计不为旧版本保持双轨兼容。
- 保留 proven provider 协议资产和安全不变量；不做 Big Bang rewrite，也不以 Store 全面 async 化为目标。
- 结果证据必须区分 confirmed、accepted、unknown、failed；未知外部效果不得盲目重试。无真实外部证据记 unknown。
- 执行阶段和所有已拍板接口、状态机、测试及 UX 决策见 [rebuild taskpack](../rebuild-v015/README.md)。
- 只操作/推送 `dev`，禁止 force push、main、tag、GitHub Release、npm publish；提交身份按仓库 THEWOLFWALKER 邮箱。
