# 本地交付替代远端 dev

2026-10-31：用户明确允许暂不推送云端，以本地 Git 历史和本地推送代替。官方 GitHub 写入尝试返回 403，远端 dev 没有改动。

- 官方 main 基线 `9d69dd7a8908fcfec6e20d92d56509764a8f23ec`。
- 旧官方 dev `2eb91c9284484fac11ed5dc8652f95dd56f74a1d` 保存在本地 `backup/dev-before-rc5` 和 `/workspace/scratch/dsh-notifier-old-dev-backup.bundle`，已验证可克隆。
- 本地裸仓库 `/workspace/scratch/notifier-local-delivery.git`：先创建与 main 完全一致的 dev，再快进加入准备文档。
- 后续每阶段仍须 review、neat 和检查，提交后以普通快进方式推送到该本地仓库的 dev，并核对 SHA；不推送官方仓库，除非用户之后重新要求并解决权限。
- 本地替代不代表原计划中远端 dev 已重建；T00 远端推送项明确延期，不伪造成功。产品实现仍未开始。
