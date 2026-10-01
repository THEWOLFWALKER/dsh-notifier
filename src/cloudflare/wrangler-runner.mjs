// Opt-in CLI adapter. No spawn, installation or auth read until explicitly invoked.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
export const WRANGLER_VERSION = '4.119.0'
const LIMIT = 256 * 1024
const fail = (message, code = 'host-unavailable') => Object.assign(new Error(message), { code })
export function parseJsonOutput(text) {
  // --json commands produce JSON, never infer IDs from decorative CLI text.
  try { return JSON.parse(text.trim()) } catch { throw fail('Cloudflare 返回格式无法识别') }
}
export function deploymentFromOutput(text, name) {
  const records = text.trim().split('\n').filter(Boolean).map(parseJsonOutput)
  const deployments = records.filter(r => r.type === 'deploy' && r.worker_name === name)
  if (deployments.length !== 1) throw fail('部署结果不明确，请刷新后重试')
  const row = deployments[0]
  const urls = (row.targets ?? []).filter(v => typeof v === 'string' && /^https:\/\/[^/]+\.workers\.dev\/?$/.test(v))
  if (urls.length !== 1 || typeof row.version_id !== 'string') throw fail('未取得唯一部署地址')
  return { endpoint: urls[0].replace(/\/$/, ''), versionId: row.version_id }
}
export function createWranglerRunner({ root, cliPath = null, spawnImpl = spawn, env = process.env } = {}) {
  const cli = cliPath ?? join(root, 'tools/node_modules/wrangler/bin/wrangler.js')
  let active = null
  let activeCancel = null
  let disposed = false
  function exec(command, args, { cwd = root, signal, onOutput, accountId, timeoutMs = 120_000, stdin, commandEnv = {} } = {}) {
    if (disposed || signal?.aborted) return Promise.reject(fail('已取消', 'conflict'))
    if (active) return Promise.reject(fail('Cloudflare 正在执行另一项操作', 'conflict'))
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    return new Promise((accept, reject) => {
      let child, timer, bytes = 0, stdout = '', settled = false
      const finish = (error, value, keepActive = false) => {
        if (settled) return
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel)
        if (active === child && !keepActive) { active = null; activeCancel = null }
        error ? reject(error) : accept(value)
      }
      const cancel = () => {
        try { child?.kill('SIGTERM') } catch {}
        finish(fail('已取消；云资源可能已创建，请刷新状态', 'conflict'), null, true)
        const force = setTimeout(() => { try { child?.kill('SIGKILL') } catch {} }, 1000)
        force.unref?.()
      }
      try {
        child = spawnImpl(command, args, {
          cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...env, ...commandEnv, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error', ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}) },
        })
        active = child; activeCancel = cancel
        signal?.addEventListener('abort', cancel, { once: true })
        timer = setTimeout(cancel, timeoutMs)
        for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
          if (settled) return
          bytes += chunk.length
          if (bytes > LIMIT) { cancel(); return }
          const text = String(chunk)
          if (stream === child.stdout) stdout += text
          // Only the device authorization URL/code is allowed into UI; no raw logs.
          if (onOutput) onOutput(text)
        })
        child.on('error', () => finish(fail('无法启动 Cloudflare 工具')))
        child.on('close', code => { if (active === child) { active = null; activeCancel = null }; finish(code === 0 ? null : fail('Cloudflare 操作失败，请检查登录、权限或网络'), stdout) })
        child.stdin?.end(stdin)
      } catch { finish(fail('无法启动 Cloudflare 工具')) }
    })
  }
  async function prepare(signal) {
    if (!existsSync(cli)) {
      const candidates = [env.npm_execpath, resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].filter(Boolean)
      const npm = candidates.find(existsSync)
      if (!npm) throw fail('未找到 npm，请先安装 Node.js 与 npm')
      await exec(process.execPath, [npm, 'install', '--prefix', join(root, 'tools'), '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', `wrangler@${WRANGLER_VERSION}`], { signal, timeoutMs: 300_000 })
    }
    const version = (await exec(process.execPath, [cli, '--version'], { signal })).trim()
    if (version !== WRANGLER_VERSION) throw fail(`需要 Wrangler ${WRANGLER_VERSION}`)
  }
  const run = (args, options) => exec(process.execPath, [cli, ...args, '--install-skills=false'], options)
  async function whoami(options = {}) {
    const result = parseJsonOutput(await run(['whoami', '--json'], options))
    if (result.loggedIn !== true || !Array.isArray(result.accounts)) throw fail('请先登录 Cloudflare')
    return { accounts: result.accounts.map(a => ({ id: String(a.id), name: String(a.name) })) }
  }
  async function deployWorker({ cwd, secrets, name, ...options }) {
    const temp = mkdtempSync(join(cwd, '.deploy-'))
    const secretFile = join(temp, 'secrets.json'), outputFile = join(temp, 'output.jsonl')
    writeFileSync(secretFile, JSON.stringify(secrets), { mode: 0o600 })
    // Structured output file is the official Wrangler deploy contract.
    try {
      const raw = await exec(process.execPath, [cli, 'deploy', '--config', join(cwd, 'wrangler.json'), '--secrets-file', secretFile, '--install-skills=false'], {
        ...options, cwd,
        // env extension is handled below via scoped commandEnv.
        commandEnv: { WRANGLER_OUTPUT_FILE_PATH: outputFile },
      })
      void raw
      return deploymentFromOutput(readFileSync(outputFile, 'utf8'), name)
    } finally { rmSync(temp, { recursive: true, force: true }) }
  }
  return {
    prepare, whoami,
    loginDevice: options => run(['login', '--device', '--browser=false'], { ...options, timeoutMs: 600_000 }),
    async d1Create({ name, cwd, ...options }) {
      await run(['d1', 'create', name, '--update-config', '--binding', 'database', '--config', join(cwd, 'wrangler.json')], { ...options, cwd })
      const config = JSON.parse(readFileSync(join(cwd, 'wrangler.json'), 'utf8'))
      const row = config.d1_databases?.find(r => r.database_name === name && r.binding === 'database')
      if (!row?.database_id) throw fail('数据库已创建，但配置读回失败；请刷新后重试')
      return { id: row.database_id }
    },
    d1List: async options => parseJsonOutput(await run(['d1', 'list', '--json'], options)),
    d1Migrate: ({ cwd, ...options }) => run(['d1', 'migrations', 'apply', 'database', '--remote', '--config', join(cwd, 'wrangler.json')], { ...options, cwd, stdin: 'y\n' }),
    deployWorker,
    readDeployment: async ({ cwd, ...options }) => parseJsonOutput(await run(['deployments', 'list', '--json', '--config', join(cwd, 'wrangler.json')], { ...options, cwd })),
    dispose() { disposed = true; activeCancel?.() },
  }
}
