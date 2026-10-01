// Explicitly configured named tunnel; no startup process, download or cloud deletion.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { validateTunnelConfig } from '../../extensions/cloudflare-tunnel/src/config.mjs'
import { createCloudflareTunnelController } from '../../extensions/cloudflare-tunnel/index.mjs'
import { transactDurable } from '../inbound/store.mjs'
const KEY = 'cloudflare:tunnel'
const fail = message => Object.assign(new Error(message), { code: 'bad-request' })
export function createNativeTunnelService({ store, spawnImpl = spawn } = {}) {
  let config = null
  const controller = createCloudflareTunnelController({ spawn: value => {
    if (!config || !existsSync(config.binary) || !existsSync(value.credentialsSource)) throw fail('请检查 cloudflared 和凭据文件的位置')
    return spawnImpl(config.binary, ['tunnel', '--no-autoupdate', '--credentials-file', value.credentialsSource, 'run', value.name], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  } })
  function configure(payload = {}) {
    if (controller.status().status === 'running' || controller.status().status === 'starting') throw fail('先停止隧道，再修改设置')
    if (typeof payload.binary !== 'string' || !isAbsolute(payload.binary) || !isAbsolute(String(payload.credentialsSource ?? ''))) throw fail('请填写 cloudflared 和凭据文件的完整路径')
    const result = validateTunnelConfig({ ...payload, protected: true })
    if (!result.ok) throw fail('隧道设置不完整，请检查名称、凭据和访问保护')
    const next = { ...result.value, binary: payload.binary }
    const receipt = transactDurable(store, draft => { draft[KEY] = next })
    if (!receipt.committed) throw fail('隧道设置未保存，请重试')
    controller.configure(next)
    config = next
    return { saved: true }
  }
  return {
    configure,
    status() { const s = controller.status(); return { configured: config !== null, state: s.status, running: s.status === 'running' } },
    async start(payload) {
      if (payload?.binary) configure(payload)
      if (!config) { const saved = store.get(KEY); if (saved) configure(saved) }
      const result = await controller.start()
      if (!result.ok) throw fail('隧道未启动，请检查文件和设置后重试')
      return { started: true, ...this.status() }
    },
    async stop() { await controller.stop(); return { stopped: true, ...this.status() } },
    dispose() { controller.dispose() },
  }
}
