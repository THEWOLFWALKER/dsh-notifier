import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.PORT ?? 9999)
const OUT = process.env.OUT ?? '/tmp/dsh-notifier-webhook-received.jsonl'

const server = createServer((req, res) => {
  let data = ''
  req.on('data', (chunk) => {
    data += chunk
    if (data.length > 512 * 1024) req.destroy()
  })
  req.on('end', () => {
    const record = { at: Date.now(), method: req.method, url: req.url, body: data }
    try {
      appendFileSync(OUT, JSON.stringify(record) + '\n')
    } catch { /* ignore */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, received: true }))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`hook server listening on http://127.0.0.1:${PORT} -> ${OUT}`)
})
