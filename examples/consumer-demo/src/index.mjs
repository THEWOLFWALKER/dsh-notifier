// dsh-notifier 消费方最小示例（examples/，不随 npm 包发布）。
//
// 静态 `inject` 声明是获取 `ctx.notifier` 的唯一可用形态：`apply` 执行时服务已就绪
// （宿主保证等待），不要用 `ctx.inject(...)` 回调式或未声明直接访问（两者在真机均不可用）。
export const inject = ['notifier']

export function apply(ctx) {
  const notifier = ctx.notifier

  // push 永不 reject：内部错误返回 failed，不需要 try-catch。
  void notifier.push(
    {
      title: 'Consumer demo',
      content: 'Hello from another plugin.',
    },
    {
      sourceName: 'consumer-demo',
    },
  ).then((result) => {
    if (!result.ok) ctx.logger?.warn?.('push failed', result.failed)
  })

  // `dsh-notifier/sent` 的记录是 metadata-only（无 title/content/原始错误正文）。
  // 军规：监听器必须 O(1) 立即返回，且**绝不**在 handler 里再次 push——会形成通知回环。
  ctx.on?.('dsh-notifier/sent', (record) => {
    ctx.logger?.debug?.(`sent via ${record.source?.name ?? '(internal)'}`)
  })

  // 卸载前排空在途送达（flush 幂等）。
  ctx.on?.('dispose', () => {
    notifier?.flush?.()
  })
}