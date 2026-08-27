// dsh-notifier test/admin-ui-behavior.test.mjs
// 管理台前端鉴权行为对抗性测试（Issue #13）。
// 目标缺陷（mnt-1）：
//   ① 缺 token 首访 loadAll 并行 5 个 api() → 各自弹一次 window.prompt → 5 个叠加窗；
//   ② token 留在 localStorage → 浏览器会话结束后仍保留；
//   ③ 并发 401 各递归重询 → 风暴刷窗、错 token 可能死循环。
// 验证：单飞询问门（并发共享一次弹窗）、成功后才写 sessionStorage（刷新不重输）、401 单次重登录
// （一次询问恰好重试一次，成功后重新武装，迟到旧世代 401 判过期不再弹窗）。
// 手段：node:vm 把 ADMIN_UI_HTML 内联 <script>（剥掉末尾 init() 自启）跑在注入
// DOM/storage/fetch/prompt 假体的沙箱里——真执行源码里的同一份逻辑，无复制粘贴。
// 内联代码运行时只依赖浏览器混合全局；沙箱预置 host 全局副本 + window/document/fetch/prompt 假体。

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
  }
  // 把 data-* 属性从 sel 解析不出来；测试里手动 el.dataset.xxx = 'yyy' 或 getAttribute 用 dataset
  // 注：ui.mjs 里 button[data-tab="channels"] 等按钮通过 getAttribute('data-tab') 取值，
  // 渲染前需在 dataset 上预置。
  return el
}

async function settle() { for (let i = 0; i < 60; i += 1) await Promise.resolve() }

function resp(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
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
 *  - 脚本导出函数（api/acquireToken/reloginGate/adoptToken/setToken/getToken/…）
 *  - els（selector → 假元素，可查 textContent / dispatch click）
 *  - store（sessionStorage 假体）
 *  - setFetch / setPrompt（可换桩，闭包内最新生效）
 */
function boot() {
  const els = new Map()
  const document = {
    hidden: false,
    querySelector: (sel) => {
      if (!els.has(sel)) els.set(sel, makeElement(sel))
      return els.get(sel)
    },
    querySelectorAll: () => [],
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
  const timeoutTaps = []
  let fetchImpl = async () => resp(200, {})
  let promptImpl = () => ''
  const sandbox = { window: {}, document, localStorage: localStore, sessionStorage: store }
  sandbox.window.localStorage = localStore
  sandbox.window.sessionStorage = store
  sandbox.window.location = { origin: 'http://127.0.0.1:8104', pathname: '/' }
  sandbox.window.navigator = {}
  sandbox.window.prompt = (...args) => { promptTaps.push(args); return promptImpl(...args) }
  sandbox.fetch = async (...args) => fetchImpl(...args)
  sandbox.prompt = (...args) => { promptTaps.push(args); return promptImpl(...args) }
  sandbox.setTimeout = (fn, ms) => { timeoutTaps.push({ fn, ms }); return timeoutTaps.length }
  sandbox.clearTimeout = () => {}

  const wrapped = `(() => {
${extractScript(ADMIN_UI_HTML).replace(/\ninit\(\)\s*$/, '\n')}
;return { api, acquireToken, reloginGate, adoptToken, setToken, getToken, renderTokenState,
  renderDashboard, overviewChannels, switchTab,
  handleStream401, startNotifyStream, loadAll, init,
  _getState: function () { return state },
  _setOverview: function (o) { state.overview = o },
  _authGen: function () { return authGen }, _setAuthGen: function (v) { authGen = v }, _recoveryUsed: function () { return recoveryUsed },
  _notifyStreamEpoch: function () { return notifyStreamEpoch }, setCandidateToken, stopNotifyStream, renderEntryPoint, copyEntryPoint }
})()`
  const context = vm.createContext(sandbox)
  const exports_ = vm.runInContext(wrapped, context, { filename: 'admin-ui-inline.mjs' })
  return {
    ...exports_,
    window: sandbox.window,
    els,
    store,
    localStore,
    prompts: () => promptTaps.slice(),
    timeouts: () => timeoutTaps.slice(),
    setFetch: (f) => { fetchImpl = f },
    setPrompt: (p) => { promptImpl = p },
  }
}

// ————————————————— ① 首访单飞询问 + 成功持久化 —————————————————

test('首访并发：5 个并行 api 只弹一次 prompt，成功响应后才落 sessionStorage', async () => {
  const rig = boot()
  let promptCount = 0
  rig.setPrompt(() => { promptCount += 1; return 'OKT0KEN' })
  rig.setFetch(async () => resp(200, { ok: true }))
  await Promise.all([rig.api('/api/a'), rig.api('/api/b'), rig.api('/api/c'), rig.api('/api/d'), rig.api('/api/e')])
  assert.equal(promptCount, 1, '并发首访共享同一单飞询问（原实现 5 个叠加窗）')
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'OKT0KEN', '成功后会话持久化（刷新无需重输）')
  assert.equal(rig.localStore.has('dsh-admin-session-token'), false, 'token 绝不写 localStorage')
  // 再发一次请求：token 已在本地 → 不再询问
  const before = promptCount
  await rig.api('/api/f')
  assert.equal(promptCount, before, '持久化后后续请求不重问')
})

test('首访 prompt 取消：绝不留任何 token，api 明确报错', async () => {
  const rig = boot()
  rig.setPrompt(() => '')
  await assert.rejects(rig.api('/api/x'), /未提供 token/)
  assert.equal(rig.store.has('dsh-admin-session-token'), false, '取消不写入')
})

test('首访 prompt 输入的候选 token 绝不进 sessionStorage（除非请求成功）', async () => {
  // mnt-1 反例加固：prompt 返回值既不是 token 也未获成功响应时，不得被当成有效 token 采纳。
  const rig = boot()
  rig.setPrompt(() => '  W00D0N  ') // 带空白 → trim 后入库当候选
  rig.setFetch(async () => resp(401, { error: 'unauthorized' })) // 任何候选都被服务器拒
  await assert.rejects(rig.api('/api/x'))
  assert.equal(rig.store.getItem('dsh-admin-session-token'), null, '候选被拒后不得持久化')
})

// ————————————————— ② 401 单次重登录 —————————————————

test('并发 401：共享单飞重登录门——一次询问、各自用新 token 重试一次、成功后持久化', async () => {
  const rig = boot()
  rig.setToken('OLD')
  let promptCount = 0
  rig.setPrompt(() => { promptCount += 1; return 'NEWTKN' })
  const q = queueableFetch()
  rig.setFetch(q.impl)

  const pA = rig.api('/api/a')
  const pB = rig.api('/api/b')
  await settle()
  assert.equal(q.pending.filter((x) => x.auth === 'Bearer OLD').length, 2, '两请求都带旧 token 发出')
  // 两个 401 几乎同时到达
  q.pending.filter((x) => x.auth === 'Bearer OLD').forEach((x) => x.resolve(resp(401, { error: 'x' })))
  await settle()
  assert.equal(promptCount, 1, '两并发 401 共享一次询问（原实现会 2 连弹）')
  const retries = q.pending.filter((x) => x.auth === 'Bearer NEWTKN')
  assert.equal(retries.length, 2, '两条请求都用新 token 重试一次')
  retries.forEach((x) => x.resolve(resp(200, { ok: true })))
  await pA
  await pB
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'NEWTKN', '重登录成功后才持久化')
  assert.equal(rig._recoveryUsed(), false, '成功响应重新允许未来自动恢复')
})

test('401 迟到旧世代：并发请求之一仍未落地时重登录已完成——迟到 401 过期，不再弹第二轮窗', async () => {
  const rig = boot()
  rig.setToken('OLD')
  let promptCount = 0
  rig.setPrompt(() => { promptCount += 1; return 'NEWTKN' })
  const q = queueableFetch()
  rig.setFetch(q.impl)

  const pA = rig.api('/api/a')
  const pB = rig.api('/api/b')
  await settle()
  const olds = q.pending.filter((x) => x.auth === 'Bearer OLD')
  assert.equal(olds.length, 2)
  // 只让第一个 401 触发重登录；第二个保持 in-flight（旧 token）
  olds[0].resolve(resp(401, { error: 'x' }))
  await settle()
  assert.equal(promptCount, 1, '第一个 401 触发单次询问')
  const retry = q.pending.find((x) => x.auth === 'Bearer NEWTKN')
  assert.ok(retry, '新 token 重试请求已发出')
  retry.resolve(resp(200, { ok: true }))
  await pA
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'NEWTKN')
  // 滞后到达的旧 token 401 → 世代已推进 → 判为过期请求，不重登录
  olds[1].resolve(resp(401, { error: 'x' }))
  await assert.rejects(pB, /已失效的 token/)
  assert.equal(promptCount, 1, '迟到旧世代 401 不再触发第二轮询问')
})

test('错 token：一次 401 至多自动重登录一次；失败后解除武装，不再自动弹窗循环', async () => {
  const rig = boot()
  rig.setToken('BAD')
  let promptCount = 0
  rig.setPrompt(() => { promptCount += 1; return 'ALSOBAD' })
  rig.setFetch(async () => resp(401, { error: 'x' }))

  await assert.rejects(rig.api('/api/x'), /自动重登录处理/)
  assert.equal(promptCount, 1, '一个 401 恰好一次自动重登录')
  assert.equal(rig._recoveryUsed(), true, '失败后不重新自动恢复')
  assert.equal(rig.getToken(), '', '重试后仍 401 时必须清掉无效候选 token')
  // 再次显式调用：无 stored token → prompt 一次；401 已解除武装 → 直接拒绝，不自动再试
  await assert.rejects(rig.api('/api/x'))
  assert.equal(promptCount, 2, '每次显式调用至多一次询问——无自动循环')
})

// ————————————————— ③ SSE 与手动换 token —————————————————

test('SSE：401 走共享重登录门，一次询问后重连，再 401 不再弹窗（提示手动更新）', async () => {
  const rig = boot()
  rig.setToken('OLD')
  let promptCount = 0
  rig.setPrompt(() => { promptCount += 1; return 'NEWTKN' })
  let eventFetches = 0
  rig.setFetch(async () => { eventFetches += 1; return resp(401, { error: 'x' }) })

  rig.startNotifyStream()
  await settle()
  assert.equal(promptCount, 1, 'SSE 401 与 api 共享单飞重登录门')
  assert.equal(eventFetches, 2, '旧 token 连接 + 新 token 重连各一次')
  assert.ok(rig.els.get('#nStream').textContent.includes('已自动重试一次'),
    '第二次 401 不再弹窗：' + rig.els.get('#nStream').textContent)
})

test('SSE 首访缺 token：与并发 api 共享单飞询问门（不叠窗），成功后持久化', async () => {
  const rig = boot()
  let promptCount = 0
  rig.setPrompt(() => { promptCount += 1; return 'NEW' })
  const auths = []
  rig.setFetch(async (url, init) => {
    auths.push(init.headers.Authorization)
    return { status: 200, ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) }, json: async () => ({}) }
  })
  // 同时起步 loadAll（6 个 api）与 SSE——原实现路径上两者会叠加 7 次询问
  const load = rig.loadAll()
  rig.startNotifyStream()
  await load
  await settle()
  assert.equal(promptCount, 1, 'SSE + 并行 api 共享同一次询问')
  assert.equal(auths.length, 7, '6 个并行 api + 1 个 SSE 连接')
  assert.ok(auths.every((a) => a === 'Bearer NEW'), '所有请求都用询问得到的 token')
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'NEW', 'SSE 连接成功后会话持久化')
})

test('点击 token 状态：手动换 token 推进世代，候选在成功后才写入会话', async () => {
  const rig = boot()
  rig.setToken('OLD')
  let promptCount = 0
  rig.setPrompt(() => { promptCount += 1; return 'MANUAL' })
  // init：SSE（/api/events 空流）+ 5 个并行 api 全部 200——不触发任何询问
  rig.setFetch(async (url) => (url === '/api/events'
    ? { status: 200, ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) }, json: async () => ({}) }
    : resp(200, {})))
  rig.init() // 真页面底部自启（监听器 + SSE + loadAll）
  await settle()
  assert.equal(promptCount, 0, 'init 各请求全部成功，不因缺 token 弹窗')
  const n0 = rig._authGen()
  assert.ok(rig.els.get('#tokenState'), 'token 状态点击区已注册')
  rig.els.get('#tokenState').dispatch('click') // 手动更换
  await settle()
  assert.equal(promptCount, 1, '手动触发一次询问')
  assert.equal(rig.store.getItem('dsh-admin-session-token'), 'MANUAL', '手动 token 经成功响应后写入会话')
  assert.equal(rig._authGen(), n0 + 1, '手动换 token 推进世代（旧请求迟到 401 判过期）')
})

test('受限 sessionStorage：读写抛错时仍使用当前页面内存，不崩也不触及 localStorage', async () => {
  const rig = boot()
  rig.store.getItem = () => { throw new Error('SecurityError') }
  rig.store.setItem = () => { throw new Error('QuotaExceededError') }
  rig.store.removeItem = () => { throw new Error('SecurityError') }
  rig.setPrompt(() => 'MEMORY')
  rig.setFetch(async () => resp(200, { ok: true }))
  await rig.api('/api/overview')
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
  assert.equal(rig.prompts().length, 0, '迟到旧流不再发起登录弹窗')
})

test('入口与退出：当前 loopback 地址可见，退出仅清会话 token 并使流世代失效', () => {
  const rig = boot()
  rig.setToken('SESSION')
  assert.equal(rig.renderEntryPoint(), 'http://127.0.0.1:8104/')
  assert.equal(rig.els.get('#entryUrl').textContent, 'http://127.0.0.1:8104/')
  const before = rig._notifyStreamEpoch()
  rig.stopNotifyStream()
  rig.setToken('')
  assert.equal(rig.getToken(), '', '退出后没有可用 token')
  assert.ok(rig._notifyStreamEpoch() > before, '退出使旧 SSE 流失效')
})

test('Issue #10/#13 静态契约：入口、会话存储、退出、窄屏与无障碍状态齐全', () => {
  const html = ADMIN_UI_HTML
  assert.match(html, /id="entryUrl"/, '顶部必须可见当前精确入口')
  assert.match(html, /id="btnCopyEntry"/, '入口必须可复制')
  assert.match(html, /id="btnLogout"/, '必须有显式退出路径')
  assert.match(html, /sessionStorage/, '认证只允许会话级持久化')
  assert.doesNotMatch(html, /localStorage\.getItem\(TOKEN_KEY\)|localStorage\.setItem\(TOKEN_KEY\)/,
    '认证 token 不得落 localStorage')
  assert.match(html, /role="status" aria-live="polite"/, '加载/恢复状态应由辅助技术播报')
  assert.match(html, /#entryHint \{ flex-basis: 100%; order: 2; \}/, '窄屏入口应独占一行避免遮挡')
})

// ————————————————— ④ Issue #10：Dashboard 首屏引导（onboarding）行为契约 —————————————————
// 验证项（对齐主管审查清单 #5）：
//   1. 无通道 + 无成员 → 引导卡显示
//   2. 仅配置未启用（configured 但 !enabled）→ 步骤 1 不算完成、引导卡仍显示
//   3. 配置且启用 → 步骤 1 完成
//   4. 通道 + 成员都齐 → 引导卡隐藏
//   5. localStorage getItem/setItem 抛异常不崩
//   6. 按钮跳转到真实存在的 tab
//   7. 移动端窄屏 CSS 静态断言（viewport meta + ≤768px 媒体查询）

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

test('onboarding：无出站通道 + 无成员 → 引导卡显示，三步均未完成', () => {
  const rig = boot()
  rig._setOverview(makeOverview({ outChannels: [outRow('bark', false, false)], members: 0 }))
  rig.renderDashboard()
  const ob = rig.els.get('#onboarding')
  assert.equal(ob.hidden, false, '无成员 + 无通道 → 引导卡应显示')
  assert.equal(rig.els.get('#step1').classList.contains('done'), false, '步骤 1 未完成')
  assert.equal(rig.els.get('#step2').classList.contains('done'), false, '步骤 2 未完成')
  assert.equal(rig.els.get('#step3').classList.contains('done'), false, '步骤 3 未完成')
})

test('onboarding：步骤 1 完成条件 = configured && enabled（仅配置未启用不算完成）', () => {
  const rig = boot()
  // 有成员，出站通道 configured=true 但 enabled=false（填了凭证但通道还没跑起来）
  rig._setOverview(makeOverview({
    outChannels: [outRow('bark', true, false)],
    members: 1,
  }))
  rig.renderDashboard()
  const ob = rig.els.get('#onboarding')
  assert.equal(ob.hidden, false, '仅配置未启用 + 有成员 → 引导卡仍应显示（通道还发不了通知）')
  assert.equal(rig.els.get('#step1').classList.contains('done'), false,
    '步骤 1 完成条件必须是 configured && enabled，不能只看 configured')
  assert.equal(rig.els.get('#step2').classList.contains('done'), true, '有成员 → 步骤 2 完成')
})

test('onboarding：配置且启用 → 步骤 1 完成；通道 + 成员都齐 → 引导卡隐藏', () => {
  const rig = boot()
  rig._setOverview(makeOverview({
    outChannels: [outRow('bark', true, true), outRow('telegram', false, false)],
    members: 2,
    sessions: 1,
  }))
  rig.renderDashboard()
  const ob = rig.els.get('#onboarding')
  assert.equal(ob.hidden, true, '有已启用通道 + 有成员 → 引导卡应自动隐藏')
  assert.equal(rig.els.get('#step1').classList.contains('done'), true, '步骤 1 完成')
  assert.equal(rig.els.get('#step2').classList.contains('done'), true, '步骤 2 完成')
  assert.equal(rig.els.get('#step3').classList.contains('done'), true, '步骤 3 完成')
})

test('onboarding：localStorage getItem 抛异常不崩，按未隐藏处理', () => {
  const rig = boot()
  // 把 store.getItem 改成抛错（模拟隐私模式/受限环境）
  rig.store.getItem = () => { throw new Error('SecurityError: The operation is insecure') }
  rig._setOverview(makeOverview({ outChannels: [], members: 0 }))
  let threw = false
  try { rig.renderDashboard() } catch (e) { threw = true }
  assert.equal(threw, false, 'localStorage 读异常时 renderDashboard 不应击穿')
  assert.equal(rig.els.get('#onboarding').hidden, false,
    'localStorage 不可用时按未隐藏降级，引导卡仍可见')
})

test('onboarding：localStorage 所有访问点均包 try/catch（源码静态契约）', () => {
  // 受限/隐私环境 localStorage 可能抛 SecurityError / QuotaExceededError。
  // 所有读写必须 try/catch 包裹，不能击穿 UI。
  const script = extractScript(ADMIN_UI_HTML)
  // 找出所有与 onboard_dismissed 相关的访问（renderDashboard 读 + 隐藏按钮写）
  const dismissIndices = []
  let idx = -1
  while ((idx = script.indexOf('onboard_dismissed', idx + 1)) !== -1) {
    dismissIndices.push(idx)
  }
  assert.ok(dismissIndices.length >= 2,
    'onboard_dismissed 应至少有两处访问（renderDashboard 读 + 隐藏按钮写）')
  // 每处访问周围 200 字符内必须有 try {，确保在 try/catch 保护下
  for (const pos of dismissIndices) {
    const context = script.slice(Math.max(0, pos - 200), pos + 100)
    assert.ok(context.includes('try {') || context.includes('try{'),
      'onboard_dismissed 的每处访问都应在 try/catch 内，上下文: ' + context.trim().slice(0, 120))
  }
})

test('onboarding：步骤 1/2 按钮 data-tab 指向真实存在的标签页', () => {
  // 静态校验：引导卡里的「去通道页」「去成员页」按钮的 data-tab 值必须在
  // 顶部 nav 的 tabbtn 按钮里也存在（即真的有对应标签页）
  const html = ADMIN_UI_HTML
  // 匹配所有含 tabbtn 类且带 data-tab 的 button（class 顺序不固定，用包含判定）
  const tabButtonRe = /<button[^>]*class="[^"]*tabbtn[^"]*"[^>]*data-tab="([^"]+)"/g
  // 从 onboarding 卡片里抠 data-tab
  const onboardSection = html.slice(
    html.indexOf('id="onboarding"'),
    html.indexOf('id="onboarding"') + 2000
  )
  const onboardTabs = [...onboardSection.matchAll(tabButtonRe)].map((m) => m[1])
  assert.ok(onboardTabs.includes('channels'), '步骤 1 按钮应指向 channels tab')
  assert.ok(onboardTabs.includes('members'), '步骤 2 按钮应指向 members tab')
  // 顶部 nav 里的 tabbtn（<nav>...</nav> 段）
  const navSection = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'))
  const navTabs = [...navSection.matchAll(tabButtonRe)].map((m) => m[1])
  assert.ok(navTabs.includes('dashboard'), 'nav 有 dashboard')
  assert.ok(navTabs.includes('channels'), 'nav 有 channels')
  assert.ok(navTabs.includes('members'), 'nav 有 members')
  // 引导卡引用的 tab 都必须在 nav 里存在
  for (const t of onboardTabs) {
    assert.ok(navTabs.includes(t), `引导卡引用的 tab "${t}" 应在顶部 nav 里存在`)
  }
})

test('onboarding：移动端窄屏静态断言（viewport meta + ≤768px 媒体查询）', () => {
  const html = ADMIN_UI_HTML
  // 1. viewport meta 存在（移动端不缩放）
  assert.ok(html.includes('<meta name="viewport"'), '应有 viewport meta')
  assert.ok(html.includes('width=device-width'), 'viewport 应含 width=device-width')
  // 2. ≤768px 媒体查询存在（移动端适配）
  assert.ok(html.includes('@media (max-width: 768px)'), '应有 ≤768px 媒体查询')
  // 3. 引导卡本身用了 flex wrap（窄屏下自动换行）
  assert.ok(html.includes('.onboard-steps'), '应有引导步骤容器')
  assert.ok(html.includes('flex-wrap: wrap'), '引导步骤容器应支持自动换行')
  // 4. 移动端触控目标 ≥44px（iOS 点击区域规范）
  assert.ok(html.includes('min-height: 44px'), '移动端按钮/输入应有 44px 触控目标')
})

test('onboarding：旧 overview（无 members 字段）时 UI 不崩，按 0 成员降级', () => {
  // 向前兼容：旧版/异常情况下 overview 可能没有 members 字段
  const rig = boot()
  const oldOverview = makeOverview({ outChannels: [] })
  delete oldOverview.members  // 模拟旧形状
  rig._setOverview(oldOverview)
  let threw = false
  try { rig.renderDashboard() } catch (e) { threw = true }
  assert.equal(threw, false, 'overview 无 members 字段时不应崩')
  assert.equal(rig.els.get('#statMembers').textContent, '–',
    '无 members 数据时成员统计显示 –（占位符）')
})

// ————————————————— ⑤ Task 04：个人模式首屏与可恢复操作 —————————————————

test('Task 04：首屏明确四态进度、个人模式默认、高级设置显式开启', () => {
  const html = ADMIN_UI_HTML
  for (const label of ['未配置', '已配对', '测试通知', '正常运行']) assert.ok(html.includes(label), `首屏应包含进度态 ${label}`)
  assert.match(html, /id="modeToggle"[^>]*>打开高级设置</, '高级设置必须有明确入口')
  assert.match(html, /class="tabbtn advanced-tab"[^>]*data-tab="bindings"[^>]*hidden/, '绑定矩阵默认隐藏')
  assert.match(html, /class="tabbtn advanced-tab"[^>]*data-tab="sessions"[^>]*hidden/, '会话默认隐藏')
  assert.ok(html.includes('MODE_KEY') && html.includes("'advanced'"), '模式切换必须是显式个人/高级状态')
})

test('Task 04：YAML 仅作为高级入口，空通道状态给出字段配置指引', () => {
  const html = ADMIN_UI_HTML
  assert.ok(html.includes('YAML 仅作为高级入口'), '空通道不应把 YAML 当默认路径')
  assert.ok(html.includes('按字段配置'), '空状态应指向字段驱动的通道页')
  assert.ok(html.includes('打开「高级设置」') || html.includes('打开高级设置'), '文档/界面应说明高级设置入口')
})

test('Task 04：测试通知成功/失败均给出下一步与重试文案', () => {
  const html = ADMIN_UI_HTML
  assert.ok(html.includes('下一步：回 Dashboard 确认状态'), '成功测试需给出后续路径')
  assert.ok(html.includes('检查必填凭证后重试'), '失败测试需给出可执行重试路径')
  assert.ok(html.includes('测试失败：'), '异常响应需可见')
})

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
  const end = script.indexOf(".then(function (d)", start)
  const block = script.slice(start, end > start ? end : start + 500)
  assert.match(block, /method:\s*'POST'/)
  assert.match(block, /body:\s*body\b/, '结算请求应把对象交给 api() 统一序列化')
  assert.doesNotMatch(block, /body:\s*JSON\.stringify\(body\)/, '禁止预序列化导致服务端收到 JSON 字符串')
})

test('首访卡：无 token 时可见，验证 token 后自动收起并保留 loopback 入口', () => {
  const rig = boot()
  rig.renderEntryPoint()
  rig.renderTokenState()
  assert.equal(rig.els.get('#firstVisitHint').hidden, false, '无 token 首访应显示快速路径卡')
  assert.equal(rig.els.get('#firstVisitEntryUrl').textContent, 'http://127.0.0.1:8104/', '首访卡应显示当前管理台地址')
  rig.setToken('SESSION')
  rig.renderTokenState()
  assert.equal(rig.els.get('#firstVisitHint').hidden, true, '已有会话 token 后首访卡应收起')
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

test('首访快速路径：通道/扫码与成员按钮可达，个人模式默认策略和高级隐藏文案清楚', () => {
  const html = ADMIN_UI_HTML
  const start = html.indexOf('id="firstVisitHint"')
  const end = html.indexOf('</div>\n    <div id="firstRunState"', start)
  const card = html.slice(start, end)
  assert.match(card, /id="btnFirstVisitToken"/, '首访卡应有 token 输入按钮')
  assert.match(card, /class="tabbtn"[^>]*data-tab="channels"[^>]*>配置通道 \/ 扫码授权/, '首访卡应直达通道/扫码配置')
  assert.match(card, /class="tabbtn"[^>]*data-tab="members"[^>]*>配对成员/, '首访卡应直达成员配对')
  assert.match(card, /observe \+ approve 已开启/, '个人模式应明确 observe + approve 默认开启')
  assert.match(card, /converse 可按需开启/, '个人模式应明确 converse 可选')
  assert.match(card, /群聊控制默认关闭/, '个人模式应明确群聊控制关闭')
  assert.match(card, /高级设置默认隐藏/, '应明确高级设置默认隐藏')
  assert.match(card, /无需先写 YAML/, '首次路径不应依赖 YAML')
})

// ————————————————— ⑥ 路线图阶段 2A：待处理远程提问面板 —————————————————

test('阶段2A：面板容器与按钮随 Dashboard 分发，个人模式默认可见', () => {
  const html = ADMIN_UI_HTML
  assert.ok(html.includes('id="pendingQuestionsPanel"'), 'Dashboard 应有待处理提问面板容器')
  assert.match(html, /待处理远程提问/, '面板有章节标题')
  // 面板位于 tab-dashboard（个人模式默认可见的主标签）内
  const dashStart = html.indexOf('<section id="tab-dashboard"')
  const dashEnd = html.indexOf('</section>', dashStart)
  const dashHtml = html.slice(dashStart, dashEnd)
  assert.ok(dashHtml.includes('pendingQuestionsPanel'), '面板必须落在默认可见的 Dashboard 内')
  assert.ok(html.includes('onQuestionsClick'), '结算按钮有事件委托处理器')
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
