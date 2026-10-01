// MIT. Hardened fork of runawayvalley/telegram-cf-proxy ca3d33578e329a90cea452ea0eb75b5a9582860a.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'x-notifier-gateway-key', 'cookie', 'authorization'])
function clean(headers) {
  const out = new Headers()
  for (const [k, v] of headers) if (!HOP.has(k.toLowerCase())) out.set(k, v)
  return out
}
export function createTelegramWorker(upstreamFetch = globalThis.fetch) {
  return { async fetch(request, env) {
    const denied = status => new Response('Gateway authorization failed', { status, headers: { 'x-notifier-gateway-error': 'auth' } })
    if (!env.BOT_TOKEN) return denied(503)
    const url = new URL(request.url)
    // Standard Bot API paths allow an existing custom reverse-proxy client to reuse its token.
    // Native automatic setup uses header authentication and keeps the token out of the URL.
    const botPrefix = `/bot${env.BOT_TOKEN}/`, filePrefix = `/file/bot${env.BOT_TOKEN}/`
    const standard = url.pathname.startsWith(botPrefix) || url.pathname.startsWith(filePrefix)
    const header = request.headers.get('x-notifier-gateway-key')
    if (header !== env.BOT_TOKEN && !(header === null && standard)) return denied(401)
    const pathname = url.pathname.startsWith(botPrefix) ? `/api/${url.pathname.slice(botPrefix.length)}` : url.pathname.startsWith(filePrefix) ? `/file/${url.pathname.slice(filePrefix.length)}` : url.pathname
    if (url.pathname === '/healthz') return Response.json({ ok: true, template: 'notifier-telegram-v1' })
    for (const k of ['key', 'token', 'api', 'api_base', 'upstream']) if (url.searchParams.has(k)) return denied(403)
    // No bot token in client URLs. The cloud secret selects the only upstream identity.
    const match = /^\/(api\/[A-Za-z][A-Za-z0-9_]*|file\/[A-Za-z0-9_./-]+)$/.exec(pathname)
    if (!match || pathname.includes('..') || /%|\\/.test(pathname)) return new Response('Not found', { status: 404 })
    const path = match[1].startsWith('api/') ? `/bot${env.BOT_TOKEN}/${match[1].slice(4)}` : `/file/bot${env.BOT_TOKEN}/${match[1].slice(5)}`
    const init = { method: request.method, headers: clean(request.headers), redirect: 'manual', signal: request.signal }
    if (!['GET', 'HEAD'].includes(request.method)) { init.body = request.body; init.duplex = 'half' }
    try {
      const response = await upstreamFetch(new Request(`https://api.telegram.org${path}${url.search}`, init))
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: clean(response.headers) })
    } catch { return new Response('Telegram upstream unavailable', { status: 502, headers: { 'x-notifier-gateway-error': 'upstream' } }) }
  } }
}
export default createTelegramWorker()
