// dsh-notifier v0.15（T27）— 云端保存窄接口（store 只管「存放已生成的文件」）。
//
// 契约只有一个动作：把**已经生成好的 bytes** 存进去、取回来、删掉。
//
//   put(bytes, metadata) -> { ok, id, size, metadata, createdAt }
//   get(id)              -> { ok, bytes, metadata, size, createdAt }
//   delete(id)           -> { ok, deleted }
//
// 三条铁律：
//   1. **不透明（opaque）**：store 绝不解析 / 解码 / 校验 / 解释 bytes 的业务含义。它不知道什么是
//      配置文档、什么是导出 v1；未知格式既不 recognize 也不 reject，只是原样搬运（G01：unknown
//      格式不 interpret）。任何「这个 bytes 是不是合法配置」的判断都属于导出/加密层，不属于这里。
//   2. **无业务权限**：cloud adapter 不持有任何 state mutation 权限，不读 store、不写 store，也不
//      参与 desired/committed 语义。它失败不影响本地导出与下载（G01「fake adapter失败不影响本地导出」）。
//   3. **无生产实现**：本文件只提供 memory fake（round-trip 与 error fixture 用）与一个
//      「未装配 provider」的诚实占位。真实 R2 / 其他实现是**将来可替换的同一契约实现**，本轮不落地、
//      不要求用户有 CF 账户、不新增云按钮（06-INTEGRATIONS §云保存窄接口）。
//
// 未来决策（见 docs/control-plane-cloud-storage.md）：加密与密钥独立性属于导出层，不属于 store；
// 云 adapter 只负责字节的可达性与持久性。

export const CLOUD_STORE_SCHEMA = 'dsh-notifier-cloud-store/v1'
export const CLOUD_STORE_CONTRACT_VERSION = 1

/**
 * 尺寸/形状上限。这些是**本窄接口自己的**预算，绝不用于收紧旧 provider 的原有合法 payload 范围。
 * maxBytes 默认 8 MiB：导出 v1 文档上限 1 MiB（06 §配置文件v1），留足未来加密后的膨胀余量。
 */
export const CLOUD_STORE_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxIdLength: 128,
  maxMetadataKeys: 16,
  maxMetadataValueBytes: 1024,
})

/** 稳定失败码（调用方按码分支，不解析 message）。 */
export const CLOUD_STORE_REASONS = Object.freeze({
  'bad-bytes': 'bytes 必须是 Uint8Array（不接受字符串，避免隐式编码解释）',
  'too-large': '内容超过云端保存上限',
  'bad-metadata': 'metadata 必须是受限的平铺键值（string/number/boolean）',
  'bad-id': '对象 id 非法',
  'not-found': '对象不存在或已被删除',
  'storage-failed': '云端存储操作失败',
  cancelled: '操作已取消',
  'not-configured': '未配置云端存储 provider',
})

const fail = (code) => ({ ok: false, code })

/**
 * 只接受 Uint8Array（Buffer 是其子类，同样接受）。字符串刻意拒绝：把字符串编码成 bytes 是一个
 * 「解释」决定，属于调用方（导出层），不属于不透明的 store。
 * @param {unknown} input
 * @returns {Uint8Array | null}
 */
function asOpaqueBytes(input) {
  return input instanceof Uint8Array ? input : null
}

/** metadata：平铺、受限、只含 primitive。任何嵌套/函数/symbol 一律拒绝。 */
function normalizeMetadata(input) {
  if (input === undefined || input === null) return { ok: true, value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return fail('bad-metadata')
  const entries = Object.entries(input)
  if (entries.length > CLOUD_STORE_LIMITS.maxMetadataKeys) return fail('bad-metadata')
  const value = {}
  for (const [key, item] of entries) {
    if (typeof key !== 'string' || key === '') return fail('bad-metadata')
    const type = typeof item
    if (type === 'string') {
      if (byteLengthOf(item) > CLOUD_STORE_LIMITS.maxMetadataValueBytes) return fail('bad-metadata')
      value[key] = item
    } else if (type === 'number') {
      if (!Number.isFinite(item)) return fail('bad-metadata')
      value[key] = item
    } else if (type === 'boolean') {
      value[key] = item
    } else {
      return fail('bad-metadata')
    }
  }
  return { ok: true, value }
}

function byteLengthOf(text) {
  try { return Buffer.byteLength(String(text), 'utf8') } catch { return Infinity }
}

function isCancelled(signal) {
  return signal !== undefined && signal !== null && signal.aborted === true
}

/**
 * 内存 fake：唯一的内置实现。用于 round-trip 与错误注入 fixture。
 *
 * @param {object} [options]
 * @param {() => Date} [options.now] - 可注入时钟（决定 createdAt）
 * @param {() => number} [options.random] - 可注入随机源（决定 id 后缀）
 * @param {(callIndex:number)=>(string|null)} [options.failPut] - 第 N 次 put 注入失败码（测试用）
 * @param {(callIndex:number)=>(string|null)} [options.failGet]
 * @param {(callIndex:number)=>(string|null)} [options.failDelete]
 * @param {number} [options.maxBytes]
 */
export function createMemoryCloudStore({
  now = () => new Date(),
  random = () => Math.random(),
  failPut = null,
  failGet = null,
  failDelete = null,
  maxBytes = CLOUD_STORE_LIMITS.maxBytes,
} = {}) {
  const records = new Map()
  const limits = { maxBytes: Math.max(1, Math.trunc(Number(maxBytes)) || CLOUD_STORE_LIMITS.maxBytes) }
  const counters = { put: 0, get: 0, delete: 0 }
  let seq = 0

  const isoNow = () => {
    try { return now().toISOString() } catch { return new Date().toISOString() }
  }
  const newId = () => {
    seq += 1
    let salt = ''
    try { salt = Math.floor(Math.abs(Number(random())) * 1e9).toString(36) } catch { salt = '' }
    return `cs_${seq.toString(36)}_${salt}`
  }
  const injected = (hook, index) => {
    if (typeof hook !== 'function') return null
    try { return hook(index) || null } catch { return null }
  }

  function put(bytes, metadata, { signal } = {}) {
    counters.put += 1
    if (isCancelled(signal)) return fail('cancelled')
    const forced = injected(failPut, counters.put)
    if (forced !== null) return fail(forced)
    const data = asOpaqueBytes(bytes)
    if (data === null) return fail('bad-bytes')
    if (data.byteLength > limits.maxBytes) return fail('too-large')
    const meta = normalizeMetadata(metadata)
    if (meta.ok !== true) return meta
    const id = newId()
    const createdAt = isoNow()
    records.set(id, {
      id,
      // copy-on-write：调用方之后改动自己的 buffer 绝不影响已存对象
      bytes: Uint8Array.from(data),
      metadata: { ...meta.value },
      size: data.byteLength,
      createdAt,
    })
    return { ok: true, id, size: data.byteLength, metadata: { ...meta.value }, createdAt }
  }

  function get(id, { signal } = {}) {
    counters.get += 1
    if (isCancelled(signal)) return fail('cancelled')
    const forced = injected(failGet, counters.get)
    if (forced !== null) return fail(forced)
    const key = String(id ?? '')
    if (key === '' || key.length > CLOUD_STORE_LIMITS.maxIdLength) return fail('bad-id')
    const record = records.get(key)
    if (record === undefined) return fail('not-found')
    return {
      ok: true,
      id: record.id,
      bytes: Uint8Array.from(record.bytes),
      metadata: { ...record.metadata },
      size: record.size,
      createdAt: record.createdAt,
    }
  }

  function remove(id, { signal } = {}) {
    counters.delete += 1
    if (isCancelled(signal)) return fail('cancelled')
    const forced = injected(failDelete, counters.delete)
    if (forced !== null) return fail(forced)
    const key = String(id ?? '')
    if (key === '' || key.length > CLOUD_STORE_LIMITS.maxIdLength) return fail('bad-id')
    const deleted = records.delete(key)
    return { ok: true, deleted }
  }

  return {
    schema: CLOUD_STORE_SCHEMA,
    kind: 'memory',
    capabilities: () => ({ available: true, kind: 'memory', maxBytes: limits.maxBytes, version: CLOUD_STORE_CONTRACT_VERSION }),
    put,
    get,
    delete: remove,
    /** 只读计数（测试观察），不参与业务语义。 */
    stats: () => ({ ...counters, stored: records.size }),
  }
}

/**
 * 「未装配云端 provider」的诚实占位：任何操作都返回 not-configured，且 capabilities().available=false。
 * 用于证明「无 cloud binding 也安装运行」——调用方据此隐藏云入口，而不是假装成功（G01）。
 */
export function createUnavailableCloudStore(reason = 'no-provider') {
  const unavailable = () => fail('not-configured')
  return {
    schema: CLOUD_STORE_SCHEMA,
    kind: 'unavailable',
    capabilities: () => ({ available: false, kind: 'unavailable', reason: String(reason) }),
    put: unavailable,
    get: unavailable,
    delete: unavailable,
  }
}