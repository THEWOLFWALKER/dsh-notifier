// dsh-notifier src/assembly/admin-token.mjs
// admin token 决策（从 src/index.mjs apply() 抽出，维护批 3 阶段 2）。
// token 策略（§0.5-6）：YAML 显式 token 以其为准（哈希同步 state）；否则首启生成
// base64url 随机串并打印一次——此后重启凭既有哈希校验（明文只在首启日志出现，不重发）。
// state 只存 SHA-256 哈希（admin:token-hash 键，64 位 hex），明文绝不落盘；
// verifyToken 先比长度再 timingSafeEqual（两串长度不等时它会抛）。
// 纯函数：唯一副作用是 store.set('admin:token-hash', ...) 与 generated 分支的两条 info。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { setDurable } from '../inbound/store.mjs'

const sha256HexOf = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')
const HEX_64 = /^[0-9a-f]{64}$/

/**
 * 解析 admin 生效 token：返回验证器与就绪日志要用的 tokenMode。
 * 零配置首访扩展：generated 分支额外返回 launchToken（本次进程内有效的明文 token），
 * 由 index.mjs 在 server 启动并取得真实端口后拼接 http://127.0.0.1:<port>/#token=<encoded>。
 * 显式 token 与复用旧哈希的路径不返回 launchToken（明文不落盘、不重发）。
 * @param {{ store: object, explicitToken: string, info: (msg: string) => void }} deps
 * @returns {{ activeHash: string, tokenMode: 'explicit'|'reused'|'generated',
 *   launchToken: string | null, verifyToken: (candidate: unknown) => boolean }}
 */
export function resolveAdminToken({ store, explicitToken, info }) {
  try {
    if (store?.bootStatus?.()?.readFailed === true) {
      const error = new Error('持久化状态读取失败，拒绝生成或覆盖 admin token')
      error.code = 'storage-failed'
      throw error
    }
  } catch (error) {
    if (error?.code === 'storage-failed') throw error
    // 不具备 bootStatus 的兼容 store 仍走原有读取路径；真正的 store 会提供该信号。
  }

  const persistHash = (hash) => {
    let durable = false
    try { durable = setDurable(store, 'admin:token-hash', hash) } catch (cause) {
      const error = new Error('admin token 哈希写入失败')
      error.code = 'storage-failed'
      error.cause = cause
      throw error
    }
    if (!durable) {
      const error = new Error('admin token 哈希未落盘，拒绝宣布 token 生效')
      error.code = 'storage-failed'
      throw error
    }
  }

  let storedHash = null
  try { storedHash = store.get('admin:token-hash') } catch { storedHash = null }
  const storedHashOk = typeof storedHash === 'string' && HEX_64.test(storedHash)

  let activeHash = '' // 生效哈希（verifyToken 比对基准；明文无需保留在内存外）
  let tokenMode = '' // 就绪日志明确 token 获取方式（explicit/reused/generated）
  let launchToken = null // 零配置首访：仅 generated 分支返回，供拼接 fragment 启动链接
  if (explicitToken !== '') {
    activeHash = sha256HexOf(explicitToken)
    if (storedHash !== activeHash) persistHash(activeHash) // 同步到 state，确认 durable 后才生效
    tokenMode = 'explicit'
  } else if (storedHashOk) {
    activeHash = storedHash // 沿用首启打印过的 token（校验靠哈希，不重发明文）
    tokenMode = 'reused'
  } else {
    // 首次生成（或既有哈希损坏视为无）：打印一次 + 落哈希。打印先于 server 启动——
    // 端口被占等启动失败时 token 已可知，重启成功后凭哈希继续有效。
    const generated = randomBytes(24).toString('base64url')
    activeHash = sha256HexOf(generated)
    persistHash(activeHash)
    info(`admin token（仅此一次打印，请妥善保存）: ${generated}`)
    info('忘记 token 时：删除 state.json 的 admin:token-hash 键（或在配置写 admin.token）后重启即重新生成')
    tokenMode = 'generated'
    launchToken = generated // 仅本次进程内有效；不落盘、不进日志、不进 API 响应
  }
  /** Bearer 校验：candidate 的 SHA-256 与生效哈希恒时比对；任何异常一律 false。 */
  const verifyToken = (candidate) => {
    try {
      if (typeof candidate !== 'string' || candidate === '') return false
      const candidateHash = sha256HexOf(candidate)
      if (candidateHash.length !== activeHash.length) return false
      return timingSafeEqual(Buffer.from(candidateHash, 'utf8'), Buffer.from(activeHash, 'utf8'))
    } catch {
      return false
    }
  }
  return { activeHash, tokenMode, launchToken, verifyToken }
}
