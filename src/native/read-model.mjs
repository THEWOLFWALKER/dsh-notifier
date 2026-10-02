// dsh-notifier v0.15 Stage 1 — Native 用户读模型（唯一只读入口）。
//
// 职责（03_ARCHITECTURE_REWRITE_PLAN）：
//  - 只生成**用户能理解**的只读数据；
//  - 不返回底层 row、内部状态名、凭据、session/binding 对象；
//  - 所有列表都有**显式上限**与截断语义（绝不无界返回，也绝不静默丢数据）。
//
// 组合 channel-view 与 private-chat-view 两个纯投影，加上长轮询游标与存储可写性，
// 形成 Native 页面一次拉取所需的全部数据。本模块不写 store、不调 provider。
//
// 游标（cursor）：不透明字符串 `<实例令牌>.<序号>`。客户端只做「原样回传」，因此既不需要
// 理解世代（epoch）或修订号（revision），也不会因宿主重启后序号回退而卡住——实例令牌变了
// 就立即视为「有更新」。

import { createHash } from 'node:crypto'
import { isStorageUntrusted } from '../inbound/store.mjs'
import { createChannelView } from './channel-view.mjs'
import { createPrivateChatView } from './private-chat-view.mjs'
import { pick } from './vocabulary.mjs'

/** 显式上限：左侧渠道栏、添加渠道选择器、待处理列表。 */
export const RAIL_CAP = 12
export const CHANNEL_CAP = 40
export const PENDING_CAP = 20

const STORAGE_TEXT = Object.freeze({
  ok: Object.freeze({ en: 'Changes are saved', zh: '设置会保存' }),
  readonly: Object.freeze({ en: "Can't save right now", zh: '暂时无法保存' }),
})

/**
 * @param {object} deps
 * @param {{ list: () => object[], get: (type: string) => object|null }} deps.channels - 渠道投影
 * @param {{ list: () => object[], listPending: () => object[] }} [deps.members]
 * @param {{ list: () => object[] }} [deps.questions]
 * @param {{ list: () => object[] }} [deps.tasks]
 * @param {(owner: object) => string|null} [deps.selectedTaskRef] - 显式选择的当前任务读投影
 *   （current-task authority）。R1：当前任务只能来自显式选择，绝不从投影推导默认。
 * @param {{ current: () => object, wait: (options: object) => Promise<object> }} deps.revision
 * @param {() => object} [deps.storageStatus]
 */
export function createNativeReadModel({
  channels = null,
  members = null,
  questions = null,
  tasks = null,
  selectedTaskRef = null,
  revision = null,
  storageStatus = null,
} = {}) {
  const channelView = createChannelView({ channels, members })
  const privateChatView = createPrivateChatView({
    members,
    questions,
    tasks,
    selectedTaskRef,
    isEnabled: () => {
      try {
        const rows = typeof channels?.list === 'function' ? channels.list() : []
        return (Array.isArray(rows) ? rows : []).some((row) => row?.control?.configured === true)
      } catch { return false }
    },
  })

  // 实例令牌：宿主重启/重建后 revision 会回到 1，令牌随之改变，客户端立刻看到「有更新」。
  const instanceToken = (() => {
    const epoch = typeof revision?.current === 'function' ? String(revision.current()?.epoch ?? '') : ''
    return createHash('sha256').update(epoch === '' ? 'no-revision' : epoch).digest('hex').slice(0, 8)
  })()

  const requireChannels = () => {
    if (channels === null || typeof channels.list !== 'function') {
      // fail-closed：能力缺失绝不返回 `ok:true` 的空表（否则会被当成「暂无渠道」）。
      throw Object.assign(new Error('渠道数据当前不可用'), { code: 'not-supported' })
    }
  }

  const cursorNow = () => {
    const current = typeof revision?.current === 'function' ? revision.current() : { revision: 0 }
    return `${instanceToken}.${Number(current?.revision) || 0}`
  }

  const parseCursor = (cursor) => {
    const text = String(cursor ?? '')
    const dot = text.lastIndexOf('.')
    if (dot <= 0) return { token: null, revision: 0 }
    return { token: text.slice(0, dot), revision: Number(text.slice(dot + 1)) || 0 }
  }

  const storageView = (lang) => {
    let status = {}
    try { status = typeof storageStatus === 'function' ? storageStatus() : (storageStatus ?? {}) } catch { status = {} }
    const readonly = isStorageUntrusted(status)
    return { canSave: !readonly, text: pick(readonly ? STORAGE_TEXT.readonly : STORAGE_TEXT.ok, lang) }
  }

  return {
    /** 只读能力标志（供 RPC 层 fail-closed 判定；用用户无关的能力名，不泄漏内部概念）。 */
    capabilities() {
      return {
        channels: channels !== null && typeof channels.list === 'function',
        liveUpdates: revision !== null && typeof revision.wait === 'function',
      }
    },

    /**
     * 一次拉取：左侧渠道栏 + 全部渠道 + 私聊摘要 + 待处理 + 游标。
     * 列表全部带上限，并显式告知是否被截断（绝不静默丢数据）。
     */
    snapshot({ lang = 'zh' } = {}) {
      requireChannels()
      const all = channelView.list(lang)
      const rail = all.filter((row) => row.state !== 'not-set')
      const pending = privateChatView.pendingItems(lang)
      return {
        cursor: cursorNow(),
        rail: rail.slice(0, RAIL_CAP),
        channels: all.slice(0, CHANNEL_CAP),
        privateChat: privateChatView.summary(lang),
        pending: pending.slice(0, PENDING_CAP),
        storage: storageView(lang),
        truncated: {
          rail: rail.length > RAIL_CAP,
          channels: all.length > CHANNEL_CAP,
          pending: pending.length > PENDING_CAP,
        },
      }
    },

    /** 单渠道详情（账号卡 + 设置字段 + 测试入口）。未知渠道返回 null。 */
    channel(type, { lang = 'zh' } = {}) {
      requireChannels()
      return channelView.detail(type, lang)
    },

    privateChat({ lang = 'zh' } = {}) {
      return privateChatView.summary(lang)
    },

    pending({ lang = 'zh' } = {}) {
      return privateChatView.pendingItems(lang).slice(0, PENDING_CAP)
    },

    /** 不透明 id → 真实成员键；只给服务端 actions 用，绝不进入对外载荷。 */
    memberKeyOf: (id) => privateChatView.memberKeyOf(id),

    /** 长轮询：客户端原样回传游标。实例令牌变化即视为有更新（宿主重启不卡住客户端）。 */
    async wait({ cursor, timeoutMs, signal } = {}) {
      const parsed = parseCursor(cursor)
      if (parsed.token !== null && parsed.token !== instanceToken) {
        return { cursor: cursorNow(), changed: true }
      }
      if (revision === null || typeof revision.wait !== 'function') {
        return { cursor: cursorNow(), changed: false }
      }
      const value = await revision.wait({ after: parsed.revision, timeoutMs, signal })
      const next = Number(value?.revision) || 0
      return { cursor: `${instanceToken}.${next}`, changed: next > parsed.revision }
    },
  }
}
