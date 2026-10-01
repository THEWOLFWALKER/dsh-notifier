// GPL-3.0: isolated derivative of cwxiaos/bark-worker a243fe59b68bfc5c5ce4b7386a674b9d76aaf0e8.
import upstream from './upstream.mjs'
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname
    if (path === '/healthz') return Response.json({ ok: true, template: 'notifier-bark-v1' })
    if (path === '/info' || path.startsWith('/mcp')) return new Response('Not found', { status: 404 })
    try { return await upstream.fetch(request, { ...env, ALLOW_QUERY_NUMS: 'false', ALLOW_NEW_DEVICE: env.ALLOW_NEW_DEVICE === 'true' ? 'true' : 'false' }, ctx) }
    catch { return new Response('Bark service error', { status: 502 }) }
  },
}
