// dsh-notifier src/assembly/admin-token.mjs
// admin token 决策（从 src/index.mjs apply() 抽出，维护批 3 阶段 2）。
// token 策略（§0.5-6）：YAML 显式 token 以其为准（哈希同步 state）；否则首启生成
// base64url 随机串并打印一次——此后重启凭既有哈希校验（明文只在首启日志出现，不重发）。
// state 只存 SHA-256 哈希（admin:token-hash 键，64 位 hex），明文绝不落盘；
// verifyToken 先比长度再 timingSafeEqual（两串长度不等时它会抛）。
// 纯函数：唯一副作用是 store.set('admin:token-hash', ...) 与 generated 分支的两条 info。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const sha256HexOf = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')
const HEX_64 = /^[0-9a-f]{64}$/

/**
 * 解析 admin 生效 token：返回验证器与就绪日志要用的 tokenMode。
 * @param {{ store: object, explicitToken: string, info: (msg: string) => void }} deps
 * @returns {{ activeHash: string, tokenMode: 'explicit'|'reused'|'generated', verifyToken: (candidate: unknown) => boolean }}
 */
export function resolveAdminToken({ store, explicitToken, info }) {
  let storedHash = null
  try { storedHash = store.get('admin:token-hash') } catch { storedHash = null }
  const storedHashOk = typeof storedHash === 'string' && HEX_64.test(storedHash)

  let activeHash = '' // 生效哈希（verifyToken 比对基准；明文无需保留在内存外）
  let tokenMode = '' // 就绪日志明确 token 获取方式（explicit/reused/generated）
  if (explicitToken !== '') {
    activeHash = sha256HexOf(explicitToken)
    if (storedHash !== activeHash) store.set('admin:token-hash', activeHash) // 同步到 state
    tokenMode = 'explicit'
  } else if (storedHashOk) {
    activeHash = storedHash // 沿用首启打印过的 token（校验靠哈希，不重发明文）
    tokenMode = 'reused'
  } else {
    // 首次生成（或既有哈希损坏视为无）：打印一次 + 落哈希。打印先于 server 启动——
    // 端口被占等启动失败时 token 已可知，重启成功后凭哈希继续有效。
    const generated = randomBytes(24).toString('base64url')
    activeHash = sha256HexOf(generated)
    store.set('admin:token-hash', activeHash)
    info(`admin token（仅此一次打印，请妥善保存）: ${generated}`)
    info('忘记 token 时：删除 state.json 的 admin:token-hash 键（或在配置写 admin.token）后重启即重新生成')
    tokenMode = 'generated'
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
  return { activeHash, tokenMode, verifyToken }
}