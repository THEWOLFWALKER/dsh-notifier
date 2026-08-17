// v0.3.3 测试：index 装配 admin 管理台（§5.2 验收面）。
// 覆盖：admin 缺省零执行（兼容红线）、出站凭证 store overlay（启用/字段级合并/resolve 失败
// 降级/store-only 跳过/双域不 overlay）、token 三条路（显式/首启生成/沿用既有哈希 + 损坏重生成）、
// state 只存哈希不存明文、EADDRINUSE 只 warn 不崩、stop() 进 disposers、HTTP 面（UI + 鉴权 + 垃圾 token 防御）。
// 端口策略：每例先 freePort() 拿空闲端口（避免固定端口撞车）；apply 保持同步契约（start 即发即忘），
// 用 waitHttp 轮询等 server 就绪；每例 finally 里 await cleanup()（effects 0 = disposers 聚合，含 adminServer.stop）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { get } from 'node:http'

import { apply, createStore } from '../src/index.mjs'

/** 临时 state 目录 + 预置 state.json（可选）。 */
function tempDir(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notifier-admin-wiring-'))
  if (initial !== undefined) writeFileSync(join(dir, 'state.json'), JSON.stringify(initial))
  return dir
}

/** ctx 桩（对齐 test/index.test.mjs 的 bootCtx，补 info 收集）。 */
function bootCtx() {
  const warnings = []
  const infos = []
  const defs = []
  const effects = []
  const listeners = {}
  return {
    warnings,
    infos,
    defs,
    effects,
    listeners,
    ctx: {
      logger: {
        warn: (...args) => warnings.push(args.join(' ')),
        info: (...args) => infos.push(args.join(' ')),
      },
      tools: { register(def) { defs.push(def); return () => {} } },
      on(event, fn) { (listeners[event] ??= []).push(fn); return () => {} },
      effect(fn) { effects.push(fn) },
    },
    /** 执行 ctx.effect 收集的清理（真 cordis 语义：fn 返回值才是 disposer，需二次调用），
     * 含 adminServer.stop 的 await；幂等安全。 */
    async cleanup() {
      for (const fn of effects) {
        try {
          const dispose = fn()
          const result = typeof dispose === 'function' ? dispose() : dispose
          if (result != null && typeof result.then === 'function') await result
        } catch { /* 卸载失败不致命 */ }
      }
    },
  }
}

/** 找一个空闲 TCP 端口（listen 0 取内核分配后立即释放）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** 轮询断言辅助：等 predicate 为真（超时返回 false，测试自行 assert）。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

/** 等 admin server 就绪（任何 HTTP 响应——含 401——即说明已监听）。 */
async function waitHttp(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/overview`, {
        headers: { Authorization: 'Bearer probe' },
      })
      await response.arrayBuffer().catch(() => {})
      return true
    } catch {
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/** 带 Bearer 的 GET（返回 fetch Response）。 */
const authGet = (port, path, token) => fetch(`http://127.0.0.1:${port}${path}`, {
  headers: { Authorization: `Bearer ${token}` },
})

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const TOKEN_PRINT = /admin token（仅此一次打印，请妥善保存）: (\S+)/
const storeOf = (dir) => createStore(join(dir, 'state.json'))

// ———————— admin 缺省 false：兼容红线（零执行） ————————

test('admin 缺省 false：零执行——不写 token 哈希、不打管理台日志、store 账号不 overlay', async () => {
  const dir = tempDir({ 'bark:account': { key: 'store-key' } })
  const rig = bootCtx()
  try {
    const resolved = apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
    })
    // overlay 零执行：v0.3.2 语义逐字节不变（bark 不进 channels）
    assert.deepEqual(resolved.channels.map((entry) => entry.type), ['webhook'])
    // token 状态零写入、管理台日志零输出
    assert.equal(storeOf(dir).get('admin:token-hash'), undefined)
    assert.ok(rig.infos.every((line) => !/管理台|token/.test(line)))
  } finally {
    await rig.cleanup()
  }
})

test('admin: {} 且 enabled 未显式 true：同样零执行（enabled 缺省 false）', async () => {
  const dir = tempDir()
  const rig = bootCtx()
  try {
    const resolved = apply(rig.ctx, { channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }], inbound: { stateDir: dir }, admin: { port: 18104 } })
    assert.deepEqual(resolved.channels.map((entry) => entry.type), ['webhook'])
    assert.equal(storeOf(dir).get('admin:token-hash'), undefined)
  } finally {
    await rig.cleanup()
  }
})

// ———————— 出站凭证 store overlay ————————

test('admin 开启 + store bark:account → 出站 overlay 生效（store-only 类型也能启用）', async () => {
  const dir = tempDir({ 'bark:account': { key: 'store-key' } })
  const rig = bootCtx()
  try {
    const resolved = apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port: await freePort() },
    })
    const bark = resolved.channels.find((entry) => entry.type === 'bark')
    assert.ok(bark !== undefined, 'bark 应经 overlay 启用')
    assert.equal(bark.config.endpoint, 'https://api.day.app/store-key', 'config 来自 store 账号')
    assert.deepEqual(resolved.channels.map((entry) => entry.type), ['webhook', 'bark'])
    assert.ok(rig.warnings.some((w) => /已启用渠道：webhook、bark/.test(w)))
  } finally {
    await rig.cleanup()
  }
})

test('overlay 字段级合并：store 字段覆盖同名 YAML 字段，YAML 独有字段保留', async () => {
  const dir = tempDir({ 'bark:account': { key: 'store-key' } })
  const rig = bootCtx()
  try {
    const resolved = apply(rig.ctx, {
      channels: [{ type: 'bark', key: 'yaml-key', timeoutMs: 7000 }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port: await freePort() },
    })
    const bark = resolved.channels.find((entry) => entry.type === 'bark')
    assert.equal(bark.config.endpoint, 'https://api.day.app/store-key', 'store.key 覆盖 YAML.key')
    assert.equal(bark.config.timeoutMs, 7000, 'YAML 独有字段 timeoutMs 保留')
  } finally {
    await rig.cleanup()
  }
})

test('overlay resolve 失败 → 降级保留 YAML 条目（只 warn，不弄崩启动）', async () => {
  const dir = tempDir({ 'bark:account': { key: '' } }) // store 把 key 覆盖成空 → merged resolve 失败
  const rig = bootCtx()
  try {
    const resolved = apply(rig.ctx, {
      channels: [{ type: 'bark', key: 'yaml-key' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port: await freePort() },
    })
    const bark = resolved.channels.find((entry) => entry.type === 'bark')
    assert.ok(bark !== undefined, 'YAML 条目原样保留（不被失败覆盖删除）')
    assert.equal(bark.config.endpoint, 'https://api.day.app/yaml-key')
    assert.ok(rig.warnings.some((w) => /沿用 YAML 配置/.test(w)))
  } finally {
    await rig.cleanup()
  }
})

test('store-only 类型凭证不完整 → 跳过该类型（不进 channels，只 warn）', async () => {
  const dir = tempDir({ 'bark:account': { device: 'x' } }) // 无 key → resolve 失败且无 YAML 兜底
  const rig = bootCtx()
  try {
    const resolved = apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port: await freePort() },
    })
    assert.equal(resolved.channels.find((entry) => entry.type === 'bark'), undefined)
    assert.ok(rig.warnings.some((w) => /bark.*跳过（state 凭证不完整）/.test(w)))
  } finally {
    await rig.cleanup()
  }
})

test('双域通道（feishu/dingtalk）不 overlay：account 键域归入站，出站只认 YAML', async () => {
  const dir = tempDir({
    'feishu:account': { appId: 'a', appSecret: 's' }, // YAML 有 webhook 行，account 不得混入
    'dingtalk:account': { appKey: 'k', appSecret: 's' }, // 无 YAML 行，不得凭 account 新增出站
  })
  const rig = bootCtx()
  try {
    const resolved = apply(rig.ctx, {
      channels: [{ type: 'feishu', webhook: 'https://open.feishu.cn/hook/yaml' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port: await freePort() },
    })
    const feishu = resolved.channels.find((entry) => entry.type === 'feishu')
    assert.ok(feishu !== undefined)
    assert.equal(feishu.config.webhook, 'https://open.feishu.cn/hook/yaml')
    assert.equal(feishu.config.appId, undefined, '入站凭证不混入出站 config')
    assert.equal(resolved.channels.find((entry) => entry.type === 'dingtalk'), undefined, 'dingtalk 不得凭 account 新增出站行')
    assert.equal(rig.warnings.some((w) => /dingtalk.*state 凭证/.test(w)), false, '双域不应触发出站回退 warn')
  } finally {
    await rig.cleanup()
  }
})

// ———————— token 策略 ————————

test('token 显式（YAML admin.token）：以其为准、哈希同步 state、state 文件不含明文', async () => {
  const dir = tempDir()
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port, token: 'explicit-tok-1' },
    })
    assert.ok(await waitHttp(port))
    assert.equal((await authGet(port, '/api/overview', 'explicit-tok-1')).status, 200)
    assert.equal((await authGet(port, '/api/overview', 'wrong-tok')).status, 401)
    assert.equal(storeOf(dir).get('admin:token-hash'), sha256Hex('explicit-tok-1'), '哈希同步到 state')
    assert.ok(!readFileSync(join(dir, 'state.json'), 'utf8').includes('explicit-tok-1'), '明文绝不落盘')
    assert.ok(rig.infos.some((line) => /Web 管理台已就绪/.test(line)))
  } finally {
    await rig.cleanup()
  }
})

test('token 自动生成（首启）：打印一次、HTTP 可用、state 只存 64 位 hex 哈希', async () => {
  const dir = tempDir()
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port },
    })
    assert.ok(await waitHttp(port))
    const printed = rig.infos.map((line) => TOKEN_PRINT.exec(line)?.[1]).find((t) => t !== undefined)
    assert.ok(printed !== undefined, '首启必须打印 token（仅此一次）')
    assert.equal((await authGet(port, '/api/overview', printed)).status, 200)
    assert.equal((await authGet(port, '/api/overview', 'guessed')).status, 401)
    const hash = storeOf(dir).get('admin:token-hash')
    assert.match(hash, /^[0-9a-f]{64}$/)
    assert.equal(hash, sha256Hex(printed), '哈希与打印的 token 对应')
    assert.ok(!readFileSync(join(dir, 'state.json'), 'utf8').includes(printed), '明文绝不落盘')
  } finally {
    await rig.cleanup()
  }
})

test('token 沿用既有哈希（第二次启动）：不重发明文，首启 token 仍可鉴权', async () => {
  const dir = tempDir({ 'admin:token-hash': sha256Hex('kept-secret-token') })
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port },
    })
    assert.ok(await waitHttp(port))
    assert.ok(rig.infos.every((line) => !TOKEN_PRINT.test(line)), '既有哈希时不得重发 token 明文')
    assert.equal((await authGet(port, '/api/overview', 'kept-secret-token')).status, 200)
    assert.equal(storeOf(dir).get('admin:token-hash'), sha256Hex('kept-secret-token'), '哈希原样不重写')
  } finally {
    await rig.cleanup()
  }
})

test('token 哈希损坏（非 64 位 hex）→ 视为无：重新生成并覆盖', async () => {
  const dir = tempDir({ 'admin:token-hash': 'garbage-not-hex' })
  const rig = bootCtx()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port: await freePort() },
    })
    assert.ok(rig.infos.some((line) => TOKEN_PRINT.test(line)), '损坏哈希按首启处理（重新生成打印）')
    const hash = storeOf(dir).get('admin:token-hash')
    assert.match(hash, /^[0-9a-f]{64}$/)
    assert.notEqual(hash, 'garbage-not-hex')
  } finally {
    await rig.cleanup()
  }
})

test('显式 token 与既有哈希不一致 → 以显式为准覆盖哈希', async () => {
  const dir = tempDir({ 'admin:token-hash': sha256Hex('old-token') })
  const rig = bootCtx()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port: await freePort(), token: 'new-token' },
    })
    assert.equal(storeOf(dir).get('admin:token-hash'), sha256Hex('new-token'))
  } finally {
    await rig.cleanup()
  }
})

// ———————— 生命周期与容错 ————————

test('EADDRINUSE：端口被占 → 只 warn 不崩插件（其余装配照常）', async () => {
  const blocker = createServer()
  await new Promise((resolve, reject) => { blocker.on('error', reject); blocker.listen(0, '127.0.0.1', resolve) })
  const port = blocker.address().port
  const dir = tempDir()
  const rig = bootCtx()
  try {
    assert.doesNotThrow(() => {
      apply(rig.ctx, {
        channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
        inbound: { stateDir: dir },
        admin: { enabled: true, port },
      })
    })
    assert.ok(await waitFor(() => rig.warnings.some((w) => /端口 .* 已被占用/.test(w))), '应有端口占用中文 warn')
    // 插件其余功能不受影响：工具照常注册、渠道照常启用
    assert.deepEqual(rig.defs.map((def) => def.name).sort(), ['notify', 'notify_test'])
    assert.ok(rig.warnings.some((w) => /已启用渠道：webhook/.test(w)))
    // token 已生成打印（端口失败不吞 token——重启成功后凭哈希继续有效）
    assert.ok(rig.infos.some((line) => TOKEN_PRINT.test(line)))
  } finally {
    await rig.cleanup()
    await new Promise((resolve) => blocker.close(() => resolve()))
  }
})

test('stop() 进 disposers：cleanup 后端口不再监听（连接拒绝）', async () => {
  const dir = tempDir()
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port, token: 'close-tok' },
    })
    assert.ok(await waitHttp(port))
    assert.equal((await authGet(port, '/api/overview', 'close-tok')).status, 200)
    await rig.cleanup()
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { Authorization: 'Bearer close-tok' } }))
  } finally {
    await rig.cleanup()
  }
})

// ———————— HTTP 集成冒烟 ————————

test('HTTP 集成：GET / 返回内嵌 UI，/api/channels 行带 fields/editable（含脱敏 config）', async () => {
  const dir = tempDir({ 'bark:account': { key: 'k' } })
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port, token: 'ui-tok' },
    })
    assert.ok(await waitHttp(port))
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    assert.ok((await page.text()).includes('dsh-notifier 管理台'))

    const channels = await (await authGet(port, '/api/channels', 'ui-tok')).json()
    const bark = channels.find((row) => row.type === 'bark' && row.direction === 'outbound')
    // 合并视图：YAML/出站 resolve 产物（endpoint/timeoutMs）⊕ store 账号（key）——均脱敏
    assert.deepEqual(bark.config, { endpoint: '***', key: '***', timeoutMs: 5000 })
    assert.ok(Object.keys(bark.fields).length > 0, 'fields 字段表随行返回（零 YAML 建单数据源）')
    const feishuOut = channels.find((row) => row.type === 'feishu' && row.direction === 'outbound')
    assert.equal(feishuOut.editable, false, '双域出站只读')
  } finally {
    await rig.cleanup()
  }
})

test('垃圾 token 防御：空/超长/非 ASCII Bearer 一律 401（verifyToken 恒时比对不炸）', async () => {
  const dir = tempDir()
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port, token: 'real-tok' },
    })
    assert.ok(await waitHttp(port))
    // ByteString 安全的垃圾值（fetch 头不允许 >255 码位——真实攻击者也受同一约束）
    for (const junk of ['', 'x'.repeat(10000), 'tökén-lätin1', 'real-tok-with-suffix']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/overview`, {
        headers: { Authorization: `Bearer ${junk}` },
      })
      assert.equal(response.status, 401, `垃圾 token（长度 ${junk.length}）必须 401 而非 500/放行`)
    }
    // 空 Authorization 头与非 Bearer 格式同样 401（server.mjs 层契约，此处冒烟）
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/overview`)).status, 401)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { Authorization: 'Basic abc' } })).status, 401)
  } finally {
    await rig.cleanup()
  }
})

// ———————— §5.5 入站通道 admin 启用信号 ————————

/** §5.5 五通道的「store 账号存在但凭证不全」预置：信号触发 → resolve 被调 → 凭证缺失 warn 跳过。
 * （完整凭证会真启长连接，测试环境不可行；「跳过 warn 出现」即证明启用信号被采纳。）
 * wechat 的 resolve 是惰性的（在大块内），需要 allowUsers 非空才走到。 */
const SIGNAL_ACCOUNTS = {
  'feishu:account': { appId: 'a' },     // 缺 appSecret
  'qq:account': { appId: 'a' },         // 缺 appSecret
  'dingtalk:account': { appKey: 'k' },  // 缺 appSecret
  'wxpusher:account': {},               // 缺 appToken（空对象也是合法启用信号）
  'wechat:account': { accountId: 'a' }, // 缺 token
}
const SKIP_KEYS = ['feishu', 'qq', 'dingtalk', 'wxpusher', 'wechat']

test('§5.5 信号生效：admin 开 + store 账号（凭证不全）→ 五通道 resolve 被触发并 warn 跳过', async () => {
  const dir = tempDir(SIGNAL_ACCOUNTS)
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir, allowUsers: ['42'] }, // allowUsers 非空：wechat 惰性 resolve 才会执行
      admin: { enabled: true, port },
    })
    for (const channel of SKIP_KEYS) {
      assert.ok(
        rig.warnings.some((w) => w.includes(`inbound.${channel} 跳过`)),
        `admin 开 + store 账号 → inbound.${channel} 启用信号生效（resolve 触发、凭证不全 warn 跳过）`,
      )
    }
    // 全部凭证不全：无任何长连接被拉起（五通道都不该有「已启动」日志）
    assert.ok(!rig.warnings.some((w) => /inbound 已启动/.test(w)), '凭证不全绝不真启动')
  } finally {
    await rig.cleanup()
  }
})

test('§5.5 对照（兼容红线）：admin 关 + 同样 store 账号 → 零启用信号（五个跳过 warn 全无）', async () => {
  const dir = tempDir(SIGNAL_ACCOUNTS)
  const rig = bootCtx()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir, allowUsers: ['42'] },
      // admin 缺省 false：store 账号不再构成启用信号（存量行为逐字节不变）
    })
    for (const channel of SKIP_KEYS) {
      assert.ok(
        !rig.warnings.some((w) => w.includes(`inbound.${channel} 跳过`)),
        `admin 关 → inbound.${channel} 不读 store 信号（YAML 显式对象才是启用阈值）`,
      )
    }
  } finally {
    await rig.cleanup()
  }
})

test('§5.5 wxpusher 凭证链尾：admin 开 + store appToken（无 YAML）→ resolve 成功 + v0.7 引导态启动', async () => {
  const dir = tempDir({ 'wxpusher:account': { appToken: 'AT_solo' } })
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      // v0.7 行为契约变更（原「空名单不启动」→「凭证就绪即启动」）：引导态下注册面开放
      // （/pair），业务面仍全拒（bus 引导态矩阵由 test/identity.test.mjs 覆盖）。
      inbound: { stateDir: dir },
      admin: { enabled: true, port },
    })
    assert.ok(!rig.warnings.some((w) => w.includes('inbound.wxpusher 跳过')),
      'store appToken 链尾兜底生效（resolve ok 而非因缺 appToken 跳过）')
    assert.ok(rig.warnings.some((w) => /inbound 已启动：wxpusher/.test(w)),
      'v0.7：allowUsers 空 + 凭证就绪 → 引导态启动（不再是死路）')
    assert.ok(rig.warnings.some((w) => /【引导配对码】/.test(w)),
      '引导态铸造 bootstrap 码（stderr 双写展示，绑定表非空后不再铸）')
  } finally {
    await rig.cleanup()
  }
})

test('v0.7 密径持久化：首次启动铸随机密径落 store；二次启动复用同一路径（不换径）', async () => {
  const dir = tempDir({ 'wxpusher:account': { appToken: 'AT_path' } })
  const readState = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port },
    })
    // 「回调服务器已监听」由 start() 内部打印，晚于装配层「已启动」日志——等它才稳
    await waitFor(() => rig.warnings.some((w) => w.includes('回调服务器已监听')))
    const first = readState()['wxpusher:webhookPath']
    assert.match(first, /^\/hook\/[0-9a-f]{32}$/, '首铸密径落盘（随机 32B hex）')
    const firstLog = rig.warnings.find((w) => w.includes('回调服务器已监听'))
    assert.ok(firstLog.includes(first), '启动日志展示的回调 URL 就是落盘密径')
  } finally {
    await rig.cleanup()
  }

  // 二次启动（同 stateDir）：复用 first，不再重铸
  const rig2 = bootCtx()
  const port2 = await freePort()
  try {
    apply(rig2.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port: port2 },
    })
    await waitFor(() => rig2.warnings.some((w) => w.includes('回调服务器已监听')))
    const secondLog = rig2.warnings.find((w) => w.includes('回调服务器已监听'))
    assert.ok(secondLog.includes(readState()['wxpusher:webhookPath']),
      '二次启动复用持久化密径（用户控制台回调 URL 不因重启失效）')
  } finally {
    await rig2.cleanup()
  }
})

test('v0.7 密径持久化：显式 webhookPath 配置仍是用户意志（不读不写持久化键）', async () => {
  const dir = tempDir({ 'wxpusher:account': { appToken: 'AT_explicit', webhookPath: '/hook/my-own' } })
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { stateDir: dir },
      admin: { enabled: true, port },
    })
    await waitFor(() => rig.warnings.some((w) => w.includes('回调服务器已监听')))
    const log = rig.warnings.find((w) => w.includes('回调服务器已监听'))
    assert.ok(log.includes('/hook/my-own'), '显式配置优先')
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))['wxpusher:webhookPath'], undefined,
      '显式配置不写持久化键（YAML 用户自管生命周期）')
  } finally {
    await rig.cleanup()
  }
})

// ———————— v0.4.0 SSE 事件流接线 ————————

test('v0.4.0 SSE 接线：notify 工具广播 → onSend → hub → GET /api/events 实时收到', async () => {
  const dir = tempDir()
  const rig = bootCtx()
  const port = await freePort()
  try {
    apply(rig.ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }], // 送达必失败——onSend 照发（failed 结果也落事件）
      inbound: { stateDir: dir },
      admin: { enabled: true, port, token: 'sse-tok' },
    })
    assert.ok(await waitHttp(port))
    // 真 HTTP 客户端打开事件流，累积文本（fetch 一次性读不适合流式断言）
    let text = ''
    let resolveTarget = null
    let resolveFn = null
    const req = get({
      host: '127.0.0.1', port, path: '/api/events',
      headers: { authorization: 'Bearer sse-tok' },
    }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
        if (resolveTarget !== null && text.includes(resolveTarget)) {
          const fn = resolveFn
          resolveTarget = null
          resolveFn = null
          fn()
        }
      })
    })
    req.on('error', () => { /* abort 属预期 */ })
    const until = (target) => new Promise((resolve, reject) => {
      if (text.includes(target)) return resolve()
      resolveTarget = target
      resolveFn = resolve
      setTimeout(() => {
        if (resolveTarget === target) {
          resolveTarget = null
          resolveFn = null
          reject(new Error(`SSE 等待超时: ${target}（已收到: ${JSON.stringify(text)}）`))
        }
      }, 4000)
    })
    try {
      await until(': connected')
      // 触发一次真实广播：notify 工具无 channel = notifyAll → onSend → hub.publish
      const notifyTool = rig.defs.find((def) => def.name === 'notify')
      assert.ok(notifyTool !== undefined, 'notify 工具已注册')
      await notifyTool.execute({ message: 'SSE 接线验证' })
      await until('SSE 接线验证')
      assert.ok(text.includes('"replay":false'), '实时事件（非缓冲重放）')
      assert.ok(text.includes('"seq":1'), '事件带序号')
      assert.ok(text.includes('webhook'), '送达结果随事件透出')
    } finally {
      req.destroy()
    }
  } finally {
    await rig.cleanup()
  }
})
