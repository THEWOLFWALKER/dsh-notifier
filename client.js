window.__ModuleLoader__.load({
  id: 'dsh-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const {
      useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React

    const PANEL_ID = 'dsh-notifier'
    const RPC_CHANNEL = '/dsh-notifier'
    const NS = 'dsh-notifier.native'

    const zh = Object.freeze({
      title: '通知与控制',
      intro: 'DSH 的通知、远程响应与运行状态',
      needsAttention: '需要你处理',
      running: '正在运行',
      channels: '通知渠道',
      activity: '最近活动',
      viewAll: '查看全部',
      manageChannels: '管理渠道',
      addChannel: '添加渠道',
      noChannels: '尚未配置通知渠道',
      noChannelsHint: '配置一个渠道后，DSH 的重要事件可以直接送到你的设备。',
      setupChannel: '设置通知渠道',
      setupFirst: '设置第一个通知渠道',
      setupIntro: '选择你已经在使用的渠道，保存后发送一条真实测试通知。',
      saveAndTest: '保存并测试',
      save: '保存',
      test: '发送测试通知',
      testing: '正在发送测试通知…',
      testDelivered: '测试通知已送达',
      testAccepted: '测试消息已发送',
      testAcceptedHint: '已发送到提供方，请到客户端确认收到。',
      testFailed: '未能送达',
      complete: '完成',
      retry: '重试',
      back: '返回',
      notify: '通知',
      control: '远程控制',
      healthy: '正常',
      ready: '可用',
      degraded: '最近失败',
      starting: '连接中',
      restartPending: '等待重启',
      disabled: '已停用',
      unavailable: '不可用',
      unconfigured: '未配置',
      runningOk: '运行正常',
      needsAction: '需要处理',
      connectionLost: '无法读取 dsh-notifier 状态',
      reconnecting: '正在重新连接 DSH…',
      loading: '正在读取通知状态…',
      tasks: '任务',
      noTasks: '暂无任务',
      noActivity: '暂无最近活动',
      reject: '拒绝',
      submit: '提交选择',
      handledElsewhere: '已在其他位置处理',
      expired: '已过期',
      submitting: '正在提交…',
      advanced: '打开高级管理台',
      advancedDisabled: '高级管理台未启用',
      refresh: '刷新',
      configured: '已配置',
      recent20: '近 20 次',
      delivered: '送达',
      skipped: '跳过',
      failed: '失败',
      lastSuccess: '最近成功',
      lastFailure: '最近失败',
      reason: '原因',
      inboundRestartHint: '保存远程控制配置后，需要重启 DSH 才会重新建立连接。',
      applyHot: '保存后立即生效',
      applyRestart: '保存后等待重启生效',
      setupActivationTitle: '设置通知',
      setupActivationBody: 'dsh-notifier 已启用。配置一个通知渠道即可开始使用。',
      later: '稍后',
      startSetup: '开始设置',
      pluginReady: '通知已就绪',
      openControl: '打开通知与控制',
      pluginAdvanced: '独立管理台用于成员、路由、会话策略以及故障恢复。',
      unknownError: '发生未知错误',
    })

    const en = Object.freeze({
      title: 'Notify & Control',
      intro: 'Notifications, remote responses, and runtime state for DSH',
      needsAttention: 'Needs your attention',
      running: 'Running',
      channels: 'Notification channels',
      activity: 'Recent activity',
      viewAll: 'View all',
      manageChannels: 'Manage channels',
      addChannel: 'Add channel',
      noChannels: 'No notification channel configured',
      noChannelsHint: 'Configure a channel to deliver important DSH events to your device.',
      setupChannel: 'Set up notification',
      setupFirst: 'Set up first channel',
      setupIntro: 'Choose a channel you already use, save it, then send a real test notification.',
      saveAndTest: 'Save and test',
      save: 'Save',
      test: 'Send test notification',
      testing: 'Sending test notification…',
      testDelivered: 'Test notification delivered',
      testAccepted: 'Test message sent',
      testAcceptedHint: 'Sent to the provider — confirm receipt on your device.',
      testFailed: 'Delivery failed',
      complete: 'Done',
      retry: 'Retry',
      back: 'Back',
      notify: 'Notify',
      control: 'Remote control',
      healthy: 'Healthy',
      ready: 'Ready',
      degraded: 'Recent failure',
      starting: 'Connecting',
      restartPending: 'Restart pending',
      disabled: 'Disabled',
      unavailable: 'Unavailable',
      unconfigured: 'Not configured',
      runningOk: 'Running normally',
      needsAction: 'Needs attention',
      connectionLost: 'Unable to read dsh-notifier status',
      reconnecting: 'Reconnecting to DSH…',
      loading: 'Loading notification status…',
      tasks: 'Tasks',
      noTasks: 'No tasks',
      noActivity: 'No recent activity',
      reject: 'Reject',
      submit: 'Submit selection',
      handledElsewhere: 'Handled elsewhere',
      expired: 'Expired',
      submitting: 'Submitting…',
      advanced: 'Open advanced console',
      advancedDisabled: 'Advanced console is disabled',
      refresh: 'Refresh',
      configured: 'Configured',
      recent20: 'Last 20',
      delivered: 'Delivered',
      skipped: 'Skipped',
      failed: 'Failed',
      lastSuccess: 'Last success',
      lastFailure: 'Last failure',
      reason: 'Reason',
      inboundRestartHint: 'Restart DSH after saving remote-control settings to establish a new connection.',
      applyHot: 'Applies immediately after saving',
      applyRestart: 'Applies after restart',
      setupActivationTitle: 'Set up notification',
      setupActivationBody: 'dsh-notifier is enabled. Configure one notification channel to get started.',
      later: 'Later',
      startSetup: 'Start setup',
      pluginReady: 'Notifications are ready',
      openControl: 'Open Notify & Control',
      pluginAdvanced: 'The advanced console is for members, routing, session policy, and recovery.',
      unknownError: 'An unknown error occurred',
    })

    function resolveText(ctx, value) {
      if (typeof value === 'string') return value
      try {
        if (ctx?.locale?.resolveText) return ctx.locale.resolveText(value)
      } catch {}
      if (value && typeof value === 'object') return value.en ?? value.zh ?? ''
      return ''
    }

    function createRpcClient(ctx) {
      async function call(endpoint, payload = {}, signal) {
        const result = await ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload, signal)
        if (result?.ok === true) return result.value
        const err = new Error(result?.error?.message || `RPC failed: ${endpoint}`)
        err.code = result?.error?.code || 'internal'
        err.details = result?.error?.details
        throw err
      }
      return Object.freeze({ call })
    }

    function createController(ctx) {
      const rpc = createRpcClient(ctx)
      let snapshot = Object.freeze({
        view: { kind: 'home' },
        home: null,
        channels: null,
        tasks: null,
        activity: null,
        channel: null,
        busy: Object.freeze({}),
        error: null,
        revision: 0,
        staleAt: null,
      })
      const listeners = new Set()
      let waitAbort = null
      let fallbackTimer = null
      let disposed = false
      // v0.12.1（P1-13）：同一资源只接受最新一代请求的响应，避免迟到数据覆盖当前视图。
      const generations = { home: 0, channels: 0, channel: 0, tasks: 0, activity: 0 }
      let paused = false

      const emit = (patch) => {
        snapshot = Object.freeze({ ...snapshot, ...patch })
        for (const listener of [...listeners]) {
          try { listener() } catch {}
        }
      }
      const setBusy = (key, value) => emit({ busy: Object.freeze({ ...snapshot.busy, [key]: value }) })
      const setError = (error) => emit({ error: error ?? null })
      const updateRevision = (value) => {
        if (Number.isFinite(Number(value))) emit({ revision: Math.max(snapshot.revision, Number(value)) })
      }

      async function loadHome() {
        const generation = ++generations.home
        try {
          const value = await rpc.call('surface.home')
          if (generation !== generations.home) return value
          emit({ home: value, error: null, revision: Math.max(snapshot.revision, Number(value?.revision ?? 0)) })
          return value
        } catch (error) {
          if (generation !== generations.home) return null
          setError(error)
          throw error
        }
      }
      async function loadChannels() {
        const generation = ++generations.channels
        try {
          const value = await rpc.call('channels.list')
          if (generation !== generations.channels) return value
          emit({ channels: value, error: null })
          updateRevision(value?.revision)
          return value
        } catch (error) {
          if (generation !== generations.channels) return null
          throw error
        }
      }
      async function loadChannel(type) {
        const generation = ++generations.channel
        try {
          const value = await rpc.call('channels.get', { type })
          if (generation !== generations.channel) return value
          if (snapshot.view.kind !== 'channel' || snapshot.view.type !== type) return value
          emit({ channel: value, error: null })
          updateRevision(value?.revision)
          return value
        } catch (error) {
          if (generation !== generations.channel) return null
          throw error
        }
      }
      async function loadTasks() {
        const generation = ++generations.tasks
        try {
          const value = await rpc.call('tasks.list')
          if (generation !== generations.tasks) return value
          emit({ tasks: value, error: null })
          updateRevision(value?.revision)
          return value
        } catch (error) {
          if (generation !== generations.tasks) return null
          throw error
        }
      }
      async function loadActivity() {
        const generation = ++generations.activity
        try {
          const value = await rpc.call('activity.list', { limit: 100 })
          if (generation !== generations.activity) return value
          emit({ activity: value, error: null })
          updateRevision(value?.revision)
          return value
        } catch (error) {
          if (generation !== generations.activity) return null
          throw error
        }
      }
      async function refreshCurrent() {
        if (disposed) return false
        try {
          const kind = snapshot.view.kind
          if (kind === 'channels') await loadChannels()
          else if (kind === 'channel') await loadChannel(snapshot.view.type)
          else if (kind === 'tasks') await loadTasks()
          else if (kind === 'activity') await loadActivity()
          else await loadHome()
          emit({ staleAt: null })
          return true
        } catch {
          emit({ staleAt: Date.now() })
          return false
        }
      }
      async function saveChannel(type, direction, patch) {
        const key = `save:${type}:${direction}`
        setBusy(key, true)
        try {
          const value = await rpc.call('channels.save', { type, direction, patch })
          setError(null)
          await loadChannel(type)
          return value
        } finally {
          setBusy(key, false)
        }
      }
      async function testChannel(type) {
        const key = `test:${type}`
        setBusy(key, true)
        try {
          const value = await rpc.call('channels.test', { type })
          setError(null)
          await loadChannel(type).catch(() => {})
          return value
        } finally {
          setBusy(key, false)
        }
      }
      async function settleQuestion(ref, action, options = []) {
        const key = `question:${ref}`
        setBusy(key, true)
        try {
          const value = await rpc.call('questions.settle', { ref, action, options })
          await loadHome().catch(() => {})
          return value
        } catch (error) {
          if (error?.code === 'dsh-notifier/conflict' || error?.code === 'dsh-notifier/already-handled') {
            await loadHome().catch(() => {})
            return { settled: false, alreadyHandled: true }
          }
          throw error
        } finally {
          setBusy(key, false)
        }
      }
      async function createStandaloneLaunch() {
        return rpc.call('standalone.createLaunch')
      }
      function navigate(view) {
        // v0.12.1（P2-10）：导航只负责切视图；目标视图的 mount effect 是唯一加载 owner。
        emit({ view, error: null })
      }
      function startWait() {
        if (disposed || paused || waitAbort !== null) return
        waitAbort = new AbortController()
        const signal = waitAbort.signal
        const loop = async () => {
          while (!disposed && !paused && !signal.aborted) {
            try {
              const value = await rpc.call('surface.wait', { after: snapshot.revision, timeoutMs: 25_000 }, signal)
              if (signal.aborted || disposed || paused) break
              if (Number(value?.revision ?? 0) > snapshot.revision) {
                const refreshed = await refreshCurrent()
                if (refreshed === true) updateRevision(value.revision)
              }
            } catch (error) {
              if (signal.aborted || disposed) break
              await new Promise(resolve => setTimeout(resolve, 1_000))
            }
          }
        }
        void loop().finally(() => {
          if (waitAbort?.signal === signal) waitAbort = null
        })
      }
      function resumeWait() {
        if (!paused) return
        paused = false
        startWait()
      }
      function setActive(active) {
        const nextPaused = !active
        if (disposed || nextPaused === paused) return
        if (nextPaused) {
          paused = true
          waitAbort?.abort()
          waitAbort = null
        } else {
          resumeWait()
          void refreshCurrent()
        }
      }
      function dispose() {
        disposed = true
        paused = true
        waitAbort?.abort()
        waitAbort = null
        if (fallbackTimer !== null) clearInterval(fallbackTimer)
        listeners.clear()
      }

      // v0.12.1（P2-11）：页面不可见时不继续定时刷新。
      fallbackTimer = setInterval(() => { if (!paused && !disposed) void refreshCurrent() }, 30_000)

      return Object.freeze({
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        loadHome, loadChannels, loadChannel, loadTasks, loadActivity,
        refreshCurrent, saveChannel, testChannel, settleQuestion, createStandaloneLaunch,
        navigate, startWait, setActive, dispose,
        // v0.12.1（P1-09）：视图必须能把业务失败写入统一错误出口。
        reportError(error) { setError(error ?? null) },
      })
    }

    function useController(controller) {
      return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    }

    function useT(ctx) {
      const [, bump] = useState(0)
      useEffect(() => {
        if (!ctx?.locale?.subscribe) return
        return ctx.locale.subscribe(() => bump(value => value + 1))
      }, [ctx])
      return useMemo(() => {
        try {
          if (ctx?.locale?.bind) return ctx.locale.bind(NS)
        } catch {}
        const language = String(ctx?.locale?.current ?? '').toLowerCase()
        const dict = language.startsWith('zh') ? zh : en
        return key => dict[key] ?? en[key] ?? key
      }, [ctx, String(ctx?.locale?.current ?? '')])
    }

    function StateDot({ state }) {
      return h('span', { className: `dn-stateDot dn-stateDot--${state || 'idle'}`, 'aria-hidden': true })
    }

    function Button({ children, kind = 'default', type = 'button', className = '', ...props }) {
      return h('button', {
        ...props,
        type,
        className: `dn-button dn-button--${kind}${className ? ` ${className}` : ''}`,
      }, children)
    }

    function PageHead({ title, intro, actions }) {
      return h('header', { className: 'dn-pageHead' },
        h('div', null, h('h1', { className: 'dn-pageTitle' }, title),
          intro ? h('p', { className: 'dn-pageIntro' }, intro) : null),
        h('div', { className: 'dn-pageActions' }, actions))
    }

    function Section({ title, action, children }) {
      return h('section', { className: 'dn-section' },
        h('div', { className: 'dn-sectionHead' },
          h('h2', { className: 'dn-sectionTitle' }, title),
          action || null),
        children)
    }

    function StatusRow({ ctx, summary, t, onRetry }) {
      const status = summary?.status ?? 'loading'
      if (status === 'unavailable') {
        return h('div', { className: 'dn-statusLine dn-statusLine--error' },
          h(StateDot, { state: 'error' }),
          h('div', null,
            h('strong', null, t('connectionLost')),
            h('span', null, t('reconnecting')),
            typeof onRetry === 'function'
              ? h('button', { type: 'button', className: 'dn-link dn-inlineRetry', onClick: onRetry }, t('retry'))
              : null))
      }
      if (status === 'attention') {
        return h('div', { className: 'dn-statusLine' },
          h(StateDot, { state: 'warn' }),
          h('div', null,
            h('strong', null, t('needsAction')),
            h('span', null, resolveText(ctx, summary?.detail))))
      }
      if (status === 'unconfigured') {
        return h('div', { className: 'dn-statusLine' },
          h(StateDot, { state: 'idle' }),
          h('div', null,
            h('strong', null, t('noChannels')),
            h('span', null, t('noChannelsHint'))))
      }
      if (status === 'loading') {
        return h('div', { className: 'dn-statusLine' }, h(StateDot, { state: 'ongoing' }), h('strong', null, t('loading')))
      }
      return h('div', { className: 'dn-statusLine' },
        h(StateDot, { state: 'done' }),
        h('div', null,
          h('strong', null, t('runningOk')),
          h('span', null, resolveText(ctx, summary?.detail))))
    }

    function QuestionCard({ ctx, question, controller, t, busy }) {
      const [selected, setSelected] = useState([])
      const [notice, setNotice] = useState(null)
      const multiple = question?.multiple === true
      const expired = question?.status === 'expired'
      const toggle = (value) => {
        setSelected(current => multiple
          ? (current.includes(value) ? current.filter(item => item !== value) : [...current, value])
          : [value])
      }
      const settle = async (action) => {
        setNotice(null)
        try {
          const result = await controller.settleQuestion(question.ref, action, selected)
          if (result?.alreadyHandled === true) setNotice(t('handledElsewhere'))
        } catch (error) {
          setNotice(error?.message || t('unknownError'))
        }
      }
      return h('article', { className: 'dn-question' },
        h('div', { className: 'dn-questionMark', 'aria-hidden': true }, '?'),
        h('div', { className: 'dn-questionBody' },
          h('strong', { className: 'dn-rowTitle' }, resolveText(ctx, question?.question)),
          question?.context ? h('span', { className: 'dn-rowMeta' }, resolveText(ctx, question.context)) : null,
          expired
            ? h('span', { className: 'dn-rowMeta' }, `${t('expired')}${question?.expiresText ? ` · ${resolveText(ctx, question.expiresText)}` : ''}`)
            : null,
          expired ? null : h('div', { className: 'dn-options' },
            ...(question?.options ?? []).map(option =>
              h('button', {
                type: 'button',
                className: `dn-option ${selected.includes(option.value) ? 'is-selected' : ''}`,
                disabled: busy,
                onClick: () => toggle(option.value),
                key: option.value,
              }, resolveText(ctx, option.label)))),
          expired ? null : h('div', { className: 'dn-questionActions' },
            multiple ? h(Button, { disabled: busy || selected.length === 0, kind: 'primary', onClick: () => void settle('choose') }, busy ? t('submitting') : t('submit')) : null,
            !multiple && selected.length > 0 ? h(Button, { disabled: busy, kind: 'primary', onClick: () => void settle('choose') }, busy ? t('submitting') : t('submit')) : null,
            h(Button, { disabled: busy, onClick: () => void settle('reject') }, t('reject'))),
          notice ? h('p', { className: 'dn-note', role: 'status' }, notice) : null))
    }

    function TaskRow({ ctx, task }) {
      const attention = task?.attention === true
      return h('div', { className: 'dn-row' },
        h(StateDot, { state: attention ? 'warn' : task?.status === 'running' ? 'ongoing' : 'idle' }),
        h('div', { className: 'dn-rowMain' },
          h('strong', { className: 'dn-rowTitle' }, task?.taskRef || '(task)'),
          h('span', { className: 'dn-rowMeta' }, [task?.workspace, task?.status].filter(Boolean).join(' · '))),
        h('div', { className: 'dn-rowAside' },
          h('span', { className: 'dn-rowMeta' }, Array.isArray(task?.boundChannels) ? task.boundChannels.join(' · ') : ''),
          task?.relativeTime
            ? h('time', { className: 'dn-rowMeta', dateTime: task?.lastActivityAt || undefined }, resolveText(ctx, task.relativeTime))
            : null))
    }

    function ChannelRow({ ctx, channel, onOpen, t }) {
      const state = channel?.health?.state ?? 'unconfigured'
      const stateText = t(state === 'healthy' ? 'healthy'
        : state === 'ready' ? 'ready'
          : state === 'degraded' ? 'degraded'
            : state === 'starting' ? 'starting'
              : state === 'restart-pending' ? 'restartPending'
                : state === 'disabled' ? 'disabled'
                  : state === 'unavailable' ? 'unavailable' : 'unconfigured')
      const stateDot = state === 'healthy' || state === 'ready' ? 'done'
        : state === 'degraded' || state === 'restart-pending' ? 'warn'
          : state === 'starting' ? 'ongoing' : 'idle'
      const capabilities = [
        channel?.capabilities?.notify ? t('notify') : null,
        channel?.capabilities?.control ? t('control') : null,
      ].filter(Boolean).join(' · ')
      return h('button', { type: 'button', className: 'dn-row dn-rowButton', onClick: onOpen },
        h('span', { className: 'dn-channelGlyph', 'aria-hidden': true }, String(channel?.type ?? '?').slice(0, 2).toUpperCase()),
        h('span', { className: 'dn-rowMain' },
          h('strong', { className: 'dn-rowTitle' }, resolveText(ctx, channel?.label) || channel?.type),
          h('span', { className: 'dn-rowMeta' }, capabilities)),
        h('span', { className: 'dn-rowAside dn-stateText' }, h(StateDot, { state: stateDot }), stateText, ' ›'))
    }

    function ActivityRow({ ctx, item }) {
      const state = item?.level === 'error' ? 'error' : item?.level === 'warn' ? 'warn' : 'idle'
      return h('div', { className: 'dn-row' },
        h(StateDot, { state }),
        h('time', { className: 'dn-activityTime', dateTime: item?.at || undefined }, resolveText(ctx, item?.timeText)),
        h('div', { className: 'dn-rowMain' },
          h('strong', { className: 'dn-rowTitle' }, resolveText(ctx, item?.title)),
          item?.detail ? h('span', { className: 'dn-rowMeta' }, resolveText(ctx, item.detail)) : null))
    }

    function launchAdvancedConsole(controller, t, windowObject = window) {
      const popup = windowObject.open('about:blank', '_blank')
      if (!popup) return { opened: false }
      try { popup.opener = null } catch (error) { void error }
      try { popup.document.title = 'dsh-notifier' } catch (error) { void error }
      void controller.createStandaloneLaunch().then(result => {
        if (result?.available === true && typeof result.url === 'string' && result.url !== '') {
          popup.location.replace(result.url)
        } else {
          popup.document.body.textContent = t('advancedDisabled')
        }
      }).catch(error => {
        popup.document.body.textContent = error?.message || t('unknownError')
      })
      return { opened: true, popup }
    }

    function HomeView({ ctx, controller, state, t }) {
      const home = state.home
      useEffect(() => { void controller.loadHome().catch(error => controller.reportError(error)) }, [])
      const openAdvanced = () => {
        launchAdvancedConsole(controller, t)
      }
      const actions = [
        h(Button, { key: 'refresh', onClick: () => void controller.refreshCurrent() }, t('refresh')),
        h(Button, {
          key: 'advanced',
          onClick: openAdvanced,
          'aria-label': t('advanced'),
          title: t('advanced'),
        }, '···'),
      ]
      return h('div', { className: 'dn-page' },
        h(PageHead, { title: t('title'), intro: t('intro'), actions }),
        h(StatusRow, { ctx, summary: home?.summary, t, onRetry: () => void controller.refreshCurrent() }),
        state.staleAt !== null
          ? h('p', { className: 'dn-error', role: 'alert' }, t('connectionLost'))
          : null,
        (home?.questions?.length ?? 0) > 0
          ? h(Section, { title: `${t('needsAttention')}  ${home.questions.length}` },
              ...home.questions.slice(0, 3).map(question =>
                h(QuestionCard, {
                  key: question.ref, ctx, question, controller, t,
                  busy: state.busy[`question:${question.ref}`] === true,
                })))
          : null,
        h(Section, {
          title: t('running'),
          action: h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'tasks' }) }, `${t('viewAll')} →`),
        }, ...(home?.tasks?.length ? home.tasks.slice(0, 5).map(task => h(TaskRow, { key: task.taskRef, ctx, task })) : [h('p', { className: 'dn-empty', key: 'empty' }, t('noTasks'))])),
        h(Section, {
          title: t('channels'),
          action: h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'channels' }) }, `${t('manageChannels')} →`),
        }, ...(home?.channels?.length ? home.channels.slice(0, 5).map(channel =>
          h(ChannelRow, { key: channel.type, ctx, channel, t, onOpen: () => controller.navigate({ kind: 'channel', type: channel.type }) }))
          : [h('div', { className: 'dn-emptyState', key: 'empty' },
              h('strong', null, t('noChannels')),
              h('span', null, t('noChannelsHint')),
              h(Button, { kind: 'primary', onClick: () => controller.navigate({ kind: 'channels', setup: true }) }, t('setupChannel')))])),
        h(Section, {
          title: t('activity'),
          action: h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'activity' }) }, `${t('viewAll')} →`),
        }, ...(home?.activity?.length ? home.activity.slice(0, 5).map(item => h(ActivityRow, { key: item.id, ctx, item })) : [h('p', { className: 'dn-empty', key: 'empty' }, t('noActivity'))])))
    }

    function SetupFlow({ ctx, controller, channels, onDone, t }) {
      const [type, setType] = useState(null)
      const [draft, setDraft] = useState({})
      const [phase, setPhase] = useState('choose')
      const [testResult, setTestResult] = useState(null)
      const [error, setError] = useState(null)
      const candidates = (channels ?? []).filter(channel => channel?.notify?.editable !== false)
      const selected = candidates.find(channel => channel.type === type)
      const fields = selected?.notify?.fields ?? {}
      const setField = (key, value) => setDraft(current => ({ ...current, [key]: value }))
      const saveAndTest = async () => {
        setError(null)
        setTestResult(null)
        try {
          await controller.saveChannel(type, 'outbound', draft)
          setPhase('testing')
          const result = await controller.testChannel(type)
          setTestResult(result)
          if (result?.status === 'delivered' || result?.status === 'accepted' || result?.delivered === true) {
            setPhase('done')
          } else if (result?.status === 'unknown' || result?.status === 'failed' || result?.delivered === false) {
            setPhase('form')
          } else {
            throw new Error('channels.test returned an invalid delivery result')
          }
        } catch (err) {
          setError(err)
          setPhase('form')
        }
      }
      if (phase === 'choose') {
        return h('div', { className: 'dn-setupCard' },
          h('h2', null, t('setupFirst')),
          h('p', null, t('setupIntro')),
          h('div', { className: 'dn-channelPicker' },
            ...candidates.map(channel =>
              h('button', {
                type: 'button', className: 'dn-pickerRow', key: channel.type,
                onClick: () => { setType(channel.type); setDraft({}); setPhase('form') },
              }, resolveText(ctx, channel.label) || channel.type, h('span', null, '›')))))
      }
      return h('div', { className: 'dn-setupCard' },
        h('div', { className: 'dn-detailBack' },
          h('button', { className: 'dn-link', onClick: () => { setPhase('choose'); setType(null) } }, `← ${t('back')}`)),
        h('h2', null, resolveText(ctx, selected?.label) || type),
        ...Object.entries(fields).map(([key, meta]) => {
          const secret = meta?.secret === true
          return h('label', { className: 'dn-field', key },
            h('span', null, resolveText(ctx, meta?.label) || key),
            h('input', {
              type: secret ? 'password' : 'text',
              value: draft[key] ?? '',
              placeholder: secret && meta?.configured === true ? t('configured') : '',
              onChange: event => setField(key, event.target.value),
            }),
            meta?.description ? h('small', null, resolveText(ctx, meta.description)) : null)
        }),
        error ? h('p', { className: 'dn-error', role: 'alert' }, error?.message || t('unknownError')) : null,
        (testResult?.status === 'unknown' || testResult?.status === 'failed' || testResult?.delivered === false)
          ? h('p', { className: 'dn-error', role: 'alert' },
          `${t('testFailed')}${testResult?.detail ? ` · ${resolveText(ctx, testResult.detail)}` : ''}`) : null,
        phase === 'testing' ? h('p', { className: 'dn-inlineStatus' }, h(StateDot, { state: 'ongoing' }), t('testing')) : null,
        phase === 'done'
          ? h('div', { className: 'dn-success' },
              h('strong', null, testResult?.status === 'delivered' ? t('testDelivered') : t('testAccepted')),
              testResult?.status !== 'delivered'
                ? h('p', { className: 'dn-note' }, resolveText(ctx, testResult?.providerDetail) || t('testAcceptedHint'))
                : null,
              h(Button, { kind: 'primary', onClick: onDone }, t('complete')))
          : h(Button, { kind: 'primary', disabled: phase === 'testing', onClick: () => void saveAndTest() }, t('saveAndTest')))
    }

    function ChannelsView({ ctx, controller, state, t }) {
      const data = state.channels
      useEffect(() => { void controller.loadChannels().catch(error => controller.reportError(error)) }, [])
      const [setup, setSetup] = useState(state.view.setup === true)
      const channels = data?.channels ?? []
      if (setup) return h('div', { className: 'dn-page' },
        h(PageHead, { title: t('setupChannel') }),
        h(SetupFlow, { ctx, controller, channels, t, onDone: () => { setSetup(false); void controller.loadChannels().catch(error => controller.reportError(error)) } }))
      return h('div', { className: 'dn-page' },
        h(PageHead, {
          title: t('channels'),
          actions: h(Button, { kind: 'primary', onClick: () => setSetup(true) }, t('addChannel')),
        }),
        h('div', { className: 'dn-list' },
          ...channels.map(channel => h(ChannelRow, {
            key: channel.type, ctx, channel, t,
            onOpen: () => controller.navigate({ kind: 'channel', type: channel.type }),
          }))))
    }

    function ChannelDetailView({ ctx, controller, state, t }) {
      const data = state.channel
      const type = state.view.type
      const [drafts, setDrafts] = useState({ outbound: {}, inbound: {} })
      const [dirty, setDirty] = useState({ outbound: new Set(), inbound: new Set() })
      const dirtyRef = useRef(dirty)
      const revisions = useRef({ outbound: null, inbound: null })
      const [testResult, setTestResult] = useState(null)
      useEffect(() => { void controller.loadChannel(type).catch(error => controller.reportError(error)) }, [type])
      useEffect(() => {
        const channel = data?.channel
        if (!channel) return
        for (const direction of ['outbound', 'inbound']) {
          const section = direction === 'outbound' ? channel.notify : channel.control
          const nextRevision = section?.configRevision ?? null
          if (revisions.current[direction] === nextRevision) continue
          revisions.current[direction] = nextRevision
          setDrafts(current => {
            const next = { ...current, [direction]: { ...current[direction] } }
            for (const [key, value] of Object.entries(section?.editableValues ?? {})) {
              if (!dirtyRef.current[direction].has(key)) next[direction][key] = value
            }
            return next
          })
        }
      }, [data?.channel?.notify?.configRevision, data?.channel?.control?.configRevision])

      const channel = data?.channel
      if (!channel) return h('div', { className: 'dn-page' }, h(PageHead, { title: type }), h('p', null, t('loading')))

      function Direction({ direction, section }) {
        if (!section) return null
        const fields = section.fields ?? {}
        const patch = drafts[direction] ?? {}
        const setField = (key, value) => {
          setDirty(current => {
            const set = new Set(current[direction]); set.add(key)
            const next = { ...current, [direction]: set }
            dirtyRef.current = next
            return next
          })
          setDrafts(current => ({ ...current, [direction]: { ...current[direction], [key]: value } }))
        }
        const save = async () => {
          const payload = {}
          for (const key of dirty[direction]) payload[key] = patch[key]
          if (Object.keys(payload).length === 0) return
          try {
            await controller.saveChannel(type, direction, payload)
            setDirty(current => {
              const next = { ...current, [direction]: new Set() }
              dirtyRef.current = next
              return next
            })
          } catch (error) {
            controller.reportError(error)
          }
        }
        return h(Section, { title: direction === 'outbound' ? t('notify') : t('control') },
          ...Object.entries(fields).map(([key, meta]) =>
            h('label', { className: 'dn-field', key },
              h('span', null, resolveText(ctx, meta?.label) || key),
              h('input', {
                type: meta?.secret === true ? 'password' : 'text',
                value: patch[key] ?? '',
                placeholder: meta?.secret === true && meta?.configured === true ? t('configured') : '',
                onChange: event => setField(key, event.target.value),
              }),
              meta?.description ? h('small', null, resolveText(ctx, meta.description)) : null)),
          h('div', { className: 'dn-formActions' },
            h(Button, { kind: 'primary', disabled: dirty[direction].size === 0, onClick: () => void save() }, t('save')),
            direction === 'outbound'
              ? h(Button, {
                  disabled: state.busy[`test:${type}`] === true,
                  onClick: () => void controller.testChannel(type).then(setTestResult).catch(error => {
                    controller.reportError(error)
                    setTestResult({ delivered: false, detail: { en: String(error?.message ?? ''), zh: String(error?.message ?? '') } })
                  }),
                }, state.busy[`test:${type}`] === true ? t('testing') : t('test')) : null),
          h('p', { className: 'dn-rowMeta' }, section.applyMode === 'hot' ? t('applyHot') : section.applyMode === 'restart' ? t('applyRestart') : ''),
          direction === 'inbound' && section.applyMode === 'restart' ? h('p', { className: 'dn-note' }, t('inboundRestartHint')) : null,
          direction === 'outbound' && testResult
            ? h('p', { className: testResult.status === 'delivered' || testResult.status === 'accepted' || testResult.delivered === true ? 'dn-successText' : 'dn-error' },
                testResult.status === 'delivered' || testResult.delivered === true
                  ? t('testDelivered')
                  : testResult.status === 'accepted'
                    ? `${t('testAccepted')}${testResult.providerDetail ? ` · ${resolveText(ctx, testResult.providerDetail)}` : ''}`
                    : `${t('testFailed')}${testResult.detail ? ` · ${resolveText(ctx, testResult.detail)}` : ''}`)
            : null)
      }

      const health = channel.health ?? {}
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' },
          h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'channels' }) }, `← ${t('back')}`)),
        h(PageHead, { title: resolveText(ctx, channel.label) || type }),
        state.error ? h('p', { className: 'dn-error', role: 'alert' }, state.error?.message || t('unknownError')) : null,
        h(Direction, { direction: 'outbound', section: channel.notify }),
        h(Direction, { direction: 'inbound', section: channel.control }),
        h(Section, { title: t('recent20') },
          h('div', { className: 'dn-healthGrid' },
            h('span', null, `${Number(health.delivered ?? 0)} ${t('delivered')}`),
            h('span', null, `${Number(health.skipped ?? 0)} ${t('skipped')}`),
            h('span', null, `${Number(health.failed ?? 0)} ${t('failed')}`)),
          health.lastSuccessAt ? h('p', { className: 'dn-rowMeta' }, `${t('lastSuccess')} · ${resolveText(ctx, health.lastSuccessText) || health.lastSuccessAt}`) : null,
          health.lastFailureAt ? h('p', { className: 'dn-rowMeta' }, `${t('lastFailure')} · ${resolveText(ctx, health.lastFailureText) || health.lastFailureAt}`) : null,
          health.lastFailureReason ? h('p', { className: 'dn-rowMeta' }, `${t('reason')} · ${resolveText(ctx, health.lastFailureReason)}`) : null))
    }

    function TasksView({ ctx, controller, state, t }) {
      useEffect(() => { void controller.loadTasks().catch(error => controller.reportError(error)) }, [])
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'home' }) }, `← ${t('back')}`)),
        h(PageHead, { title: t('tasks') }),
        h('div', { className: 'dn-list' },
          ...(state.tasks?.tasks?.length ? state.tasks.tasks.map(task => h(TaskRow, { key: task.taskRef, ctx, task })) : [h('p', { className: 'dn-empty', key: 'empty' }, t('noTasks'))])))
    }

    function ActivityView({ ctx, controller, state, t }) {
      useEffect(() => { void controller.loadActivity().catch(error => controller.reportError(error)) }, [])
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'home' }) }, `← ${t('back')}`)),
        h(PageHead, { title: t('activity') }),
        h('div', { className: 'dn-list' },
          ...(state.activity?.items?.length ? state.activity.items.map(item => h(ActivityRow, { key: item.id, ctx, item })) : [h('p', { className: 'dn-empty', key: 'empty' }, t('noActivity'))])))
    }

    function MainPanel({ controller, ctx }) {
      const state = useController(controller)
      const t = useT(ctx)
      useEffect(() => {
        controller.startWait()
      }, [])
      if (state.view.kind === 'channels') return h(ChannelsView, { ctx, controller, state, t })
      // v0.12.1（P1-12）：按渠道类型重建详情组件，避免草稿/测试结果跨渠道串台。
      if (state.view.kind === 'channel') return h(ChannelDetailView, { key: state.view.type, ctx, controller, state, t })
      if (state.view.kind === 'tasks') return h(TasksView, { ctx, controller, state, t })
      if (state.view.kind === 'activity') return h(ActivityView, { ctx, controller, state, t })
      return h(HomeView, { ctx, controller, state, t })
    }

    function SidebarIcon({ size = 18, active = false }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.45, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, 'data-active': active ? 'true' : 'false',
      },
      h('circle', { cx: 10, cy: 12.5, r: 1.2, fill: 'currentColor', stroke: 'none' }),
      h('path', { d: 'M6.8 10.8a4.2 4.2 0 0 1 6.4 0' }),
      h('path', { d: 'M4.5 8.6a7.2 7.2 0 0 1 11 0' }))
    }

    function PluginConfig({ controller, ctx, view }) {
      const state = useController(controller)
      const t = useT(ctx)
      useEffect(() => { if (view === 'page') void controller.loadHome().catch(error => controller.reportError(error)) }, [view])
      if (view !== 'page') return null
      const ready = (state.home?.channels ?? []).some(channel => channel?.notify?.configured === true)
      return h('div', { className: 'dn-pluginConfig' },
        h('strong', null, ready ? t('pluginReady') : t('noChannels')),
        h('p', null, ready ? resolveText(ctx, state.home?.summary?.detail) : t('noChannelsHint')),
        h('div', { className: 'dn-formActions' },
          h(Button, {
            kind: 'primary',
            onClick: () => {
              try { ctx.layout.selectPanel(PANEL_ID) } catch (error) { controller.reportError(error) }
              controller.navigate({ kind: ready ? 'home' : 'channels', setup: !ready })
            },
          }, ready ? t('openControl') : t('setupFirst'))),
        h('p', { className: 'dn-note' }, t('pluginAdvanced')))
    }

    function Activation({ onDismiss, onOpenDetails, ctx }) {
      const t = useT(ctx)
      return h('div', { className: 'dn-activation' },
        h('strong', null, t('setupActivationTitle')),
        h('p', null, t('setupActivationBody')),
        h('div', { className: 'dn-formActions' },
          h(Button, { onClick: onDismiss }, t('later')),
          h(Button, { kind: 'primary', onClick: onOpenDetails }, t('startSetup'))))
    }

    const CSS = `
      .dn-page{box-sizing:border-box;max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary);font-family:inherit}
      .dn-pageHead{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin:0 0 28px}
      .dn-pageTitle{margin:0;font-size:20px;line-height:28px;font-weight:500}
      .dn-pageIntro{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
      .dn-pageActions,.dn-formActions,.dn-questionActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .dn-section{margin-top:32px}.dn-sectionHead{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
      .dn-sectionTitle{margin:0;font-size:14px;line-height:22px;font-weight:500}
      .dn-list{display:flex;flex-direction:column;gap:2px}
      .dn-row{display:flex;align-items:center;gap:12px;min-height:52px;padding:8px 10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;text-align:left}
      .dn-rowButton{width:100%;cursor:pointer}.dn-rowButton:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dn-rowMain{min-width:0;flex:1;display:flex;flex-direction:column}.dn-rowTitle{font-size:14px;line-height:20px;font-weight:500}
      .dn-rowMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.dn-rowAside{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
      .dn-link{border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:13px;cursor:pointer;padding:2px 0}
      .dn-button{min-height:30px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:5px 10px;font:inherit;font-size:13px;cursor:pointer}
      .dn-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dn-button:disabled{opacity:.5;cursor:default}
      .dn-button--primary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-base)}
      .dn-statusLine{display:flex;gap:10px;align-items:flex-start;padding:10px 0}.dn-statusLine>div{display:flex;flex-direction:column}
      .dn-statusLine strong{font-size:14px;line-height:20px;font-weight:500}.dn-statusLine span{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .dn-statusLine--error strong{color:var(--dsw-alias-state-error-primary)}
      .dn-stateDot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);display:inline-block;flex:0 0 auto;margin-top:6px}
      .dn-stateDot--done{background:var(--dsw-alias-state-success-primary)}.dn-stateDot--warn{background:var(--dsw-alias-state-warn-primary)}.dn-stateDot--error{background:var(--dsw-alias-state-error-primary)}
      .dn-stateDot--ongoing{background:var(--dsw-alias-state-business-primary);animation:dnPulse 1.3s ease-in-out infinite}
      .dn-stateText{flex-direction:row;align-items:center;gap:7px}.dn-stateText .dn-stateDot{margin-top:0}
      .dn-question,.dn-setupCard,.dn-activation{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:16px}
      .dn-question{display:flex;gap:12px}.dn-questionMark{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--dsw-alias-bg-layer-2)}
      .dn-questionBody{flex:1;display:flex;flex-direction:column;gap:6px}.dn-options{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
      .dn-option{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:inherit;border-radius:var(--dsw-radius-md);padding:6px 10px;cursor:pointer}
      .dn-option.is-selected{border-color:var(--dsw-alias-state-business-primary)}
      .dn-channelGlyph{width:36px;height:36px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);display:grid;place-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
      .dn-empty,.dn-note{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:8px 0}
      .dn-emptyState{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:12px 0}.dn-emptyState span{color:var(--dsw-alias-label-secondary);font-size:13px}
      .dn-detailBack{margin-bottom:12px}.dn-field{display:flex;flex-direction:column;gap:5px;margin:12px 0;font-size:13px}
      .dn-field input{box-sizing:border-box;width:100%;max-width:560px;height:34px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:7px 10px;font:inherit}
      .dn-field small{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dn-error{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}.dn-successText,.dn-success{color:var(--dsw-alias-state-success-primary);font-size:13px}
      .dn-success{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-top:12px}
      .dn-inlineStatus{display:flex;gap:8px;align-items:center;font-size:13px}.dn-inlineStatus .dn-stateDot{margin-top:0}
      .dn-channelPicker{display:flex;flex-direction:column;gap:2px;margin-top:12px}.dn-pickerRow{display:flex;justify-content:space-between;border:0;background:transparent;color:inherit;padding:10px;border-radius:var(--dsw-radius-md);cursor:pointer;text-align:left}.dn-pickerRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dn-healthGrid{display:flex;gap:16px;flex-wrap:wrap;font-size:13px}.dn-activityTime{width:48px;color:var(--dsw-alias-label-tertiary);font-size:12px}
      .dn-pluginConfig{display:flex;flex-direction:column;gap:8px;padding:8px 0}.dn-pluginConfig>p,.dn-activation>p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
      @keyframes dnPulse{0%,100%{opacity:.35}50%{opacity:1}}
      @media(max-width:719px){.dn-page{padding:20px 16px 40px}.dn-pageHead{gap:12px}.dn-row{align-items:flex-start}.dn-rowAside{align-items:flex-start}.dn-options{flex-direction:column}.dn-option{width:100%;text-align:left}}
      @media(prefers-reduced-motion:reduce){.dn-stateDot--ongoing{animation:none}}
    `

    return {
      inject: ['slots', 'connection', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-notifier: native locale')
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-notifier'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => { style.remove() }, 'dsh-notifier: native styles')

        const controller = createController(ctx)
        // v0.12.1（P2-11）：页面不可见时停止 surface.wait 与 fallback 刷新，恢复时追一次。
        ctx.effect(() => {
          const page = typeof document === 'object' ? document : null
          if (page === null) return
          const onChange = () => controller.setActive(page.visibilityState !== 'hidden')
          onChange()
          page.addEventListener('visibilitychange', onChange)
          return () => page.removeEventListener('visibilitychange', onChange)
        }, 'dsh-notifier: native visibility')
        ctx.effect(() => () => controller.dispose(), 'dsh-notifier: native controller')

        const Main = () => h(MainPanel, { controller, ctx })
        const Config = props => h(PluginConfig, { ...props, controller, ctx })
        const ActivationView = props => h(Activation, { ...props, ctx })

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Main))
        // label 必须是 thunk：宿主 resolveSlotLabel 只对函数求值（`typeof label === 'function' ? label() : label`），
        // 传普通对象会被原样当 React child 渲染 → "Objects are not valid as a React child"，
        // 直接崩掉整个 sidebar slot（2026-09-25 真机 0.1.7-rc.2 复现：data-slot-error="sidebar"）。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => resolveText(ctx, { en: 'Notify & Control', zh: '通知与控制' }),
        }, SidebarIcon))
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-notifier',
        }, Config))
        ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
          name: 'plugins.bundle.activation',
          key: 'dsh-notifier',
        }, ActivationView))
      },
    }
  },
})
