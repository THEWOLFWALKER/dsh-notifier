// dsh-notifier test/admin-ui-behavior.test.mjs
// 管理台前端行为对抗性测试（零配置首访重构版，取代旧 window.prompt 契约）。
// 新契约（交付包 §1.1/§1.2）：
//   ① 首访绝不弹 window.prompt——无 token / token 失效一律走站内解锁门（#gate）；
//   ② 启动凭证只在 URL fragment（/#token=...），验证前先清地址栏，成功响应后才写 sessionStorage；
//   ③ 认证 token 绝不写 localStorage；受限 sessionStorage 退化到当前页面内存；
//   ④ 401 → 清 token 回解锁门，单飞共享、至多自动恢复一次，迟到旧世代 401 不再开门；
//   ⑤ 首访向导：选渠道 → 填凭证 → 保存并当场真实测试，送达才视为初始化完成。
// 手段：node:vm 把 ADMIN_UI_HTML 内联 <script>（剥掉末尾 init() 自启）跑在注入
// DOM/storage/fetch/history 假体的沙箱里——真执行源码里的同一份逻辑，无复制粘贴。

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { ADMIN_UI_HTML } from '../src/admin/ui.mjs'

/** 提取内联 <script> 正文（取最后一个 script 块，防止未来加外部 script 干扰）。 */
function extractScript(html) {
  const start = html.lastIndexOf('<script>') + '<script>'.length
  const end = html.indexOf('</script>', start)
  return html.slice(start, end)
}

/** 剥掉注释后的脚本正文（静态断言用，避免注释里的词被误判为调用）。 */
function stripComments(script) {
  return script.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function makeElement(sel) {
  const listeners = {}
  const el = {
    sel,
    textContent: '',
    className: '',
    innerHTML: '',
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      contains(cls) { return el.className.split(' ').includes(cls) },
      add(cls) { if (!el.classList.contains(cls)) el.className = (el.className + ' ' + cls).trim() },
      remove(cls) { el.className = el.className.split(' ').filter((c) => c !== cls).join(' ') },
      toggle(cls, force) {
        const has = el.classList.contains(cls)
        if (force === true && !has) { el.classList.add(cls); return true }
        if (force === false && has) { el.classList.remove(cls); return false }
        if (force !== undefined) return force
        if (has) { el.classList.remove(cls); return false }
        el.classList.add(cls); return true
      },
    },
    getAttribute(name) {
      if (name.startsWith('data-')) return el.dataset[name.slice(5)] !== undefined ? el.dataset[name.slice(5)] : null
      if (name === 'class') return el.className || null
      if (name === 'hidden') return el.hidden ? '' : null
      return el[name] !== undefined ? String(el[name]) : null
    },
    setAttribute(name, val) {
      if (name.startsWith('data-')) { el.dataset[name.slice(5)] = String(val); return }
      if (name === 'class') { el.className = String(val); return }
      el[name] = val
    },
    addEventListener(evt, fn) { listeners[evt] = fn },
    removeEventListener(evt) { delete listeners[evt] },
    dispatch(evt) { const fn = listeners[evt]; if (fn) fn({ target: el, preventDefault() {} }) },
    focus() {},
    scrollIntoView() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
  }
  return el
}

async function settle() { for (let i = 0; i < 60; i += 1) await Promise.resolve() }

function resp(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

/** SSE 200 响应假体：流式端点最小形状（首读即 done，触发重连退避分支但不计时）。 */
function sseOk() {
  return { status: 200, ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) }, json: async () => ({}) }
}

/** loadAll 六个端点的正常响应体。 */
function okBody(url) {
  if (url === '/api/overview') return { channels: [], sessions: { active: 0, total: 0 }, agents: { keys: 0 }, members: { total: 0 }, audit: [] }
  if (url === '/api/channels' || url === '/api/questions' || url === '/api/sessions') return []
  return {}
}

/** 可手动控制 resolve 顺序的 fetch：把每个待决请求排进 pending 队列。 */
function queueableFetch() {
  const pending = []
  return {
    pending,
    impl: async (url, init) => new Promise((resolve) => {
      pending.push({ resolve, url, auth: init.headers.Authorization })
    }),
  }
}

/**
 * 启动 UI 沙箱。返回活动句柄：
 *  - 脚本导出函数（api/acquireToken/onUnlockSubmit/setupSave/renderDashboard/…）
 *  - els（selector → 假元素）、lists（selector → querySelectorAll 注册表）
 *  - store（sessionStorage 假体）、localStore（localStorage 假体）
 *  - prompts()（陷阱：新契约下必须永远为空）、replaceStateTaps()、setFetch()
 */
function boot() {
  const els = new Map()
  const lists = new Map()
  const document = {
    hidden: false,
    querySelector: (sel) => {
      if (!els.has(sel)) els.set(sel, makeElement(sel))
      return els.get(sel)
    },
    querySelectorAll: (sel) => lists.get(sel) || [],
    createElement: () => makeElement('div'),
  }
  const makeStore = () => {
    const data = new Map()
    return {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => data.set(k, String(v)),
      removeItem: (k) => data.delete(k),
      has: (k) => data.has(k),
    }
  }
  const store = makeStore()
  const localStore = makeStore()
  const promptTaps = []
  const confirmTaps = []
  const timeoutTaps = []
  const replaceStateTaps = []
  let fetchImpl = async () => resp(200, {})
  let confirmImpl = () => true
  const sandbox = { window: {}, document, localStorage: localStore, sessionStorage: store }
  sandbox.window.localStorage = localStore
  sandbox.window.sessionStorage = store
  sandbox.window.location = { origin: 'http://127.0.0.1:8104', pathname: '/', search: '', hash: '' }
  sandbox.window.history = { replaceState: (a, b, url) => { replaceStateTaps.push(String(url)) } }
  sandbox.window.navigator = {}
  sandbox.navigator = sandbox.window.navigator
  // prompt 陷阱：新契约下任何一次调用都是回归（交付包：首次页面不得自动弹 window.prompt）
  sandbox.window.prompt = (...args) => { promptTaps.push(args); return '' }
  sandbox.prompt = sandbox.window.prompt
  sandbox.window.confirm = (...args) => { confirmTaps.push(args); return confirmImpl(...args) }
  sandbox.confirm = sandbox.window.confirm
  sandbox.fetch = async (...args) => fetchImpl(...args)
  sandbox.setTimeout = (fn, ms) => { timeoutTaps.push({ fn, ms }); return timeoutTaps.length }
  sandbox.clearTimeout = () => {}
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}

  const wrapped = `(() => {
${extractScript(ADMIN_UI_HTML).replace(/\ninit\(\)\s*$/, '\n')}
;return { api, acquireToken, reloginGate, adoptToken, setToken, getToken, setCandidateToken,
  renderTokenState, renderDashboard, renderChannels, renderBindings, renderSessions, renderMembers,
  renderPendingQuestions, renderSetup, setupSelect, setupSave, setupTest, setupSubmit, dismissSetup,
  finishSetup, bannerTest, onSetupClick, onNextActionClick, onBannerClick, overviewChannels, switchTab,
  handleStream401, startNotifyStream, stopNotifyStream, loadAll, loadChannelsOnly, init,
  onUnlockSubmit, onUnlockCancel, onUnlockPeek, onTokenStateClick, showGate, hideGate,
  readFragmentToken, clearFragment, renderEntryPoint, copyEntryPoint, esc,
  _getState: function () { return state },
  _setOverview: function (o) { state.overview = o },
  _setChannels: function (c) { state.channels = c },
  _setMembers: function (m) { state.members = m },
  _authGen: function () { return authGen }, _setAuthGen: function (v) { authGen = v },
  _recoveryUsed: function () { return recoveryUsed },
  _gateShows: function () { return gateShows }, _gateMode: function () { return gateMode },
  _setupStep: function () { return setupStep },
  _notifyStreamEpoch: function () { return notifyStreamEpoch } }
})()`
  const context = vm.createContext(sandbox)
  const exports_ = vm.runInContext(wrapped, context, { filename: 'admin-ui-inline.mjs' })
  // 与 markup 的初始 hidden 态对齐：门 / 向导 / 横幅 / 向导 2-4 步面板起始隐藏
  for (const [sel, hidden] of [['#gate', true], ['#verifyBanner', true], ['#setup', true],
    ['#setupPane1', false], ['#setupPane2', true], ['#setupPane3', true], ['#setupPane4', true]]) {
    document.querySelector(sel).hidden = hidden
  }
  return {
    ...exports_,
    window: sandbox.window,
    els,
    lists,
    store,
    localStore,
    prompts: () => promptTaps.slice(),
    confirms: () => confirmTaps.slice(),
    timeouts: () => timeoutTaps.slice(),
    replaceStateTaps: () => replaceStateTaps.slice(),
    setFetch: (f) => { fetchImpl = f },
    setConfirm: (c) => { confirmImpl = c },
  }
}

/** 驱动解锁门：向输入框写入 token 并提交表单（等价于用户点击「进入管理台」）。 */
function driveGate(rig, token) {
  rig.els.get('#unlockInput').value = token
  rig.onUnlockSubmit()
}

// ————————————————— A. fragment 启动凭证（零配置首访主路径）—————————————————

test('fragment 启动凭证：/#token= 静默验证、先清地址栏、成功后才写 sessionStorage', async () => {
  const rig = boot()
  rig.window.location.hash = '#token=LAUNCH-1'
  const auths = []
  rig.setFetch(async (url, init) => {
    auths.push(init.headers.Authorization)
    if (url === '/api/events') return sseOk()
    return resp(200, okBody(url))
  })
  rig.init()
  await settle()
  assert.equal(rig.replaceStateTaps().length, 1, '地址栏 fragment 被清除')
  assert.equal(rig.replaceStateTaps()[0], '/', '清 fragment 保留 path，token 不进历史/书签')
  assert.equal(rig._gateShows(), 0, '有效启动凭证不经过解锁门')
  assert.equal(rig.prompts().length, 0, '绝不弹 window.prompt')
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'LAUNCH-1', '验证成功后写 sessionStorage')
  assert.equal(rig.localStore.has('dsh-admin-session-token'), false, 'token 绝不写 localStorage')
  assert.equal(auths.length, 1, '恢复报告请求携带启动 token')
  assert.ok(auths.every((a) => a === 'Bearer LAUNCH-1'))
})

test('fragment 凭证失效：先清地址栏再回解锁门，专属原因可见；改输有效 token 后恢复', async () => {
  const rig = boot()
  rig.window.location.hash = '#token=STALE'
  let good = false
  rig.setFetch(async (url, init) => {
    if (!good) return resp(401, { error: 'unauthorized' })
    if (url === '/api/events') return sseOk()
    return resp(200, okBody(url))
  })
  rig.init()
  await settle()
  assert.equal(rig._gateShows(), 1, '全部 401 共享一扇解锁门（无重试风暴）')
  assert.equal(rig.replaceStateTaps().length, 1, '验证前 fragment 已从地址栏清除')
  assert.equal(rig.store.has('dsh-admin-session-token'), false, '失效候选不落会话')
  assert.match(rig.els.get('#unlockError').textContent, /启动链接中的凭证无效或已过期/,
    'fragment 专属原因不被 401 通用文案覆盖')
  assert.equal(rig.prompts().length, 0)
  good = true
  driveGate(rig, 'FRESH')
  await settle()
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'FRESH', '重新输入有效 token 后持久化')
  assert.equal(rig.els.get('#gate').hidden, true, '恢复后门收起')
})

test('fragment 解析：仅认 #token= 参数；query 里的 token 样串不被采信', () => {
  const rig = boot()
  rig.window.location.hash = '#token=abc123'
  assert.equal(rig.readFragmentToken(), 'abc123')
  rig.window.location.hash = '#token=' + encodeURIComponent('a b+c')
  assert.equal(rig.readFragmentToken(), 'a b+c', 'URL 编码字符正确解码')
  rig.window.location.hash = '#foo=1&token=zzz'
  assert.equal(rig.readFragmentToken(), 'zzz')
  rig.window.location.hash = '#foo=1'
  assert.equal(rig.readFragmentToken(), '')
  rig.window.location.hash = ''
  assert.equal(rig.readFragmentToken(), '')
  // token 绝不从 query 读取（交付包：不得放 query / Referer）
  rig.window.location.search = '?token=query-leak'
  assert.equal(rig.readFragmentToken(), '')
  // 清 fragment 保留 path 与既有 query
  rig.clearFragment()
  assert.equal(rig.replaceStateTaps()[rig.replaceStateTaps().length - 1], '/?token=query-leak'.replace('token=query-leak', 'token=query-leak'),
    'clearFragment 只去 fragment（保留 path+query）')
})

test('无 token 首访：解锁门单飞挡住 loadAll+SSE，提交后全部放行', async () => {
  const rig = boot()
  const auths = []
  rig.setFetch(async (url, init) => {
    auths.push(init.headers.Authorization)
    if (url === '/api/events') return sseOk()
    return resp(200, okBody(url))
  })
  rig.init()
  await settle()
  assert.equal(rig._gateShows(), 1, '报告读取打开解锁门')
  assert.equal(auths.length, 0, '解锁前不发出任何带凭证请求')
  assert.equal(rig.prompts().length, 0, '绝不弹 window.prompt')
  assert.equal(rig.els.get('#gate').hidden, false, '门可见')
  driveGate(rig, 'GATE-OK')
  await settle()
  assert.equal(auths.length, 1, '提交后报告请求放行')
  assert.ok(auths.every((a) => a === 'Bearer GATE-OK'))
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'GATE-OK')
  assert.equal(rig.els.get('#gate').hidden, true, '解锁后门收起')
})

// ————————————————— B. 解锁门单飞与持久化 —————————————————

test('并发首访：5 个并行 api 只开一次解锁门，成功响应后才落 sessionStorage', async () => {
  const rig = boot()
  rig.setFetch(async () => resp(200, { ok: true }))
  const reqs = [rig.api('/api/a'), rig.api('/api/b'), rig.api('/api/c'), rig.api('/api/d'), rig.api('/api/e')]
  await settle()
  assert.equal(rig._gateShows(), 1, '并发首访共享同一扇解锁门（旧实现 5 个叠加 prompt）')
  assert.equal(rig.store.has('dsh-admin-session-token'), false, '验证成功前不落会话')
  driveGate(rig, 'OKT0KEN')
  await Promise.all(reqs)
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'OKT0KEN', '成功后会话持久化（刷新无需重输）')
  assert.equal(rig.localStore.has('dsh-admin-session-token'), false, 'token 绝不写 localStorage')
  await rig.api('/api/f')
  assert.equal(rig._gateShows(), 1, '持久化后后续请求不再开门')
  assert.equal(rig.prompts().length, 0)
})

test('解锁门空提交：不兑现、原地提示、门不收起；随后有效提交正常放行', async () => {
  const rig = boot()
  rig.setFetch(async () => resp(200, { ok: true }))
  const p = rig.api('/api/x')
  await settle()
  driveGate(rig, '   ')
  await settle()
  const errEl = rig.els.get('#unlockError')
  assert.equal(errEl.hidden, false, '空提交给出可见错误')
  assert.match(errEl.textContent, /请输入访问 token/)
  assert.equal(rig.els.get('#gate').hidden, false, '空提交后门不收起')
  assert.equal(rig.store.has('dsh-admin-session-token'), false, '空提交不留任何 token')
  driveGate(rig, 'GOOD')
  await p
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'GOOD')
})

test('首访候选 token 绝不进 sessionStorage（除非请求成功）', async () => {
  const rig = boot()
  rig.setFetch(async () => resp(401, { error: 'unauthorized' }))
  const p = rig.api('/api/x')
  await settle()
  driveGate(rig, '  W00D0N  ') // 带空白 → trim 后作候选
  await settle()
  assert.equal(rig.store.getItem('dsh-admin-session-token'), null, '首次候选被拒后不得持久化')
  assert.equal(rig._gateShows(), 2, '候选 401 自动重开一次门（单次恢复）')
  driveGate(rig, 'ALSOBAD')
  await assert.rejects(p, /已按一次自动重登录处理/)
  assert.equal(rig.store.getItem('dsh-admin-session-token'), null, '重试候选同样不落会话')
  assert.equal(rig.getToken(), '', '失败候选清除')
  assert.equal(rig.prompts().length, 0)
})

// ————————————————— C. 401 单次重登录（门版） —————————————————

test('并发 401：共享单飞重登录门——一次开门、各自用新 token 重试一次、成功后持久化', async () => {
  const rig = boot()
  rig.setToken('OLD')
  const q = queueableFetch()
  rig.setFetch(q.impl)

  const pA = rig.api('/api/a')
  const pB = rig.api('/api/b')
  await settle()
  assert.equal(q.pending.filter((x) => x.auth === 'Bearer OLD').length, 2, '两请求都带旧 token 发出')
  q.pending.filter((x) => x.auth === 'Bearer OLD').forEach((x) => x.resolve(resp(401, { error: 'x' })))
  await settle()
  assert.equal(rig._gateShows(), 1, '两并发 401 共享一次开门（旧实现会 2 连弹）')
  driveGate(rig, 'NEWTKN')
  await settle()
  const retries = q.pending.filter((x) => x.auth === 'Bearer NEWTKN')
  assert.equal(retries.length, 2, '两条请求都用新 token 重试一次')
  retries.forEach((x) => x.resolve(resp(200, { ok: true })))
  await pA
  await pB
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'NEWTKN', '重登录成功后才持久化')
  assert.equal(rig._recoveryUsed(), false, '成功响应重新允许未来自动恢复')
  assert.equal(rig.prompts().length, 0)
})

test('401 迟到旧世代：并发请求之一仍未落地时重登录已完成——迟到 401 过期，不再开第二轮门', async () => {
  const rig = boot()
  rig.setToken('OLD')
  const q = queueableFetch()
  rig.setFetch(q.impl)

  const pA = rig.api('/api/a')
  const pB = rig.api('/api/b')
  await settle()
  const olds = q.pending.filter((x) => x.auth === 'Bearer OLD')
  assert.equal(olds.length, 2)
  olds[0].resolve(resp(401, { error: 'x' }))
  await settle()
  assert.equal(rig._gateShows(), 1, '第一个 401 触发单次开门')
  driveGate(rig, 'NEWTKN')
  await settle()
  const retry = q.pending.find((x) => x.auth === 'Bearer NEWTKN')
  assert.ok(retry, '新 token 重试请求已发出')
  retry.resolve(resp(200, { ok: true }))
  await pA
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'NEWTKN')
  olds[1].resolve(resp(401, { error: 'x' }))
  await assert.rejects(pB, /已失效的 token/)
  assert.equal(rig._gateShows(), 1, '迟到旧世代 401 不再触发第二轮开门')
})

test('错 token：一次 401 至多自动重登录一次；失败后解除武装，不再自动开门循环', async () => {
  const rig = boot()
  rig.setToken('BAD')
  rig.setFetch(async () => resp(401, { error: 'x' }))

  const p1 = rig.api('/api/x')
  await settle()
  driveGate(rig, 'ALSOBAD')
  await assert.rejects(p1, /自动重登录处理/)
  assert.equal(rig._gateShows(), 1, '一个 401 恰好一次自动重登录')
  assert.equal(rig._recoveryUsed(), true, '失败后不重新自动恢复')
  assert.equal(rig.getToken(), '', '重试后仍 401 时必须清掉无效候选 token')
  // 再次显式调用：无 stored token → 开一次门；401 已解除武装 → 直接拒绝，不自动再试
  const p2 = rig.api('/api/x')
  await settle()
  assert.equal(rig._gateShows(), 2, '每次显式调用至多一次开门——无自动循环')
  driveGate(rig, 'THIRD')
  await assert.rejects(p2, /已自动重试一次/)
  assert.equal(rig._gateShows(), 2, '解除武装后不再自动开门')
  assert.equal(rig.prompts().length, 0)
})

// ————————————————— D. SSE 与手动换 token —————————————————

test('SSE：401 走共享重登录门，一次开门后重连，再 401 不再开门（提示手动更新）', async () => {
  const rig = boot()
  rig.setToken('OLD')
  let eventFetches = 0
  rig.setFetch(async () => { eventFetches += 1; return resp(401, { error: 'x' }) })

  rig.startNotifyStream()
  await settle()
  assert.equal(rig._gateShows(), 1, 'SSE 401 与 api 共享单飞重登录门')
  driveGate(rig, 'NEWTKN')
  await settle()
  assert.equal(eventFetches, 2, '旧 token 连接 + 新 token 重连各一次')
  assert.ok(rig.els.get('#nStream').textContent.includes('已自动重试一次'),
    '第二次 401 不再开门：' + rig.els.get('#nStream').textContent)
  assert.equal(rig._gateShows(), 1)
})

test('SSE 首访缺 token：与并发 api 共享单飞解锁门（不叠门），成功后持久化', async () => {
  const rig = boot()
  const auths = []
  rig.setFetch(async (url, init) => {
    auths.push(init.headers.Authorization)
    return sseOk()
  })
  const load = rig.loadAll()
  rig.startNotifyStream()
  await settle()
  assert.equal(rig._gateShows(), 1, 'SSE + 并行 api 共享同一扇门')
  driveGate(rig, 'NEW')
  await load
  await settle()
  assert.equal(auths.length, 2, '报告请求与 SSE 均使用解锁凭证')
  assert.ok(auths.every((a) => a === 'Bearer NEW'), '所有请求都用解锁得到的 token')
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'NEW', 'SSE 连接成功后会话持久化')
})

test('手动换 token：change 门带取消；提交候选在成功后才写会话并推进世代；取消不动现状', async () => {
  const rig = boot()
  rig.setToken('OLD')
  rig.setFetch(async (url) => (url === '/api/events' ? sseOk() : resp(200, okBody(url))))
  rig.init()
  await settle()
  assert.equal(rig._gateShows(), 0, '会话有效时 init 不开门')
  const n0 = rig._authGen()
  // 取消路径：开门 → 取消 → token 与世代不变
  rig.onTokenStateClick()
  assert.equal(rig._gateMode(), 'change', '已有会话时走更换模式')
  assert.equal(rig.els.get('#unlockCancel').hidden, false, 'change 门显示取消键')
  rig.onUnlockCancel()
  assert.equal(rig.getToken(), 'OLD', '取消后原 token 不变')
  assert.equal(rig._authGen(), n0, '取消不推进世代')
  // 提交路径：候选先进内存，成功响应后才写会话
  rig.onTokenStateClick()
  driveGate(rig, 'MANUAL')
  await settle()
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'MANUAL', '手动 token 经成功响应后写入会话')
  assert.equal(rig._authGen(), n0 + 1, '手动换 token 推进世代（旧请求迟到 401 判过期）')
})

test('受限 sessionStorage：读写抛错时仍使用当前页面内存，不崩也不触及 localStorage', async () => {
  const rig = boot()
  rig.store.getItem = () => { throw new Error('SecurityError') }
  rig.store.setItem = () => { throw new Error('QuotaExceededError') }
  rig.store.removeItem = () => { throw new Error('SecurityError') }
  rig.setFetch(async () => resp(200, { ok: true }))
  const p = rig.api('/api/overview')
  await settle()
  driveGate(rig, 'MEMORY')
  await p
  assert.equal(rig.getToken(), 'MEMORY', '存储不可用时当前页面仍保留已验证 token')
  assert.equal(rig.localStore.has('dsh-admin-session-token'), false, '认证 token 不回退写入 localStorage')
})

test('迟到 SSE 401：新会话 token 保持不变，旧流不触发第二次登录', async () => {
  const rig = boot()
  rig.setToken('OLD')
  const q = queueableFetch()
  rig.setFetch(q.impl)
  rig.startNotifyStream()
  await settle()
  assert.equal(q.pending.length, 1)
  rig._setAuthGen(1)
  rig.setCandidateToken('NEW')
  q.pending[0].resolve(resp(401, { error: 'expired' }))
  await settle()
  assert.equal(rig.getToken(), 'NEW', '迟到旧流 401 不得清除新 token')
  assert.match(rig.els.get('#nStream').textContent, /旧会话请求已失效/)
  assert.equal(rig._gateShows(), 0, '迟到旧流不再开门')
  assert.equal(rig.prompts().length, 0)
})

test('入口与退出：当前 loopback 地址可见，退出仅清会话 token 并使流世代失效', async () => {
  const rig = boot()
  rig.setToken('SESSION')
  rig.setFetch(async (url) => (url === '/api/events' ? sseOk() : resp(200, okBody(url))))
  assert.equal(rig.renderEntryPoint(), 'http://127.0.0.1:8104/')
  assert.equal(rig.els.get('#entryUrl').textContent, 'http://127.0.0.1:8104/')
  rig.init()
  await settle()
  const gen0 = rig._authGen()
  const epoch0 = rig._notifyStreamEpoch()
  rig.els.get('#btnLogout').dispatch('click')
  assert.equal(rig.getToken(), '', '退出后没有可用 token')
  assert.equal(rig.store.has('dsh-admin-session-token'), false, '会话存储同步清除')
  assert.ok(rig._authGen() > gen0, '退出推进世代')
  assert.ok(rig._notifyStreamEpoch() > epoch0, '退出使旧 SSE 流失效')
})

// ————————————————— E. 静态契约（鉴权 / 存储 / 窄屏 / 无障碍） —————————————————

test('静态契约：脚本绝不调用 window.prompt / prompt（站内解锁门取而代之）', () => {
  const script = extractScript(ADMIN_UI_HTML)
  const code = stripComments(script)
  assert.doesNotMatch(code, /(?:window\.)?prompt\s*\(/, '交付包红线：首次页面不得自动弹 window.prompt')
  assert.ok(script.includes('showGate') && script.includes('acquireToken'), '站内解锁门路径存在')
})

test('静态契约：站内解锁门齐备（dialog/alert/password/autocomplete-off），初始隐藏', () => {
  const html = ADMIN_UI_HTML
  assert.match(html, /<div id="gate" class="gate" hidden>/, '门初始隐藏')
  assert.match(html, /role="dialog" aria-modal="true"/, '门是模态对话框')
  assert.match(html, /<form id="unlockForm" autocomplete="off">/, '表单关自动完成')
  assert.match(html, /<input id="unlockInput" type="password"/, 'token 掩码输入')
  assert.match(html, /id="unlockError" class="gate-err" role="alert" hidden/, '错误以 alert 角色播报')
  assert.match(html, /id="unlockCancel" hidden/, '取消键默认隐藏（acquire 模式无取消）')
})

test('静态契约：认证 token 只用 sessionStorage；localStorage 全部访问点包 try/catch', () => {
  const script = extractScript(ADMIN_UI_HTML)
  assert.match(script, /sessionStorage/, '会话级持久化存在')
  assert.doesNotMatch(script, /localStorage[\s\S]{0,80}TOKEN_KEY|TOKEN_KEY[\s\S]{0,80}localStorage/,
    '认证 token 不得落 localStorage')
  // 受限/隐私环境 localStorage 可能抛 SecurityError / QuotaExceededError：所有读写必须 try/catch
  const code = stripComments(script)
  let idx = -1
  let count = 0
  while ((idx = code.indexOf('localStorage', idx + 1)) !== -1) {
    count += 1
    const ctx = code.slice(Math.max(0, idx - 250), idx + 120)
    assert.ok(ctx.includes('try'), 'localStorage 访问须在 try/catch 内：…' + ctx.slice(-160).replace(/\s+/g, ' '))
  }
  assert.ok(count >= 6, 'localStorage 访问点应被逐一覆盖（实际 ' + count + ' 处）')
})

test('静态契约：fragment 是唯一 URL 凭证通道；token 不进 query/日志', () => {
  const script = extractScript(ADMIN_UI_HTML)
  assert.ok(script.includes('readFragmentToken'), 'fragment 读取器存在')
  const code = stripComments(script)
  assert.ok(code.includes('location.hash'), 'token 只从 location.hash 读取')
  assert.doesNotMatch(code, /location\.search[\s\S]{0,40}token/i, 'token 不得从 query 读取')
  assert.ok(code.includes('replaceState'), '验证前用 replaceState 清地址栏（不进历史）')
})

test('静态契约：窄屏与无障碍——viewport、≤768px 媒体查询、44px 触控目标、aria-live、reduced-motion', () => {
  const html = ADMIN_UI_HTML
  assert.ok(html.includes('<meta name="viewport"'), '应有 viewport meta')
  assert.ok(html.includes('width=device-width'), 'viewport 应含 width=device-width')
  assert.ok(html.includes('@media (max-width: 768px)'), '应有 ≤768px 媒体查询')
  assert.ok(html.includes('min-height: 44px'), '移动端按钮/输入应有 44px 触控目标')
  assert.match(html, /role="status" aria-live="polite"/, '加载/恢复状态应由辅助技术播报')
  assert.ok(html.includes('prefers-reduced-motion'), '动效应尊重 prefers-reduced-motion')
})













// ————————————————— F. 首访向导行为（交付包核心链路） —————————————————

/** 构造一条模拟的 overview 通道行 */
function outRow(type, configured, enabled) {
  return { type, direction: 'outbound', configured, enabled }
}
function inRow(type, configured) {
  return { type, direction: 'inbound', configured, enabled: configured }
}
function makeOverview({ outChannels = [], members = 0, sessions = 0 } = {}) {
  return {
    channels: outChannels,
    sessions: { active: 0, total: sessions },
    agents: { keys: 0 },
    members: { total: members, owners: members > 0 ? 1 : 0, guided: members === 0 },
    audit: [],
  }
}
/** 构造一个向导表单输入假体 */
function makeInput(key, value, required) {
  const el = makeElement('input')
  el.setAttribute('data-sf', key)
  if (required) el.setAttribute('data-req', '1')
  el.value = value
  return el
}

















// ————————————————— G. 首页渲染 —————————————————









// ————————————————— H. 保留契约（危险确认 / 结算编码 / 提问面板 / 角标 / 剪贴板） —————————————————













test('入口复制：Clipboard 成功与失败/不可用均给出可读反馈', async () => {
  const rig = boot()
  const copied = []
  rig.window.navigator.clipboard = { writeText: async (value) => { copied.push(value) } }
  await rig.copyEntryPoint()
  assert.deepEqual(copied, ['http://127.0.0.1:8104/'], '复制成功应写入精确 loopback 地址')
  assert.match(rig.els.get('#globalMsg').textContent, /管理台地址已复制/)

  rig.window.navigator.clipboard = { writeText: async () => { throw new Error('NotAllowedError') } }
  await rig.copyEntryPoint()
  assert.match(rig.els.get('#globalMsg').textContent, /复制失败.*当前地址已显示在顶部，可手动复制/)

  rig.window.navigator.clipboard = undefined
  await rig.copyEntryPoint()
  assert.match(rig.els.get('#globalMsg').textContent, /当前地址已显示在顶部，可手动复制/)
})


test('recovery entry reads only the shared report and has no daily administration markup', async () => {
  const rig = boot(), calls = []
  rig.setToken('RECOVERY')
  rig.setFetch(async (url, init) => { calls.push([url, init.method ?? 'GET']); return resp(200, {}) })
  rig.init(); await settle()
  assert.deepEqual(calls, [['/api/diagnostics', 'GET']])
  assert.match(ADMIN_UI_HTML, /data-mode="recovery"/)
  for (const id of ['setup', 'tab-dashboard', 'tab-channels', 'tab-members', 'tab-bindings', 'tab-sessions']) assert.ok(!ADMIN_UI_HTML.includes('id="' + id + '"'))
})
