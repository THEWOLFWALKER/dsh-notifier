#!/usr/bin/env node
// test/host/harness.smoke.mjs — real-host rc.5 smoke for dsh-notifier.
//
// Run:  node test/host/harness.smoke.mjs
//
// It does NOT use the node:test runner on purpose: `test/host/**` must stay
// OUT of the `npm test` glob (`test/*.test.mjs`), so this is a plain executable
// script that prints a PASS/FAIL summary and exits non-zero on failure.
//
// What it proves, on the real DSH 0.2.1-rc.5 CLI:
//   A. web profile     — boots; the plugin's own channel/admin log line appears.
//   B. headless profile — boots; the plugin activates with NO connection /
//                          webServer and NO PENDING wait; its own 已启用渠道
//                          line appears and a real notify push reaches a local
//                          loopback receiver.
//
// All DSH_HOMEs are throwaway dirs under the scratch root.

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SCRATCH_ROOT,
  assertNotRealDshHome,
  bootProfile,
  dumpConfig,
  hasPnpm,
  installPluginIntoProfile,
  installProbeIntoProfile,
  makeDisposableDshHome,
  readPluginState,
  startLocalReceiver,
} from './harness.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROBE_DIR = join(__dirname, 'fixtures', 'smoke-probe')

// ── tiny test reporter ─────────────────────────────────────────────────────
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`)
}
function section(title) {
  console.log(`\n=== ${title} ===`)
}
/** strip anything that looks like a secret/token from a log line before print */
function sanitize(s) {
  return String(s)
    .replace(/token=[A-Za-z0-9._~-]+/g, 'token=<redacted>')
    .replace(/\?token=[^\s"']+/g, '?token=<redacted>')
}

async function main() {
  console.log('dsh-notifier rc.5 real-host harness smoke')
  console.log(`scratch root : ${SCRATCH_ROOT}`)
  console.log(`pnpm present : ${hasPnpm()}`)

  const cleanupFns = []
  const homes = []

  try {
    // ── guard demonstration ────────────────────────────────────────────────
    section('guards')
    let guardOk = false
    try {
      assertNotRealDshHome(join(process.env.HOME ?? '/root', '.dsh'))
    } catch {
      guardOk = true
    }
    record('refuses to touch real ~/.dsh', guardOk)

    // ── local receiver ─────────────────────────────────────────────────────
    section('local receiver')
    const receiver = await startLocalReceiver()
    cleanupFns.push(() => receiver.close())
    record('loopback receiver listening', receiver.port > 0, `port ${receiver.port}`)

    // ── WEB profile ────────────────────────────────────────────────────────
    section('A. web profile boot')
    const webHome = makeDisposableDshHome('smoke-web')
    homes.push(webHome)
    installPluginIntoProfile({
      home: webHome.home,
      profile: 'web',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    })
    record('installed dsh-notifier into web profile', existsSync(webHome.home))

    // T02 verification command: dump-config must compose the plugin row.
    const dump = await dumpConfig({ home: webHome.home, profile: 'web' })
    const dumpHasPlugin = /id:\s*dsh-notifier\b/.test(dump.stdout)
    const dumpSkipping = /skipping profile bundle\s*"dsh-notifier"/.test(dump.stdout + dump.stderr)
    record(
      'dump-config composes dsh-notifier row',
      dumpHasPlugin && !dumpSkipping,
      dumpSkipping ? 'host SKIPPED the bundle (install gate denied)' : `exit ${dump.exitCode}`,
    )

    const web = await bootProfile({
      home: webHome.home,
      profile: 'web',
      args: ['--no-open'],
      timeoutMs: 30000,
    })
    // Wait for the LATEST startup line ("dsh web: http://...") so earlier lines
    // have all flushed and the boot is provably complete, THEN stop the child.
    let webSignal = ''
    try {
      webSignal = await web.waitFor(/dsh web: http:\/\/127\.0\.0\.1:\d+/, 25000)
    } catch {
      webSignal = ''
    }
    await web.stop()
    const webOutput = web.output()
    const webChannel = /\[dsh-notifier\][^\n]*渠道/.test(webOutput)
    const webAdmin = /\[dsh-notifier\/admin:server\][^\n]*admin/.test(webOutput)
    const webUrl = /dsh web: http:\/\/127\.0\.0\.1:\d+/.test(webOutput)
    record('web boots and plugin line appears', /\[dsh-notifier\]/.test(webOutput), sanitize(webSignal))
    record('web channel/admin line present', webChannel || webAdmin,
      sanitize((webOutput.match(/\[dsh-notifier\][^\n]*/)?.[0] ?? '').slice(0, 120)))
    record('web server URL advertised', webUrl)
    console.log('  --- web boot log (sanitized) ---')
    for (const line of sanitize(webOutput).split('\n').filter(Boolean).slice(0, 12)) {
      console.log(`    | ${line}`)
    }

    // ── HEADLESS profile ───────────────────────────────────────────────────
    section('B. headless profile boot + real notify push')
    const hlHome = makeDisposableDshHome('smoke-headless')
    homes.push(hlHome)
    // Point the notifier at our local receiver via a webhook channel.
    const hookUrl = receiver.url('/hook')
    installPluginIntoProfile({
      home: hlHome.home,
      profile: 'headless',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
      cordisPatchYaml:
        `- id: dsh-notifier\n` +
        `  config:\n` +
        `    enabled: true\n` +
        `    channels:\n` +
        `      - type: webhook\n` +
        `        url: '${hookUrl}'\n` +
        `        allowPrivateNetwork: true\n`,
    })
    installProbeIntoProfile({
      home: hlHome.home,
      profile: 'headless',
      probeDir: PROBE_DIR,
    })
    record('installed dsh-notifier + probe into headless profile', existsSync(hlHome.home))

    // dump-config must show NO connection/webServer rows (headless composes
    // neither) and NO skipping.
    const hlDump = await dumpConfig({ home: hlHome.home, profile: 'headless' })
    const noConn = !/id:\s*connection\b/.test(hlDump.stdout)
    const noWeb = !/id:\s*webserver\b/i.test(hlDump.stdout)
    record('headless composes no connection/webServer', noConn && noWeb)

    // Boot headless with a benign task. It exits 1 with MISSING_CREDENTIAL
    // (no LLM key) AFTER the plugin activates and delivers — that is expected.
    const hl = await bootProfile({
      home: hlHome.home,
      profile: 'headless',
      args: ['echo hello'],
      timeoutMs: 45000,
    })
    const hlResult = await hl.result()
    const hlOutput = hl.output()

    const activated = /\[dsh-notifier\]\s*已启用渠道/.test(hlOutput)
    const pending = /waiting for services|PENDING|did not activate/i.test(hlOutput)
    record('headless plugin activates (已启用渠道)', activated,
      sanitize((hlOutput.match(/\[dsh-notifier\][^\n]*/)?.[0] ?? '').slice(0, 120)))
    record('headless has NO pending/waiting-for-services', !pending)

    const probePresent = /\[SMOKE-PROBE\] notifier-present \{"present":true\}/.test(hlOutput)
    const probePushOk = /\[SMOKE-PROBE\] push-result .*"ok":true/.test(hlOutput)
    record('probe sees notifier present', probePresent)
    record('probe push reported ok:true', probePushOk)

    const hookHits = receiver.requests.filter((r) => r.path === '/hook')
    record('local receiver got real POST /hook', hookHits.length > 0,
      `${hookHits.length} request(s), exit ${hlResult.exitCode}`)

    await hl.stop()
    console.log('  --- headless boot log (sanitized) ---')
    for (const line of sanitize(hlOutput).split('\n').filter(Boolean).slice(0, 14)) {
      console.log(`    | ${line}`)
    }

    if (hookHits.length) {
      const body = hookHits[0].body
      console.log('  --- receiver request[0] ---')
      console.log(`    | ${hookHits[0].method} ${hookHits[0].path} body=${JSON.stringify(body).slice(0, 200)}`)
    }

    // ── plugin state (read-only) ───────────────────────────────────────────
    section('plugin state (read-only)')
    const stateDir = join(hlHome.home, 'dsh-notifier')
    const state = readPluginState(stateDir)
    record('readPluginState never throws', true, state ? 'state.json present' : 'no state.json')
  } finally {
    // Always tear down the homes we created.
    for (const h of homes) {
      try {
        h.cleanup()
      } catch {
        /* best effort */
      }
    }
    for (const fn of cleanupFns.reverse()) {
      try {
        await fn()
      } catch {
        /* best effort */
      }
    }
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok)
  console.log('\n=== SUMMARY ===')
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log(`SMOKE: FAIL (${failed.length} failing)`)
    process.exitCode = 1
  } else {
    console.log('SMOKE: PASS')
    process.exitCode = 0
  }
}

main().catch((error) => {
  console.error('\nSMOKE: FAIL (unhandled error)')
  console.error(sanitize(error?.stack ?? String(error)))
  process.exitCode = 1
})
