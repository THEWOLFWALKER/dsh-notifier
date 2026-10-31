// Probe plugin used by the real-host smoke (see test/host/README.md).
//
// It is a *separate* bundle package installed alongside dsh-notifier in a
// disposable profile. On activation it:
//   1. reports whether `ctx.notifier` exists and is enabled;
//   2. reports whether the `notify` tool is registered;
//   3. pushes ONE real notification (to a webhook channel the smoke points at
//      its local receiver), so a genuine HTTP POST is observed.
//
// It deliberately mirrors the T02 probe (docs/new-host/evidence/T02.json) but
// is a test fixture owned by test/host/ — it never touches product code.
export const name = 'dsh-notifier-smoke-probe'
export const inject = ['notifier', 'tools']

export function apply(ctx) {
  const report = (tag, payload) => {
    try {
      console.log(`[SMOKE-PROBE] ${tag} ${JSON.stringify(payload)}`)
    } catch {
      console.log(`[SMOKE-PROBE] ${tag}`)
    }
  }

  report('notifier-present', {
    present: ctx.notifier !== undefined && ctx.notifier !== null,
  })

  try {
    report('notifier-enabled', { enabled: ctx.notifier?.enabled?.() === true })
  } catch (error) {
    report('notifier-enabled-error', { error: String(error?.message ?? error) })
  }

  try {
    const notifyDef = ctx.tools?.get?.('notify')
    report('tools-registered', {
      hasNotify: notifyDef !== undefined && notifyDef !== null,
    })
  } catch (error) {
    report('tools-error', { error: String(error?.message ?? error) })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['notifier'], async (subCtx) => {
      try {
        const result = await subCtx.notifier.push(
          { title: 'smoke probe', content: 'headless activation' },
          { channel: 'webhook', sourceName: 'smoke-probe' },
        )
        report('push-result', result)
      } catch (error) {
        report('push-error', { error: String(error?.message ?? error) })
      }
    })
  }
}
