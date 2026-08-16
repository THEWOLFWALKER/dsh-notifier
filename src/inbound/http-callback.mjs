// dsh-notifier inbound/http-callback.mjs
// 最小 HTTP 回调服务器（v0.3.0 阶段 3，WxPusher 用；飞书/QQ webhook 降级可复用）。
// 设计约束（照实现计划 §5.3）：
//  - 仅接受 POST + 精确匹配 webhookPath（密径即凭证，其余路径一律 404）
//  - body 上限 64KB（防滥用拖垮宿主）；超限 413
//  - JSON 解析失败 400；正常载荷交给 onPayload 后回 200 空体（WxPusher 对响应体无格式要求）
//  - server 错误绝不向上抛：请求级异常回 500，监听级异常只 warn
// 军规：stop() 关闭 server 并等在途请求收敛；host 默认 127.0.0.1（需公网由用户反代，README 写明）。

import { createServer } from 'node:http'

const MAX_BODY_BYTES = 64 * 1024

/**
 * 创建并启动回调服务器。
 * @param {object} options
 * @param {string} options.path - 精确匹配的密径（如 /hook/<32B hex>）
 * @param {(payload: object, meta: { ip: string }) => void | Promise<void>} options.onPayload
 * @param {string} [options.host='127.0.0.1']
 * @param {number} [options.port=8103] - 0 = 随机可用端口（测试用）
 * @param {object} [options.logger]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function startHttpCallback({ path, onPayload, host = '127.0.0.1', port = 8103, logger = null }) {
  if (typeof path !== 'string' || path === '' || !path.startsWith('/')) {
    return Promise.reject(new Error('webhookPath 必须是 / 开头的非空路径'))
  }
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/http-callback]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/http-callback]', message) } catch { /* 控制台不可用不致命 */ }
  }

  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      let responded = false // 413 destroy 与后续事件可能竞态：只允许写一次响应
      const finish = (status, body = '') => {
        if (responded) return
        responded = true
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(body)
      }
      try {
        if ((request.url ?? '').split('?')[0] !== path) return finish(404, 'not found')
        if (request.method !== 'POST') return finish(405, 'method not allowed')
        const chunks = []
        let size = 0
        request.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            finish(413, 'payload too large')
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        request.on('end', () => {
          let payload
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch {
            return finish(400, 'invalid json')
          }
          if (payload === null || typeof payload !== 'object') return finish(400, 'invalid payload')
          Promise.resolve(onPayload(payload, { ip: request.socket.remoteAddress ?? '' }))
            .then(() => finish(200))
            .catch((error) => {
              warn(`payload 处理异常: ${error instanceof Error ? error.message : String(error)}`)
              finish(200) // 已接收：让平台不重试（异常由通道层 warn 吸收）
            })
        })
        request.on('error', () => { /* 连接层错误：响应已尽可能给出 */ })
      } catch (error) {
        warn(`请求处理异常: ${error instanceof Error ? error.message : String(error)}`)
        finish(500)
      }
    })

    server.on('error', (error) => {
      warn(`server 异常: ${error instanceof Error ? error.message : String(error)}`)
    })

    server.listen(port, host, () => {
      const actual = server.address()
      const bound = typeof actual === 'object' && actual !== null ? actual.port : port
      resolve({
        port: bound,
        close: () => new Promise((resolveClose) => {
          server.close(() => resolveClose())
          // close() 只等优雅退出；挂着的 keep-alive 连接直接砍（回调场景无长连接语义）
          server.closeAllConnections?.()
        }),
      })
    })
    server.once('error', reject) // listen 失败（端口占用等）要向上抛
  })
}
