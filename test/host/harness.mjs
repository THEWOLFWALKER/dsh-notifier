// Disposable DSH rc.5 test harness for dsh-notifier.
//
// Goals (see test/host/README.md):
//   * Every DSH_HOME we create lives under the scratch root and is disposable.
//   * A profile is installed through the host's OWN profile-bundle path
//     (profiles/<name>/package.json `dsh.profile.bundles` + a plugin payload
//     under profiles/<name>/node_modules/<pkg>). This mirrors exactly the
//     recipe the T02 agent used, because `dsh plugin --profile <name> add`
//     forwards to pnpm and pnpm is NOT installed in this environment.
//   * Booting spawns the real `dsh` CLI with DSH_HOME pointing at our
//     throwaway home, with a bounded timeout and a guaranteed kill (never
//     leaves an orphan process).
//   * A loopback HTTP receiver records requests and can simulate slow/stalled
//     bodies (T09 deadline tests) and redirects.
//
// This module has NO side effects on import. It only touches paths under
// SCRATCH_ROOT (and the repo, for reading) and refuses anything reaching the
// real ~/.dsh.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── fixed locations ────────────────────────────────────────────────────────
// test/host/harness.mjs -> repo root is two levels up.
const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(__dirname, '..', '..')

/** The ONLY directory we are ever allowed to create DSH_HOMEs under. */
export const SCRATCH_ROOT = '/home/orca/work/dsh-notifier-rc5/scratch'

/** The real, sacred profile home. Any path resolution that lands here throws. */
export const REAL_DSH_HOME = join(homedir(), '.dsh')

/** The pinned DSH 0.2.1-rc.5 CLI entrypoint (host install, not the repo). */
export const DSH_CLI =
  '/home/orca/work/dsh-notifier-rc5/dsh-host/node_modules/@deepseek-ai/dsh/lib/bin.js'

/** The host packages (base bundles) live next to the CLI. */
export const DSH_HOST_NODE_MODULES =
  '/home/orca/work/dsh-notifier-rc5/dsh-host/node_modules'

// ── path guards ────────────────────────────────────────────────────────────

/** True when `child` is the same as, or nested under, `root` (both resolved). */
function isInside(root, child) {
  const r = resolve(root)
  const c = resolve(child)
  if (c === r) return true
  return c.startsWith(r + sep)
}

/** Throws unless `p` is strictly inside the scratch root. */
export function assertInsideScratch(p) {
  if (!isInside(SCRATCH_ROOT, p)) {
    throw new Error(
      `refusing path outside scratch root: ${p} is not under ${SCRATCH_ROOT}`,
    )
  }
}

/**
 * Throws if `p` resolves to the real ~/.dsh (or anything inside it). Called by
 * every write helper so a typo can never damage the maintainer's live profile.
 */
export function assertNotRealDshHome(p) {
  const resolved = resolve(p)
  if (isInside(REAL_DSH_HOME, resolved)) {
    throw new Error(
      `refusing to touch the real DSH home (${REAL_DSH_HOME}); got ${resolved}`,
    )
  }
  // Also reject any scratch path that strings onto ~/.dsh by accident.
  if (resolved === resolve(REAL_DSH_HOME)) {
    throw new Error(`refusing to touch the real DSH home: ${resolved}`)
  }
  return resolved
}

/** Combined guard used by every mutating helper. */
function guardWritePath(p) {
  assertNotRealDshHome(p)
  assertInsideScratch(p)
  return resolve(p)
}

// ── makeDisposableDshHome ──────────────────────────────────────────────────

/**
 * Create a disposable DSH_HOME under the scratch root.
 *
 * @param {string} name short slug, e.g. "smoke-web"
 * @param {{ reset?: boolean }} [opts] reset=true (default) removes a previous
 *        home of the same name first, so reruns start clean.
 * @returns {{ home: string, name: string, cleanup: () => void }}
 */
export function makeDisposableDshHome(name, opts = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(name))) {
    throw new Error(`invalid home name (use [A-Za-z0-9._-]): ${name}`)
  }
  const reset = opts.reset !== false
  const home = join(SCRATCH_ROOT, `dshhome-${name}`)
  // Guard BEFORE any filesystem mutation.
  guardWritePath(home)
  if (reset && existsSync(home)) {
    guardWritePath(home)
    rmSync(home, { recursive: true, force: true })
  }
  mkdirSync(home, { recursive: true })
  return {
    home,
    name,
    cleanup() {
      guardWritePath(home)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

// ── installPluginIntoProfile ───────────────────────────────────────────────

/** Read a package's declared bundle patch file (relative to the package dir). */
function readBundlePatchPath(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const patch = pkg?.dsh?.bundle?.patch
  if (typeof patch !== 'string') return null
  return join(pkgDir, patch)
}

/**
 * Copy a package directory into a profile's node_modules, skipping the
 * obvious heavyweight / irrelevant entries. We copy (not symlink) so the
 * profile is self-contained and a later repo edit cannot bleed into a home
 * that is supposed to be frozen for evidence.
 */
function copyPackageInto(destDir, srcDir) {
  const skip = new Set(['node_modules', '.git', '.agents', '.claude', '.codex', '.opencode'])
  guardWritePath(destDir)
  cpSync(srcDir, destDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = relative(srcDir, src)
      if (rel === '') return true
      const top = rel.split(sep)[0]
      return !skip.has(top)
    },
  })
}

/**
 * Install the dsh-notifier plugin (this repo) into a profile using the host's
 * profile-bundle path — the exact T02 recipe.
 *
 * Layout produced under <home>/profiles/<profile>/:
 *   package.json        { dsh.profile.bundles: [...defaults, "dsh-notifier"] }
 *   cordis.yml          [] (empty root; the tree is composed from patches)
 *   cordis.patch.yml    [] (profile patch layer; caller may override)
 *   node_modules/<pkg>/ the plugin payload (copied from <pkgDir>)
 *
 * @param {object} o
 * @param {string} o.home            DSH_HOME (must be inside scratch)
 * @param {string} o.profile         profile name, e.g. "web" / "headless"
 * @param {string[]} o.bundles       base bundle names WITHOUT the plugin,
 *                                   e.g. ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]
 * @param {string} [o.repoRoot]      source repo (default REPO_ROOT)
 * @param {string} [o.linkMode]      "copy" (default) | "symlink"
 * @param {string} [o.cordisPatchYaml] contents for the profile cordis.patch.yml
 *                                     (default "[]\n")
 * @returns {{ profileDir, pluginDir, packageJsonPath, patchPath }}
 */
export function installPluginIntoProfile({
  home,
  profile,
  bundles,
  repoRoot = REPO_ROOT,
  linkMode = 'copy',
  cordisPatchYaml = '[]\n',
}) {
  if (!home) throw new Error('installPluginIntoProfile: home is required')
  if (!profile) throw new Error('installPluginIntoProfile: profile is required')
  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error('installPluginIntoProfile: bundles must be a non-empty array')
  }
  guardWritePath(home)
  guardWritePath(join(home, 'profiles', profile))

  const pkgPath = join(repoRoot, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const pluginName = pkg.name
  if (pluginName !== 'dsh-notifier') {
    throw new Error(`expected repo package name "dsh-notifier", got "${pluginName}"`)
  }

  const profileDir = join(home, 'profiles', profile)
  const nmDir = join(profileDir, 'node_modules')
  const pluginDir = join(nmDir, pluginName)
  mkdirSync(nmDir, { recursive: true })

  // Profile manifest — bundles = base bundles + our plugin.
  const profilePkg = {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...bundles, pluginName] } },
  }
  guardWritePath(join(profileDir, 'package.json'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profilePkg, null, 2) + '\n')

  // Root entry list (unused; the tree is composed from patch layers).
  guardWritePath(join(profileDir, 'cordis.yml'))
  writeFileSync(
    join(profileDir, 'cordis.yml'),
    '# dsh profile root — composed from bundle patches + cordis.patch.yml.\n[]\n',
  )

  // Profile patch layer.
  guardWritePath(join(profileDir, 'cordis.patch.yml'))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), cordisPatchYaml)

  // Plugin payload into the profile's node_modules.
  if (linkMode === 'symlink') {
    guardWritePath(pluginDir)
    symlinkSync(resolve(repoRoot), pluginDir, 'dir')
  } else {
    copyPackageInto(pluginDir, resolve(repoRoot))
  }

  // Sanity: the copied payload must declare its bundle patch.
  const bp = readBundlePatchPath(pluginDir)
  if (!bp || !existsSync(bp)) {
    throw new Error(`installed plugin payload is missing its dsh.bundle.patch (${bp})`)
  }

  return {
    profileDir,
    pluginDir,
    packageJsonPath: join(profileDir, 'package.json'),
    patchPath: join(profileDir, 'cordis.patch.yml'),
  }
}

/**
 * Copy a *separate* probe plugin package into a profile's node_modules and
 * append it to the profile bundle list. Used to prove activation from inside
 * a real boot without touching product code.
 *
 * @param {object} o
 * @param {string} o.home
 * @param {string} o.profile
 * @param {string} o.probeDir   directory containing the probe package
 * @returns {{ pluginDir: string }}
 */
export function installProbeIntoProfile({ home, profile, probeDir }) {
  guardWritePath(join(home, 'profiles', profile))
  const probePkg = JSON.parse(readFileSync(join(probeDir, 'package.json'), 'utf8'))
  const probeName = probePkg.name
  const profileDir = join(home, 'profiles', profile)
  const profilePkgPath = join(profileDir, 'package.json')
  const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
  if (!profilePkg.dsh.profile.bundles.includes(probeName)) {
    profilePkg.dsh.profile.bundles.push(probeName)
    guardWritePath(profilePkgPath)
    writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n')
  }
  const pluginDir = join(profileDir, 'node_modules', probeName)
  copyPackageInto(pluginDir, probeDir)
  return { pluginDir }
}

// ── dumpConfig (verification command, mirrors T02) ─────────────────────────

/**
 * Run `dsh --profile <profile> --dump-config` and return the composed tree.
 * This is the exact verification command the T02 evidence uses:
 *   DSH_HOME=<home> node <cli> --profile web --dump-config | grep dsh-notifier
 *
 * @returns {Promise<{ exitCode:number, stdout:string, stderr:string }>}
 */
export function dumpConfig({ home, profile, timeoutMs = 60000 }) {
  guardWritePath(home)
  return new Promise((resolveP) => {
    const child = spawn(
      process.execPath,
      [DSH_CLI, '--profile', profile, '--dump-config'],
      { env: { ...bootEnv(home) }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveP({ exitCode: code, stdout, stderr })
    })
  })
}

// ── boot environment ───────────────────────────────────────────────────────

/**
 * Build a minimal, allowlisted env for a booted dsh child. We deliberately do
 * NOT forward the parent's full environment (no secret leakage). Only PATH,
 * HOME (a harmless pointer for node), and DSH_HOME are set. NODE_ENV quiet
 * flags keep startup logs focused.
 */
export function bootEnv(home) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? homedir(),
    DSH_HOME: home,
    // Deterministic, no-color, no proxy surprises.
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
}

// ── bootProfile ────────────────────────────────────────────────────────────

/**
 * Spawn the real dsh CLI against a disposable profile with a bounded timeout
 * and a guaranteed kill. Returns a handle whose `waitFor(pattern)` awaits a
 * regex/string match against the accumulated stdout+stderr, and whose
 * `result()` resolves once the process exits (or is killed).
 *
 * @param {object} o
 * @param {string} o.home
 * @param {string} o.profile
 * @param {string[]} [o.args]      app args after the profile (e.g. a task text)
 * @param {number} [o.timeoutMs]   hard kill deadline (default 30000)
 * @param {NodeJS.ProcessEnv} [o.env] extra env (merged over bootEnv)
 * @returns {Promise<{ pid:number, stdout:string, stderr:string,
 *                     exitCode:number|null, killed:boolean,
 *                     waitFor:(p:RegExp|string, ms?:number)=>Promise<string>,
 *                     output:()=>string, result:()=>Promise<object>,
 *                     stop:()=>Promise<void> }>}
 */
export function bootProfile({
  home,
  profile,
  args = [],
  timeoutMs = 30000,
  env = {},
}) {
  guardWritePath(home)
  return new Promise((resolveP, rejectP) => {
    let child
    try {
      child = spawn(
        process.execPath,
        [DSH_CLI, '--profile', profile, ...args],
        {
          env: { ...bootEnv(home), ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
          // Own process group so a kill takes the whole (possible) tree down.
          detached: true,
        },
      )
    } catch (error) {
      rejectP(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let killed = false
    let settled = false

    const output = () => stdout + stderr

    // Hard deadline: guaranteed kill, never leaves an orphan.
    const hardTimer = setTimeout(() => {
      killed = true
      killTree(child)
    }, timeoutMs)

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))

    const exitPromise = new Promise((res) => {
      child.on('close', (code, signal) => {
        clearTimeout(hardTimer)
        if (settled) return
        settled = true
        res({
          exitCode: code,
          signal: signal ?? null,
          killed,
          stdout,
          stderr,
        })
      })
      child.on('error', (err) => {
        clearTimeout(hardTimer)
        if (settled) return
        settled = true
        res({ exitCode: null, signal: null, killed, stdout, stderr, error: String(err) })
      })
    })

    /**
     * Await a pattern in the merged output. Rejects on timeout so callers get
     * a clear failure rather than hanging.
     */
    function waitFor(pattern, ms = timeoutMs) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(escapeRe(pattern))
      return new Promise((res, rej) => {
        const check = () => {
          const m = re.exec(output())
          return m ? m : null
        }
        const now = check()
        if (now) {
          res(now[0])
          return
        }
        let done = false
        const iv = setInterval(() => {
          if (done) return
          const m = check()
          if (m) {
            done = true
            clearInterval(iv)
            clearTimeout(t)
            res(m[0])
          }
        }, 50)
        const t = setTimeout(() => {
          if (done) return
          done = true
          clearInterval(iv)
          rej(new Error(`waitFor timed out after ${ms}ms waiting for ${re}`))
        }, ms)
      })
    }

    /** SIGTERM, then SIGKILL after a grace period (whole group). */
    async function stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      killTree(child, 'SIGTERM')
      const deadline = Date.now() + 3000
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }
      if (child.exitCode === null && child.signalCode === null) {
        killed = true
        killTree(child, 'SIGKILL')
      }
    }

    resolveP({
      pid: child.pid,
      get stdout() {
        return stdout
      },
      get stderr() {
        return stderr
      },
      killed: () => killed,
      waitFor,
      output,
      result: () => exitPromise,
      stop,
    })
  })
}

/** Kill a (possibly detached) child's whole process group, falling back to the pid. */
function killTree(child, signal = 'SIGKILL') {
  try {
    // Negative pid targets the process group (we spawned detached).
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── startLocalReceiver ─────────────────────────────────────────────────────

/**
 * A loopback HTTP server that records received requests.
 *
 * Behaviour modes:
 *   * default        — parse JSON body, reply 200 { ok:true }, record.
 *   * { slowMs }     — sleep before reading the body (stall the sender).
 *   * { stallBody }  — never end the response (hold the socket open).
 *   * { redirectTo } — reply 302 with a Location header.
 *
 * @param {object} [opts]
 * @param {number} [opts.slowMs=0]
 * @param {boolean} [opts.stallBody=false]
 * @param {string} [opts.redirectTo]  when set, every request 302-redirects here
 * @param {number} [opts.status=200]  success status for normal replies
 * @returns {Promise<object>} { port, url(path), requests, server, close() }
 */
export function startLocalReceiver(opts = {}) {
  const { slowMs = 0, stallBody = false, redirectTo, status = 200 } = opts
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    const record = (body) => {
      requests.push({
        method: req.method,
        path: req.url,
        headers: { ...req.headers },
        body,
        at: new Date().toISOString(),
      })
    }

    req.on('data', (c) => chunks.push(c))
    req.on('error', () => {})

    const respond = () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed = raw
      try {
        parsed = raw.length ? JSON.parse(raw) : null
      } catch {
        /* keep raw string */
      }
      record(parsed)

      if (redirectTo) {
        res.writeHead(302, { Location: redirectTo })
        res.end()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }

    if (stallBody) {
      // Record the admission but never finish the response.
      record(null)
      // Do not call res.end(); keep the socket open until the client gives up.
      return
    }
    if (slowMs > 0) {
      setTimeout(respond, slowMs)
    } else {
      respond()
    }
  })

  return new Promise((resolveP, rejectP) => {
    server.on('error', rejectP)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolveP({
        port,
        url: (path = '/') => `http://127.0.0.1:${port}${path}`,
        requests,
        server,
        close: () =>
          new Promise((res) => {
            server.close(() => res())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

// ── readPluginState ────────────────────────────────────────────────────────

/**
 * Read <dir>/state.json if present. NEVER writes. Returns null when absent.
 * @param {string} dir
 * @returns {object|null}
 */
export function readPluginState(dir) {
  const p = join(dir, 'state.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// ── misc helpers ───────────────────────────────────────────────────────────

/** True when pnpm resolves on PATH (expected FALSE in this environment). */
export function hasPnpm() {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  return dirs.some((d) => existsSync(join(d, 'pnpm')))
}

export const constants = {
  REPO_ROOT,
  SCRATCH_ROOT,
  REAL_DSH_HOME,
  DSH_CLI,
  DSH_HOST_NODE_MODULES,
}

export default {
  makeDisposableDshHome,
  installPluginIntoProfile,
  installProbeIntoProfile,
  dumpConfig,
  bootProfile,
  bootEnv,
  startLocalReceiver,
  readPluginState,
  assertInsideScratch,
  assertNotRealDshHome,
  hasPnpm,
  constants,
}
