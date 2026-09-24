// dsh-notifier host/messages.mjs
// Host P0-A：外部 IM 输入 → DSH UserMessage V4 的宿主边界（提交4）。
// 依据（官方 deepseek-harness @ dsh-v0.1.7-rc.1 实际源码，非旧文档）：
//   - packages/llm/llm/src/message.ts::MessageSourceMap —— 注释明确
//     「there is no shared catch-all `plugin` kind」；producer 在各自模块声明自己的
//     `kind`，user 消息可携带任意 producer kind，consumer 对未知 kind fall through。
//     因此本插件淘汰 `kind:'plugin'`，改用自有 `kind:'dsh-notifier'`。
//   - packages/llm/llm/src/message.ts::ContextFormed —— form:'notice' 必带
//     summary:string；CONTEXT_SUMMARY_MAX_CHARS = 120。
//   - packages/llm/llm/src/types.ts::TextBlock/ImageBlock/FileBlock —— image 块为
//     { type:'image', attachment: ImageAttachmentRef }，image_url 已不在 V4 契约。
//   - packages/attachment/attachment/src/index.ts——AttachmentStore 注册为 cordis
//     Service 'attachments'（module augmentation 暴露 ctx.attachments）；saveImage
//     ({ data, mediaType, name? }) → Promise<ImageAttachmentRef>。
//   - packages/attachment/attachment/src/types.ts::ImageMediaType ——
//     'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'。
//
// 本模块只做三件事，不做 routing / Control Core / HTTP transport：
//   readAttachments / admitInboundImage / buildRemoteUserMessage。

import { randomUUID } from 'node:crypto'

const isRecord = (value) => typeof value === 'object' && value !== null

/** rc.1 ImageMediaType（DSH attachment/types.ts）。其余 image/* 一律 fail-closed。 */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** DSH message.ts::CONTEXT_SUMMARY_MAX_CHARS。notice summary 硬上界。 */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/**
 * 防御读取宿主 attachments 服务（cordis Service 'attachments'）。
 * 与 host/capability.mjs::readUserQuestions 同口径：优先非抛错 ctx.get(name, false)，
 * 无 get 的宿主/测试桩回落直读属性并吞掉代理抛错（按「无服务」处理）。
 * @returns {object|null} AttachmentStore，或 null（缺失/不可读）。
 */
export function readAttachments(ctx) {
  try {
    if (typeof ctx?.get === 'function') {
      const service = ctx.get('attachments', false)
      return service === undefined || service === null ? null : service
    }
  } catch { /* get 异常按无服务处理，不致命 */ }
  try {
    const service = ctx?.attachments
    return service === undefined || service === null ? null : service
  } catch { return null }
}

/**
 * 把已下载图片字节 admitted 为 durable ImageAttachmentRef（P0-A fail-closed）。
 * mediaType 不在 rc.1 ImageMediaType 白名单、attachments 缺失、saveImage reject，
 * 一律返回 null——绝不 fallback 回远程 URL 继续塞进 Session（红线 2.4）。
 * @param {object|null} attachments - readAttachments(ctx) 产物
 * @param {Uint8Array} bytes - 有界下载得到的实读字节
 * @param {string} mediaType - 调用方声明的媒体类型（如 content-type 归一）
 * @param {string} [name] - 可选展示名（去路径信息，交给 store 自行清洗）
 * @returns {Promise<object|null>} ImageAttachmentRef，或 null。
 */
export async function admitInboundImage(attachments, bytes, mediaType, name) {
  if (attachments === null || attachments === undefined) return null
  if (!(bytes instanceof Uint8Array) || !IMAGE_MEDIA_TYPES.includes(mediaType)) return null
  try {
    const ref = await attachments.saveImage({
      data: bytes,
      mediaType,
      ...(name === undefined || name === null || name === '' ? {} : { name }),
    })
    return isRecord(ref) && typeof ref.attachmentId === 'string' ? ref : null
  } catch { return null }
}

/**
 * 组装 DSH UserMessage V4（source.kind = 'dsh-notifier'，producer-owned）。
 * 图片走 durable image block（{ type:'image', attachment: ref }），不再产 image_url。
 * 纯图（text 为空）不夹带占位 text 块；summary 截断至 CONTEXT_SUMMARY_MAX_CHARS。
 * @param {{ text: string, imageRef?: object|null }} input
 * @returns {{ id: string, role: 'user', content: object[], source: object }}
 */
export function buildRemoteUserMessage({ text, imageRef = null }) {
  const realText = String(text ?? '')
  const hasImage = isRecord(imageRef)
  const content = []
  if (realText !== '') content.push({ type: 'text', text: realText })
  if (hasImage) content.push({ type: 'image', attachment: imageRef })
  const summary = realText !== '' ? realText : '(图片消息)'
  return {
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'dsh-notifier', form: 'notice', summary: summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS) },
  }
}