// dsh-notifier inbound/callback-refs.mjs
// v0.6.2：TG callback_data 短引用注册表。
//
// 背景（2026-08-16 真机事故）：TG callback_data 硬限 64 字节，而
// `ap:<decision>:<approvalKey>:<token>` ≈ 131~165 字节（token 自身 ~109：
// b64url(payload) ~44 + '.' + HMAC hex 64）→ sendMessage 400 BUTTON_DATA_INVALID，
// 审批/动作按钮在真机全军覆没（mock fetch 不校验长度，单测测不出来）。
//
// 方案：按钮只带 `r:<8 字符随机 ref>`（10 字节恒定），完整 data 存本注册表，
// 点击时展开回既有解析（ap:/ac: 分支零改动）。不动 vault 密码学、不动审批账本。
// 单次核销（take 即删）+ TTL + 容量上限三重防泄；重启即清（token secret 默认进程
// 随机、TTL 10 分钟，重启失效本就是既有语义，不新增窗口）。
//
// v0.8.3 SEC-1：短引用条目额外携带来源会话元数据（最少 chatId），供按钮回调做
// 「点击所在会话 vs 卡片原始会话」比对（转发拒绝）。take() 保持旧语义只返回 data；
// 新增 peek() 非核销读取（读元数据判定后再消费，转发点击不会吃掉原卡 ref）。
//
// 军规：任何异常绝不抛出（按钮路径只 warn）；时间可注入（测试）。

import { randomInt } from 'node:crypto'

// Crockford base32 去歧义字符集（无 0/O/1/I/L/U）——适合口读、防看错
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const REF_LEN = 8 // 32^8 ≈ 1.1e12，按钮生命周期内碰撞概率可忽略（冲突再铸）
const DEFAULT_TTL_MS = 15 * 60 * 1000 // 略长于 vault 默认 10min：让「过期」语义由 token 判定
const DEFAULT_MAX = 256 // 每卡 2 ref → 128 张在途卡片，远超真实审批并发

/**
 * 创建短引用注册表。
 * @param {object} [options]
 * @param {number} [options.ttlMs=900000] - ref 有效期（默认 15 分钟）
 * @param {number} [options.max=256] - 容量上限（FIFO 淘汰最旧）
 * @param {() => number} [options.now] - 时钟注入（测试）
 */
export function createCallbackRefs({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = Date.now } = {}) {
  const ttl = Math.max(0, Number(ttlMs) || DEFAULT_TTL_MS)
  const cap = Math.max(1, Math.trunc(Number(max)) || DEFAULT_MAX)
  const refs = new Map() // ref → { data, expireAt }

  const sweep = () => {
    const t = now()
    for (const [ref, entry] of refs) {
      if (entry.expireAt <= t) refs.delete(ref)
      else break // Map 迭代序 = 插入序，过期项必然在前缀（TTL 相同）
    }
  }

  const randomRef = () => {
    let out = ''
    for (let i = 0; i < REF_LEN; i++) out += ALPHABET[randomInt(ALPHABET.length)]
    return out
  }

  return {
    /** 为完整 data 铸一枚短引用（过期项顺带清扫；容量满淘汰最旧）。origin 为可选的来源会话元数据（SEC-1）。 */
    mint(data, origin = null) {
      sweep()
      if (refs.size >= cap) {
        const oldest = refs.keys().next().value
        refs.delete(oldest)
      }
      let ref = randomRef()
      while (refs.has(ref)) ref = randomRef()
      refs.set(ref, {
        data: String(data),
        expireAt: now() + ttl,
        origin: (origin !== null && typeof origin === 'object') ? origin : null,
      })
      return ref
    },

    /**
     * 核销式取回：命中返回完整 data 并删除；未命中/过期返回 null（单次使用）。
     */
    take(ref) {
      const entry = refs.get(ref)
      if (entry === undefined) return null
      refs.delete(ref)
      if (now() > entry.expireAt) return null
      return entry.data
    },

    /**
     * 非核销式读取（SEC-1）：命中且未过期返回条目元信息，不删除条目。
     * 返回 { data, origin }；未命中/过期返回 null。按钮路径先 peek 判定来源
     * 再决定是否消费，转发点击不会吃原卡 ref。
     */
    peek(ref) {
      const entry = refs.get(ref)
      if (entry === undefined) return null
      if (now() > entry.expireAt) return null
      return { data: entry.data, origin: entry.origin ?? null }
    },

    /** 当前在册数（测试/诊断用）。 */
    get size() { return refs.size },
  }
}
