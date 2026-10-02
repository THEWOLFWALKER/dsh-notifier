# 账本口径

共546条来源记录：F系列251、C-DSH系列61、S系列110、M系列124。存在大量重复，不是546个独立bug。每个原始编号均保留。related是相关来源提示，不等于已证明完全重复。

work_package为主归属；涉及其它模块按依赖一起验收。decision是设计处理方向，status目前全部planned，evidence为空，不表示修复完成。下一位需完成第二遍语义核对，尤其跨报告映射。

只有证据足够才能结案：fixed需commit和测试；removed需无业务可达路径及迁移；verified-existing需当前代码依据；scope-decision需本包范围裁决；external-evidence-gap需明确安全默认与公开能力限制。禁止将未解决的已知安全缺陷仅标实验就关闭。
