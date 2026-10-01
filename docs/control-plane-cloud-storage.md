# 云端保存窄接口（预留契约，v0.15 T27）

> 状态：**契约 + memory fake 已落地；无任何生产云实现**。本轮不提供 R2 / D1 / KV 适配器，不要求
> Cloudflare 账户，Native 里**没有云按钮**。这里定义的是将来接入云端存储时必须遵守的窄接口，
> 以及加密与密钥独立性的既定决策。

## 1. 这个接口解决什么

只解决一件事：**把一个已经生成好的文件（bytes）安全地放进去、取回来、删掉**。
它不理解这个文件是什么——不是配置文档，也不是导出快照，只是字节。

- 不做账号、不做同步冲突解决、不做版本合并；
- 不读插件 state、不写插件 state，**不持有任何 state mutation 权限**；
- 失败时本地导出与下载**完全不受影响**。

## 2. 契约

实现位于 `src/control-plane/cloud-store.mjs`，schema 固定 `dsh-notifier-cloud-store/v1`。

```text
put(bytes, metadata) -> { ok:true, id, size, metadata, createdAt }
                      | { ok:false, code }
get(id)              -> { ok:true, id, bytes, metadata, size, createdAt }
                      | { ok:false, code }
delete(id)           -> { ok:true, deleted:boolean } | { ok:false, code }
capabilities()       -> { available:boolean, kind, reason? }
```

稳定失败码：`bad-bytes` / `too-large` / `bad-metadata` / `bad-id` / `not-found` /
`storage-failed` / `cancelled` / `not-configured`。调用方按 `code` 分支，不解析 message。

### 不变量

| 不变量 | 含义 |
|---|---|
| 不透明 | store 绝不 parse / decode / validate / interpret bytes 的业务含义。未知格式既不 recognize 也不 reject，原样搬运 |
| 只收 Uint8Array | 字符串刻意拒绝：把字符串编码成 bytes 是调用方的「解释」决定，不是不透明 store 的职责 |
| 拷贝语义 | 写入与读取都复制，调用方之后的 mutation 绝不影响已存对象，返回值也改不动内部状态 |
| metadata 平铺受限 | 只含 `string` / `number` / `boolean`，键数 ≤ 16，单值 ≤ 1024 字节；嵌套/函数/symbol 一律拒绝 |
| 有界 | `maxBytes` 默认 8 MiB（导出 v1 文档上限 1 MiB，留足未来加密膨胀余量） |
| 可取消 | 传入已 abort 的 `AbortSignal` 返回 `cancelled`，且**零写入** |

这些上限是**本窄接口自己的**预算，**绝不**用于收紧旧 provider 原有的合法 payload 范围。

## 3. 内置实现

| 实现 | 用途 | 说明 |
|---|---|---|
| `createMemoryCloudStore()` | round-trip 与错误注入 fixture | 内存、确定性（可注入 `now` / `random` / `failPut` / `failGet` / `failDelete`）；**不是生产存储** |
| `createUnavailableCloudStore(reason)` | 「未装配 provider」的诚实占位 | 所有操作返回 `not-configured`，`capabilities().available === false` |

调用方以 `capabilities().available` 决定是否显示云入口。**绝不假装成功**（G01：无 cloud binding 也
安装运行；缺 provider 时明确 `not-configured`，而不是把失败写成「已保存」）。

## 4. 验收（G01）

| 反例 | 结论 | 覆盖 |
|---|---|---|
| fake cloud storage 失败 | 本地导出正常，云端 `storage-failed`，零存储 | `test/v015-stage-s18-cloud-store.test.mjs` |
| 未知 bytes | 原样搬运，store 无 parse/interpret 面 | 同上 |
| 无 cloud binding | 插件正常运行；占位实现诚实 `not-configured` | 同上 |
| 导出 v1 round-trip | 存进去取回来与原文逐字节一致 | 同上 |

运行：`node --test test/v015-stage-s18-cloud-store.test.mjs`

## 5. 未来决策（本轮只记录，不实现）

1. **职责边界**：云 adapter 只负责字节的可达性与持久性；**加密是导出层的职责**。导出层产出 bytes，
   加密（若启用）也发生在导出层，`put` 收到的始终是最终字节。
2. **密钥独立**：加密密钥与云存储账户**互相独立**——换云 provider 不需要重新加密，换密钥也不需要
   换 provider。密钥不进入 `metadata`，也不由云 adapter 保管。
3. **真实适配器（R2 等）**：是同一契约的可替换实现，只替换 `createMemoryCloudStore`，不新增业务
   authority，不获得 state mutation 权限。
4. **绝不悄悄增密**：加密全量备份是**另一个独立格式**，不会悄悄给导出 v1 增加 secret 字段。
   普通配置导出永久**不是**灾难恢复快照。
5. **触发条件**：只有当真实 provider 落地并且 UI 有明确入口时，才在 Native 里增加云保存入口；
   在此之前保持无按钮、无账户、无同步。