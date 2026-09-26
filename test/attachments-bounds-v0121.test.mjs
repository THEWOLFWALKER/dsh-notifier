import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_INBOUND_ATTACHMENTS_PER_MESSAGE,
  MAX_INBOUND_ATTACHMENTS_TOTAL_BYTES,
  MAX_INBOUND_DOWNLOAD_CONCURRENCY,
  MAX_INBOUND_DOWNLOAD_QUEUE,
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

test('C10：附件下载排队最多 32，获取槽位超时后失败关闭', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetchImpl = async () => {
    await gate
    return new Response(new Uint8Array([1]), { headers: { 'content-type': 'application/octet-stream' } })
  }
  const active = Array.from({ length: MAX_INBOUND_DOWNLOAD_CONCURRENCY }, (_, index) =>
    downloadInboundFileBytes(`https://queue.example.test/active-${index}`, { fetchImpl }))
  await delay(5)
  const queued = Array.from({ length: MAX_INBOUND_DOWNLOAD_QUEUE }, (_, index) =>
    downloadInboundFileBytes(`https://queue.example.test/queued-${index}`, { fetchImpl }))
  const overflow = await downloadInboundFileBytes('https://queue.example.test/overflow', { fetchImpl })
  assert.equal(overflow, null, '队列满后必须立即拒绝')
  const timedOut = await downloadInboundFileBytes('https://queue.example.test/timeout', {
    fetchImpl, acquireTimeoutMs: 5,
  })
  assert.equal(timedOut, null, '等待槽位超过预算必须失败关闭')
  release()
  const completed = await Promise.all([...active, ...queued])
  assert.ok(completed.every((entry) => entry !== null))
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
