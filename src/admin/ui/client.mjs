// dsh-notifier src/admin/ui/client.mjs
// 管理台浏览器端脚本（导出为内嵌 <script> 正文，由 ui.mjs 组合进 ADMIN_UI_HTML）。
// 零配置首访重构要点：
//  - 鉴权：fragment 启动凭证（#token=...）静默验证；无 token → 站内解锁门，绝不弹 window.prompt；
//    token 只在验证成功后写 sessionStorage（禁止 localStorage）；401 → 清 token 回解锁门，单飞不重试风暴。
//  - 首访向导：选渠道 → 填凭证 → 保存并当场真实测试（新方向 API），送达才视为初始化完成。
//  - 通道页：出站（主）/ 入站（次）分组卡片，保存/测试/删除/扫码全保留。
// 注意：本文件是模板字面量——正文不得出现反引号与 ${ 序列；反斜杠一律双写（如 '\\n'）。
export const ADMIN_UI_JS = `'use strict'
var TOKEN_KEY = 'dsh-admin-session-token'
var SCAN_TYPES = ['qq', 'dingtalk', 'feishu', 'wechat']
var state = { overview: null, bindings: null, sessions: null, channels: null, members: null }
var draft = null
var scanTimers = {}
var flashTimer = null
var MODE_KEY = 'dsh-admin-mode'
var TESTED_KEY = 'dsh-admin-first-run-tested'
var ADMIN_STRINGS = window.__DSH_NOTIFIER_ADMIN_STRINGS__ || {}

function $(sel, root) { return (root || document).querySelector(sel) }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }
function plain(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
function tr(path, vars) {
  var value = path.split('.').reduce(function (node, key) {
    return node && Object.prototype.hasOwnProperty.call(node, key) ? node[key] : null
  }, ADMIN_STRINGS)
  if (typeof value !== 'string') return path
  return value.replace(/\{([A-Za-z0-9_.-]+)\}/g, function (match, key) {
    return vars && vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : match
  })
}
function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function errText(e) { return e && e.message ? e.message : String(e) }
function byAttr(sel, attr, val) {
  var found = null
  $all(sel).forEach(function (el) { if (el.getAttribute(attr) === val) found = el })
  return found
}
function setStatus(el, text, kind) {
  if (!el) return
  el.textContent = text
  el.className = el.className.split(' ')[0] + ' show ' + (kind || 'ok')
}
function flash(text, kind) {
  setStatus($('#globalMsg'), text, kind)
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(function () { $('#globalMsg').className = 'msg' }, 6000)
}
function setLoading(on) {
  $('#loadState').textContent = on ? tr('loading') : ''
  $('#btnRefresh').disabled = on
}
function setBtnBusy(btn, text) {
  if (!btn) return
  if (btn._oldText === undefined || btn._oldText === null) btn._oldText = btn.textContent
  btn.disabled = true
  btn.textContent = text
}
function restoreBtn(btn) {
  if (!btn) return
  btn.disabled = false
  if (btn._oldText !== undefined && btn._oldText !== null) { btn.textContent = btn._oldText; btn._oldText = null }
}
function sidPrefix(id) { id = String(id || ''); return id.length > 8 ? id.slice(0, 8) + '…' : id }
function fmtTime(v) {
  if (v === undefined || v === null || v === '') return tr('unknown')
  var n = Number(v)
  var d = Number.isFinite(n) && n > 0 ? new Date(n) : new Date(v)
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString()
}
function sourceLabel(s) {
  var map = { session: 'sourceSession', 'agent-exact': 'sourceAgentExact', 'agent-workspace': 'sourceAgentWorkspace', global: 'sourceGlobal' }
  return map[s] ? tr(map[s]) : (s || tr('unknown'))
}

// ---------- 鉴权：fragment 启动凭证 + 站内解锁门；会话级 Bearer token；单飞门 + 401 单次恢复 ----------
// token 永不进入 URL query、日志、响应或 localStorage。fragment（# 之后）本就不随请求发送、
// 不进 Referer 与访问日志；验证成功即清地址栏并只存 sessionStorage（受限浏览器退化到本页内存）。
var authGate = null        // 在途 acquireToken promise（并发请求共享同一扇门）
var gateResolve = null     // 门的兑现函数（解锁表单提交时调用）
var gateMode = 'acquire'   // 'acquire' = 无会话解锁；'change' = 已有会话手动更换（可取消）
var gateReason = ''        // 下一次开门要展示的 actionable 错误（401 / fragment 失效）
var gateShows = 0          // 门打开次数（测试观测单飞）
var reloginPromise = null
var authGen = 0
var recoveryUsed = false
var memoryToken = ''
function sessionStore() { try { return window.sessionStorage } catch (e) { return null } }
function getToken() {
  if (memoryToken) return memoryToken
  var store = sessionStore()
  if (store) {
    try {
      var stored = store.getItem(TOKEN_KEY) || ''
      if (stored) return stored
    } catch (e) {}
  }
  return memoryToken
}
function setCandidateToken(v) {
  memoryToken = v || ''
  var store = sessionStore()
  if (!store) return false
  try { store.removeItem(TOKEN_KEY); return true } catch (e) { return false }
}
function setToken(v) {
  memoryToken = v || ''
  var store = sessionStore()
  if (!store) return false
  try { if (v) store.setItem(TOKEN_KEY, v); else store.removeItem(TOKEN_KEY); return true } catch (e) { return false }
}
// —— 解锁门（替代旧 window.prompt）：无 token / token 失效时的站内解锁页 ——
function gateEl() { return $('#gate') }
function showGate(reason) {
  var g = gateEl()
  var wasHidden = !g || g.hidden !== false
  if (g) g.hidden = false
  if (wasHidden) gateShows += 1
  var cancel = $('#unlockCancel')
  if (cancel) cancel.hidden = gateMode !== 'change'
  var err = $('#unlockError')
  if (err) {
    if (reason) { err.textContent = reason; err.hidden = false }
    else { err.textContent = ''; err.hidden = true }
  }
  var input = $('#unlockInput')
  if (input && input.focus) { try { input.focus() } catch (e) {} }
}
function hideGate() {
  var g = gateEl()
  if (g) g.hidden = true
  var input = $('#unlockInput')
  if (input) input.value = ''
  var err = $('#unlockError')
  if (err) { err.textContent = ''; err.hidden = true }
}
/** token 询问单飞门：并发请求共享同一扇解锁门；表单提交兑现。 */
function acquireToken() {
  if (!authGate) {
    gateMode = 'acquire'
    authGate = new Promise(function (resolve) { gateResolve = resolve })
    showGate(gateReason)
    gateReason = ''
  }
  return authGate
}
/** 解锁表单提交：空值不兑现（原地提示）；acquire 模式喂给单飞门，change 模式走手动换 token。 */
function onUnlockSubmit(ev) {
  if (ev && ev.preventDefault) ev.preventDefault()
  var input = $('#unlockInput')
  var t = input && input.value ? String(input.value).trim() : ''
  if (!t) {
    var err = $('#unlockError')
    if (err) {
      err.textContent = tr('enterTokenEmpty')
      err.hidden = false
    }
    return
  }
  var resolve = gateResolve
  gateResolve = null
  authGate = null
  if (gateMode === 'change' || !resolve) {
    // 手动换 token / 门被单独打开：候选只进内存，成功响应后才写会话
    gateMode = 'acquire'
    hideGate()
    authGen += 1
    recoveryUsed = false
    stopNotifyStream()
    setCandidateToken(t)
    renderTokenState()
    loadAll()
    startNotifyStream(t)
    return
  }
  gateMode = 'acquire'
  hideGate()
  resolve(t)
}
function onUnlockCancel() { gateMode = 'acquire'; hideGate() }
function onUnlockPeek() {
  var input = $('#unlockInput')
  var btn = $('#unlockPeek')
  if (!input) return
  var show = input.type !== 'text'
  try { input.type = show ? 'text' : 'password' } catch (e) {}
  if (btn) btn.textContent = show ? tr('peekHide') : tr('peekShow')
}
function onTokenStateClick() {
  if (getToken()) { gateMode = 'change'; showGate('') }
  else { gateMode = 'acquire'; showGate(gateReason); gateReason = '' }
}
function renderTokenState() {
  var t = getToken()
  $('#tokenState').textContent = t ? tr('tokenSet') : tr('tokenUnset')
  $('#btnLogout').disabled = !t
}
function renderEntryPoint() {
  var target = window.location.origin + window.location.pathname
  $('#entryUrl').textContent = target
  return target
}
function copyEntryPoint() {
  var target = renderEntryPoint()
  var clipboard = window.navigator && window.navigator.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    flash(tr('addressShownTop'), 'warn')
    return
  }
  clipboard.writeText(target).then(function () { flash(tr('addressCopied'), 'ok') }, function () {
    flash(tr('copyFailedShownTop'), 'warn')
  })
}
/** fragment 启动凭证：读 #token=...（零配置首访链接，仅此一次有效输出）。 */
function readFragmentToken() {
  try {
    var h = window.location && typeof window.location.hash === 'string' ? window.location.hash : ''
    if (h.length < 2 || h.charAt(0) !== '#') return ''
    var parts = h.slice(1).split('&')
    for (var i = 0; i < parts.length; i += 1) {
      var eq = parts[i].indexOf('=')
      if (eq <= 0) continue
      if (parts[i].slice(0, eq) === 'token') {
        var v = decodeURIComponent(parts[i].slice(eq + 1))
        return v && v.trim() ? v.trim() : ''
      }
    }
    return ''
  } catch (e) { return '' }
}
/** Native one-time launch ticket. */
function readFragmentTicket() {
  try {
    var h = window.location && typeof window.location.hash === 'string' ? window.location.hash : ''
    if (h.length < 2 || h.charAt(0) !== '#') return ''
    var parts = h.slice(1).split('&')
    for (var i = 0; i < parts.length; i += 1) {
      var eq = parts[i].indexOf('=')
      if (eq <= 0) continue
      if (parts[i].slice(0, eq) === 'ticket') {
        var v = decodeURIComponent(parts[i].slice(eq + 1))
        return v && v.trim() ? v.trim() : ''
      }
    }
    return ''
  } catch (e) { return '' }
}
function exchangeLaunchTicket(ticket) {
  return fetch('/api/auth/exchange-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: ticket }),
  }).then(function (res) {
    if (!res.ok) throw new Error(tr('launchTicketInvalid'))
    return res.json()
  })
}
/** 验证前即清地址栏 fragment。 */
function clearFragment() {
  try {
    if (window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', window.location.pathname + (window.location.search || ''))
    }
  } catch (e) {}
}
/** 低层 Bearer 请求（不含 401 处理；401 由 apiWith/relogin 统一裁决）。 */
function request(path, options, token) {
  var init = { method: options.method || 'GET', headers: { Authorization: 'Bearer ' + token } }
  if (options.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.body) }
  return fetch(path, init)
}
/** 成功响应（非 401）才保存到会话；错误 token 不会留下。 */
function adoptToken(t) { if (t) setToken(t) }
/** 任何非 401 响应说明当前 token 当时有效 → 重新允许一次未来自动恢复。 */
function markAuthOk() { recoveryUsed = false }
/** 401 单飞重登录门：清旧 token → 开解锁门 → 返回新 token（并发共享同一次开门）。 */
function reloginGate() {
  if (!reloginPromise) {
    reloginPromise = Promise.resolve().then(function () {
      setToken('')
      renderTokenState()
      return acquireToken()
    }).then(function (t) {
      authGen += 1 // 世代推进：此后老 token 发出的迟到 401 = 过期请求，不再自动开门
      reloginPromise = null
      return t
    }, function (error) {
      reloginPromise = null
      throw error
    })
  }
  return reloginPromise
}
/** 用新 token 恰好重试一次；仍 401 = 抛错（不循环）。成功则持久化并重新武装。 */
function retryRelogin(path, options, t) {
  return request(path, options, t).then(function (res) {
    if (res.status === 401) {
      setToken('')
      renderTokenState()
      throw new Error(tr('authReloginFailed'))
    }
    markAuthOk()
    adoptToken(t)
    return res
  })
}
function api(path, options) {
  options = options || {}
  var token = getToken()
  var gen = authGen
  if (!token) return acquireToken().then(function (t) {
    if (!t) throw new Error(tr('noTokenRetry'))
    return apiWith(path, options, t, gen)
  })
  return apiWith(path, options, token, gen)
}
/** 一次请求 + 单次 401 裁决（并发 401 共享 reloginGate，只开一次门）。 */
function apiWith(path, options, token, gen) {
  return request(path, options, token).then(function (res) {
    if (res.status !== 401) {
      markAuthOk()
      adoptToken(token)
      return res
    }
    if (gen < authGen) {
      // 用已作废 token 发出的迟到 401：请求本身过期，不重登录、只拒掉这一条
      throw new Error(tr('staleTokenRequest'))
    }
    if (reloginPromise) {
      // 已有在途重登录（并发 401）→ 等它，用新 token 各自重试一次
      return reloginGate().then(function (t) {
        if (!t) throw new Error(tr('loginCancelled'))
        return retryRelogin(path, options, t)
      })
    }
    if (recoveryUsed) throw new Error(tr('authRetriedFailed'))
    recoveryUsed = true
    // 保留更具体的预置原因（如 init 的 fragment 凭证失效说明）；无预置时才用通用文案
    if (!gateReason) gateReason = tr('gateInvalidReason')
    return reloginGate().then(function (t) {
      if (!t) throw new Error(tr('loginCancelled'))
      return retryRelogin(path, options, t)
    })
  }).then(function (res) {
    return res.json().catch(function () { throw new Error(tr('httpNotJson', { status: res.status })) }).then(function (data) {
      if (!res.ok) throw new Error(data && data.error ? data.error : tr('httpStatus', { status: res.status }))
      return data
    })
  })
}

// ---------- 数据加载与总渲染 ----------
function overviewChannels() {
  var o = plain(state.overview)
  return Array.isArray(o.channels) ? o.channels : []
}
function outboundTypes() {
  return overviewChannels().filter(function (c) { return c.direction === 'outbound' }).map(function (c) { return c.type })
}
function inboundTypes() {
  return overviewChannels().filter(function (c) { return c.direction === 'inbound' }).map(function (c) { return c.type })
}
function loadAll() {
  setLoading(true)
  return Promise.all([api('/api/overview'), api('/api/bindings'), api('/api/sessions'), api('/api/channels'), api('/api/members'), api('/api/questions')])
    .then(function (rs) {
      state.overview = rs[0]; state.bindings = rs[1]; state.sessions = rs[2]; state.channels = rs[3]; state.members = rs[4]; state.questions = rs[5]
      draft = null
      renderDashboard(); renderBindings(); renderSessions(); renderChannels(); renderMembers(); renderPendingQuestions()
      flash(tr('refreshed', { time: new Date().toLocaleTimeString() }), 'ok')
    })
    .catch(function (e) { flash(tr('loadFailed', { error: errText(e) }), 'err') })
    .then(function () { setLoading(false); renderTokenState() })
}
function switchTab(name) {
  $all('.tabbtn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name) })
  $all('.tabsec').forEach(function (s) { s.classList.toggle('active', s.id === 'tab-' + name) })
}

// 个人模式是默认路径；高级导航仅在用户明确打开后显示。localStorage 受限时按个人模式降级。
function readAdminMode() {
  try { return window.localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'personal' } catch (e) { return 'personal' }
}
function applyAdminMode() {
  var advanced = readAdminMode() === 'advanced'
  $all('.advanced-tab').forEach(function (el) { el.hidden = !advanced })
  var toggle = $('#modeToggle')
  if (toggle) toggle.textContent = advanced ? tr('modeClose') : tr('modeOpen')
  if (!advanced && (document.querySelector('#tab-bindings.active') || document.querySelector('#tab-sessions.active'))) switchTab('dashboard')
}
function setAdminMode(mode) {
  try { window.localStorage.setItem(MODE_KEY, mode === 'advanced' ? 'advanced' : 'personal') } catch (e) {}
  applyAdminMode()
}
function readTestedState() {
  try { return window.localStorage.getItem(TESTED_KEY) === '1' } catch (e) { return false }
}
function markTestedState() {
  try { window.localStorage.setItem(TESTED_KEY, '1') } catch (e) {}
}
function readOnboardDismissed() {
  try { return window.localStorage.getItem('onboard_dismissed') === '1' } catch (e) { return false }
}

// ---------- 首页：英雄区（链路状态）+ 下一步行动 + 健康矩阵 + 审计流 ----------
/** 审计 detail 归一为可展示文本：对象/数组 JSON.stringify，空值空串（避免 [object Object]）。 */
function fmtDetail(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch (e) { return String(v) } }
  return String(v)
}
function chipGroups(groups, emptyText) {
  var total = 0
  groups.forEach(function (g) { total += g[2].length })
  if (total === 0) return '<div class="muted small">' + esc(emptyText) + '</div>'
  return groups.map(function (g) {
    var chips = g[2].map(function (c) { return '<span class="chip ' + g[1] + '">' + esc(c.type) + '</span>' }).join('')
    return '<div class="group"><div class="gtitle ' + g[1] + '">' + esc(g[0]) + ' · ' + g[2].length + '</div>' + chips + '</div>'
  }).join('')
}
function renderDashboard() {
  var o = plain(state.overview)
  var sess = plain(o.sessions)
  var keys = plain(o.agents).keys
  var m = plain(o.members) || {}
  $('#statActive').textContent = sess.active !== undefined ? String(sess.active) : '–'
  $('#statTotal').textContent = sess.total !== undefined ? String(sess.total) : '–'
  $('#statKeys').textContent = keys !== undefined ? String(keys) : '–'
  $('#statMembers').textContent = m.total !== undefined ? String(m.total) : '–'

  var out = overviewChannels().filter(function (c) { return c.direction === 'outbound' })
  var inn = overviewChannels().filter(function (c) { return c.direction === 'inbound' })
  var outConfigured = out.filter(function (c) { return c.configured }).length
  var outEnabled = out.filter(function (c) { return c.configured && c.enabled }).length
  var anyOutConfigured = outConfigured > 0
  var anyOutEnabled = outEnabled > 0
  var hasMembers = m.total > 0
  var tested = readTestedState()
  var dismissed = readOnboardDismissed()

  // 英雄区：系统是否工作、通知是否可达（一眼状态）
  var hero = $('#heroState')
  if (hero) {
    var hs = tr('heroUnconfigured')
    var hc = 'hero-state none'
    if (anyOutEnabled && tested) { hs = tr('heroReady'); hc = 'hero-state ok' }
    else if (tested && anyOutConfigured) { hs = tr('heroTested'); hc = 'hero-state warn' }
    else if (anyOutConfigured) { hs = tr('heroSaved'); hc = 'hero-state warn' }
    hero.textContent = hs
    hero.className = hc
  }
  var heroSub = $('#heroSub')
  if (heroSub) {
    heroSub.textContent = tr('heroSub', {
      enabled: outEnabled,
      total: out.length,
      inbound: inn.filter(function (c) { return c.configured }).length,
      members: m.total !== undefined ? m.total : 0,
    })
  }
  var beacon = $('#heroBeacon')
  if (beacon) beacon.className = 'beacon' + (anyOutEnabled && tested ? '' : ' dim')
  // 运行状态进度轨：未配置 → 已保存 → 已测试 → 正常运行
  var current = !anyOutConfigured ? 'unconfigured' : (!tested ? 'saved' : (!anyOutEnabled ? 'tested' : 'ready'))
  var order = ['unconfigured', 'saved', 'tested', 'ready']
  var currentIndex = order.indexOf(current)
  $all('#heroRail [data-hstate]').forEach(function (el) {
    var idx = order.indexOf(el.getAttribute('data-hstate'))
    el.classList.toggle('done', idx < currentIndex)
    el.classList.toggle('current', idx === currentIndex)
  })

  // 首访向导与验证横幅显隐：完成条件只有一个——当场收到测试通知（tested）。
  // 无任何已启用出站通道 → 三步向导；已启用未验证（升级用户）→ 轻量横幅；dismissed 持久隐藏。
  var showSetup = !dismissed && !tested && !anyOutEnabled
  var setupEl = $('#setup')
  if (setupEl) setupEl.hidden = !showSetup
  var banner = $('#verifyBanner')
  if (banner) banner.hidden = !(!dismissed && !tested && anyOutEnabled)
  if (showSetup) renderSetup()

  // 下一件该做的事
  var na = $('#nextAction')
  if (na) {
    var action
    if (!anyOutConfigured) {
      action = { cls: 'todo', title: tr('nextSetupTitle'), desc: tr('nextSetupDesc'), btn: tr('nextSetupBtn'), act: 'setup' }
    } else if (!tested) {
      action = { cls: 'todo', title: tr('nextTestTitle'), desc: tr('nextTestDesc'), btn: tr('nextTestBtn'), act: 'setup' }
    } else if (!hasMembers) {
      action = { cls: '', title: tr('nextMemberTitle'), desc: tr('nextMemberDesc'), btn: tr('nextMemberBtn'), act: 'members' }
    } else {
      action = { cls: 'ok', title: tr('nextReadyTitle'), desc: tr('nextReadyDesc'), btn: '', act: '' }
    }
    na.innerHTML = '<div class="nextcard ' + action.cls + '"><span class="nc-ico"><span class="dot '
      + (action.cls === 'ok' ? 'ok' : 'warn') + '"></span></span><div><b>' + esc(action.title) + '</b><p>'
      + esc(action.desc) + '</p></div>'
      + (action.btn ? '<div class="row"><button type="button" class="btn-primary" data-next="' + esc(action.act) + '">' + esc(action.btn) + '</button></div>' : '')
      + '</div>'
  }

  $('#outGroups').innerHTML = chipGroups([
    [tr('groupEnabled'), 'ok', out.filter(function (c) { return c.configured && c.enabled })],
    [tr('groupConfiguredDisabled'), 'warn', out.filter(function (c) { return c.configured && !c.enabled })],
    [tr('groupUnconfigured'), 'none', out.filter(function (c) { return !c.configured })]
  ], tr('outNoneEmpty', { total: out.length }))
  $('#inGroups').innerHTML = chipGroups([
    [tr('inConfigured'), 'ok', inn.filter(function (c) { return c.configured })],
    [tr('groupUnconfigured'), 'none', inn.filter(function (c) { return !c.configured })]
  ], tr('inNoneEmpty'))
  var audit = Array.isArray(o.audit) ? o.audit.slice(0, 30) : []
  $('#auditList').innerHTML = audit.map(function (row) {
    var r = plain(row)
    return '<div class="auditrow"><span class="at">' + esc(fmtTime(r.time)) + '</span><b>' + esc(r.action || '') + '</b><span class="mono">' + esc(fmtDetail(r.detail)) + '</span></div>'
  }).join('') || '<div class="muted small" style="padding:8px 0">' + esc(tr('noAudit')) + '</div>'
}
function onNextActionClick(ev) {
  var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-next]') : null
  if (!btn) return
  var act = btn.getAttribute('data-next')
  if (act === 'members') { switchTab('members'); return }
  if (act === 'setup') {
    try { window.localStorage.setItem('onboard_dismissed', '0') } catch (e) {}
    renderDashboard()
    var setupEl = $('#setup')
    if (setupEl && setupEl.scrollIntoView) { try { setupEl.scrollIntoView() } catch (e) {} }
  }
}

// ---------- 首访向导：选渠道 → 填凭证 → 保存并当场真实测试 ----------
// 完成条件唯一：用户确实收到测试通知（TESTED_KEY 落 localStorage）。入站/成员不阻塞。
var setupStep = 1
var setupType = ''
function setupMeta(type) {
  var m = ADMIN_STRINGS.channelMeta && ADMIN_STRINGS.channelMeta[type]
  if (m) return { name: m.name, tagline: m.tagline, rec: m.rec === true }
  return { name: type, tagline: '', rec: false }
}
function glyphOf(type) { return String(type || '?').slice(0, 2).toUpperCase() }
function renderSetup() {
  $all('#setupRail [data-step]').forEach(function (el) {
    var n = Number(el.getAttribute('data-step'))
    el.classList.toggle('done', n < setupStep)
    el.classList.toggle('current', n === setupStep)
  })
  var i
  for (i = 1; i <= 4; i += 1) {
    var pane = $('#setupPane' + i)
    if (pane) pane.hidden = i !== setupStep
  }
  if (setupStep === 1) renderSetupTiles()
}
function tileHtml(c) {
  var m = setupMeta(c.type)
  return '<button type="button" class="tile" data-setup-type="' + esc(c.type) + '">'
    + '<span class="tile-glyph">' + esc(glyphOf(c.type)) + '</span>'
    + '<b>' + esc(m.name) + '</b>'
    + (m.tagline ? '<span class="tile-tag">' + esc(m.tagline) + '</span>' : '')
    + (m.rec ? '<span class="tile-rec">' + esc(tr('tileRecommended')) + '</span>' : '')
    + (c.configured ? '<span class="tile-tag">' + esc(tr('tileSaved')) + '</span>' : '')
    + '</button>'
}
function renderSetupTiles() {
  var box = $('#setupTiles')
  if (!box) return
  var rows = (Array.isArray(state.channels) ? state.channels : []).filter(function (c) { return c && c.direction === 'outbound' })
  if (rows.length === 0) {
    box.innerHTML = '<p class="muted small">' + esc(tr('tilesNotLoaded')) + '</p>'
    return
  }
  var rec = rows.filter(function (c) { return setupMeta(c.type).rec })
  var rest = rows.filter(function (c) { return !setupMeta(c.type).rec })
  // 结构注意：#setupTiles 是纯容器（不能带 .tiles 网格类）——推荐行与展开区各自成网，
  // 否则展开区会沦为外层网格的一个格子，被压成单列（实测 1440px 下 27 张瓷砖挤成 1 列）。
  var html = '<div class="tiles">' + rec.map(tileHtml).join('')
  if (rest.length > 0) {
    html += '<button type="button" class="tile more" id="setupMore">' + esc(tr('tileMore', { total: rows.length })) + '</button>'
    html += '</div><div id="setupRest" class="tiles" hidden>' + rest.map(tileHtml).join('') + '</div>'
  } else {
    html += '</div>'
  }
  box.innerHTML = html
}
function setupGoto(step) {
  setupStep = step
  renderSetup()
}
function setupRowOf(type) {
  var row = null
  var list = Array.isArray(state.channels) ? state.channels : []
  list.forEach(function (c) { if (c && c.type === type && c.direction === 'outbound') row = c })
  return row
}
function setupFieldRow(key, spec, current) {
  var specObj = plain(spec)
  var req = specObj.required === true
  var secret = !(specObj.exposure === 'public' || (specObj.exposure === undefined && (specObj.secret === false || specObj.plain === true)))
  var desc = typeof specObj.desc === 'string' && specObj.desc !== '' ? specObj.desc : ''
  var shown = current === undefined ? '' : current
  return '<label class="fld"><span class="mono">' + esc(key) + (req ? ' <b style="color:var(--warn)">*</b>' : '')
    + '</span><input data-sf="' + esc(key) + '"' + (req ? ' data-req="1"' : '')
    + ' value="' + esc(shown) + '"'
    + (desc ? ' title="' + esc(desc) + '" placeholder="' + esc(desc) + '"' : '')
    + '>' + (secret ? '<button type="button" data-clear-field="' + esc(key) + '">' + esc(tr('fieldClear')) + '</button>' : '') + '</label>'
}
function buildSetupForm() {
  var row = setupRowOf(setupType)
  var meta = setupMeta(setupType)
  var title = $('#setupFormTitle')
  if (title) title.textContent = tr('setupFormTitle', { name: meta.name })
  var box = $('#setupForm')
  if (!box) return
  var specs = plain(row && row.fields)
  var cfg = plain(row && row.config)
  var seen = {}
  var keys = Object.keys(specs).filter(function (k) { seen[k] = 1; return true })
    .concat(Object.keys(cfg).filter(function (k) { return !seen[k] }))
  keys.sort(function (a, b) {
    var ra = plain(specs[a]).required === true ? 0 : 1
    var rb = plain(specs[b]).required === true ? 0 : 1
    return ra - rb
  })
  var html = keys.map(function (k) {
    var current = Object.prototype.hasOwnProperty.call(cfg, k)
      ? (cfg[k] === undefined || cfg[k] === null ? '***' : cfg[k])
      : undefined
    return setupFieldRow(k, specs[k], current)
  }).join('')
  // spec 声明 docUrl 的渠道（wps-bot）在向导表单底部附官方文档跳转
  if (row && typeof row.docUrl === 'string' && row.docUrl !== '') {
    html += '<p class="muted small"><a href="' + esc(row.docUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(tr('setupDocLink')) + '</a></p>'
  }
  box.innerHTML = html || '<p class="muted small">' + esc(tr('setupFormEmpty')) + '</p>'
}
function setupSelect(type) {
  setupType = type
  buildSetupForm()
  setupGoto(2)
}
function collectSetupPayload() {
  var payload = {}
  var clear = $all('#setupForm button[data-clear-field][data-clear="1"]').map(function (btn) { return btn.getAttribute('data-clear-field') })
  var missing = []
  $all('#setupForm input[data-sf]').forEach(function (inp) {
    var k = inp.getAttribute('data-sf')
    if (clear.indexOf(k) >= 0) return
    if (inp.getAttribute('data-req') === '1' && inp.value !== '***' && inp.value.trim() === '') { missing.push(k); return }
    if (inp.value === '***' || inp.value.trim() === '') return // *** 未修改 / 空值，均不提交
    payload[k] = inp.value
  })
  if (clear.length > 0) payload.clearSecrets = clear
  return { payload: payload, missing: missing }
}
function renderTestState(phase, text) {
  var el = $('#setupTestState')
  if (!el) return
  var ico = phase === 'fail' ? '<span class="dot err"></span>'
    : (phase === 'saving' || phase === 'testing' ? '<span class="spinner"></span>' : '<span class="dot ok"></span>')
  el.innerHTML = '<div class="setup-test"><span class="st-ico">' + ico + '</span><div>' + esc(text) + '</div></div>'
}
/** 向导保存（可选接续真实测试）：新方向出站 API，保存成功与测试成功是两个独立状态。 */
function setupSubmit(type, payload, alsoTest, btn) {
  var meta = setupMeta(type)
  if (alsoTest) {
    setupGoto(3)
    renderTestState('saving', tr('setupSavingConfig', { name: meta.name }))
  }
  setBtnBusy(btn, alsoTest ? tr('btnSavingAndTesting') : tr('btnSaving'))
  return api('/api/channels/outbound/' + encodeURIComponent(type), { method: 'PUT', body: { config: payload } })
    .then(function (r) {
      if (plain(r).saved === false) {
        if (alsoTest) { setupGoto(2) }
        setStatus($('#setupMsg2'), tr('writeStateFailed'), 'err')
        return null
      }
      if (!alsoTest) {
        setStatus($('#setupMsg2'), tr('setupSaveOnlyDone'), 'ok')
        return loadChannelsOnly()
      }
      renderTestState('testing', tr('setupTesting', { name: meta.name }))
      return setupTest(null)
    })
    .catch(function (e) {
      if (alsoTest) renderTestState('fail', tr('saveFailedRetry', { error: errText(e) }))
      else setStatus($('#setupMsg2'), tr('saveFailed', { error: errText(e) }), 'err')
    })
    .then(function () { restoreBtn(btn) })
}
/** 向导即时真实测试：读取最新合并配置（保存后无需重启）。失败保留输入并给出重试入口。 */
function setupTest(btn) {
  if (!setupType) return Promise.resolve()
  setBtnBusy(btn, tr('btnSending'))
  renderTestState('testing', tr('setupTestSending'))
  return api('/api/channels/outbound/' + encodeURIComponent(setupType) + '/test', { method: 'POST' })
    .then(function (r) {
      if (plain(r).ok === true) {
        markTestedState()
        var detail = plain(r).detail
        var done = $('#setupDoneDetail')
        if (done && typeof detail === 'string' && detail !== '') done.textContent = tr('deliveryReceipt', { detail: detail })
        setupGoto(4)
        loadAll()
      } else {
        var d = plain(r).detail
        renderTestState('fail', tr('testFailedRetry', { detail: typeof d === 'string' && d !== '' ? d : tr('channelReturnedFailure') }))
      }
    })
    .catch(function (e) {
      renderTestState('fail', tr('testFailedRetry', { detail: errText(e) }))
    })
    .then(function () { restoreBtn(btn) })
}
function setupSave(alsoTest, btn) {
  var msg = $('#setupMsg2')
  if (!setupType) { setStatus(msg, tr('setupPickChannel'), 'err'); return }
  var collected = collectSetupPayload()
  if (collected.missing.length > 0) {
    setStatus(msg, tr('missingRequired', { fields: collected.missing.join(tr('sessionChannelsJoiner')) }), 'err')
    return
  }
  if (Object.keys(collected.payload).length === 0) {
    setStatus(msg, tr('noChangedFields'), 'warn')
    return
  }
  setupSubmit(setupType, collected.payload, alsoTest, btn)
}
function dismissSetup() {
  try { window.localStorage.setItem('onboard_dismissed', '1') } catch (e) {}
  renderDashboard()
}
function finishSetup() {
  switchTab('dashboard')
  renderDashboard()
  flash(tr('setupDone'), 'ok')
}
function onSetupClick(ev) {
  var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null
  if (!btn || btn.disabled) return
  var clearKey = btn.getAttribute('data-clear-field')
  if (clearKey) {
    var marked = btn.getAttribute('data-clear') === '1'
    btn.setAttribute('data-clear', marked ? '0' : '1')
    btn.textContent = marked ? tr('fieldClear') : tr('fieldCleared')
    btn.className = marked ? '' : 'muted-btn'
    return
  }
  var type = btn.getAttribute('data-setup-type')
  if (type) { setupSelect(type); return }
  if (btn.id === 'setupMore') {
    var rest = $('#setupRest')
    if (rest) rest.hidden = !rest.hidden
    btn.textContent = rest && rest.hidden === false ? tr('tileMoreCollapse') : btn.textContent
    return
  }
  if (btn.id === 'setupBack2') { setupGoto(1); return }
  if (btn.id === 'setupGoTest') { setupSave(true, btn); return }
  if (btn.id === 'setupSaveOnly') { setupSave(false, btn); return }
  if (btn.id === 'setupBack3') { setupGoto(2); return }
  if (btn.id === 'setupRetest') { setupTest(btn); return }
}
/** 验证横幅（升级老用户）：对已启用出站通道发一条真实测试。 */
function bannerTest(btn) {
  var row = null
  overviewChannels().forEach(function (c) {
    if (!row && c.direction === 'outbound' && c.configured && c.enabled) row = c
  })
  var msg = $('#bannerMsg')
  if (!row) { setStatus(msg, tr('bannerNoEnabled'), 'err'); return Promise.resolve() }
  setBtnBusy(btn, tr('btnSending'))
  return api('/api/channels/outbound/' + encodeURIComponent(row.type) + '/test', { method: 'POST' })
    .then(function (r) {
      if (plain(r).ok === true) {
        markTestedState()
        flash(tr('bannerTestPassed', { type: row.type }), 'ok')
        renderDashboard()
      } else {
        var d = plain(r).detail
        setStatus(msg, tr('bannerTestFailed', { detail: typeof d === 'string' && d !== '' ? d : tr('channelReturnedFailure') }), 'err')
      }
    })
    .catch(function (e) { setStatus(msg, tr('bannerTestFailed', { detail: errText(e) }), 'err') })
    .then(function () { restoreBtn(btn) })
}
function onBannerClick(ev) {
  var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null
  if (!btn) return
  if (btn.id === 'bannerTest') { bannerTest(btn); return }
  if (btn.id === 'bannerDismiss') {
    try { window.localStorage.setItem('onboard_dismissed', '1') } catch (e) {}
    renderDashboard()
  }
}
function loadChannelsOnly() {
  return api('/api/channels').then(function (r) {
    state.channels = r
    renderChannels()
  }).catch(function () { /* 通道列表刷新失败不打断向导 */ })
}

// ---------- 待处理远程提问（脱敏只读快照 + 受保护结算）----------
// 只渲染 { ref, question, options, source(掩码), agent(掩码), 时间 }；token/凭证/完整标识
// 绝不下发到 DOM。为每个选项提供「采用此项」、整题一个「驳回（交还桌面）」。
function renderPendingQuestions() {
  var list = Array.isArray(state.questions) ? state.questions : []
  var el = $('#pendingQuestionsPanel')
  if (!el) return
  if (!list.length) {
    el.innerHTML = '<div class="muted small" style="padding:8px 0">' + esc(tr('noPendingQuestions')) + '</div>'
    return
  }
  el.innerHTML = list.map(function (q) {
    var qq = plain(q)
    var opts = (Array.isArray(qq.options) ? qq.options : []).map(function (label, idx) {
      return '<li><code>' + esc(String(idx + 1)) + '</code> · ' + esc(String(label)) +
        ' <button type="button" class="small q-choose" data-ref="' + esc(qq.ref) + '" data-opt="' + idx + '">' + esc(tr('qAdopt')) + '</button></li>'
    }).join('')
    var cul = (Array.isArray(qq.source) ? qq.source : []).map(function (s) {
      var sp = plain(s)
      return (esc(String(sp.channel || '?'))) + (sp.user ? ' · ' + esc(sp.user) : '') + (sp.chat ? ' · ' + esc(sp.chat) : '')
    }).join(tr('qJoiner'))
    var meta = []
    if (qq.agent) meta.push(tr('qAgent', { agent: esc(qq.agent) }))
    if (cul) meta.push(tr('qSource', { source: cul }))
    meta.push(tr('qCreated', { time: esc(fmtTime(qq.createdAt)) }))
    meta.push(tr('qExpires', { time: esc(fmtTime(qq.expiresAt)) }))
    return '<div class="card"><div class="card-head" style="cursor:default"><span class="dot warn"></span>' +
      '<b>' + esc(String(qq.question || tr('qNoText'))) + '</b><span class="badge none">' + esc(tr('qPendingBadge')) + '</span></div>' +
      '<div class="card-body"><ul class="qopts">' + opts + '</ul>' +
      '<div class="muted small">' + meta.join(' · ') + '</div>' +
      '<div class="row" style="margin-top:8px"><button type="button" class="small muted-btn q-reject" data-ref="' + esc(qq.ref) + '">' + esc(tr('qReject')) + '</button>' +
      '<span class="q-msg inline muted small"></span></div></div></div>'
  }).join('')
}
/** 提交一条 settle 到收件人识别的路由；成功/失败都写到卡片内 q-msg 并联动刷新。 */
function settleQuestionClick(ref, action, opt) {
  var target = undefined
  var refS = String(ref || '')
  if (action === 'choose' && opt !== undefined && opt !== null) {
    // Ref values come from the server but are still untrusted DOM data. Avoid
    // interpolating them into a CSS selector (a malformed quote would throw
    // before the request and leave the button stuck in an indeterminate state).
    target = $all('button[data-ref]').find(function (el) {
      return el.getAttribute('data-ref') === refS && el.getAttribute('data-opt') === String(opt)
    })
  } else {
    target = $all('button[data-ref]').find(function (el) {
      return el.getAttribute('data-ref') === refS
        && el.classList.contains(action === 'reject' ? 'q-reject' : 'q-choose')
    })
  }
  var msgBox = null
  if (target) {
    target.disabled = true
    var card = target.closest ? target.closest('.card') : null
    msgBox = card ? card.querySelector('.q-msg') : null
  }
  if (msgBox) setStatus(msgBox, tr('qSubmitting'), '')
  var body = { action: action }
  if (action === 'choose') body.options = [Number(opt)]
  api('/api/questions/' + encodeURIComponent(refS) + '/settle', {
    // api()/request() serializes object bodies exactly once. Passing a
    // pre-stringified payload here would double-encode JSON and make the
    // server spread a string, dropping action/options and returning 422.
    method: 'POST', body: body
  })
    .then(function (d) { if (msgBox) setStatus(msgBox, d.message || tr('qSettled'), 'ok') })
    .catch(function (e) { if (msgBox) setStatus(msgBox, tr('qNotEffective', { error: errText(e) }), 'err') })
    .then(function () { if (target) target.disabled = false; loadAll() })
}
function onQuestionsClick(evt) {
  var btn = evt.target && evt.target.closest ? evt.target.closest('button[data-ref]') : null
  if (!btn || btn.disabled) return
  if (btn.classList.contains('q-choose')) settleQuestionClick(btn.getAttribute('data-ref'), 'choose', Number(btn.getAttribute('data-opt')))
  else if (btn.classList.contains('q-reject')) settleQuestionClick(btn.getAttribute('data-ref'), 'reject')
}

// ---------- 绑定矩阵：agent 键勾选网格 + 通道默认 agent，整表 PUT ----------
function draftFromBindings() {
  var agents = {}
  var src = plain(plain(state.bindings).agents)
  Object.keys(src).forEach(function (k) {
    var e = plain(src[k])
    agents[k] = { channels: Array.isArray(e.channels) ? e.channels.slice() : [], quiet: e.quiet === true }
  })
  var defaults = {}
  var ch = plain(plain(state.bindings).channels)
  Object.keys(ch).forEach(function (c) {
    var d = plain(ch[c]).defaultAgent
    if (typeof d === 'string' && d !== '') defaults[c] = d
  })
  return { agents: agents, defaults: defaults }
}
function renderBindings() {
  if (!draft) draft = draftFromBindings()
  var outbound = outboundTypes()
  var keys = Object.keys(draft.agents)
  var rows = keys.map(function (key) {
    var e = draft.agents[key]
    var checks = outbound.map(function (t) {
      return '<label class="ck"><input type="checkbox" data-agent="' + esc(key) + '" value="' + esc(t) + '"'
        + (e.channels.indexOf(t) >= 0 ? ' checked' : '') + '>' + esc(t) + '</label>'
    }).join('')
    return '<tr><td class="mono">' + esc(key) + '</td><td class="wrap">'
      + (checks || '<span class="muted small">' + esc(tr('bindNoOutbound')) + '</span>')
      + '</td><td class="center"><input type="checkbox" data-quiet="' + esc(key) + '"' + (e.quiet ? ' checked' : '')
      + ' title="' + esc(tr('quietTitle')) + '"></td>'
      + '<td class="center"><button class="danger" data-del="' + esc(key) + '">' + esc(tr('delete')) + '</button></td></tr>'
  }).join('')
  if (keys.length === 0) rows = '<tr><td colspan="4" class="empty">' + esc(tr('bindNoAgents')) + '</td></tr>'
  $('#agentsBody').innerHTML = rows
  var drows = inboundTypes().map(function (c) {
    return '<tr><td class="mono">' + esc(c) + '</td><td><input class="wide" list="agentKeyOptions" data-default="'
      + esc(c) + '" value="' + esc(draft.defaults[c] || '') + '" placeholder="' + esc(tr('defaultAgentPlaceholder')) + '"></td></tr>'
  }).join('')
  $('#defaultsBody').innerHTML = drows || '<tr><td colspan="2" class="empty">' + esc(tr('bindNoInbound')) + '</td></tr>'
  $('#agentKeyOptions').innerHTML = keys.map(function (k) { return '<option value="' + esc(k) + '"></option>' }).join('')
}
function onBindingsChange(ev) {
  if (!draft) draft = draftFromBindings()
  var el = ev.target
  var key = el.getAttribute('data-agent')
  var quietKey = el.getAttribute('data-quiet')
  var defChan = el.getAttribute('data-default')
  if (key !== null && draft.agents[key]) {
    var list = draft.agents[key].channels
    var i = list.indexOf(el.value)
    if (el.checked && i < 0) list.push(el.value)
    if (!el.checked && i >= 0) list.splice(i, 1)
  } else if (quietKey !== null && draft.agents[quietKey]) {
    draft.agents[quietKey].quiet = el.checked
  } else if (defChan !== null) {
    draft.defaults[defChan] = el.value
  }
}
function onBindingsClick(ev) {
  var btn = ev.target.closest ? ev.target.closest('button') : null
  if (!btn) return
  if (!draft) draft = draftFromBindings()
  if (btn.id === 'btnAddKey') {
    var v = $('#newKey').value.trim()
    if (v === '') { setStatus($('#bindingsMsg'), tr('bindKeyRequired'), 'err'); return }
    if (draft.agents[v]) { setStatus($('#bindingsMsg'), tr('bindKeyExists', { key: v }), 'err'); return }
    draft.agents[v] = { channels: [], quiet: false }
    $('#newKey').value = ''
    renderBindings()
    setStatus($('#bindingsMsg'), tr('bindKeyAdded'), 'warn')
  } else if (btn.id === 'btnSaveBindings') {
    saveBindings(btn)
  } else if (btn.getAttribute('data-del')) {
    var k = btn.getAttribute('data-del')
    delete draft.agents[k]
    renderBindings()
    setStatus($('#bindingsMsg'), tr('bindKeyRemoved', { key: k }), 'warn')
  }
}
function saveBindings(btn) {
  var agents = {}
  Object.keys(draft.agents).forEach(function (k) {
    agents[k] = { channels: draft.agents[k].channels.slice(), quiet: draft.agents[k].quiet === true }
  })
  var channels = {}
  $all('#tab-bindings input[data-default]').forEach(function (inp) {
    var v = inp.value.trim()
    if (v !== '') channels[inp.getAttribute('data-default')] = { defaultAgent: v }
  })
  btn.disabled = true; var old = btn.textContent; btn.textContent = tr('btnSaving')
  api('/api/bindings', { method: 'PUT', body: { agents: agents, channels: channels } })
    .then(function (nb) { state.bindings = nb; draft = null; renderBindings(); setStatus($('#bindingsMsg'), tr('bindingsSaved'), 'ok') })
    .catch(function (e) { setStatus($('#bindingsMsg'), tr('saveFailed', { error: errText(e) }), 'err') })
    .then(function () { btn.disabled = false; btn.textContent = old })
}

// ---------- 会话：台账列表 + 出站覆盖（diff）编辑，PATCH ----------
function sessionRow(s, outbound) {
  var id = String(s.id || '')
  var res = plain(s.resolved)
  var diff = plain(s.outbound)
  var resolvedCh = Array.isArray(res.channelTypes) ? res.channelTypes : []
  var hasDiffCh = Array.isArray(diff.channels)
  var initCh = hasDiffCh ? diff.channels : resolvedCh
  var checks = outbound.map(function (t) {
    return '<label class="ck"><input type="checkbox" data-sch="' + esc(id) + '" value="' + esc(t) + '"'
      + (initCh.indexOf(t) >= 0 ? ' checked' : '') + '>' + esc(t) + '</label>'
  }).join('')
  var qv = diff.quiet === undefined || diff.quiet === null ? '' : (diff.quiet ? 'on' : 'off')
  var qsel = '<select data-squiet="' + esc(id) + '">'
    + '<option value=""' + (qv === '' ? ' selected' : '') + '>' + esc(tr('quietFollow')) + '</option>'
    + '<option value="on"' + (qv === 'on' ? ' selected' : '') + '>' + esc(tr('quietOn')) + '</option>'
    + '<option value="off"' + (qv === 'off' ? ' selected' : '') + '>' + esc(tr('quietOff')) + '</option></select>'
  var main = '<tr><td>' + esc(s.workspace || tr('unknown')) + '</td>'
    + '<td class="mono" title="' + esc(id) + '">' + esc(sidPrefix(id)) + '</td>'
    + '<td><span class="dot ' + (s.active ? 'ok' : 'off') + '"></span>' + (s.active ? tr('sessionActive') : tr('sessionGone')) + '</td>'
    + '<td class="wrap">' + esc(resolvedCh.join(tr('sessionChannelsJoiner')) || tr('sessionChannelsEmpty')) + '</td>'
    + '<td>' + (res.quiet ? tr('sessionQuiet') : tr('sessionNormal')) + '</td>'
    + '<td>' + esc(sourceLabel(res.source)) + '</td>'
    + '<td class="center">' + (Array.isArray(s.inbound) ? String(s.inbound.length) : '0') + '</td>'
    + '<td><button data-edit="' + esc(id) + '">' + esc(tr('sessionEditOutbound')) + '</button></td></tr>'
  var editor = '<tr class="editor" data-edfor="' + esc(id) + '" hidden><td colspan="8"><div class="edbox">'
    + '<label class="ck"><input type="checkbox" data-sover="' + esc(id) + '"' + (hasDiffCh ? ' checked' : '') + '>' + esc(tr('sessionOverrideOutbound')) + '</label>'
    + checks + '<span class="muted">·</span>' + qsel + '<button data-save="' + esc(id) + '">' + esc(tr('sessionPatchSave')) + '</button>'
    + '<div class="inline" data-sstat="' + esc(id) + '"></div>'
    + '<div class="muted small">' + esc(tr('sessionOverrideHint')) + '</div>'
    + '</div></td></tr>'
  return main + editor
}
function renderSessions() {
  var list = Array.isArray(state.sessions) ? state.sessions : []
  var outbound = outboundTypes()
  $('#sessionsBody').innerHTML = list.map(function (s) { return sessionRow(plain(s), outbound) }).join('')
    || '<tr><td colspan="8" class="empty">' + esc(tr('sessionEmpty')) + '</td></tr>'
}
function onSessionsClick(ev) {
  var btn = ev.target.closest ? ev.target.closest('button') : null
  if (!btn) return
  var id = btn.getAttribute('data-edit')
  if (id) {
    $all('tr[data-edfor]').forEach(function (tr) { if (tr.getAttribute('data-edfor') === id) tr.hidden = !tr.hidden })
    return
  }
  var saveId = btn.getAttribute('data-save')
  if (saveId) saveSession(saveId, btn)
}
function saveSession(id, btn) {
  var msg = byAttr('.inline[data-sstat]', 'data-sstat', id)
  var over = byAttr('input[data-sover]', 'data-sover', id)
  var qsel = byAttr('select[data-squiet]', 'data-squiet', id)
  var chans = $all('input[data-sch]').filter(function (c) { return c.getAttribute('data-sch') === id && c.checked })
    .map(function (c) { return c.value })
  var body = { channels: over && over.checked ? chans : null, quiet: !qsel || qsel.value === '' ? null : qsel.value === 'on' }
  btn.disabled = true; var old = btn.textContent; btn.textContent = tr('btnSaving')
  api('/api/sessions/' + encodeURIComponent(id), { method: 'PATCH', body: body })
    .then(function () { return api('/api/sessions') })
    .then(function (list) {
      state.sessions = list
      renderSessions()
      flash(tr('sessionOverrideSaved', { sid: sidPrefix(id) }), 'ok')
    })
    .catch(function (e) { setStatus(msg, tr('saveFailed', { error: errText(e) }), 'err') })
    .then(function () { if (btn.parentNode) { btn.disabled = false; btn.textContent = old } })
}

// ---------- 通道：出站（主）/ 入站（次）分组卡片；方向 API + 即时测试 + 删除 + 扫码 ----------
function splitKey(key) { var i = key.indexOf('|'); return [key.slice(0, i), key.slice(i + 1)] }
/**
 * 单个凭证字段行：fields 声明表驱动（required 标 * / desc 作 placeholder 与悬停提示），
 * config 已有键带脱敏当前值（字符串 → ***），fields 有而 config 无的键留空 = 从零新建。
 */
function fieldRow(key, spec, current, disabled) {
  var specObj = plain(spec)
  var req = specObj.required === true
  var secret = !(specObj.exposure === 'public' || (specObj.exposure === undefined && (specObj.secret === false || specObj.plain === true)))
  var desc = typeof specObj.desc === 'string' && specObj.desc !== '' ? specObj.desc : ''
  var shown = current === undefined ? '' : current
  return '<label class="fld"><span class="mono">' + esc(key) + (req ? ' <b style="color:var(--warn)">*</b>' : '')
    + '</span><input data-ck="' + esc(key) + '"' + (req ? ' data-req="1"' : '')
    + ' value="' + esc(shown) + '"'
    + (disabled ? ' disabled title="' + esc(tr('fieldReadonly')) + '"' : '')
    + (desc ? ' title="' + esc(desc) + '" placeholder="' + esc(desc) + '"' : '')
    + '>' + (secret && !disabled ? '<button type="button" data-clear-field="' + esc(key) + '">' + esc(tr('fieldClear')) + '</button>' : '') + '</label>'
}
function cardHtml(c) {
  var cfg = plain(c.config)
  var specs = plain(c.fields)
  var ro = c.editable === false // 只读防御：键域冲突等场景降级为只读展示
  // 字段键 = fields 声明键 ∪ config 现有键（YAML bootstrap 的 endpoint/timeoutMs 等也要展示）
  var seen = {}
  var keys = Object.keys(specs).filter(function (k) { seen[k] = 1; return true })
    .concat(Object.keys(cfg).filter(function (k) { return !seen[k] }))
  var fields = keys.map(function (k) {
    var current = Object.prototype.hasOwnProperty.call(cfg, k)
      ? (cfg[k] === undefined || cfg[k] === null ? '***' : cfg[k])
      : undefined
    return fieldRow(k, specs[k], current, ro)
  }).join('')
  var dir = c.direction === 'inbound' ? tr('dirInbound') : tr('dirOutbound')
  // G-14（W12）：出站配置视图热/投递冷——出站行保存后 UI 即时回显，但投递层（出站路由/
  // 通道实例）只在插件下次启动时并入运行时（YAML ⊕ store 合并），故角标显著标记「重启后
  // 生效」而非「已配置」；入站保持「已配置」（凭证保存即下次启动启用/重连，语义近似热）。
  // 标记随 getChannels 返回的 restartRequired 走：出站恒 true（YAML 改也要重启才并入）。
  var badge = c.configured
    ? '<span class="badge ' + (c.restartRequired ? 'warn">' + esc(tr('badgeRestart')) : 'ok">' + esc(tr('badgeConfigured'))) + '</span>'
    : '<span class="badge none">' + esc(tr('badgeUnconfigured')) + '</span>'
  var scan = c.direction === 'inbound' && SCAN_TYPES.indexOf(c.type) >= 0
    ? '<button data-scan="' + esc(c.type) + '">' + esc(tr('scanAuth')) + '</button>' : ''
  // spec 声明 docUrl 的渠道（wps-bot）在卡片头部附官方文档跳转
  var docLink = c.docUrl
    ? ' <a class="muted small" href="' + esc(c.docUrl) + '" target="_blank" rel="noopener noreferrer" title="' + esc(tr('docOpenTitle')) + '">' + esc(tr('docOpen')) + '</a>'
    : ''
  // 微信专属提示：iLink 机器人 = 扫码微信的专属好友（1:1），扫码那一刻即完成配对
  var wechatHint = c.type === 'wechat' && c.direction === 'inbound'
    ? '<p class="muted small">' + tr('wechatHint') + '</p>'
    : ''
  var key = c.type + '|' + c.direction
  // testChannel 语义是出站连通性自检——入站凭证行按钮换文案，
  // 不再让用户误以为它能验证入站链路是否可用
  var testLabel = c.direction === 'inbound' ? tr('testInbound') : tr('testSend')
  var controls = ro
    ? '<span class="muted small">' + tr('readonlyHint', { type: esc(c.type) }) + '</span>'
    : '<button class="btn-primary" data-save="' + esc(key) + '">' + esc(tr('save')) + '</button>'
  var del = !ro && c.configured
    ? '<button class="danger" data-delch="' + esc(key) + '">' + esc(tr('deleteConfig')) + '</button>' : ''
  return '<div class="card" data-key="' + esc(key) + '">'
    + '<div class="card-head"><span class="glyph">' + esc(glyphOf(c.type)) + '</span><b class="mono">' + esc(c.type) + '</b><span class="dir-tag">' + esc(dir) + '</span>' + badge + docLink + '</div>'
    + '<div class="card-body" hidden>'
    + (fields || '<p class="muted small">' + esc(tr('cardEmptyFields')) + '</p>')
    + wechatHint
    + (keys.length > 0 && !ro
      ? '<p class="muted small">' + esc(tr('fieldHint')) + '</p>' : '')
    + '<div class="row">' + controls
    + '<button data-test="' + esc(key) + '" title="' + esc(tr('testTitle')) + '">' + esc(testLabel) + '</button>' + scan + del + '</div>'
    + '<div class="inline" data-cmsg="' + esc(key) + '"></div>'
    + '<div class="inline" data-smsg="' + esc(c.type) + '"></div>'
    + '</div></div>'
}
function renderChannels() {
  var list = Array.isArray(state.channels) ? state.channels : []
  var out = list.filter(function (c) { return c && c.direction === 'outbound' })
  var inn = list.filter(function (c) { return c && c.direction === 'inbound' })
  // 排序：已配置在前，其后推荐，最后其余（其余收进「更多渠道」折叠组，避免 27 张卡一次性铺开）
  function rank(c) { return (c.configured ? 0 : 1) * 10 + (setupMeta(c.type).rec ? 0 : 1) }
  function sorter(a, b) { return rank(a) - rank(b) || String(a.type).localeCompare(String(b.type)) }
  out = out.slice().sort(sorter)
  inn = inn.slice().sort(sorter)
  // 平铺 = 已配置 ∪ 推荐；折叠 = 其余（未配置且非推荐）
  function split(rows) {
    var top = rows.filter(function (c) { return c.configured || setupMeta(c.type).rec })
    var more = rows.filter(function (c) { return !(c.configured || setupMeta(c.type).rec) })
    return [top, more]
  }
  var outSp = split(out)
  var innSp = split(inn)
  function moreBlock(more) {
    if (more.length === 0) return ''
    return '<details class="more-group"><summary>' + esc(tr('moreChannels', { count: more.length })) + '<span class="muted small">' + esc(tr('moreChannelsHint')) + '</span></summary>'
      + '<div class="more-body">' + more.map(function (c) { return cardHtml(plain(c)) }).join('') + '</div></details>'
  }
  var html = '<h3 class="chan-group-title">' + esc(tr('groupOutboundTitle')) + '<span class="dir-tag">' + esc(tr('groupOutboundTag')) + '</span><span class="muted small">' + esc(tr('groupOutboundHint')) + '</span></h3>'
  html += outSp[0].map(function (c) { return cardHtml(plain(c)) }).join('') || '<p class="muted">' + esc(tr('noOutbound')) + '</p>'
  html += moreBlock(outSp[1])
  html += '<h3 class="chan-group-title">' + esc(tr('groupInboundTitle')) + '<span class="dir-tag">' + esc(tr('groupInboundTag')) + '</span><span class="muted small">' + esc(tr('groupInboundHint')) + '</span></h3>'
  html += innSp[0].map(function (c) { return cardHtml(plain(c)) }).join('') || '<p class="muted">' + esc(tr('noInbound')) + '</p>'
  html += moreBlock(innSp[1])
  $('#channelCards').innerHTML = html
}
function saveChannel(key, btn) {
  var type = splitKey(key)[0]
  var direction = splitKey(key)[1]
  var card = byAttr('.card[data-key]', 'data-key', key)
  var msg = byAttr('.inline[data-cmsg]', 'data-cmsg', key)
  var payload = {}
  var clear = $all('button[data-clear-field][data-clear="1"]', card).map(function (button) { return button.getAttribute('data-clear-field') })
  var missing = []
  $all('input[data-ck]', card).forEach(function (inp) {
    var k = inp.getAttribute('data-ck')
    if (clear.indexOf(k) >= 0) return
    // 必填字段被清空（值非 *** 即代表用户动过）→ 记入缺失清单提示，不静默剔除
    if (inp.getAttribute('data-req') === '1' && inp.value !== '***' && inp.value.trim() === '') {
      missing.push(k)
      return
    }
    if (inp.value === '***' || inp.value.trim() === '') return // *** 未修改 / 空值，均不提交
    payload[k] = inp.value
  })
  if (clear.length > 0) payload.clearSecrets = clear
  if (missing.length > 0) {
    setStatus(msg, tr('missingRequired', { fields: missing.join(tr('sessionChannelsJoiner')) }), 'err')
    return
  }
  if (Object.keys(payload).length === 0) {
    setStatus(msg, tr('noChangedFields'), 'warn')
    return
  }
  btn.disabled = true; var old = btn.textContent; btn.textContent = tr('btnSaving')
  // 方向明确 API：出站写 admin 自有出站键，入站写 <type>:account（与扫码落盘同域）
  var path = direction === 'inbound'
    ? '/api/channels/inbound/' + encodeURIComponent(type)
    : '/api/channels/outbound/' + encodeURIComponent(type)
  api(path, { method: 'PUT', body: { config: payload } })
    .then(function (r) {
      if (plain(r).saved === false) {
        setStatus(msg, tr('channelWriteFailed'), 'err')
        return
      }
      // 热更新边界：store 凭证在下次插件启动时并入运行时（YAML ⊕ store 合并）；
      // 出站自检与入站凭证语义分开说清；保存后角标就地翻成「重启后生效」即时回显
      // （不整表重渲染，避免收起正在编辑的其他卡片）；本地 state 同步置 configured。
      if (direction === 'outbound') {
        var head = card ? $('.card-head', card) : null
        var oldBadge = head ? $('.badge', head) : null
        if (oldBadge) oldBadge.outerHTML = '<span class="badge warn">' + esc(tr('badgeRestart')) + '</span>'
        var local = (state.channels || []).filter(function (c) { return c.type === type && c.direction === direction })[0]
        if (local) local.configured = true
      }
      setStatus(msg, direction === 'inbound'
        ? tr('channelSavedInbound')
        : tr('channelSavedOutbound'), 'ok')
    })
    .catch(function (e) { setStatus(msg, tr('saveFailed', { error: errText(e) }), 'err') })
    .then(function () { btn.disabled = false; btn.textContent = old })
}
function testChannel(key, btn) {
  var type = splitKey(key)[0]
  var direction = splitKey(key)[1]
  var msg = byAttr('.inline[data-cmsg]', 'data-cmsg', key)
  btn.disabled = true; var old = btn.textContent; btn.textContent = tr('btnTesting')
  // 出站走即时真实测试（最新 YAML+state 合并配置，保存后无需重启）；入站行保留旧自检语义
  var path = direction === 'inbound'
    ? '/api/channels/' + encodeURIComponent(type) + '/test'
    : '/api/channels/outbound/' + encodeURIComponent(type) + '/test'
  api(path, { method: 'POST' })
    .then(function (r) {
      var ok = plain(r).ok === true
      if (ok) {
        markTestedState()
        setStatus(msg, tr('testPassedNext', { detail: r.detail ? tr('detailSuffix', { detail: r.detail }) : '' }), 'ok')
      } else {
        setStatus(msg, tr('testFailedNext', { detail: r.detail ? tr('detailSuffix', { detail: r.detail }) : '' }), 'err')
      }
    })
    .catch(function (e) { setStatus(msg, tr('testFailedNext', { detail: tr('detailSuffix', { detail: errText(e) }) }), 'err') })
    .then(function () { btn.disabled = false; btn.textContent = old })
}
function deleteChannel(key, btn) {
  var type = splitKey(key)[0]
  var direction = splitKey(key)[1]
  var label = direction === 'inbound' ? tr('deleteInboundLabel') : tr('deleteOutboundLabel')
  // 删除不可恢复：显式确认，避免窄屏误触清空凭证（YAML 同名行不受影响）
  if (typeof window.confirm === 'function'
    && !window.confirm(tr('deleteConfirm', { type: type, label: label }))) return
  btn.disabled = true
  var path = direction === 'inbound'
    ? '/api/channels/inbound/' + encodeURIComponent(type)
    : '/api/channels/outbound/' + encodeURIComponent(type)
  api(path, { method: 'DELETE' })
    .then(function () { flash(tr('deleted', { type: type, label: label }), 'ok'); return api('/api/channels') })
    .then(function (rows) { state.channels = rows; renderChannels(); renderDashboard() })
    .catch(function (e) { flash(tr('deleteFailed', { error: errText(e) }), 'err'); btn.disabled = false })
}
function scanMsgEl(type) { return byAttr('.inline[data-smsg]', 'data-smsg', type) }
function toggleScan(type, btn) {
  if (scanTimers[type]) {
    clearTimeout(scanTimers[type]); scanTimers[type] = null
    btn.textContent = tr('scanAuth')
    setStatus(scanMsgEl(type), tr('scanStopped'), 'warn')
    return
  }
  btn.textContent = tr('scanStopPolling')
  scanStep(type, btn)
}
function scanStep(type, btn) {
  api('/api/scan/' + encodeURIComponent(type), { method: 'POST' })
    .then(function (r) {
      var qr = plain(r).qrContent
      var failed = typeof r.error === 'string' && r.error !== ''
      var html = ''
      if (qr) {
        html += '<div class="row qr"><span class="mono">' + esc(qr) + '</span><button data-copy="' + esc(qr) + '">' + esc(tr('scanCopy')) + '</button></div>'
        html += /^https?:/i.test(qr)
          ? '<div class="small"><a href="' + esc(qr) + '" target="_blank" rel="noopener">' + esc(tr('scanOpenLink')) + '</a> · ' + esc(tr('scanOrCopy')) + '</div>'
          : '<div class="small muted">' + esc(tr('scanCopyHint')) + '</div>'
      }
      if (failed) html += '<div class="small" style="color:var(--err)">' + esc(tr('scanFailed', { error: esc(r.error) })) + '</div>'
      else if (r.saved) html += '<div class="small" style="color:var(--ok)">' + esc(tr('scanSaved')) + '</div>'
      else if (r.done) html += '<div class="small" style="color:var(--ok)">' + esc(tr('scanDone')) + '</div>'
      else html += '<div class="small muted">' + esc(tr('scanWaiting')) + '</div>'
      var el = scanMsgEl(type)
      if (el) { el.className = 'inline show ' + (failed ? 'err' : 'ok'); el.innerHTML = html }
      if (!r.done && !r.saved && !failed) scanTimers[type] = setTimeout(function () { scanStep(type, btn) }, 2000)
      else { scanTimers[type] = null; btn.textContent = tr('scanAuth') }
    })
    .catch(function (e) {
      scanTimers[type] = null
      btn.textContent = tr('scanAuth')
      setStatus(scanMsgEl(type), tr('scanAuthFailed', { error: errText(e) }), 'err')
    })
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      function () { flash(tr('copied'), 'ok') },
      function () { flash(tr('copyFailed'), 'err') })
  } else {
    flash(tr('clipboardUnavailable'), 'warn')
  }
}
function onChannelsClick(ev) {
  var btn = ev.target.closest ? ev.target.closest('button') : null
  if (btn) {
    var saveKey = btn.getAttribute('data-save')
    var testKey = btn.getAttribute('data-test')
    var scanType = btn.getAttribute('data-scan')
    var copyVal = btn.getAttribute('data-copy')
    var delKey = btn.getAttribute('data-delch')
    var clearKey = btn.getAttribute('data-clear-field')
    if (clearKey) {
      var marked = btn.getAttribute('data-clear') === '1'
      btn.setAttribute('data-clear', marked ? '0' : '1')
      btn.textContent = marked ? tr('fieldClear') : tr('fieldCleared')
      btn.className = marked ? '' : 'muted-btn'
      return
    }
    if (saveKey) { saveChannel(saveKey, btn); return }
    if (testKey) { testChannel(testKey, btn); return }
    if (scanType) { toggleScan(scanType, btn); return }
    if (copyVal) { copyText(copyVal); return }
    if (delKey) { deleteChannel(delKey, btn); return }
  }
  var head = ev.target.closest ? ev.target.closest('.card-head') : null
  if (head) {
    var body = head.parentNode.querySelector('.card-body')
    if (body) body.hidden = !body.hidden
  }
}

// ---------- 成员页：身份绑定表 + 配对码生命周期 + 待确认绑定 ----------
function fmtRemain(ms) {
  var s = Math.floor(ms / 1000)
  if (s <= 0) return tr('expired')
  var m = Math.floor(s / 60)
  if (m >= 60) return tr('remainHoursMinutes', { h: Math.floor(m / 60), m: m % 60 })
  return tr('remainMinutesSeconds', { m: m, s: s % 60 })
}
var pairCountdownTimer = null
function stopPairCountdown() {
  if (pairCountdownTimer) { clearInterval(pairCountdownTimer); pairCountdownTimer = null }
  var box = $('#pairCodeBox')
  if (box) { box.hidden = true; box.className = 'paircode' }
}
function showPairCode(r) {
  var box = $('#pairCodeBox')
  box.innerHTML = '<div class="code">' + esc(r.code) + '</div>'
    + '<div class="ttl">' + tr('pairValidUntil', { time: esc(fmtTime(r.expiresAt)), remain: '<span data-remain></span>', code: esc(r.code) }) + '</div>'
  box.hidden = false
  box.className = 'paircode show'
  stopPairCountdown()
  var remain = box.querySelector('[data-remain]')
  pairCountdownTimer = setInterval(function () {
    var left = Number(r.expiresAt) - Date.now()
    if (left <= 0) { stopPairCountdown(); return }
    remain.textContent = tr('remainPrefix', { remain: fmtRemain(left) })
  }, 1000)
  remain.textContent = tr('remainPrefix', { remain: fmtRemain(Number(r.expiresAt) - Date.now()) })
}
function mintPairingCode() {
  var btn = $('#btnMint')
  var msg = $('#pairMsg')
  var body = { ttlMin: Number($('#pairTtl').value) || 10 }
  var label = $('#pairLabel').value.trim()
  if (label !== '') body.label = label
  btn.disabled = true
  api('/api/pairing', { method: 'POST', body: body })
    .then(function (r) {
      var res = plain(r)
      showPairCode(res)
      var ttlText = body.ttlMin >= 60
        ? tr('ttlHours', { h: Math.floor(body.ttlMin / 60) })
        : tr('ttlMinutes', { m: body.ttlMin })
      setStatus(msg, tr('pairMinted', { id: res.id || '', ttl: ttlText }), 'ok')
      return loadMembersOnly()
    })
    .catch(function (e) { setStatus(msg, tr('pairMintFailed', { error: errText(e) }), 'err') })
    .then(function () { btn.disabled = false })
}
function loadMembersOnly() {
  return api('/api/members').then(function (r) { state.members = r; renderMembers() })
    .catch(function (e) { flash(tr('membersRefreshFailed', { error: errText(e) }), 'err') })
}
function renderMembers() {
  var m = plain(state.members)
  var members = Array.isArray(m.members) ? m.members : []
  var pending = Array.isArray(m.pending) ? m.pending : []
  var codes = Array.isArray(m.pairingCodes) ? m.pairingCodes : []
  $('#mCount').textContent = String(members.length)
  $('#mOwners').textContent = String(members.filter(function (r) { return plain(r).role === 'owner' }).length)
  $('#mPending').textContent = String(pending.length)
  $('#mGuided').hidden = m.guided !== true
  $('#membersBody').innerHTML = members.map(function (row) {
    var r = plain(row)
    return '<tr>'
      + '<td><span class="chip ' + (r.role === 'owner' ? 'warn' : 'ok') + '">' + esc(r.channel) + '</span></td>'
      + '<td class="mono" title="' + esc(r.key) + '">' + esc(r.userId) + '</td>'
      + '<td><input data-mlabel="' + esc(r.key) + '" value="' + esc(r.label || '') + '" placeholder="' + esc(tr('labelPlaceholder')) + '" style="max-width:160px"></td>'
      + '<td><select data-mrole="' + esc(r.key) + '">'
      + '<option value="member"' + (r.role !== 'owner' ? ' selected' : '') + '>member</option>'
      + '<option value="owner"' + (r.role === 'owner' ? ' selected' : '') + '>owner</option>'
      + '</select></td>'
      + '<td>' + esc(fmtTime(r.pairedAt)) + '</td>'
      + '<td>' + (Number(r.lastSeenAt) > 0 ? esc(fmtTime(r.lastSeenAt)) : '—') + '</td>'
      + '<td><button class="danger" data-mdel="' + esc(r.key) + '">' + esc(tr('delete')) + '</button></td>'
      + '</tr>'
  }).join('') || '<tr><td colspan="7" class="empty">' + esc(tr('membersEmpty')) + '</td></tr>'
  $('#pairingBody').innerHTML = codes.map(function (row) {
    var r = plain(row)
    var left = Number(r.expiresAt) - Date.now()
    return '<tr>'
      + '<td class="mono">' + esc(r.id || '') + '</td>'
      + '<td>' + esc(r.origin || '') + '</td>'
      + '<td><span class="chip ' + (r.state === 'active' ? 'ok' : 'warn') + '">' + esc(r.state || '') + '</span></td>'
      + '<td>' + esc(fmtTime(r.mintedAt)) + '</td>'
      + '<td>' + esc(fmtRemain(left)) + '</td>'
      + '<td>' + esc(r.label || '') + '</td>'
      + '<td><button class="danger" data-prevoke="' + esc(r.id) + '">' + esc(tr('revoke')) + '</button></td>'
      + '</tr>'
  }).join('') || '<tr><td colspan="7" class="empty">' + esc(tr('pairCodesEmpty')) + '</td></tr>'
  $('#pendingBody').innerHTML = pending.map(function (row) {
    var r = plain(row)
    return '<tr>'
      + '<td><span class="chip none">' + esc(r.channel) + '</span></td>'
      + '<td class="mono">' + esc(r.userId) + '</td>'
      + '<td>' + esc(r.origin || 'learned') + '</td>'
      + '<td>' + esc(fmtTime(r.at)) + '</td>'
      + '<td><button data-pconfirm="' + esc(r.key) + '">' + esc(tr('confirmPromote')) + '</button>'
      + ' <button class="danger" data-pdismiss="' + esc(r.key) + '">' + esc(tr('dismiss')) + '</button></td>'
      + '</tr>'
  }).join('') || '<tr><td colspan="5" class="empty">' + esc(tr('pendingEmpty')) + '</td></tr>'
}
function memberKeyOf(el, attr) { return el.getAttribute(attr) || '' }
function onMembersChange(ev) {
  var labelKey = ev.target.getAttribute && ev.target.getAttribute('data-mlabel')
  var roleKey = ev.target.getAttribute && ev.target.getAttribute('data-mrole')
  if (labelKey !== null && labelKey !== undefined && labelKey !== '' && ev.target.getAttribute('data-mlabel')) {
    api('/api/members/' + encodeURIComponent(labelKey), { method: 'PUT', body: { label: ev.target.value } })
      .then(function () { flash(tr('labelUpdated'), 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash(tr('labelUpdateFailed', { error: errText(e) }), 'err') })
    return
  }
  if (roleKey) {
    api('/api/members/' + encodeURIComponent(roleKey), { method: 'PUT', body: { role: ev.target.value } })
      .then(function () { flash(tr('roleUpdated'), 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash(tr('roleUpdateFailed', { error: errText(e) }), 'err'); return loadMembersOnly() })
  }
}
function onMembersClick(ev) {
  var btn = ev.target.closest ? ev.target.closest('button') : null
  if (!btn) return
  if (btn.id === 'btnMint') { mintPairingCode(); return }
  var delKey = memberKeyOf(btn, 'data-mdel')
  if (delKey) {
    if (!window.confirm(tr('deleteMemberConfirm', { key: delKey }))) return
    api('/api/members/' + encodeURIComponent(delKey), { method: 'DELETE' })
      .then(function () { flash(tr('memberDeleted', { key: delKey }), 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash(tr('deleteFailed', { error: errText(e) }), 'err') })
    return
  }
  var revokeId = memberKeyOf(btn, 'data-prevoke')
  if (revokeId) {
    // Revoking a pairing code is destructive: the one-shot code becomes unusable
    // immediately and cannot be recovered. Require an explicit confirmation so a
    // fat-fingered click on a narrow/mobile layout does not strand the invitee.
    // Compatibility contract: the localized confirmation must state 立即失效 / 无法恢复.
    if (!window.confirm(tr('revokePairConfirm', { id: revokeId }))) return
    api('/api/pairing/' + encodeURIComponent(revokeId), { method: 'DELETE' })
      .then(function () { flash(tr('pairRevoked', { id: revokeId }), 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash(tr('revokeFailed', { error: errText(e) }), 'err') })
    return
  }
  var confirmKey = memberKeyOf(btn, 'data-pconfirm')
  if (confirmKey) {
    api('/api/members/' + encodeURIComponent(confirmKey) + '/confirm', { method: 'POST' })
      .then(function () { flash(tr('memberConfirmed', { key: confirmKey }), 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash(tr('confirmFailed', { error: errText(e) }), 'err') })
    return
  }
  var dismissKey = memberKeyOf(btn, 'data-pdismiss')
  if (dismissKey) {
    // Compatibility contract: the localized confirmation must explain 当前请求将被删除 / 重新触发.
    if (!window.confirm(tr('dismissConfirm', { key: dismissKey }))) return
    api('/api/members/' + encodeURIComponent(dismissKey) + '/dismiss', { method: 'POST' })
      .then(function () { flash(tr('dismissed', { key: dismissKey }), 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash(tr('opFailed', { error: errText(e) }), 'err') })
  }
}

// ---------- 通知页：SSE 事件流 → 系统桌面通知 + Web Audio 提示音 + 页面日志 ----------
// 偏好四项存 localStorage（默认全开）：总开关 / 普通级也弹 / 紧急级提示音 / 仅页面不可见时弹。
// 语义（对齐参考成品 dsh-notification 的取舍）：replay 事件只进日志不弹（断线期间的不补弹）；
// 同级别 tag 复用让新通知顶掉旧的（通知中心不堆山）；声音走 Web Audio（用户手势解锁 AudioContext）。
var NOTIFY_PREFS_KEY = 'dsh-notify-prefs'
var notifyLog = []
var notifyCount = 0
var audioCtx = null
var notifyStreamTimer = null
var notifyStreamEpoch = 0

function readNotifyPrefs() {
  var p = {}
  try { p = plain(JSON.parse(window.localStorage.getItem(NOTIFY_PREFS_KEY) || '{}')) } catch (e) {}
  return {
    enable: p.enable !== false,
    active: p.active !== false,
    sound: p.sound !== false,
    hiddenOnly: p.hiddenOnly !== false,
  }
}
function writeNotifyPrefs() {
  var p = readNotifyPrefs()
  try { window.localStorage.setItem(NOTIFY_PREFS_KEY, JSON.stringify(p)) } catch (e) {}
  $('#npEnable').checked = p.enable
  $('#npActive').checked = p.active
  $('#npSound').checked = p.sound
  $('#npHidden').checked = p.hiddenOnly
}
function setStreamState(text) { var el = $('#nStream'); if (el) el.textContent = text }
function stopNotifyStream() {
  notifyStreamEpoch += 1
  if (notifyStreamTimer) { clearTimeout(notifyStreamTimer); notifyStreamTimer = null }
}
function renderPermState() {
  var el = $('#nPerm')
  if (!el) return
  var perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  el.textContent = perm === 'granted' ? tr('permGranted') : perm === 'denied' ? tr('permDenied') : perm === 'unsupported' ? tr('permUnsupported') : tr('permDefault')
}
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    var osc = audioCtx.createOscillator()
    var gain = audioCtx.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime)
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start()
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.4)
    osc.stop(audioCtx.currentTime + 0.45)
  } catch (e) { /* 声音是锦上添花：AudioContext 被策略挡住时静默 */ }
}
/** 弹系统通知：同级别 tag 复用（新事件顶掉旧横幅）；构造失败静默（API 缺失/权限收回）。 */
function fireNotification(title, body, level) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try { new Notification(title, { body: body, tag: 'dsh-notify-' + level }) } catch (e) {}
}
function levelClass(level) {
  return level === 'timeSensitive' ? 'err' : level === 'active' ? 'ok' : 'none'
}
function onNotifyEvent(evt) {
  var e = plain(evt)
  var payload = plain(e.payload)
  var msg = plain(payload.message)
  notifyCount += 1
  $('#nCount').textContent = String(notifyCount)
  notifyLog.unshift({ time: e.time || '', level: msg.level || '', title: msg.title || tr('noTitle'), body: msg.content || '', delivered: Array.isArray(payload.delivered) ? payload.delivered : [], accepted: Array.isArray(payload.accepted) ? payload.accepted : (Array.isArray(payload.delivered) ? payload.delivered : []), confirmed: Array.isArray(payload.confirmed) ? payload.confirmed : [], failed: Array.isArray(payload.failed) ? payload.failed.length : 0, replay: e.replay === true })
  if (notifyLog.length > 50) notifyLog.length = 50
  renderNotifyLog()
  if (e.replay === true) return // 断线期间的事件只补日志不补弹（不轰炸通知中心）
  var prefs = readNotifyPrefs()
  if (!prefs.enable) return
  if (msg.level === 'passive') return // 摘要类永不弹
  if (msg.level !== 'timeSensitive' && !prefs.active) return
  if (prefs.hiddenOnly && document.hidden === false) return // 页面正看着：日志已可见，不再弹系统横幅
  fireNotification(msg.title || tr('notifyAppName'), msg.content || '', msg.level || 'active')
  if (prefs.sound && msg.level === 'timeSensitive') beep()
}
function renderNotifyLog() {
  var body = $('#notifyLog')
  if (!body) return
  if (notifyLog.length === 0) { body.innerHTML = '<tr><td colspan="5" class="empty">' + esc(tr('noEvents')) + '</td></tr>'; return }
  body.innerHTML = notifyLog.map(function (row) {
    // v0.13（R4）：accepted ≠ confirmed。无显式回执只能说「已发送到提供方」，不得宣称「已送达」。
    var confirmed = Array.isArray(row.confirmed) ? row.confirmed : []
    var accepted = Array.isArray(row.accepted) ? row.accepted : (Array.isArray(row.delivered) ? row.delivered : [])
    var delivery = confirmed.length > 0 ? tr('deliveredConfirmed', { channels: esc(confirmed.join(tr('sessionChannelsJoiner'))) })
      : accepted.length > 0 ? tr('deliveredAccepted', { channels: esc(accepted.join(tr('sessionChannelsJoiner'))) })
        : tr('notDelivered')
    if (row.failed > 0) delivery += tr('failedChannelsSuffix', { count: row.failed })
    return '<tr><td class="small">' + esc(fmtTime(row.time)) + '</td>'
      + '<td><span class="chip ' + levelClass(row.level) + '">' + esc(row.level || '?') + '</span></td>'
      + '<td>' + esc(row.title) + '</td>'
      + '<td class="small">' + esc(row.body) + '<div class="muted small">' + esc(delivery) + '</div></td>'
      + '<td class="small">' + esc(row.replay ? tr('replay') : tr('live')) + '</td></tr>'
  }).join('')
}
/** SSE 客户端（fetch 流式读：EventSource 不支持 Authorization 头）；断线 5s 退避重连。
 * 401 与 api 共用同一 reloginGate：并发时只开一次解锁门，重登录成功后原流重播。 */
function startNotifyStream(explicitToken) {
  if (notifyStreamTimer) { clearTimeout(notifyStreamTimer); notifyStreamTimer = null }
  var token = explicitToken || getToken()
  if (!token) {
    // 首访无 token：与并行 loadAll 共享同一扇解锁门（不重复开门）
    var waitingGen = authGen
    acquireToken().then(function (t) {
      if (t && waitingGen === authGen) startNotifyStream(t)
      else setStreamState(tr('streamNoToken'))
    })
    return
  }
  var gen = authGen
  var epoch = notifyStreamEpoch + 1
  notifyStreamEpoch = epoch
  fetch('/api/events', { headers: { Authorization: 'Bearer ' + token } }).then(function (res) {
    if (epoch !== notifyStreamEpoch) return
    if (res.status === 401) {
      if (gen >= authGen) { handleStream401(token); return } // 活 token 失效 → 走共享重登录门
      setStreamState(tr('streamOldSession')); return // 迟到旧流不得清掉新 token
    }
    markAuthOk()
    adoptToken(token) // 连接正常 → 持久化（首访解锁输入的 token 在此落库）
    if (!res.ok || !res.body) throw new Error(tr('httpStatus', { status: res.status }))
    setStreamState(tr('streamConnected'))
    var reader = res.body.getReader()
    var decoder = new TextDecoder()
    var buf = ''
    function pump() {
      return reader.read().then(function (chunk) {
        if (epoch !== notifyStreamEpoch || gen !== authGen) throw new Error('stream superseded')
        if (chunk.done) throw new Error('stream end')
        buf += decoder.decode(chunk.value, { stream: true })
        var blocks = buf.split('\\n\\n')
        buf = blocks.pop()
        blocks.forEach(function (block) {
          block.split('\\n').forEach(function (line) {
            if (line.indexOf('data: ') !== 0) return // ': connected'/': hb' 注释行
            try { onNotifyEvent(JSON.parse(line.slice(6))) } catch (e) { /* 残包/坏包丢弃 */ }
          })
        })
        return pump()
      })
    }
    return pump()
  }).catch(function () {
    if (epoch !== notifyStreamEpoch || gen !== authGen || getToken() !== token) return
    setStreamState(tr('streamDisconnected'))
    notifyStreamTimer = setTimeout(startNotifyStream, 5000)
  })
}
/** SSE 401 单次重登录（与 api 共享门；并发已由 reloginGate 兜住）。 */
function handleStream401(lastToken) {
  if (reloginPromise) {
    reloginGate().then(function (t) { if (t) startNotifyStream(t); else setStreamState(tr('streamTokenFailedRetry')) })
    return
  }
  if (recoveryUsed) { setStreamState(tr('streamTokenFailedManual')); return }
  recoveryUsed = true
  if (!gateReason) gateReason = tr('streamReloginReason')
  reloginGate().then(function (t) {
    if (t) startNotifyStream(t)
    else { setToken(''); renderTokenState(); setStreamState(tr('streamTokenFailedRetry')) }
  })
}
var NOTIFY_PREF_IDS = { npEnable: 'enable', npActive: 'active', npSound: 'sound', npHidden: 'hiddenOnly' }
function initNotifyTab() {
  writeNotifyPrefs() // 同步 checkbox 与存储（首访写入默认值）
  renderPermState()
  $('#nPermBtn').addEventListener('click', function () {
    if (typeof Notification === 'undefined') { flash(tr('notifyUnsupported'), 'err'); return }
    Notification.requestPermission().then(function () { renderPermState(); beep() }) // 手势顺带解锁 AudioContext
  })
  $('#nTestBtn').addEventListener('click', function () {
    beep()
    fireNotification(tr('notifyTestTitle'), tr('notifyTestBody', { time: new Date().toLocaleTimeString() }), 'active')
    flash(tr('notifyTestFired'), 'ok')
  })
  Object.keys(NOTIFY_PREF_IDS).forEach(function (id) {
    $('#' + id).addEventListener('change', function () {
      var p = readNotifyPrefs()
      p[NOTIFY_PREF_IDS[id]] = $('#' + id).checked
      try { window.localStorage.setItem(NOTIFY_PREFS_KEY, JSON.stringify(p)) } catch (e) {}
    })
  })
  startNotifyStream()
}

// ---------- 初始化 ----------
function init() {
  // 显式落地解锁门初始态（真实浏览器里 hidden attribute 已就位；此处保证脚本态一致）
  var g0 = gateEl()
  if (g0) g0.hidden = true
  $all('.tabbtn').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')) })
  })
  $('#btnRefresh').addEventListener('click', function () { loadAll() })
  applyAdminMode()
  var modeToggle = $('#modeToggle')
  if (modeToggle) modeToggle.addEventListener('click', function () {
    setAdminMode(readAdminMode() === 'advanced' ? 'personal' : 'advanced')
  })
  // 解锁门（站内页，不弹 window.prompt）：提交 / 取消 / 明文切换 / token 状态入口
  $('#unlockForm').addEventListener('submit', onUnlockSubmit)
  $('#unlockCancel').addEventListener('click', onUnlockCancel)
  $('#unlockPeek').addEventListener('click', onUnlockPeek)
  $('#tokenState').addEventListener('click', onTokenStateClick)
  $('#btnLogout').addEventListener('click', function () {
    authGen += 1
    stopNotifyStream()
    setToken('')
    renderTokenState()
    setStreamState(tr('logoutStream'))
    flash(tr('logout'), 'ok')
  })
  $('#btnCopyEntry').addEventListener('click', copyEntryPoint)
  renderEntryPoint()
  // 零配置首访：fragment 启动凭证（#token=...）——读到即清地址栏，候选只进内存，
  // 随后的 loadAll/SSE 用它验证；成功才写 sessionStorage，401 回解锁门并给出可执行提示。
  var ticket = readFragmentTicket()
  var launch = readFragmentToken()
  if (ticket) {
    clearFragment()
    exchangeLaunchTicket(ticket).then(function () {
      flash(tr('ticketOpened'), 'ok')
    }).catch(function (e) {
      gateReason = errText(e)
      showGate(gateReason)
    })
  } else if (launch) {
    clearFragment()
    setCandidateToken(launch)
    gateReason = tr('launchInvalid')
  }
  // 首访向导与验证横幅（事件委托；面板缺按钮时静默）
  var setupEl0 = $('#setup')
  if (setupEl0) setupEl0.addEventListener('click', onSetupClick)
  var banner0 = $('#verifyBanner')
  if (banner0) banner0.addEventListener('click', onBannerClick)
  var next0 = $('#nextAction')
  if (next0) next0.addEventListener('click', onNextActionClick)
  var skipBtn = $('#setupSkip')
  if (skipBtn) skipBtn.addEventListener('click', dismissSetup)
  var finishBtn = $('#setupFinish')
  if (finishBtn) finishBtn.addEventListener('click', finishSetup)
  $('#tab-bindings').addEventListener('change', onBindingsChange)
  $('#tab-bindings').addEventListener('click', onBindingsClick)
  $('#tab-sessions').addEventListener('click', onSessionsClick)
  $('#tab-channels').addEventListener('click', onChannelsClick)
  // 成员页事件委托（R5 审查 R5-2-P1-1：首版漏挂——铸码/删成员/撤码/转正/忽略/改角色整页死键）
  $('#tab-members').addEventListener('click', onMembersClick)
  $('#tab-members').addEventListener('change', onMembersChange)
  // 待处理远程提问结算（事件委托，面板空/缺按钮时静默）
  $('#pendingQuestionsPanel').addEventListener('click', onQuestionsClick)
  initNotifyTab()
  renderTokenState()
  loadAll()
}
init()`
