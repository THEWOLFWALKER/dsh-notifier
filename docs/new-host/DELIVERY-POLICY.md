# dev重建与每阶段交付门槛（最新用户要求）

本文件覆盖本包旧准备说明中“永不推送dev/排除dev分支”的表述：**排除的是旧dev的代码与重写成果，不是dev这个分支名。** 用户已授权执行agent用当前main重建dev，并在每阶段review和neat后推送dev。main/tag/Release/npm发布仍未授权。准备agent此次只更新任务包，不执行远端写入。

## T00：先重建dev，再开始产品改动

1. 核对官方仓库URL、当前工作区和未提交文件，不reset/clean用户工作区。fetch官方main/dev，记录两个精确SHA。任务包已审main为9d69dd7a8908fcfec6e20d92d56509764a8f23ec。
2. 在覆盖前保存旧origin/dev的本地恢复引用和可独立恢复的git bundle到任务外的安全路径，验证bundle能读取/克隆；记录SHA/路径/哈希。不把旧源码merge/cherry-pick进新实现，不上传未经检查的旧秘密。
3. 若官方main仍是固定基线，直接使用该commit。若main已经前进，先对增量做静态差异审查并更新基线/证据映射，再以执行时已记录的当前main继续；不能静默覆盖新main或使用过时快照冒充当前main。宿主目标仍固定rc.5。
4. 验证将推送的commit就是选定main，工作树没有混入旧dev或未审产品修改。该操作仅重建refs/heads/dev，绝不写main。
5. dev与main无共同祖先/非快进时，仅允许一次**精确lease**更新：`git push --force-with-lease=refs/heads/dev:<已记录旧devSHA> origin <已记录mainSHA>:refs/heads/dev`。此权限仅用于用户明确要求的初始重建，不是后续随意force授权。dev不存在时用普通创建推送。
6. lease失败说明他人已更新dev：保留现场，重新fetch审查，不自动重试、不改为--force。远端保护拒绝时不得绕过；记录原因，继续可独立完成的本地工作。
7. 读回远端dev精确SHA并确认等于选定main。然后把本任务包的准备文档提交带入以新dev为基础的工作分支，并普通快进推送文档。若main变更导致准备文档冲突，按最新用户要求和新设计逐项解决，不恢复旧dev。
8. 证据包含旧dev恢复位置、main/dev的before/after SHA、命令结果和无产品改动核对。不得把T00写成已完成，直到读回验证通过。

## 每阶段强制循环

实现 → focused验证 → **review** → 修正 → 重验 → **neat** → 文档一致性检查 → 本地提交 → 普通快进push dev → 读回SHA → 更新阶段交接。

- review检查授权/账号/取消/副作用/事务/协议/兼容/打包，不只是格式。能使用独立审查agent时可委派，否则进行明确的第二遍反向审查。记录发现、修复、残留与理由，不能只有“review done”。
- neat必须完整阅读并执行`.agents/skills/neat-freak/SKILL.md`，同步所有受影响的AGENTS、当前HANDOFF/memory、README/guide、architecture/contracts、兼容矩阵、CHANGELOG、types/API、TASKS/STATUS与证据。只同步该阶段真正变更，不抄聊天、不机械追加历史。
- 不允许源码已改而测试/文档/投影仍是旧语义。每阶段做一次适当的全量检查；无改动时不无意义重复耗时验证。新失败不得用skip、减少断言或虚构证据清零。
- 按CSV phase分组交付；跨phase任务依赖未满足时不可提前标完成，阶段不得以“有个提交”代替验收。
- 每阶段证据增加reviewFindings、reviewResolution、neatFiles、checks、commit、remoteDevSha字段。commit/hash采用实际值，避免在提交内自指未来SHA；可由下一条交接记录引用已完成提交。
- 后续push只允许dev普通快进；无权覆盖他人工作。失败记录并继续本地独立工作，不擅自合并main、不发版。

## 最终交付

全部阶段通过后，dev包含完整已审实现和同步文档。提供完整源码ZIP、执行入口、版本基线、测试/真实DSH与browser结果、28/6证据分级、提交与远端SHA、环境限制。真实账号验证不在任务内。ZIP不得包含node_modules、凭据、状态、私聊、原始日志；发布npm包检查仍必须排除协作工具配置。
