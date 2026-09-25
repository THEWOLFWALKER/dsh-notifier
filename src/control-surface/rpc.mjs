// dsh-notifier v0.12 — Native Control Surface over DSH authenticated Connection RPC.
// Verified against DSH 0.1.7-alpha.1..0.1.7-rc.2 HostConnectionRpc.

export function registerControlSurfaceRpc(ctx, service) {
  if (typeof ctx?.connection?.rpc?.handle !== 'function') return null
  return ctx.connection.rpc.handle('/dsh-notifier', async (endpoint, payload, signal) => {
    return await service.call(endpoint, payload, signal)
  })
}
