// dsh-notifier extensions/cloudflare-tunnel/index.mjs
// T25（可选 Cloudflare Tunnel）— 扩展装配入口。
//
// 默认**停用**、默认 **user-managed binary**（不代下载）。本入口把「配置校验（R03）」与
// 「进程监督器（R01/R02/R05）」编排成一个窄控制面：configure → start/stop/status/dispose。
// 它不持有任何 store 键、不写业务状态；状态只是进程内投影（epoch + 脱敏日志 + 自有 PID）。
//
// 装配方可通过注入 `spawn` 用真实 `node:child_process.spawn`，或测试桩注入假进程（R05）。

import { validateTunnelConfig } from './src/config.mjs'
import { createTunnelSupervisor } from './src/supervisor.mjs'

/**
 * @param {object} options
 * @param {(config:object)=>object} options.spawn
 * @param {object} [options.supervisor]
 */
export function createCloudflareTunnelController(options = {}) {
  const supervisor = options.supervisor ?? createTunnelSupervisor({ spawn: options.spawn })

  let configured = null // 最近一次通过校验的配置；null = not-configured

  const configure = (input) => {
    const result = validateTunnelConfig(input)
    if (result.ok !== true) return result
    configured = result.value
    return { ok: true, value: result.value }
  }

  const start = async () => {
    if (configured === null) {
      return { ok: false, code: 'not-configured', status: supervisor.status() }
    }
    if (configured.enabled !== true) {
      return { ok: false, code: 'disabled', status: supervisor.status() }
    }
    try {
      const result = await supervisor.start(configured)
      return { ok: true, ...result, status: supervisor.status() }
    } catch (error) {
      return { ok: false, code: error?.code ?? 'start-failed', status: supervisor.status() }
    }
  }

  const stop = async () => {
    const result = await supervisor.stop()
    return { ok: true, ...result, status: supervisor.status() }
  }

  return {
    configure,
    start,
    stop,
    status: () => ({ configured: configured !== null, ...supervisor.status() }),
    dispose: () => supervisor.dispose(),
  }
}