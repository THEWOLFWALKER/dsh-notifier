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
  assert.equal(auths.length, 7, 'loadAll 6 个 API + 1 个 SSE 连接均携带启动 token')
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

test('无 token 首访：解锁门单飞挡住 loadAll+SSE（7 请求共享一扇门），提交后全部放行', async () => {
  const rig = boot()
  const auths = []
  rig.setFetch(async (url, init) => {
    auths.push(init.headers.Authorization)
    if (url === '/api/events') return sseOk()
    return resp(200, okBody(url))
  })
  rig.init()
  await settle()
  assert.equal(rig._gateShows(), 1, '6 个并行 API + SSE 共享同一扇解锁门')
  assert.equal(auths.length, 0, '解锁前不发出任何带凭证请求')
  assert.equal(rig.prompts().length, 0, '绝不弹 window.prompt')
  assert.equal(rig.els.get('#gate').hidden, false, '门可见')
  driveGate(rig, 'GATE-OK')
  await settle()
  assert.equal(auths.length, 7, '提交后 6 个 API + SSE 全部放行')
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
  assert.equal(auths.length, 7, '6 个并行 api + 1 个 SSE 连接')
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

test('静态契约：向导/导航 data-tab 均指向真实存在的标签页容器', () => {
  const html = ADMIN_UI_HTML
  const tabButtonRe = /<button[^>]*class="[^"]*tabbtn[^"]*"[^>]*data-tab="([^"]+)"/g
  const navSection = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))
  const navTabs = [...navSection.matchAll(tabButtonRe)].map((m) => m[1])
  for (const t of ['dashboard', 'channels', 'members', 'notify', 'bindings', 'sessions']) {
    assert.ok(navTabs.includes(t), 'nav 含 ' + t)
  }
  const doneSection = html.slice(html.indexOf('id="setupPane4"'), html.indexOf('class="setup-foot"'))
  const doneTabs = [...doneSection.matchAll(tabButtonRe)].map((m) => m[1])
  assert.ok(doneTabs.includes('channels') && doneTabs.includes('members'), '完成页直达渠道与成员')
  for (const t of doneTabs) assert.ok(navTabs.includes(t), '完成页引用的 tab 存在：' + t)
  for (const t of navTabs) assert.ok(html.includes('id="tab-' + t + '"'), 'tab 容器存在：' + t)
})

test('静态契约：首访向导四步结构齐备，主按钮文案即完成条件', () => {
  const html = ADMIN_UI_HTML
  assert.ok(html.includes('id="setup"'), '向导容器存在')
  for (const s of ['1', '2', '3', '4']) assert.ok(html.includes('data-step="' + s + '"'), '步骤轨 ' + s)
  for (const s of ['1', '2', '3', '4']) assert.ok(html.includes('id="setupPane' + s + '"'), '步骤面板 ' + s)
  assert.ok(html.includes('id="setupGoTest"'), '保存并测试按钮存在')
  assert.ok(html.includes('保存并发送测试通知'), '主按钮文案即完成条件')
  assert.ok(html.includes('id="setupSkip"'), '可跳过（不阻塞进入管理台）')
  assert.ok(html.includes('先把通知送到你手上'), '向导目标一句话')
})

test('静态契约：首屏四态进度轨、个人模式默认、高级设置显式开启', () => {
  const html = ADMIN_UI_HTML
  for (const label of ['未配置', '已保存', '已测试', '正常运行']) {
    assert.ok(html.includes(label), '进度轨含状态 ' + label)
  }
  assert.match(html, /id="modeToggle"[^>]*>打开高级设置</, '高级设置必须有明确入口')
  assert.match(html, /class="tabbtn advanced-tab"[^>]*data-tab="bindings"[^>]*hidden/, '绑定矩阵默认隐藏')
  assert.match(html, /class="tabbtn advanced-tab"[^>]*data-tab="sessions"[^>]*hidden/, '会话默认隐藏')
  assert.ok(html.includes('MODE_KEY') && html.includes("'advanced'"), '模式切换必须是显式个人/高级状态')
})

test('静态契约：YAML 仅作为高级入口，空通道状态给出字段配置指引', () => {
  const html = ADMIN_UI_HTML
  assert.ok(html.includes('YAML 仅作为高级入口'), 'YAML 不作为默认路径')
  assert.ok(html.includes('按字段配置'), '空状态指向字段驱动的通道页')
  assert.ok(html.includes('YAML 仍可用于自动部署与高级配置，但不是默认路径'), '向导页脚说清 YAML 定位')
  assert.ok(html.includes('打开高级设置'), '界面说明高级设置入口')
})

test('静态契约：测试通知成功/失败均给出下一步与重试文案', () => {
  const html = ADMIN_UI_HTML
  assert.ok(html.includes('下一步：回首页确认运行状态'), '成功测试给出后续路径')
  assert.ok(html.includes('检查必填凭证后重试'), '失败测试给出可执行重试路径')
  assert.ok(html.includes('测试失败：'), '异常响应可见')
  assert.ok(html.includes('保存成功不等于通知可达'), '向导明确「保存 ≠ 可达」')
})

test('静态契约：首访快速路径——向导完成页直达渠道/成员，解锁门说清回环与存储边界', () => {
  const html = ADMIN_UI_HTML
  const doneSection = html.slice(html.indexOf('id="setupPane4"'), html.indexOf('class="setup-foot"'))
  assert.match(doneSection, /data-tab="channels"/, '完成页可去配置手机回复')
  assert.match(doneSection, /data-tab="members"/, '完成页可去配对成员')
  assert.ok(html.includes('仅 127.0.0.1 回环可访问'), '解锁门标明仅本机回环')
  assert.ok(html.includes('绝不写入 localStorage'), '解锁门说清 token 存储边界')
  assert.ok(html.includes('observe + approve 已开启'), '个人模式默认 observe+approve')
  assert.ok(html.includes('converse 可按需开启'), 'converse 按需开启')
  assert.ok(html.includes('群聊控制默认关闭'), '群聊控制默认关闭')
  assert.ok(html.includes('高级设置默认隐藏'), '高级设置默认隐藏')
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

test('首访向导：无已启用出站 + 未验证 → 向导显示，推荐瓷砖在前、入站不进向导', () => {
  const rig = boot()
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', false, false)] }))
  rig._setChannels([
    { type: 'ntfy', direction: 'outbound', configured: false, fields: {}, config: {} },
    { type: 'bark', direction: 'outbound', configured: false, fields: { key: { required: true } }, config: {} },
    { type: 'feishu', direction: 'inbound', configured: false, fields: {}, config: {} },
  ])
  const rail = ['1', '2', '3', '4'].map((s) => { const el = makeElement('li'); el.setAttribute('data-step', s); return el })
  rig.lists.set('#setupRail [data-step]', rail)
  rig.renderDashboard()
  assert.equal(rig.els.get('#setup').hidden, false, '向导显示')
  const tiles = rig.els.get('#setupTiles').innerHTML
  assert.ok(tiles.includes('data-setup-type="bark"'), '渠道瓷砖渲染')
  assert.ok(tiles.includes('推荐'), '推荐渠道带推荐标')
  assert.ok(tiles.indexOf('bark') < tiles.indexOf('ntfy'), '推荐渠道排在普通渠道前')
  assert.ok(!tiles.includes('data-setup-type="feishu"'), '入站渠道不进首访向导')
  assert.ok(tiles.includes('全部 2 个渠道'), '非推荐渠道收进展开区')
  assert.ok(rail[0].classList.contains('current') && !rail[0].classList.contains('done'), '步骤轨定位第 1 步')
})

test('首访向导：选渠道后进入填凭证步，必填字段标星、描述入 placeholder', () => {
  const rig = boot()
  rig._setChannels([{ type: 'bark', direction: 'outbound', configured: false, fields: { key: { required: true, desc: 'Bark 设备 key' }, barkUrl: { required: false } }, config: {} }])
  rig.setupSelect('bark')
  assert.equal(rig._setupStep(), 2)
  assert.equal(rig.els.get('#setupPane1').hidden, true)
  assert.equal(rig.els.get('#setupPane2').hidden, false)
  assert.equal(rig.els.get('#setupFormTitle').textContent, '填写 Bark 凭证')
  const form = rig.els.get('#setupForm').innerHTML
  assert.ok(form.includes('data-sf="key"'), '字段行渲染')
  assert.ok(form.includes('data-req="1"'), '必填字段带标记')
  assert.ok(form.includes('Bark 设备 key'), '字段描述入 placeholder')
  assert.ok(form.indexOf('data-sf="key"') < form.indexOf('data-sf="barkUrl"'), '必填字段排在前')
})

test('首访向导：必填缺失 / 无修改（*** 未动）不发出任何请求', () => {
  const rig = boot()
  rig.setToken('T')
  rig._setChannels([{ type: 'bark', direction: 'outbound', configured: false, fields: { key: { required: true } }, config: {} }])
  rig.setupSelect('bark')
  let fetches = 0
  rig.setFetch(async () => { fetches += 1; return resp(200, {}) })
  const input = makeInput('key', '', true)
  rig.lists.set('#setupForm input[data-sf]', [input])
  rig.setupSave(true, makeElement('button'))
  assert.match(rig.els.get('#setupMsg2').textContent, /必填字段未填写：key/)
  assert.equal(fetches, 0, '必填缺失不发请求')
  input.value = '***'
  rig.setupSave(false, makeElement('button'))
  assert.match(rig.els.get('#setupMsg2').textContent, /没有修改的字段/)
  assert.equal(fetches, 0, '*** 未修改不提交')
})

test('首访向导全链路：PUT 出站配置 → 当场真实测试 → 完成步 + tested 落库 + 向导收起', async () => {
  const rig = boot()
  rig.setToken('T')
  rig._setChannels([{ type: 'bark', direction: 'outbound', configured: false, fields: { key: { required: true } }, config: {} }])
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', false, false)] }))
  rig.setupSelect('bark')
  const input = makeInput('key', 'DEVICEKEY', true)
  rig.lists.set('#setupForm input[data-sf]', [input])
  const calls = []
  rig.setFetch(async (url, init) => {
    calls.push({ url, method: init.method, body: init.body })
    if (init.method === 'PUT') return resp(200, { type: 'bark', saved: true, direction: 'outbound' })
    if (url.endsWith('/test')) return resp(200, { ok: true, detail: 'HTTP 200' })
    return resp(200, okBody(url))
  })
  const btn = makeElement('button')
  rig.setupSave(true, btn)
  await settle()
  const put = calls.find((c) => c.method === 'PUT')
  assert.equal(put.url, '/api/channels/outbound/bark', '出站保存走方向 API')
  assert.deepEqual(JSON.parse(put.body), { config: { key: 'DEVICEKEY' } }, '字段级 payload 正确')
  assert.ok(calls.some((c) => c.url === '/api/channels/outbound/bark/test' && c.method === 'POST'),
    '保存后当场发送真实测试通知')
  assert.equal(rig.localStore.getItem('dsh-admin-first-run-tested'), '1', '送达事实落 localStorage（本浏览器已验证）')
  assert.equal(rig.els.get('#setupPane4').hidden, false, '进入完成步')
  assert.equal(rig.els.get('#setupPane3').hidden, true)
  assert.match(rig.els.get('#setupDoneDetail').textContent, /送达回执：HTTP 200/)
  assert.equal(rig.els.get('#setup').hidden, true, 'loadAll 刷新后向导整体收起（初始化完成）')
  assert.equal(btn.disabled, false, '按钮恢复')
})

test('首访向导：测试失败保留输入并给出重试路径，「重新发送」直接再发真实测试', async () => {
  const rig = boot()
  rig.setToken('T')
  rig._setChannels([{ type: 'bark', direction: 'outbound', configured: false, fields: { key: { required: true } }, config: {} }])
  rig.setupSelect('bark')
  const input = makeInput('key', 'BADKEY', true)
  rig.lists.set('#setupForm input[data-sf]', [input])
  let testCalls = 0
  rig.setFetch(async (url, init) => {
    if (init.method === 'PUT') return resp(200, { type: 'bark', saved: true })
    if (url.endsWith('/test')) { testCalls += 1; return resp(200, { ok: false, detail: 'HTTP 401: unauthorized' }) }
    return resp(200, okBody(url))
  })
  rig.setupSave(true, makeElement('button'))
  await settle()
  assert.equal(testCalls, 1)
  assert.match(rig.els.get('#setupTestState').innerHTML, /测试失败：HTTP 401: unauthorized。请检查必填凭证后重试，输入已保留。/)
  assert.equal(rig.localStore.has('dsh-admin-first-run-tested'), false, '失败不得标记已验证')
  assert.equal(input.value, 'BADKEY', '表单输入保留')
  const retestBtn = makeElement('button')
  rig.setupTest(retestBtn)
  await settle()
  assert.equal(testCalls, 2, '重试直接再发真实测试')
  assert.equal(retestBtn.disabled, false, '重试按钮恢复')
})

test('首访向导：state 写入失败（saved:false）回退到表单步并给出存储不可用提示', async () => {
  const rig = boot()
  rig.setToken('T')
  rig._setChannels([{ type: 'bark', direction: 'outbound', configured: false, fields: { key: { required: true } }, config: {} }])
  rig.setupSelect('bark')
  rig.lists.set('#setupForm input[data-sf]', [makeInput('key', 'K', true)])
  rig.setFetch(async (url, init) => (init.method === 'PUT' ? resp(200, { type: 'bark', saved: false }) : resp(200, okBody(url))))
  rig.setupSave(true, makeElement('button'))
  await settle()
  assert.equal(rig._setupStep(), 2, '回退到表单步')
  assert.match(rig.els.get('#setupMsg2').textContent, /写入失败：state 存储不可用/)
})

test('首访向导：「稍后再说」持久关闭向导且不阻塞进入管理台', () => {
  const rig = boot()
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', false, false)] }))
  rig._setChannels([])
  rig.renderDashboard()
  assert.equal(rig.els.get('#setup').hidden, false, '向导初始显示')
  rig.dismissSetup()
  assert.equal(rig.localStore.getItem('onboard_dismissed'), '1')
  assert.equal(rig.els.get('#setup').hidden, true, 'dismiss 后向导隐藏')
})

test('验证横幅：已启用出站但本浏览器未验证 → 横幅显示；当场测试通过后收起', async () => {
  const rig = boot()
  rig.setToken('T')
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', true, true)] }))
  rig._setChannels([])
  rig.renderDashboard()
  assert.equal(rig.els.get('#verifyBanner').hidden, false, '已启用未验证 → 横幅显示（升级老用户路径）')
  assert.equal(rig.els.get('#setup').hidden, true, '升级用户不再强弹三步向导')
  rig.setFetch(async (url, init) => (url.endsWith('/test') ? resp(200, { ok: true }) : resp(200, okBody(url))))
  await rig.bannerTest(makeElement('button'))
  assert.equal(rig.localStore.getItem('dsh-admin-first-run-tested'), '1')
  assert.equal(rig.els.get('#verifyBanner').hidden, true, '验证通过后横幅收起')
})

// ————————————————— G. 首页渲染 —————————————————

test('首页英雄区：四态进度（未配置 → 已保存 → 已测试 → 正常运行）与信号塔亮暗', () => {
  const rig = boot()
  const rail = ['unconfigured', 'saved', 'tested', 'ready'].map((s) => {
    const el = makeElement('span')
    el.setAttribute('data-hstate', s)
    return el
  })
  rig.lists.set('#heroRail [data-hstate]', rail)
  rig._setChannels([])
  // 态 1：未配置
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', false, false)] }))
  rig.renderDashboard()
  assert.equal(rig.els.get('#heroState').textContent, '尚未配置通知渠道')
  assert.ok(rail[0].classList.contains('current') && !rail[0].classList.contains('done'), '未配置为当前节点')
  assert.ok(!rail[3].classList.contains('current'))
  assert.ok(rig.els.get('#heroBeacon').className.includes('dim'), '未就绪信号塔暗态')
  // 态 2：已保存未测试
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', true, false)] }))
  rig.renderDashboard()
  assert.equal(rig.els.get('#heroState').textContent, '已保存 · 待发送测试通知')
  assert.ok(rail[0].classList.contains('done') && rail[1].classList.contains('current'))
  // 态 3：已测试未并入运行时
  rig.localStore.setItem('dsh-admin-first-run-tested', '1')
  rig.renderDashboard()
  assert.equal(rig.els.get('#heroState').textContent, '已验证送达 · 重启后并入投递')
  assert.ok(rail[2].classList.contains('current'))
  // 态 4：正常运行
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', true, true)] }))
  rig.renderDashboard()
  assert.equal(rig.els.get('#heroState').textContent, '通知链路正常')
  assert.ok(rail[3].classList.contains('current') && rail[0].classList.contains('done'))
  assert.equal(rig.els.get('#heroBeacon').className, 'beacon', '就绪后信号塔亮态')
})

test('下一步行动：按链路状态给出唯一主线动作（配置 → 测试 → 可选成员 → 就绪）', () => {
  const rig = boot()
  rig._setChannels([])
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', false, false)], members: 0 }))
  rig.renderDashboard()
  let html = rig.els.get('#nextAction').innerHTML
  assert.match(html, /第一步：配置一个通知渠道/)
  assert.ok(html.includes('data-next="setup"'))
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', true, false)], members: 0 }))
  rig.renderDashboard()
  html = rig.els.get('#nextAction').innerHTML
  assert.match(html, /发送测试通知完成初始化/)
  assert.ok(html.includes('data-next="setup"'))
  rig.localStore.setItem('dsh-admin-first-run-tested', '1')
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', true, true)], members: 0 }))
  rig.renderDashboard()
  html = rig.els.get('#nextAction').innerHTML
  assert.match(html, /可选：配对成员/)
  assert.ok(html.includes('data-next="members"'))
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', true, true)], members: 2 }))
  rig.renderDashboard()
  assert.match(rig.els.get('#nextAction').innerHTML, /一切就绪/)
})

test('旧 overview（无 members 字段）时 UI 不崩，按 0 成员降级', () => {
  const rig = boot()
  rig._setChannels([])
  const oldOverview = makeOverview({ outChannels: [] })
  delete oldOverview.members
  rig._setOverview(oldOverview)
  let threw = false
  try { rig.renderDashboard() } catch (e) { threw = true }
  assert.equal(threw, false, 'overview 无 members 字段时不应崩')
  assert.equal(rig.els.get('#statMembers').textContent, '–', '无 members 数据时成员统计显示 –（占位符）')
})

test('健康分组：渠道类型经 esc 转义，注入串不进入 DOM', () => {
  const rig = boot()
  rig._setChannels([])
  rig._setOverview(makeOverview({
    outChannels: [{ type: '<img src=x onerror=alert(1)>', direction: 'outbound', configured: false, enabled: false }],
  }))
  rig.renderDashboard()
  const html = rig.els.get('#outGroups').innerHTML
  assert.ok(!html.includes('<img'), '不注入 HTML')
  assert.ok(html.includes('&lt;img'), '以转义形式呈现')
})

// ————————————————— H. 保留契约（危险确认 / 结算编码 / 提问面板 / 角标 / 剪贴板） —————————————————

test('危险操作确认：撤销配对码必须二次确认，避免误触造成不可恢复失效', () => {
  const script = extractScript(ADMIN_UI_HTML)
  const marker = "var revokeId = memberKeyOf(btn, 'data-prevoke')"
  const start = script.indexOf(marker)
  assert.ok(start >= 0, '成员页应包含撤销配对码处理')
  const end = script.indexOf("api('/api/pairing/'", start)
  assert.ok(end > start, '撤销请求应位于处理分支中')
  const block = script.slice(start, end)
  assert.match(block, /window\.confirm\(/, '撤销配对码前必须调用 confirm')
  assert.match(block, /立即失效|无法恢复/, '确认文案应说明不可逆影响')
})

test('危险操作确认：忽略待确认绑定需明确确认，避免误删待接入身份', () => {
  const script = extractScript(ADMIN_UI_HTML)
  const marker = "var dismissKey = memberKeyOf(btn, 'data-pdismiss')"
  const start = script.indexOf(marker)
  assert.ok(start >= 0, '成员页应包含忽略待确认绑定处理')
  const end = script.indexOf("api('/api/members/'", start)
  assert.ok(end > start, '忽略请求应位于处理分支中')
  const block = script.slice(start, end)
  assert.match(block, /window\.confirm\(/, '忽略待确认绑定前必须调用 confirm')
  assert.match(block, /重新触发|当前请求将被删除/, '确认文案应说明忽略影响')
})

test('远程提问结算：POST 传对象避免 api 层二次 JSON 编码', () => {
  const script = extractScript(ADMIN_UI_HTML)
  const start = script.indexOf("api('/api/questions/'")
  assert.ok(start >= 0, '应存在远程提问结算请求')
  const end = script.indexOf('.then(function (d)', start)
  const block = script.slice(start, end > start ? end : start + 500)
  assert.match(block, /method:\s*'POST'/)
  assert.match(block, /body:\s*body\b/, '结算请求应把对象交给 api() 统一序列化')
  assert.doesNotMatch(block, /body:\s*JSON\.stringify\(body\)/, '禁止预序列化导致服务端收到 JSON 字符串')
})

test('阶段2A：loadAll 渲染面板，仅掩码 ref/聊天，token 与完整标识绝不进 HTML，且转义注入', async () => {
  const rig = boot()
  rig.setToken('TKN12345precious')
  const travialPayload = [
    {
      ref: '0f0f0f0f0f0f',
      question: '选图标 <img src=x onerror=alert(1)>',
      options: ['测试', '生产'],
      multiSelect: false,
      status: 'pending',
      agent: 'agent-abc123',
      source: [{ channel: 'telegram', chat: 'chat-111111', user: 'user-222222' }],
      createdAt: 1, expiresAt: 2,
    },
  ]
  rig.setFetch(async (url) => {
    if (url === '/api/questions') return resp(200, travialPayload)
    if (url === '/api/overview') return resp(200, { channels: [], sessions: {}, agents: {}, members: { total: 0 } })
    return resp(200, { ok: true })
  })
  await rig.loadAll()
  const html = rig.els.get('#pendingQuestionsPanel').innerHTML
  assert.match(html, /采用此项/, '每个选项提供采用按钮')
  assert.match(html, /驳回/, '提供驳回（交还桌面）按钮')
  assert.match(html, /0f0f0f0f0f0f/, 'ref 短段入面板')
  assert.match(html, /chat-111111/, '掩码 chat 入面板')
  assert.ok(!html.includes('TKN12345precious'), 'token 绝不进入 DOM')
  assert.ok(!html.includes('user-222222full') && !html.includes('900113'), '完整原始标识绝不进入 DOM')
  assert.ok(!html.includes('<img'), 'option/question 文本经 esc 转义，不注入 HTML')
  assert.ok(html.includes('&lt;img'), '注入串以转义形式呈现')
})

test('阶段2A：无待决问题/空响应时面板显示空态文案，不崩', async () => {
  const rig = boot()
  rig.setToken('TKN')
  rig.setFetch(async (url) => {
    if (url === '/api/questions') return resp(200, [])
    if (url === '/api/overview') return resp(200, { channels: [], sessions: {}, agents: {}, members: { total: 0 } })
    return resp(200, { ok: true })
  })
  await rig.loadAll()
  assert.match(rig.els.get('#pendingQuestionsPanel').innerHTML, /暂无待处理远程提问/, '空面板给出空态提示')
})

test('G-14：通道卡片角标——出站/入站已配置均标「重启后生效」（warn），未配置标「未配置」', async () => {
  const rig = boot()
  rig.setToken('TKN')
  const out = { type: 'telegram', direction: 'outbound', configured: true, enabled: true, editable: true, restartRequired: true, config: { botToken: '***' }, fields: {} }
  // v0.13（C11.5 / R6）：入站凭证只在下次启动建立 transport，restartRequired 恒 true。
  const inn = { type: 'feishu', direction: 'inbound', configured: true, enabled: true, active: false, editable: true, restartRequired: true, config: { appId: '***' }, fields: {} }
  const none = { type: 'pushplus', direction: 'outbound', configured: false, enabled: false, editable: true, restartRequired: true, config: {}, fields: {} }
  rig.setFetch(async (url) => {
    if (url === '/api/channels') return resp(200, [out, inn, none])
    if (url === '/api/overview') return resp(200, { channels: [out, inn, none], sessions: {}, agents: {}, members: { total: 0 } })
    if (url === '/api/questions') return resp(200, [])
    return resp(200, { ok: true })
  })
  await rig.loadAll()
  const html = rig.els.get('#channelCards').innerHTML
  assert.match(html, /badge warn">重启后生效/, `已配置卡片应标「重启后生效」（实际：${html.slice(0, 200)}）`)
  assert.match(html, /badge none">未配置/, '未配置卡片应标「未配置」')
  assert.doesNotMatch(html, /badge ok">已配置/, '已配置的入站也必须提示重启后生效，不得谎称已生效')
})

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
