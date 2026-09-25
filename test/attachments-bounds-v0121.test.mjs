import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_INBOUND_ATTACHMENTS_PER_MESSAGE,
  MAX_INBOUND_ATTACHMENTS_TOTAL_BYTES,
  MAX_INBOUND_DOWNLOAD_CONCURRENCY,
  parseQqAttachments,
  downloadInboundFileBytes,
} from '../src/inbound/message.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('P2-02：单条消息附件数量与声明总量均有界', () => {
  const many = parseQqAttachments({
    attachments: Array.from({ length: MAX_INBOUND_ATTACHMENTS_PER_MESSAGE + 12 }, (_, index) => ({
      content_type: 'image/png',
      url: `https://example.com/${index}.png`,
      size: 1,
    })),
  })
  assert.equal(many.length, MAX_INBOUND_ATTACHMENTS_PER_MESSAGE)

  const large = parseQqAttachments({
    attachments: Array.from({ length: 20 }, (_, index) => ({
      content_type: 'application/octet-stream',
      url: `https://example.com/${index}.bin`,
      size: 2 * 1024 * 1024,
    })),
  })
  assert.ok(large.length * (2 * 1024 * 1024) <= MAX_INBOUND_ATTACHMENTS_TOTAL_BYTES)
})

test('P2-02：并发下载不超过全局预算', async () => {
  let active = 0
  let peak = 0
  const fetchImpl = async () => {
    active += 1
    peak = Math.max(peak, active)
    await delay(10)
    active -= 1
    return {
      ok: true,
      headers: { get: (name) => name === 'content-type' ? 'application/octet-stream' : '1' },
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          cancel: async () => {},
        }),
      },
    }
  }
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    downloadInboundFileBytes(`https://example.com/${index}.bin`, { fetchImpl, timeoutMs: 1000 })))
  assert.ok(results.every((result) => result !== null))
  assert.ok(peak <= MAX_INBOUND_DOWNLOAD_CONCURRENCY)
})
