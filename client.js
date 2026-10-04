window.__ModuleLoader__.load({
  id: 'dsh-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const {
      Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React

    const PANEL_ID = 'dsh-notifier'
    // v0.15（Stage 1 / S2）：用户信息架构重建。旧 Home 的「常用 / 管理」pill 导航已删除——
    // Home / Channels / Tasks / Sessions / Bindings 不再作为用户 IA。唯一用户页面是
    // 「通知与私聊」（native / native-channel），二级能力从「更多」菜单进入。
    const RPC_CHANNEL = '/dsh-notifier'
    const NS = 'dsh-notifier.native'

    const zh = Object.freeze({
      configTransfer: '导入与导出',
      transferIntro: '导出不含密钥。新渠道导入后需补充凭证并保存。',
      exportConfig: '导出配置', importConfig: '选择配置文件', previewImport: '预览导入',
      confirmImport: '确认导入', importDone: '导入已完成', importStaged: '待配置',
      importAdd: '新增（暂不启用）', importPatch: '补充字段', importConflict: '覆盖已有字段',
      importSkip: '配置相同', importUnsupported: '不支持', importMissing: '需补充',
      importFields: '变更字段', importConfigure: '补充配置', importEmpty: '暂无待配置渠道',
      exportFailed: '下载失败，请复制下方内容。', cloudflare: 'Cloudflare 设置',
      nativeTitle: '通知与私聊',
      nativeIntro: '把重要事件发到你的设备，也能用手机回话。',
      more: '更多',
      moreNotify: '通知设置',
      moreRemote: '远程访问',
      moreImport: '导入旧设置',
      moreHelp: '帮助',
      allChannels: '全部',
      railAdd: '添加渠道',
      overviewNotify: '通知',
      overviewNotifyEmpty: '还没有开启通知的渠道',
      overviewPrivate: '私聊',
      overviewPrivateOff: '私聊还没有开启',
      currentTask: '当前任务',
      usersLabel: '使用者',
      pendingBannerTitle: '有需要处理的事',
      pendingBannerView: '查看',
      pendingEmpty: '暂时没有需要处理的事',
      pickerTitle: '添加渠道',
      pickerSearch: '搜索渠道',
      pickerCommon: '常用',
      pickerOther: '其他通知方式',
      pickerAdded: '已添加',
      pickerEmpty: '没有找到这个渠道',
      pickerClose: '关闭',
      accountMore: '更多设置',
      accountBasic: '基础设置',
      accountExpand: '展开设置',
      accountCollapse: '收起设置',
      accountNoFields: '这个渠道没有可填的选项，直接保存即可。',
      accountSaved: '已保存',
      privateEnable: '开启私聊',
      privateDisable: '关闭私聊',
      privateRestart: '已开启；重启宿主后连接生效',
      connectionHelp: '连接帮助',
      telegramAutoFallback: '自动准备备用连接',
      telegramCustomAddress: '使用自定义地址',
      connectionHelpHint: '连接失败时，可以准备一条备用线路，或改用你自己的地址。',
      // v0.15（Stage 1 / S4）：私聊（确认本人 → 选择任务 → 试用）与待处理流程。
      privateOpen: '设置私聊',
      privateView: '查看私聊',
      privateSetupTitle: '设置私聊',
      privateReadyTitle: '私聊已开启',
      privateStepConfirm: '确认是你',
      privateStepTask: '选择任务',
      privateStepTry: '试用',
      privateConfirmHint: '用手机给机器人发一句话，然后在下面确认是你。',
      privateConfirmWaiting: '还没有收到消息',
      privateConfirmMint: '生成确认码',
      privateConfirmCodeHint: '把这个码发给机器人，就能确认是你：',
      privateConfirmPendingTitle: '等待确认',
      privateTaskHint: '选一个私聊要汇报的任务。',
      privateSelectOwner: '选择要设置当前任务的使用者。',
      reconfigureNotice: '旧使用者记录没有关联渠道账号，不能用于访问。请重新配对本人并选择当前任务；如需旧资料，请从本机状态备份离线核对。',
      privateTaskEmpty: '现在没有正在运行的任务。',
      privateTaskUse: '就用这个',
      privateTryHint: '在手机私聊里发送「状态」，看看能不能收到回复。',
      privateTryWord: '状态',
      privateFinish: '完成',
      privateClose: '关闭私聊',
      privateCloseConfirm: '关闭后手机就不能回话了，确定关闭吗？',
      privateCloseStay: '先不关',
      privateCurrentChannel: '当前渠道',
      privateNoChannel: '还没有确认的渠道',
      privateNoTask: '还没有任务',
      privatePeople: '使用者',
      pendingIgnore: '忽略',
      pendingAlreadyHandled: '这件事已经被处理过了',
      channels: '通知渠道',
      activity: '最近活动',
      noChannels: '尚未配置通知渠道',
      noChannelsHint: '配置一个渠道后，DSH 的重要事件可以直接送到你的设备。',
      reconfigureStateTitle: '已为此版本建立空白状态',
      reconfigureStateSteps: '请重新添加通知渠道，重新确认私聊身份并选择当前任务。旧状态已另存为本机备份；需要旧资料时，请离线手工查看备份，不要直接恢复整份文件。',
      setupFirst: '设置第一个通知渠道',
      save: '保存',
      test: '发送测试通知',
      testing: '正在发送测试通知…',
      testDelivered: '测试通知已送达',
      testAccepted: '测试消息已发送',
      // v0.15（T18 / U01–U12）：保存回执与刷新分离；测试证据分级；列表三态。
      saving: '正在保存…',
      savedOk: '配置已保存',
      savedRefreshFailed: '已保存，但详情刷新失败。重试只会重新读取。',
      testCommittedConfig: '测试的是已保存的配置。',
      unsavedChangesHint: '有未保存的修改，请先保存再测试。',
      testUnconfirmed: '无法确认结果',
      testConfirmedHint: '已送达',
      testAcceptedDetail: '已发送，请检查设备',
      testReasonAuth: '凭证或权限被拒绝',
      testReasonTimeout: '请求超时',
      testReasonNetwork: '网络不可达',
      testReasonProvider: '平台返回错误',
      unknownNoRetry: '发送结果未知',
      secretConfiguredKeep: '已配置（默认保留）',
      secretNotShown: '出于安全，不显示已保存的值',
      secretKeep: '保留',
      secretReplace: '替换',
      secretClear: '清除',
      listHint: '每行一项，也可用逗号分隔',
      retry: '重试',
      back: '返回',
      notify: '通知',
      control: '远程控制',
      ready: '可用',
      restartPending: '等待重启',
      unavailable: '不可用',
      runningOk: '运行正常',
      needsAction: '需要处理',
      connectionLost: '无法读取 dsh-notifier 状态',
      reconnecting: '正在重新连接 DSH…',
      loading: '正在读取通知状态…',
      tasks: '任务',
      questions: '待处理提问',
      members: '成员',
      approve: '转正',
      sessions: '任务记录',
      bindings: '发送设置',
      cancelAction: '取消',
      // v0.14（Stage E / P1-10）：Session Detail（路由 / 出站 / 静默 / 控制 / 绑定）。
      reject: '拒绝',
      refresh: '刷新',
      configured: '已配置',
      delivered: '送达',
      skipped: '跳过',
      failed: '失败',
      setupActivationTitle: '设置通知',
      setupActivationBody: 'dsh-notifier 已启用。配置一个通知渠道即可开始使用。',
      later: '稍后',
      startSetup: '开始设置',
      pluginReady: '通知已就绪',
      openControl: '打开通知与控制',
      unknownError: '发生未知错误',
      staleData: '连接中断，当前显示的是上次成功读取的数据。',
      yes: '是',
      no: '否',
      supportReport: '支持报告',
      reportIntro: '生成支持报告',
      reportNotBackup: '支持报告不包含密钥。',
      generateReport: '生成支持报告',
      copiedOk: '已复制到剪贴板',
      downloadedOk: '已下载报告文件',
      copyFailedDownload: '无法复制，已改为下载',
      // v0.15（T24）：远程入口（手机访问）。
      remoteEntry: '远程入口',
      remoteIntro: '填写 HTTPS 地址，在手机上打开通知与控制。',
      remoteUrlLabel: '访问链接',
      remoteUrlPlaceholder: 'https://example.com/…',
      remoteGenerate: '生成入口',
      remoteValid: '链接格式正确',
      remoteOpen: '打开链接',
      remoteCopy: '复制链接',
      remoteCopied: '链接已复制',
      remoteCopyUnavailable: '无法访问剪贴板，请手动长按链接复制',
      remoteQrTitle: '二维码',
      remoteQrUnavailable: '当前环境不支持二维码，请使用下方普通链接',
      remoteQrEquivalent: '二维码与普通链接指向同一个地址',
      remoteHint: '链接可以打开不代表已取得管理权限；连接与权限请分别核对。',
      remoteNoSecret: '不要在链接里放入 ticket / token / 密码等秘密参数。',
      // v0.15（Stage 1 / S5）：二级能力收口——通知总览 + 用户向帮助。
      notifySettingsTitle: '通知设置',
      notifySettingsIntro: '打开通知的渠道会收到 DSH 的重要事件。',
      notifySettingsEmpty: '还没有渠道能接收通知，先添加一个渠道。',
      notifySettingsOpen: '打开设置',
      helpTitle: '帮助',
      helpIntro: '先试这几步；还不行就生成摘要发给开发者。',
      helpTipPhone: '手机没收到消息',
      helpTipPhoneBody: '确认渠道里的信息填写正确，点「发送测试通知」再看一次。',
      helpTipConnect: '连接一直失败',
      helpTipConnectBody: '回到该渠道，展开「连接帮助」，按提示准备备用连接。',
      helpTipReply: '手机回复没有反应',
      helpTipReplyBody: '确认私聊已开启，并且已经确认是你。',
      helpTipRestart: '刚改完还没生效',
      helpTipRestartBody: '重启 DSH 后再试一次。',
    })

    const en = Object.freeze({
      configTransfer: 'Import & export',
      transferIntro: 'Exports omit credentials. Complete new channels before saving.',
      exportConfig: 'Export config', importConfig: 'Choose config file', previewImport: 'Preview import',
      confirmImport: 'Confirm import', importDone: 'Import complete', importStaged: 'Pending setup',
      importAdd: 'New (inactive)', importPatch: 'Add fields', importConflict: 'Replace existing fields',
      importSkip: 'No changes', importUnsupported: 'Unsupported', importMissing: 'Required',
      importFields: 'Changed fields', importConfigure: 'Complete setup', importEmpty: 'No pending channels',
      exportFailed: 'Download failed. Copy the content below.', cloudflare: 'Cloudflare setup',
      nativeTitle: 'Notify & Private chat',
      nativeIntro: 'Send important events to your device, and reply from your phone.',
      more: 'More',
      moreNotify: 'Notification settings',
      moreRemote: 'Remote access',
      moreImport: 'Import old settings',
      moreHelp: 'Help',
      allChannels: 'All',
      railAdd: 'Add channel',
      overviewNotify: 'Notifications',
      overviewNotifyEmpty: 'No channel has notifications on yet',
      overviewPrivate: 'Private chat',
      overviewPrivateOff: 'Private chat is not on yet',
      currentTask: 'Current task',
      usersLabel: 'People',
      pendingBannerTitle: 'Something needs your attention',
      pendingBannerView: 'View',
      pendingEmpty: 'Nothing needs your attention',
      pickerTitle: 'Add a channel',
      pickerSearch: 'Search channels',
      pickerCommon: 'Common',
      pickerOther: 'Other ways to notify',
      pickerAdded: 'Added',
      pickerEmpty: 'No channel matches that',
      pickerClose: 'Close',
      accountMore: 'More settings',
      accountBasic: 'Basic settings',
      accountExpand: 'Expand settings',
      accountCollapse: 'Collapse settings',
      accountNoFields: 'This channel has nothing to fill in — just save.',
      accountSaved: 'Saved',
      privateEnable: 'Enable private chat',
      privateDisable: 'Disable private chat',
      privateRestart: 'Enabled; restart the host to connect',
      connectionHelp: 'Connection help',
      telegramAutoFallback: 'Prepare a fallback connection',
      telegramCustomAddress: 'Use a custom address',
      connectionHelpHint: 'If connecting fails, prepare a fallback line or switch to your own address.',
      // v0.15 (Stage 1 / S4): private chat (confirm → pick a task → try) and pending flow.
      privateOpen: 'Set up private chat',
      privateView: 'View private chat',
      privateSetupTitle: 'Set up private chat',
      privateReadyTitle: 'Private chat is on',
      privateStepConfirm: 'Confirm it is you',
      privateStepTask: 'Pick a task',
      privateStepTry: 'Try it',
      privateConfirmHint: 'Send the bot a message from your phone, then confirm it is you below.',
      privateConfirmWaiting: 'No message yet',
      privateConfirmMint: 'Make a confirmation code',
      privateConfirmCodeHint: 'Send this code to the bot to confirm it is you:',
      privateConfirmPendingTitle: 'Waiting to confirm',
      privateTaskHint: 'Pick the task private chat should report on.',
      privateSelectOwner: 'Choose who should use this current task.',
      reconfigureNotice: 'A saved user record has no linked channel account, so it cannot be used for access. Pair yourself again and choose a current task. Use the local state backup for offline reference if needed.',
      privateTaskEmpty: 'No task is running right now.',
      privateTaskUse: 'Use this one',
      privateTryHint: 'Send "status" in the private chat on your phone and see if it replies.',
      privateTryWord: 'status',
      privateFinish: 'Done',
      privateClose: 'Turn off private chat',
      privateCloseConfirm: 'Your phone will not be able to reply after this. Turn it off?',
      privateCloseStay: 'Keep it on',
      privateCurrentChannel: 'Current channel',
      privateNoChannel: 'No confirmed channel yet',
      privateNoTask: 'No task yet',
      privatePeople: 'People',
      pendingIgnore: 'Ignore',
      pendingAlreadyHandled: 'This one was already handled',
      channels: 'Notification channels',
      activity: 'Recent activity',
      noChannels: 'No notification channel yet',
      noChannelsHint: 'Add a channel to send important DSH events to your device.',
      reconfigureStateTitle: 'A clean state is ready for this version',
      reconfigureStateSteps: 'Add notification channels again, confirm your private-chat identity, and choose a current task. The old state is preserved in a local backup; inspect it offline if you need reference material, and do not restore the whole file.',
      setupFirst: 'Set up first channel',
      save: 'Save',
      test: 'Send test notification',
      testing: 'Sending test notification…',
      testDelivered: 'Test notification delivered',
      testAccepted: 'Test message sent',
      // v0.15 (T18 / U01–U12): save receipt vs refresh; delivery evidence levels; list tri-state.
      saving: 'Saving…',
      savedOk: 'Configuration saved',
      savedRefreshFailed: 'Saved, but refreshing details failed. Retry only re-reads.',
      testCommittedConfig: 'Tests the saved configuration.',
      unsavedChangesHint: 'You have unsaved changes — save before testing.',
      testUnconfirmed: 'Could not confirm delivery',
      testConfirmedHint: 'Delivered',
      testAcceptedDetail: 'Sent. Check your device.',
      testReasonAuth: 'Credential or permission rejected',
      testReasonTimeout: 'Request timed out',
      testReasonNetwork: 'Network unreachable',
      testReasonProvider: 'The service returned an error',
      unknownNoRetry: 'Send result unknown',
      secretConfiguredKeep: 'Set up (kept by default)',
      secretNotShown: 'The saved value is never shown, for safety',
      secretKeep: 'Keep',
      secretReplace: 'Replace',
      secretClear: 'Clear',
      listHint: 'One item per line, or comma-separated',
      retry: 'Retry',
      back: 'Back',
      notify: 'Notify',
      control: 'Remote control',
      ready: 'Ready',
      restartPending: 'Restart pending',
      unavailable: 'Unavailable',
      runningOk: 'Running normally',
      needsAction: 'Needs attention',
      connectionLost: 'Unable to read dsh-notifier status',
      reconnecting: 'Reconnecting to DSH…',
      loading: 'Loading notification status…',
      tasks: 'Tasks',
      questions: 'Questions',
      members: 'Members',
      approve: 'Approve',
      sessions: 'Sessions',
      bindings: 'Routing bindings',
      cancelAction: 'Cancel',
      // v0.14 (Stage E / P1-10): Session Detail (routing / outbound / quiet / control / bindings).
      reject: 'Reject',
      refresh: 'Refresh',
      configured: 'Set up',
      delivered: 'Delivered',
      skipped: 'Skipped',
      failed: 'Failed',
      setupActivationTitle: 'Set up notification',
      setupActivationBody: 'dsh-notifier is enabled. Configure one notification channel to get started.',
      later: 'Later',
      startSetup: 'Start setup',
      pluginReady: 'Notifications are ready',
      openControl: 'Open Notify & Control',
      unknownError: 'An unknown error occurred',
      staleData: 'Connection interrupted; showing the last successfully loaded data.',
      yes: 'Yes',
      no: 'No',
      supportReport: 'Support report',
      reportIntro: 'Generate a summary and attach it to your report.',
      reportNotBackup: 'The summary contains no credentials.',
      generateReport: 'Generate support report',
      copiedOk: 'Copied to clipboard',
      downloadedOk: 'Report downloaded',
      copyFailedDownload: 'Could not copy — downloaded instead',
      // v0.15 (T24): remote entry (phone access).
      remoteEntry: 'Remote entry',
      remoteIntro: 'Enter an HTTPS address to open Notify & Control on your phone.',
      remoteUrlLabel: 'Access link',
      remoteUrlPlaceholder: 'https://example.com/…',
      remoteGenerate: 'Build entry',
      remoteValid: 'Link format valid',
      remoteOpen: 'Open link',
      remoteCopy: 'Copy link',
      remoteCopied: 'Link copied',
      remoteCopyUnavailable: 'Clipboard unavailable — long-press the link to copy it manually',
      remoteQrTitle: 'QR code',
      remoteQrUnavailable: 'QR rendering is unavailable in this environment — use the plain link below',
      remoteQrEquivalent: 'The QR code and the plain link point to the same address',
      remoteHint: 'A link that opens does not mean you hold management permissions; check connection and permissions separately.',
      remoteNoSecret: 'Do not put ticket / token / password params into the link.',
      // v0.15 (Stage 1 / S5): consolidate secondary settings — notification overview + user-facing help.
      notifySettingsTitle: 'Notification settings',
      notifySettingsIntro: 'Channels with notifications on receive important DSH events.',
      notifySettingsEmpty: 'No channel can notify yet — add one first.',
      notifySettingsOpen: 'Open settings',
      helpTitle: 'Help',
      helpIntro: 'Try these first; if it still fails, generate a summary for the developer.',
      helpTipPhone: 'The phone got nothing',
      helpTipPhoneBody: 'Check the channel details are correct, then send a test notification again.',
      helpTipConnect: 'Connecting keeps failing',
      helpTipConnectBody: 'Go back to that channel, expand "Connection help", and prepare a fallback connection.',
      helpTipReply: 'Replying from the phone does nothing',
      helpTipReplyBody: 'Check private chat is on and that you are confirmed.',
      helpTipRestart: 'A change has not taken effect',
      helpTipRestartBody: 'Restart DSH and try again.',
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

    class ErrorBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() { return { failed: true } }
      componentDidCatch() { /* 宿主 slot 保持存活；结构化 RPC 错误由视图自身展示。 */ }
      render() {
        if (!this.state.failed) return this.props.children
        return h('div', { className: 'dn-page dn-errorBoundary', role: 'alert' },
          h('strong', null, this.props.message || 'Notify & Control could not render'),
          h(Button, { onClick: () => this.setState({ failed: false }) }, this.props.retry || 'Retry'))
      }
    }

    // S11：支持报告必须 deterministic + redacted —— 只序列化已脱敏的 canonical 快照，
    // 不追加任何新采集字段；导出方式按运行环境在剪贴板 / 浏览器下载间二选一。
    function buildSupportReport(snapshot) {
      const value = snapshot !== null && typeof snapshot === 'object' ? snapshot : {}
      return [
        '### dsh-notifier support report',
        '',
        `- plugin version: ${String(value.version ?? 'unknown')}`,
        `- generated at: ${String(value.generatedAt ?? 'unknown')}`,
        `- attention required: ${value.attention?.required === true ? 'yes' : 'no'}`,
        `- evidence level: ${String(value.channels?.latestEvidence ?? 'none')}`,
        '',
        '```json',
        JSON.stringify(value, null, 2),
        '```',
        '',
      ].join('\n')
    }

    /**
     * v0.15（T19 / U10）：复制纯文本到剪贴板。**只做一件事**：成功返回 true，任何原因
     * （无剪贴板能力、非安全上下文、被拒绝）都返回 false —— 由调用方给出**手动 fallback**
     * 文案，绝不假装复制成功。绝不把被复制内容写入任何持久层（明文配对码只在内存一次）。
     */
    async function copyText(text) {
      try {
        if (typeof navigator === 'object' && navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(String(text))
          return true
        }
      } catch {}
      return false
    }

    async function deliverReport(report) {
      try {
        if (typeof navigator === 'object' && navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(report)
          return { ok: true, type: 'copied' }
        }
      } catch {}
      try {
        const blob = new Blob([report], { type: 'text/markdown' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `dsh-notifier-diagnostics-${new Date().toISOString().slice(0, 10)}.md`
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        URL.revokeObjectURL(url)
        return { ok: true, type: 'downloaded' }
      } catch {
        return { ok: false, type: 'failed' }
      }
    }

    function createController(ctx) {
      const rpc = createRpcClient(ctx)
      let snapshot = Object.freeze({
        // v0.15（Stage 1 / S2）：唯一用户页面「通知与私聊」就是默认视图。
        view: { kind: 'native' },
        // v0.15（Stage 1 / S2）：Native v2 页面数据（native.snapshot / native.channel）。
        native: null,
        nativeChannel: null,
        busy: Object.freeze({}),
        error: null,
        epoch: null,
        revision: 0,
        staleAt: null,
        connectionState: 'connecting',
      })
      const listeners = new Set()
      let waitAbort = null
      let fallbackTimer = null
      let disposed = false
      // v0.12.1（P1-13）：同一资源只接受最新一代请求的响应，避免迟到数据覆盖当前视图。
      const generations = { native: 0, nativeChannel: 0 }
      let paused = false

      /** 语言：服务端 read model 需要 zh/en 决定用户词，与宿主编排语言一致。 */
      const nativeLang = () => {
        const current = String(ctx?.locale?.current ?? '').toLowerCase()
        return current.startsWith('en') ? 'en' : 'zh'
      }

      const emit = (patch) => {
        snapshot = Object.freeze({ ...snapshot, ...patch })
        for (const listener of [...listeners]) {
          try { listener() } catch {}
        }
      }
      const setBusy = (key, value) => emit({ busy: Object.freeze({ ...snapshot.busy, [key]: value }) })
      const setError = (error) => emit({ error: error ?? null })
      const clockPatch = (value) => {
        const incomingEpoch = typeof value?.epoch === 'string' && value.epoch !== '' ? value.epoch : snapshot.epoch
        const incomingRevision = Number.isFinite(Number(value?.revision)) ? Number(value.revision) : snapshot.revision
        const epochChanged = snapshot.epoch !== null && incomingEpoch !== null && incomingEpoch !== snapshot.epoch
        return {
          epochChanged,
          patch: {
            ...(epochChanged ? { native: null, nativeChannel: null } : {}),
            epoch: incomingEpoch,
            revision: epochChanged ? incomingRevision : Math.max(snapshot.revision, incomingRevision),
            connectionState: 'connected',
            staleAt: null,
          },
        }
      }
      const commit = (resource, value) => {
        const clock = clockPatch(value)
        emit({ ...clock.patch, [resource]: value, error: null })
        return clock.epochChanged
      }

      // Native v2 只读入口。一次拉取渠道栏、渠道状态、私聊和待处理项。
      async function loadNative() {
        const generation = ++generations.native
        try {
          const value = await rpc.call('native.snapshot', { lang: nativeLang() })
          if (generation !== generations.native) return value
          commit('native', value)
          return value
        } catch (error) {
          if (generation !== generations.native) return null
          setError(error)
          throw error
        }
      }
      async function loadNativeChannel(type) {
        const generation = ++generations.nativeChannel
        try {
          const value = await rpc.call('native.channel', { type, lang: nativeLang() })
          if (generation !== generations.nativeChannel) return value
          if (snapshot.view.kind !== 'native-channel' || snapshot.view.type !== type) return value
          commit('nativeChannel', value)
          return value
        } catch (error) {
          if (generation !== generations.nativeChannel) return null
          throw error
        }
      }
      async function refreshCurrent() {
        if (disposed) return false
        try {
          const kind = snapshot.view.kind
          if (kind === 'native') await loadNative()
          else if (kind === 'native-channel') await loadNativeChannel(snapshot.view.type)
          // v0.15（Stage 1 / S4）：私聊页与待处理页共用同一份 native 快照。
          else if (kind === 'native-private' || kind === 'native-pending') await loadNative()
          // v0.15（Stage 1 / S5）：通知总览复用 native 快照；帮助页无需额外读取。
          else if (kind === 'notify-settings') await loadNative()
          else await loadNative()
          emit({ staleAt: null, connectionState: 'connected' })
          return true
        } catch {
          const hasData = snapshot.native !== null || snapshot.nativeChannel !== null
          emit({ staleAt: Date.now(), connectionState: hasData ? 'stale' : 'disconnected' })
          return false
        }
      }
      // v0.15（Stage 1 / S2）：Native v2 窄写动作。每个动作只调一个 `native.*` 方法
      // （服务端把它委派给**一个**既有 authority），成功后刷新当前 Native 视图；
      // 不写 store、不做补偿写、不建第二 authority。
      async function nativeApproveUser(id) {
        const key = `pending:${id}`
        if (snapshot.busy[key] === true) return null
        setBusy(key, true)
        try {
          const value = await rpc.call('native.approveUser', { id })
          setError(null)
          await refreshCurrent().catch(() => {})
          return value
        } finally {
          setBusy(key, false)
        }
      }
      async function nativeDismissUser(id) {
        const key = `pending:${id}`
        if (snapshot.busy[key] === true) return null
        setBusy(key, true)
        try {
          const value = await rpc.call('native.dismissUser', { id })
          setError(null)
          await refreshCurrent().catch(() => {})
          return value
        } finally {
          setBusy(key, false)
        }
      }
      // v0.15（Stage 1 / S3）：Native v2 账号卡的保存与测试。仍走窄动作表——出站与入站各对应
      // **一个** authority（native.saveChannel / native.saveInboundChannel），测试只针对已保存配置。
      // secret 三态在这里收敛成 payload（值）+ clearSecrets（清除列表），空串既不表示保留也不表示清除。
      async function nativeSaveChannel(type, direction, patch, clearSecrets = []) {
        const key = `save:${type}:${direction}`
        if (snapshot.busy[key] === true) return { saved: false, duplicate: true, refreshed: false }
        setBusy(key, true)
        try {
          const method = direction === 'inbound' ? 'native.saveInboundChannel' : 'native.saveChannel'
          const payload = { type, patch }
          if (clearSecrets.length > 0) payload.clearSecrets = [...clearSecrets]
          const value = await rpc.call(method, payload)
          setError(null)
          // 落盘结果就是回执；刷新详情是另一件事——刷新失败不能上报成「保存失败」。
          const refreshed = await loadNativeChannel(type).then(() => true).catch(() => false)
          return { ...(value && typeof value === 'object' ? value : {}), refreshed }
        } finally {
          setBusy(key, false)
        }
      }
      async function nativeTestChannel(type) {
        const key = `test:${type}`
        if (snapshot.busy[key] === true) return null
        setBusy(key, true)
        try {
          const value = await rpc.call('native.testChannel', { type, lang: nativeLang() })
          setError(null)
          await loadNativeChannel(type).catch(() => {})
          return value
        } finally {
          setBusy(key, false)
        }
      }
      // v0.15（Stage 1 / S4）：待处理项结算。仍走窄动作表——服务端把它委派给**一个**既有
      // authority（提问控制服务 / 成员控制服务）。已被手机端处理过时服务端返回 alreadyHandled，
      // 客户端据此显示「已经被处理过了」，绝不把它当成新动作再执行一次（防重放）。
      async function nativeSettlePending(ref, action, options = []) {
        const key = `pending:${ref}`
        if (snapshot.busy[key] === true) return { settled: false, duplicate: true }
        setBusy(key, true)
        try {
          const value = await rpc.call('native.settlePending', { ref, action, options })
          setError(null)
          await loadNative().catch(() => {})
          return value
        } finally {
          setBusy(key, false)
        }
      }
      // v0.15（Stage 1 / S4）：确认本人（待确认身份 → 正式使用者）。
      async function nativeSelectTask(taskRef, ownerId) {
        const value = await rpc.call('native.selectTask', { taskRef, ownerId })
        await loadNative()
        return value
      }
      async function nativeMintPairing(label = '') {
        const key = 'pairing:mint'
        if (snapshot.busy[key] === true) return null
        setBusy(key, true)
        try {
          const value = await rpc.call('native.mintPairing', { label })
          setError(null)
          return value
        } finally {
          setBusy(key, false)
        }
      }
      // 私聊开关与凭证分离，关闭只撤销运行准入，不删除账号配置。
      async function nativeClosePrivateChat(type) {
        return nativeSetPrivateChatEnabled(type, false)
      }
      async function nativeSetPrivateChatEnabled(type, enabled) {
        const key = `private-chat:${type}`
        if (snapshot.busy[key] === true) return { removed: false, duplicate: true }
        setBusy(key, true)
        try {
          const value = await rpc.call('native.setPrivateChatEnabled', { type, enabled })
          setError(null)
          await Promise.all([loadNative().catch(() => {}), loadNativeChannel(type).catch(() => {})])
          return value
        } catch (error) {
          // A failed durable close still fences admission in this process; refresh the
          // Native projection before showing the storage error so it reflects that fence.
          await Promise.all([loadNative().catch(() => {}), loadNativeChannel(type).catch(() => {})])
          throw error
        } finally {
          setBusy(key, false)
        }
      }
      // v0.15（T24）：远程入口 URL 校验。纯只读 RPC（零写、零网络、不 touch revision）。
      async function validateRemoteUrl(url) {
        return rpc.call('remote.validate', { url })
      }
      async function generateSupportReport() {
        setBusy('diagnostics:report', true)
        try {
          const value = await rpc.call('diagnostics.snapshot')
          return await deliverReport(buildSupportReport(value))
        } finally {
          setBusy('diagnostics:report', false)
        }
      }
      function navigate(view) {
        // 导航只负责切视图；目标视图的 mount effect 是唯一加载 owner。
        const changingNativeChannel = view?.kind === 'native-channel'
          && (snapshot.view.kind !== 'native-channel' || snapshot.view.type !== view.type)
        if (changingNativeChannel) generations.nativeChannel += 1
        emit({
          view,
          error: null,
          ...(changingNativeChannel ? { nativeChannel: null } : {}),
        })
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
          if (value?.capacity === true) {
            const retryAfterMs = Math.max(500, Math.min(30_000, Number(value.retryAfterMs) || 1_000))
            await new Promise(resolve => setTimeout(resolve, retryAfterMs))
            continue
          }
          const epochChanged = typeof value?.epoch === 'string' && value.epoch !== '' && snapshot.epoch !== null && value.epoch !== snapshot.epoch
          if (epochChanged || Number(value?.revision ?? 0) > snapshot.revision) {
                const refreshed = await refreshCurrent()
                if (refreshed === true && !epochChanged) emit({ revision: Math.max(snapshot.revision, Number(value.revision) || 0) })
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
        // v0.15（Stage 1 / S2）：Native v2 只读 + 窄写动作。
        loadNative, loadNativeChannel, nativeApproveUser, nativeDismissUser,
        // v0.15（Stage 1 / S3）：账号卡保存/测试（仍走窄动作表）。
        nativeSaveChannel, nativeTestChannel,
        // v0.15（Stage 1 / S4）：待处理结算、确认本人、关闭私聊（每个只调一个 authority）。
        nativeSettlePending, nativeMintPairing, nativeClosePrivateChat, nativeSetPrivateChatEnabled, nativeSelectTask,
        refreshCurrent, validateRemoteUrl,
        exportConfig: () => rpc.call('portability.export'),
        previewImport: text => rpc.call('portability.preview', { text }),
        commitImport: (token, selections) => rpc.call('portability.commit', { token, selections }),
        cancelImport: token => rpc.call('portability.cancel', { token }),
        readImported: () => rpc.call('portability.readBack'),
        cloudCall: (method, payload = {}) => rpc.call(`cloudflare.${method}`, payload),
        generateSupportReport,
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

    // v0.14（Stage E / P1-09）：破坏性操作统一二次确认。
    // 首次点击只「武装」，必须再点确认才执行；4 秒无操作自动回落，避免误触后长期悬置。
    // last-owner 等底层约束仍由 authority 强制，UI 确认只是防手滑，不替代权威校验。
    // v0.15（T19 / U13）：`impact` 显示**具体对象与后果**（谁、会发生什么），取消则零 mutation。


    // v0.14（Stage E / P1-10）：原始标识默认脱敏——保留首尾少量字符，中间打码。
    // 仅在用户显式展开 raw 区时渲染完整值（见 RawIdentifiers）。




    function ErrorNotice({ error, t, onRetry }) {
      if (!error) return null
      const code = String(error?.code ?? 'dsh-notifier/internal')
      return h('div', { className: 'dn-error', role: 'alert', 'data-error-code': code },
        h('span', null, error?.message || t('unknownError')),
        onRetry ? h(Button, { onClick: onRetry }, t('retry')) : null)
    }

    // v0.15（T18 / U08–U09）：投递证据分级——confirmed（显式回执）/ accepted（仅平台接收）/
    // unknown（无法确认）。accepted 绝不显示成「送达」，unknown 绝不显示成「失败可重发」。
    function testReasonText(code, t) {
      return code === 'auth-failed' ? t('testReasonAuth')
        : code === 'timeout' ? t('testReasonTimeout')
          : code === 'network-error' ? t('testReasonNetwork')
            : t('testReasonProvider')
    }

    function testOutcome(ctx, result, t) {
      const confirmed = result?.confirmed === true || result?.status === 'delivered' || result?.delivered === true
      if (confirmed) return { ok: true, title: t('testDelivered'), note: t('testConfirmedHint') }
      const accepted = result?.accepted === true || result?.status === 'accepted'
      if (accepted) {
        return {
          ok: true,
          title: t('testAccepted'),
          note: `${t('testAcceptedDetail')}${result?.providerDetail ? ` · ${resolveText(ctx, result.providerDetail)}` : ''}`,
        }
      }
      const detail = result?.detail ? resolveText(ctx, result.detail) : ''
      return {
        ok: false,
        title: t('testUnconfirmed'),
        note: `${testReasonText(result?.reasonCode, t)}${detail ? ` · ${detail}` : ''} · ${t('unknownNoRetry')}`,
      }
    }

    // v0.15（T18 / U04）：列表三态——loading（尚无响应，不伪装「暂无」）/ error（服务或网络失败，
    // 不伪装成空）/ empty（已回但为空）；stale 数据保留但标注更新时间，不伪装实时。

    // v0.15（T19 / U07）：非 secret 草稿可**短时**保留（sessionStorage，随标签页关闭失效）；
    // secret 明文绝不写入任何 Web 存储、日志或支持报告——只写进当前 React state。
    const DRAFT_PREFIX = 'dsh-notifier:draft:'
    function safeStorage(name) {
      try {
        const store = globalThis[name]
        return store !== null && typeof store === 'object' ? store : null
      } catch { return null }
    }
    function saveDraft(where, type, values, fields) {
      const store = safeStorage('sessionStorage')
      if (store === null) return
      try {
        const safe = {}
        for (const [key, value] of Object.entries(values ?? {})) {
          if (fields?.[key]?.secret === true) continue
          safe[key] = value
        }
        const target = `${DRAFT_PREFIX}${where}:${type}`
        if (Object.keys(safe).length === 0) store.removeItem(target)
        else store.setItem(target, JSON.stringify(safe))
      } catch { /* storage 不可用/配额满：草稿只在内存，功能不受影响 */ }
    }
    function loadDraft(where, type, fields) {
      const store = safeStorage('sessionStorage')
      if (store === null) return null
      try {
        const raw = store.getItem(`${DRAFT_PREFIX}${where}:${type}`)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        const out = {}
        for (const [key, value] of Object.entries(parsed)) {
          if (fields?.[key]?.secret === true) continue
          out[key] = value
        }
        return Object.keys(out).length > 0 ? out : null
      } catch { return null }
    }
    function clearDraft(where, type) {
      const store = safeStorage('sessionStorage')
      if (store === null) return
      try { store.removeItem(`${DRAFT_PREFIX}${where}:${type}`) } catch {}
    }

    // v0.15（T19 / U06）：按声明选择控件——bool 开关 / enum 选择 / 数字输入 / 列表输入 / 文本。
    // 这纯粹是**表现层**映射（schema），不改任何业务规则；未声明类型一律退回文本。
    // secret 字段显式区分 保留 / 替换 / 清除，绝不把掩码或旧值当值回填。
    const SECRET_MODES = Object.freeze([['keep', 'secretKeep'], ['replace', 'secretReplace'], ['clear', 'secretClear']])
    // 首次挂载必须把已填的公共值同步一次；用哨兵对象保证「修订为 null」时也会触发第一次同步。
    const FORM_SENTINEL = {}
    function SchemaField({ ctx, name, meta, value, onChange, secretMode, onSecretMode, t }) {
      const secret = meta?.secret === true
      const configured = meta?.configured === true
      const type = meta?.type || 'string'
      const label = resolveText(ctx, meta?.label) || name
      const description = meta?.description ? h('small', null, resolveText(ctx, meta.description)) : null
      if (secret && configured) {
        const mode = secretMode ?? 'keep'
        return h('fieldset', { className: 'dn-field dn-field--secret', key: name },
          h('legend', { className: 'dn-fieldLabel' }, label),
          h('span', { className: 'dn-rowMeta' }, `${t('secretConfiguredKeep')} · ${t('secretNotShown')}`),
          h('div', { className: 'dn-secretModes' },
            ...SECRET_MODES.map(([modeKey, labelKey]) =>
              h('label', { key: modeKey, className: 'dn-radio' },
                h('input', {
                  type: 'radio',
                  name: `dn-secret-${name}`,
                  value: modeKey,
                  checked: mode === modeKey,
                  onChange: () => onSecretMode(modeKey),
                }),
                t(labelKey)))),
          mode === 'replace'
            ? h('input', {
                type: 'password', value: value ?? '', 'aria-label': `${label} (${t('secretReplace')})`,
                onChange: event => onChange(event.target.value),
              })
            : null,
          description)
      }
      if (type === 'enum' && Array.isArray(meta?.options)) {
        return h('label', { className: 'dn-field', key: name },
          h('span', { className: 'dn-fieldLabel' }, label),
          h('select', {
            value: value ?? '', 'aria-label': label,
            onChange: event => onChange(event.target.value),
          },
          h('option', { value: '' }, '—'),
          ...meta.options.map(option => h('option', { key: String(option), value: String(option) }, String(option)))),
          description)
      }
      if (type === 'boolean') {
        return h('label', { className: 'dn-field dn-field--check', key: name },
          h('input', {
            type: 'checkbox', checked: value === true, 'aria-label': label,
            onChange: event => onChange(event.target.checked),
          }),
          h('span', null, label),
          description)
      }
      if (type === 'list') {
        const text = Array.isArray(value) ? value.join('\n') : String(value ?? '')
        return h('label', { className: 'dn-field', key: name },
          h('span', { className: 'dn-fieldLabel' }, label),
          h('textarea', {
            rows: 3, value: text, 'aria-label': label, placeholder: t('listHint'),
            onChange: event => onChange(event.target.value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)),
          }),
          h('small', null, t('listHint')),
          description)
      }
      if (type === 'number') {
        return h('label', { className: 'dn-field', key: name },
          h('span', { className: 'dn-fieldLabel' }, label),
          h('input', {
            type: 'number', value: value ?? '', 'aria-label': label,
            // 合法数字才收窄为 number；空串保留为未填，非法输入原样保留交给 authority 校验。
            onChange: event => {
              const raw = event.target.value
              onChange(raw === '' ? '' : (Number.isFinite(Number(raw)) ? Number(raw) : raw))
            },
          }),
          description)
      }
      return h('label', { className: 'dn-field', key: name },
        h('span', { className: 'dn-fieldLabel' }, label),
        h('input', {
          type: secret ? 'password' : 'text', value: value ?? '', 'aria-label': label,
          placeholder: secret && configured ? t('configured') : '',
          onChange: event => onChange(event.target.value),
        }),
        description)
    }

    // v0.15（T19 / U05）：单个方向（出站 / 入站）的表单区块——**模块级稳定组件**。
    // 旧实现把它定义在 ChannelDetailView 内部，每次父轮询/状态更新都会产生新的组件类型，
    // React 因此整棵子树 remount：输入框 DOM 被替换，focus 与 caret 丢失（U05）。
    // 现在类型身份稳定，输入节点原地更新，连续输入不丢焦点。


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

    // ————————————————————————————————————————————————————————————————
    // v0.15（Stage 1 / S2）：Native v2 外壳。
    //
    // 用户信息架构只有一页——「通知与私聊」：左侧是已添加渠道（真实品牌 Logo + 渠道名），
    // 右侧是「全部」概览或某渠道详情；二级能力收进「更多」菜单。旧 Home 的「常用 / 管理」
    // pill 导航已删除：Home / Channels / Tasks / Sessions / Bindings 不再是用户 IA。
    //
    // 响应式（06_RESPONSIVE_LAYOUT_CONTRACT）：
    //   ≥880px  左栏 176px + 分隔线 + minmax(0,1fr) 内容（右列可缩，卡片不会被硬挤）；
    //   640–879 渠道栏变成顶部横向可滚动条；
    //   <640    不保留常驻栏，顶部是当前渠道选择器。
    // ————————————————————————————————————————————————————————————————

    // 品牌标识：要让人认出**品牌**，不是内部 type。品牌色圆角底 + 品牌字形/简单图形，
    // 绝不使用 ○ / ● 之类的点状图标。
    const BRAND_MARKS = Object.freeze({
      plane: 'M21.9 4.3 18.8 19c-.2 1-.9 1.2-1.7.8l-4.7-3.5-2.3 2.2c-.3.3-.5.5-.9.5l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L6.9 12.6l-4.5-1.4c-1-.3-1-1 .2-1.4l17.6-6.8c.8-.3 1.5.2 1.2 1.3z',
      screen: 'M3 4.5h14v9H3zM8 16.5h4M10 13.5v3',
      link: 'M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 1 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 1 0 4.2 4.2l1-1',
    })

    const BRAND_LOGO = Object.freeze({
      telegram: Object.freeze({ color: '#2AABEE', mark: 'plane' }),
      qq: Object.freeze({ color: '#12B7F5', text: 'QQ' }),
      feishu: Object.freeze({ color: '#3370FF', text: '飞' }),
      wecom: Object.freeze({ color: '#2F6BFF', text: '企' }),
      dingtalk: Object.freeze({ color: '#0089FF', text: '钉' }),
      wechat: Object.freeze({ color: '#07C160', text: '微' }),
      bark: Object.freeze({ color: '#FF9500', text: 'B' }),
      wxpusher: Object.freeze({ color: '#07C160', text: 'W' }),
      serverchan: Object.freeze({ color: '#07C160', text: 'S' }),
      pushplus: Object.freeze({ color: '#2E7DF6', text: 'P' }),
      pushdeer: Object.freeze({ color: '#FF6B00', text: 'D' }),
      pushover: Object.freeze({ color: '#249DF1', text: 'P' }),
      gotify: Object.freeze({ color: '#2E8B57', text: 'G' }),
      ntfy: Object.freeze({ color: '#338574', text: 'n' }),
      chanify: Object.freeze({ color: '#4A90D9', text: 'C' }),
      bell: Object.freeze({ color: '#6B7BFF', text: 'B' }),
      igot: Object.freeze({ color: '#FF3B30', text: 'i' }),
      qmsg: Object.freeze({ color: '#12B7F5', text: 'Q' }),
      discord: Object.freeze({ color: '#5865F2', text: 'D' }),
      slack: Object.freeze({ color: '#4A154B', text: 'S' }),
      teams: Object.freeze({ color: '#6264A7', text: 'T' }),
      mattermost: Object.freeze({ color: '#1E325C', text: 'M' }),
      gchat: Object.freeze({ color: '#34A853', text: 'G' }),
      wps: Object.freeze({ color: '#FF6600', text: 'W' }),
      xizhi: Object.freeze({ color: '#07C160', text: '息' }),
      desktop: Object.freeze({ color: '#5B6472', mark: 'screen' }),
      custom: Object.freeze({ color: '#5B6472', mark: 'link' }),
    })

    function ChannelLogo({ brand, name, size = 32 }) {
      const meta = BRAND_LOGO[String(brand ?? '')] ?? null
      const color = meta?.color ?? '#5B6472'
      const glyph = meta?.mark ? BRAND_MARKS[meta.mark] : null
      const label = meta?.text ?? (glyph ? null : String(name ?? '').slice(0, 1).toUpperCase())
      return h('svg', {
        className: 'dn-logo', width: size, height: size, viewBox: '0 0 24 24',
        'aria-hidden': true, focusable: 'false', 'data-brand': String(brand ?? 'generic'),
      },
        h('rect', { x: 0, y: 0, width: 24, height: 24, rx: 7, fill: color }),
        glyph
          ? h('path', { d: glyph, fill: 'none', stroke: '#fff', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })
          : h('text', {
              x: 12, y: 12.5, textAnchor: 'middle', dominantBaseline: 'middle',
              fill: '#fff', fontSize: label && label.length > 1 ? 9.5 : 12, fontWeight: 600,
            }, label ?? ''))
    }

    function AllGlyph() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('rect', { x: 1, y: 1, width: 6, height: 6, rx: 1.5, fill: 'currentColor' }),
        h('rect', { x: 9, y: 1, width: 6, height: 6, rx: 1.5, fill: 'currentColor' }),
        h('rect', { x: 1, y: 9, width: 6, height: 6, rx: 1.5, fill: 'currentColor' }),
        h('rect', { x: 9, y: 9, width: 6, height: 6, rx: 1.5, fill: 'currentColor' }))
    }

    /** 私聊渠道 id（`<channel>:<account>`）→ 该渠道的渠道摘要（取品牌标识用）。 */
    function brandRowOf(rows, id) {
      const type = String(id ?? '').split(':')[0]
      return (rows ?? []).find(row => row.id === type) ?? null
    }

    function ProductHeader({ t, onAdd, actions }) {
      return h('header', { className: 'dn-productHead' },
        h('div', { className: 'dn-productTitle' },
          h('h1', null, t('nativeTitle')),
          h('p', null, t('nativeIntro'))),
        h('div', { className: 'dn-productActions' },
          h(Button, { kind: 'primary', onClick: onAdd }, t('railAdd')),
          actions))
    }

    // 二级能力不是用户 IA，收进「更多」；不再做一个高级后台。
    // S5：通知设置 / 远程访问 / 导入旧设置 / 帮助——低频能力全部从主导航降级到这里。
    function MoreMenu({ controller, t }) {
      const [open, setOpen] = useState(false)
      const items = [
        ['moreNotify', 'notify-settings'],
        ['moreRemote', 'remote'],
        ['moreImport', 'portability'],
        ['moreHelp', 'help'],
      ]
      return h('div', { className: 'dn-moreWrap' },
        h(Button, {
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen(value => !value),
        }, `${t('more')} ▾`),
        open
          ? h('div', { className: 'dn-moreMenu', role: 'menu' },
              ...items.map(([key, kind]) => h('button', {
                key, type: 'button', role: 'menuitem', className: 'dn-moreItem',
                onClick: () => { setOpen(false); controller.navigate({ kind }) },
              }, t(key))))
          : null)
    }

    function channelNavEntries({ items, selected, onSelect, onAdd, t }) {
      return [
        h('button', {
          key: '__all', type: 'button', className: `dn-navItem ${selected === 'all' ? 'is-selected' : ''}`,
          'data-nav': 'all', 'aria-current': selected === 'all' ? 'page' : undefined,
          onClick: () => onSelect('all'),
        },
          h('span', { className: 'dn-navGlyph', 'aria-hidden': true }, h(AllGlyph)),
          h('span', { className: 'dn-navLabel' }, t('allChannels'))),
        ...items.map(row => h('button', {
          key: row.id, type: 'button', className: `dn-navItem ${selected === row.id ? 'is-selected' : ''}`,
          'data-nav': row.id, 'aria-current': selected === row.id ? 'page' : undefined,
          onClick: () => onSelect(row.id),
        },
          h(ChannelLogo, { brand: row.brand, name: row.name, size: 24 }),
          h('span', { className: 'dn-navLabel' }, row.name))),
        h('button', {
          key: '__add', type: 'button', className: 'dn-navItem dn-navAdd', 'data-nav': 'add',
          onClick: onAdd,
        },
          h('span', { className: 'dn-navGlyph', 'aria-hidden': true }, '+'),
          h('span', { className: 'dn-navLabel' }, t('railAdd'))),
      ]
    }

    function ChannelRail(props) {
      return h('nav', { className: 'dn-rail', 'aria-label': props.t('channels') }, ...channelNavEntries(props))
    }

    function ChannelStrip(props) {
      return h('nav', { className: 'dn-strip', 'aria-label': props.t('channels') }, ...channelNavEntries(props))
    }

    // 手机：不保留常驻栏，顶部是当前渠道按钮，点开弹出渠道选择。
    function ChannelTopSelector({ items, selected, onSelect, onAdd, t }) {
      const [open, setOpen] = useState(false)
      const current = selected === 'all' ? null : items.find(row => row.id === selected) ?? null
      return h('div', { className: 'dn-channelSelect' },
        h('button', {
          type: 'button', className: 'dn-selectButton',
          'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen(value => !value),
        },
          current ? h(ChannelLogo, { brand: current.brand, name: current.name, size: 22 })
            : h('span', { className: 'dn-navGlyph', 'aria-hidden': true }, h(AllGlyph)),
          h('span', { className: 'dn-selectLabel' }, current ? current.name : t('allChannels')),
          h('span', { className: 'dn-selectCaret', 'aria-hidden': true }, '▾')),
        open
          ? h('div', { className: 'dn-selectMenu', role: 'listbox' },
              h('button', {
                type: 'button', role: 'option', className: 'dn-selectOption',
                'aria-selected': selected === 'all' ? 'true' : 'false',
                onClick: () => { setOpen(false); onSelect('all') },
              }, t('allChannels')),
              ...items.map(row => h('button', {
                key: row.id, type: 'button', role: 'option', className: 'dn-selectOption',
                'aria-selected': selected === row.id ? 'true' : 'false',
                onClick: () => { setOpen(false); onSelect(row.id) },
              },
                h(ChannelLogo, { brand: row.brand, name: row.name, size: 20 }),
                h('span', null, row.name))),
              h('button', {
                type: 'button', role: 'option', className: 'dn-selectOption dn-selectAdd',
                'aria-selected': 'false',
                onClick: () => { setOpen(false); onAdd() },
              }, t('railAdd')))
          : null)
    }

    // 待处理：不是永久导航，只在有待处理时从顶部浅色提示进入。
    // 身份确认项直接确认/忽略；提问项按明确的选择或拒绝结算。
    // 已被手机端处理过的项不再执行一次，只提示「已经被处理过了」（防重放）。
    function PendingList({ controller, state, items, t }) {
      const [note, setNote] = useState({})
      if (items.length === 0) return h('p', { className: 'dn-empty' }, t('pendingEmpty'))
      const run = (item, choice) => {
        if (state?.busy?.[`pending:${item.id}`] === true) return
        const identity = (item.choices ?? []).some(candidate => candidate.id === 'approve')
        const promise = identity
          ? (choice.id === 'approve' ? controller.nativeApproveUser(item.id) : controller.nativeDismissUser(item.id))
          : controller.nativeSettlePending(
              item.id,
              choice.kind === 'reject' ? 'reject' : 'choose',
              choice.kind === 'reject' ? [] : [choice.id],
            )
        void Promise.resolve(promise).then(result => {
          // 已被手机端裁决过：服务端不二次执行，界面也不假装成功。
          if (result?.alreadyHandled === true) {
            setNote(current => ({ ...current, [item.id]: t('pendingAlreadyHandled') }))
          }
        }).catch(error => controller.reportError(error))
      }
      return h('div', { className: 'dn-list' }, ...items.map(item => {
        const identity = (item.choices ?? []).some(choice => choice.id === 'approve')
        const busy = state?.busy?.[`pending:${item.id}`] === true
        return h('article', { key: item.id, className: 'dn-question' },
          h('div', { className: 'dn-questionMark', 'aria-hidden': true }, identity ? '?' : '!'),
          h('div', { className: 'dn-questionBody' },
            h('strong', { className: 'dn-rowTitle' }, item.title),
            h('span', { className: 'dn-rowMeta' }, [item.sourceText, item.createdText].filter(Boolean).join(' · ')),
            note[item.id] ? h('span', { className: 'dn-rowMeta', role: 'status' }, note[item.id]) : null,
            h('div', { className: 'dn-questionActions' },
              ...(item.choices ?? []).map(choice => h(Button, {
                key: choice.id,
                kind: choice.kind === 'reject' ? 'default' : 'primary',
                disabled: busy,
                onClick: () => run(item, choice),
              }, choice.label)))))
      }))
    }

    // 顶部浅色提示：不是永久导航，只在有待处理时出现，点开进入待处理页。
    function PendingBanner({ count, onOpen, t }) {
      return h('button', { type: 'button', className: 'dn-pendingBanner', onClick: onOpen },
        h('span', { className: 'dn-pendingMark', 'aria-hidden': true }, '!'),
        h('span', { className: 'dn-pendingText' }, `${t('pendingBannerTitle')} · ${count}`),
        h('span', { className: 'dn-pendingGo' }, t('pendingBannerView')))
    }

    // 待处理页：从顶部提示进入，可返回「通知与私聊」主页。
    function PendingPage({ controller, state, t }) {
      const items = state.native?.pending ?? []
      return h('div', { className: 'dn-privatePage' },
        h('div', { className: 'dn-detailBack' },
          h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'native' }) }, `← ${t('back')}`)),
        h('h2', { className: 'dn-pageTitle' }, t('pendingBannerTitle')),
        h(PendingList, { controller, state, items, t }))
    }

    // v0.15（Stage 1 / S4）：私聊页。只保留三个用户概念：确认是你 / 当前任务 / 使用者。
    // 首次启用是三步向导（确认本人 → 选择任务 → 试用）；可以用了之后只显示当前渠道、当前任务、
    // 使用者与「关闭私聊」。待处理项不在这里常驻——它们从顶部提示进入。
    function PrivateChatPanel({ controller, state, t }) {
      const native = state.native
      const [minted, setMinted] = useState(null)
      const [picked, setPicked] = useState(null)
      const [selectedOwnerId, setSelectedOwnerId] = useState(null)
      const [showTry, setShowTry] = useState(false)
      const [closing, setClosing] = useState(false)
      const back = h('div', { className: 'dn-detailBack' },
        h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'native' }) }, `← ${t('back')}`))
      if (native === null) {
        return h('div', { className: 'dn-privatePage' }, back,
          h('p', { className: 'dn-inlineStatus' }, h(StateDot, { state: 'ongoing' }), t('loading')))
      }
      const pc = native.privateChat ?? null
      if (pc === null || pc.enabled !== true) {
        return h('div', { className: 'dn-privatePage' }, back,
          h('h2', { className: 'dn-pageTitle' }, t('privateSetupTitle')),
          h('p', { className: 'dn-empty' }, t('overviewPrivateOff')))
      }
      const setup = pc.setup ?? { step: 'confirm', pendingIdentities: [], tasks: [] }
      const users = pc.users ?? []
      const owners = setup.owners ?? []
      const activeOwnerId = selectedOwnerId ?? (owners.length === 1 ? owners[0].id : null)
      const channelType = pc.channel ? String(pc.channel.id).split(':')[0] : null

      const mint = () => {
        void Promise.resolve(controller.nativeMintPairing())
          .then(value => { if (value?.code) setMinted(value.code) })
          .catch(error => controller.reportError(error))
      }
      const pickTask = (task) => {
        if (activeOwnerId === null) return
        void controller.nativeSelectTask(task.id, activeOwnerId)
          .then(() => { setSelectedOwnerId(activeOwnerId); setPicked(task); setShowTry(true) })
          .catch(error => controller.reportError(error))
      }
      const closePrivate = () => {
        if (channelType === null) return
        void Promise.resolve(controller.nativeClosePrivateChat(channelType))
          .then(() => { setClosing(false); controller.navigate({ kind: 'native' }) })
          .catch(error => { setClosing(false); controller.reportError(error) })
      }

      // 步骤条：确认本人 → 选择任务 → 试用。当前步之前/当前高亮，之后灰。
      const stepOrder = ['confirm', 'task', 'try']
      const activeStep = setup.step === 'ready' ? 'try' : setup.step
      const steps = h('ol', { className: 'dn-steps' },
        ...[['confirm', 'privateStepConfirm'], ['task', 'privateStepTask'], ['try', 'privateStepTry']].map(([id, key]) => h('li', {
          key: id, className: `dn-step ${id === activeStep ? 'is-active' : ''} ${stepOrder.indexOf(id) < stepOrder.indexOf(activeStep) ? 'is-done' : ''}`,
        }, t(key))))

      return h('div', { className: 'dn-privatePage' }, back,
        h('h2', { className: 'dn-pageTitle' }, setup.step === 'ready' ? t('privateReadyTitle') : t('privateSetupTitle')),
        pc.reconfigurationRequired === true
          ? h('p', { className: 'dn-note', role: 'status' }, t('reconfigureNotice'))
          : null,
        steps,
        // 第一步：确认是你。
        h(Section, { title: t('privateStepConfirm') },
          setup.pendingIdentities.length > 0
            ? h('div', { className: 'dn-list' }, ...setup.pendingIdentities.map(identity => h('div', {
                key: identity.id, className: 'dn-row',
              },
                h('span', { className: 'dn-rowMain' },
                  h('strong', { className: 'dn-rowTitle' }, identity.displayName),
                  h('span', { className: 'dn-rowMeta' }, identity.sourceText)),
                h('span', { className: 'dn-rowAside' },
                  h(Button, {
                    kind: 'primary',
                    disabled: state?.busy?.[`pending:${identity.id}`] === true,
                    onClick: () => void controller.nativeApproveUser(identity.id).catch(error => controller.reportError(error)),
                  }, t('privateConfirmPendingTitle')),
                  h(Button, {
                    disabled: state?.busy?.[`pending:${identity.id}`] === true,
                    onClick: () => void controller.nativeDismissUser(identity.id).catch(error => controller.reportError(error)),
                  }, t('pendingIgnore'))))))
            : h('div', null,
                h('p', { className: 'dn-note' }, t('privateConfirmHint')),
                h('p', { className: 'dn-empty' }, t('privateConfirmWaiting')),
                minted
                  ? h('div', { className: 'dn-codeBox' },
                      h('span', { className: 'dn-rowMeta' }, t('privateConfirmCodeHint')),
                      h('strong', { className: 'dn-code' }, minted))
                  : h('div', { className: 'dn-formActions' },
                      h(Button, { onClick: mint }, t('privateConfirmMint'))))),
        // 第二步：选择任务。
        h(Section, { title: t('privateStepTask') },
          owners.length > 1
            ? h('div', { className: 'dn-list' },
                h('p', { className: 'dn-note' }, t('privateSelectOwner')),
                ...owners.map(owner => h('button', {
                  key: owner.id,
                  type: 'button',
                  className: `dn-row dn-rowButton ${activeOwnerId === owner.id ? 'is-current' : ''}`,
                  'aria-pressed': activeOwnerId === owner.id,
                  onClick: () => setSelectedOwnerId(owner.id),
                },
                  h('span', { className: 'dn-rowMain' },
                    h('strong', { className: 'dn-rowTitle' }, owner.displayName),
                    h('span', { className: 'dn-rowMeta' }, owner.channelName)),
                  owner.currentTask ? h('span', { className: 'dn-rowAside' }, owner.currentTask.title) : null)))
            : null,
          setup.tasks.length > 0
            ? h('div', null,
                h('p', { className: 'dn-note' }, t('privateTaskHint')),
                h('div', { className: 'dn-list' }, ...setup.tasks.map(task => h('div', {
                  key: task.id, className: 'dn-row',
                },
                  h('span', { className: 'dn-rowMain' }, h('strong', { className: 'dn-rowTitle' }, task.title)),
                  h('span', { className: 'dn-rowAside' },
                    h(Button, { disabled: owners.length > 1 && activeOwnerId === null, onClick: () => pickTask(task) }, t('privateTaskUse')))))))
            : h('p', { className: 'dn-empty' }, t('privateTaskEmpty'))),
        // 第三步：试用。
        h(Section, { title: t('privateStepTry') },
          h('p', { className: 'dn-note' }, t('privateTryHint')),
          h('p', { className: 'dn-tryWord' }, `「${t('privateTryWord')}」`),
          h('div', { className: 'dn-formActions' },
            h(Button, { kind: 'primary', onClick: () => controller.navigate({ kind: 'native' }) }, t('privateFinish')))),
        // 可以用了：当前渠道 / 当前任务 / 使用者。
        setup.step === 'ready'
          ? h(Section, { title: t('privateCurrentChannel') },
              h('div', { className: 'dn-list' },
                owners.length > 1
                  ? h('div', { className: 'dn-list' }, ...owners.map(owner => h('div', { key: owner.id, className: 'dn-row' },
                      h('span', { className: 'dn-rowMain' },
                        h('strong', { className: 'dn-rowTitle' }, owner.displayName),
                        h('span', { className: 'dn-rowMeta' }, owner.channelName)))))
                  : pc.channel
                  ? h('div', { className: 'dn-row' },
                      h(ChannelLogo, { brand: brandRowOf(native.channels, pc.channel.id)?.brand, name: pc.channel.name, size: 28 }),
                      h('span', { className: 'dn-rowMain' },
                        h('strong', { className: 'dn-rowTitle' }, pc.channel.name),
                        h('span', { className: 'dn-rowMeta' }, pc.verifiedText)))
                  : h('p', { className: 'dn-empty' }, t('privateNoChannel')),
                owners.length > 1
                  ? h('div', { className: 'dn-list' }, ...owners.map(owner => h('div', { key: owner.id, className: 'dn-row' },
                      h('span', { className: 'dn-rowMain' },
                        h('strong', { className: 'dn-rowTitle' }, owner.displayName),
                        h('span', { className: 'dn-rowMeta' }, owner.currentTask?.title ?? t('privateNoTask'))))))
                  : h('div', { className: 'dn-row' },
                      h('span', { className: 'dn-rowMain' },
                        h('strong', { className: 'dn-rowTitle' }, (picked ?? pc.currentTask)?.title ?? t('privateNoTask')),
                        h('span', { className: 'dn-rowMeta' }, t('currentTask')))),
                h('div', { className: 'dn-row' },
                  h('span', { className: 'dn-rowMain' },
                    h('strong', { className: 'dn-rowTitle' }, String(users.length)),
                    h('span', { className: 'dn-rowMeta' }, t('privatePeople'))))),
              h('div', { className: 'dn-formActions' },
                closing
                  ? h('div', { className: 'dn-leaveGuard', role: 'alertdialog', 'aria-label': t('privateCloseConfirm') },
                      h('strong', null, t('privateCloseConfirm')),
                      h('div', { className: 'dn-formActions' },
                        h(Button, { onClick: () => setClosing(false) }, t('privateCloseStay')),
                        h(Button, { kind: 'danger', onClick: closePrivate }, t('privateClose'))))
                  : h(Button, { kind: 'danger', onClick: () => setClosing(true) }, t('privateClose'))))
          : null,
        // 首次向导：选择任务后可直接进入试用（不等服务端 ready）。
        showTry && setup.step !== 'ready'
          ? h('p', { className: 'dn-successText' }, `${t('privateStepTry')} · ${(picked ?? {}).title ?? ''}`)
          : null)
    }

    function Overview({ controller, state, native, t, onOpenChannel, onAdd }) {
      if (native === null) {
        return h('p', { className: 'dn-inlineStatus' }, h(StateDot, { state: 'ongoing' }), t('loading'))
      }
      const rail = native.rail ?? []
      if (rail.length === 0) {
        return h('div', { className: 'dn-emptyState' },
          native.setup?.reconfigurationRequired === true
            ? h('div', { className: 'dn-note', role: 'status' },
                h('strong', null, t('reconfigureStateTitle')),
                h('p', null, t('reconfigureStateSteps')),
                h(Button, { kind: 'primary', onClick: onAdd }, t('pickerTitle')))
            : null,
          h('strong', null, t('noChannels')),
          h('span', null, t('noChannelsHint')))
      }
      const notifyRows = (native.channels ?? []).filter(row => row.notifyEnabled === true)
      const pc = native.privateChat ?? null
      // 待处理不是永久导航：只在有待处理时于主页顶部给一条浅色提示，点击进入待处理页。
      const pendingCount = (native.pending ?? []).length
      return h('div', null,
        native.setup?.reconfigurationRequired === true
          ? h('div', { className: 'dn-note', role: 'status' },
              h('strong', null, t('reconfigureStateTitle')),
              h('p', null, t('reconfigureStateSteps')))
          : null,
        pendingCount > 0
          ? h(PendingBanner, {
              count: pendingCount,
              onOpen: () => controller.navigate({ kind: 'native-pending' }),
              t,
            })
          : null,
        h(Section, { title: t('overviewNotify') },
          notifyRows.length > 0
            ? h('div', { className: 'dn-list' }, ...notifyRows.map(row => h('button', {
                key: row.id, type: 'button', className: 'dn-row dn-rowButton', onClick: () => onOpenChannel(row.id),
              },
                h(ChannelLogo, { brand: row.brand, name: row.name, size: 28 }),
                h('span', { className: 'dn-rowMain' },
                  h('strong', { className: 'dn-rowTitle' }, row.name),
                  h('span', { className: 'dn-rowMeta' }, row.usage)),
                h('span', { className: 'dn-rowAside' }, h('span', { className: 'dn-badge' }, row.stateText)))))
            : h('p', { className: 'dn-empty' }, t('overviewNotifyEmpty'))),
        h(Section, { title: t('overviewPrivate') },
          h('div', null,
            pc?.enabled === true
              ? h('div', { className: 'dn-list' },
                  pc.channel
                    ? h('div', { className: 'dn-row' },
                        h(ChannelLogo, { brand: brandRowOf(native.channels, pc.channel.id)?.brand, name: pc.channel.name, size: 28 }),
                        h('span', { className: 'dn-rowMain' },
                          h('strong', { className: 'dn-rowTitle' }, pc.channel.name),
                          h('span', { className: 'dn-rowMeta' }, pc.verifiedText)))
                    : null,
                  pc.currentTask
                    ? h('div', { className: 'dn-row' },
                        h('span', { className: 'dn-rowMain' },
                          h('strong', { className: 'dn-rowTitle' }, pc.currentTask.title),
                          h('span', { className: 'dn-rowMeta' }, t('currentTask'))))
                    : null,
                  h('div', { className: 'dn-row' },
                    h('span', { className: 'dn-rowMain' },
                      h('strong', { className: 'dn-rowTitle' }, String((pc.users ?? []).length)),
                      h('span', { className: 'dn-rowMeta' }, t('usersLabel')))))
              : h('p', { className: 'dn-empty' }, t('overviewPrivateOff')),
            // 私聊没开启时不给死胡同页：直接引导去添加/配置一个支持私聊的渠道。
            pc?.enabled === true
              ? h('div', { className: 'dn-formActions' },
                  h(Button, { onClick: () => controller.navigate({ kind: 'native-private' }) },
                    pc.verified === true ? t('privateView') : t('privateOpen')))
              : h('div', { className: 'dn-formActions' },
                  h(Button, { onClick: onAdd }, t('pickerTitle'))))))
    }

    // v0.15（Stage 1 / S3）：账号卡里的一个方向表单（出站通知 / 入站私聊）。
    //
    // 字段以**数组**形状来自 read-model（secret 只有 presence，没有值），这里适配成 SchemaField 的
    // meta 形状。secret 三态仍是 保留 / 替换 / 清除——空串既不表示保留也不表示清除（由 authority 判定）。
    // 组件是**模块级稳定**的：轮询刷新时输入节点不 remount，连续输入不丢焦点（U05）。
    function NativeDirectionForm({ ctx, controller, state, t, type, direction, fields, values, revision, canTest, enabled, configured, hiddenKeys = [], importDraft = null }) {
      const hidden = new Set(hiddenKeys)
      const visible = (fields ?? []).filter(field => !hidden.has(field.key))
      const fieldsByKey = useMemo(
        () => Object.fromEntries((fields ?? []).map(field => [field.key, field])),
        [fields],
      )
      const draft = Object.fromEntries(Object.entries(importDraft ?? {}).filter(([k]) => fieldsByKey[k]?.secret !== true))
      const [patch, setPatch] = useState(draft)
      const [dirty, setDirty] = useState(new Set(Object.keys(draft)))
      const [secretModes, setSecretModes] = useState({})
      const [notice, setNotice] = useState(null)
      const [outcome, setOutcome] = useState(null)
      const dirtyRef = useRef(dirty)
      const revisionRef = useRef(FORM_SENTINEL)

      // revision 变化时把**未编辑**字段同步到最新投影；dirty 字段保留本地草稿。
      useEffect(() => {
        if (revisionRef.current === revision) return
        revisionRef.current = revision
        setPatch(current => {
          const next = { ...current }
          for (const [key, value] of Object.entries(values ?? {})) {
            if (!dirtyRef.current.has(key)) next[key] = value
          }
          return next
        })
      }, [revision])

      const markDirty = (key, on) => {
        setDirty(current => {
          const next = new Set(current)
          if (on) next.add(key); else next.delete(key)
          dirtyRef.current = next
          return next
        })
      }
      const setField = (key, value) => { markDirty(key, true); setPatch(current => ({ ...current, [key]: value })) }
      const setSecretMode = (key, mode) => {
        setSecretModes(current => ({ ...current, [key]: mode }))
        markDirty(key, mode !== 'keep')
        if (mode !== 'replace') {
          setPatch(current => {
            if (!Object.prototype.hasOwnProperty.call(current, key)) return current
            const next = { ...current }; delete next[key]; return next
          })
        }
      }

      const saveBusy = state?.busy?.[`save:${type}:${direction}`] === true
      const testBusy = state?.busy?.[`test:${type}`] === true
      const privateBusy = state?.busy?.[`private-chat:${type}`] === true
      const hasDirty = dirty.size > 0

      const save = async () => {
        const payload = {}
        const clearSecrets = []
        for (const key of dirty) {
          // secret 显式「清除」→ 走 clearSecrets；绝不把掩码或旧值当值写回。
          if (fieldsByKey[key]?.secret === true && (secretModes[key] ?? 'keep') === 'clear') { clearSecrets.push(key); continue }
          payload[key] = patch[key]
        }
        if (Object.keys(payload).length === 0 && clearSecrets.length === 0) return
        setNotice(null)
        try {
          const receipt = await controller.nativeSaveChannel(type, direction, payload, clearSecrets)
          if (receipt?.duplicate === true) return
          if (receipt?.saved !== false) {
            setPatch(current => {
              const next = { ...current }
              for (const key of Object.keys(payload)) if (fieldsByKey[key]?.secret === true) delete next[key]
              for (const key of clearSecrets) delete next[key]
              return next
            })
            setSecretModes({})
            const empty = new Set()
            dirtyRef.current = empty
            setDirty(empty)
            setNotice(receipt?.refreshed === false
              ? { kind: 'warn', text: t('savedRefreshFailed') }
              : { kind: 'ok', text: t('accountSaved') })
          }
        } catch (error) {
          // 落盘/校验失败：草稿保留，错误经统一出口展示。
          controller.reportError(error)
        }
      }

      const runTest = () => {
        void controller.nativeTestChannel(type).then(result => {
          if (result === null) return
          setOutcome(result)
        }).catch(error => controller.reportError(error))
      }

      const togglePrivateChat = () => {
        void controller.nativeSetPrivateChatEnabled(type, enabled !== true)
          .then(receipt => {
            if (receipt?.needsRestart === true) setNotice({ kind: 'warn', text: t('privateRestart') })
          })
          .catch(error => controller.reportError(error))
      }

      const metaOf = (field) => ({
        required: field.required,
        secret: field.secret,
        exposure: field.secret ? 'secret' : 'public',
        type: field.type,
        ...(Array.isArray(field.options) ? { options: field.options } : {}),
        configured: field.present,
        label: { zh: field.label, en: field.label },
        ...(field.help ? { description: { zh: field.help, en: field.help } } : {}),
      })

      return h('div', { className: 'dn-accountForm' },
        visible.length > 0
          ? visible.map(field => h(SchemaField, {
              key: field.key, ctx, name: field.key, meta: metaOf(field),
              value: patch[field.key],
              onChange: value => setField(field.key, value),
              secretMode: secretModes[field.key],
              onSecretMode: mode => setSecretMode(field.key, mode),
              t,
            }))
          : h('p', { className: 'dn-note' }, t('accountNoFields')),
        h('div', { className: 'dn-formActions' },
          h(Button, {
            kind: 'primary', disabled: saveBusy || !hasDirty,
            onClick: () => void save(),
          }, saveBusy ? t('saving') : t('save')),
          direction === 'outbound' && canTest === true
            ? h(Button, {
                // 只测已保存配置；有未保存修改时先保存，绝不静默 save+send。
                disabled: testBusy || hasDirty,
                title: hasDirty ? t('unsavedChangesHint') : t('testCommittedConfig'),
                onClick: runTest,
              }, testBusy ? t('testing') : t('test'))
            : null,
          direction === 'inbound'
            ? h(Button, {
                disabled: privateBusy || hasDirty || (enabled !== true && configured !== true),
                onClick: togglePrivateChat,
              }, privateBusy ? t('saving') : enabled === true ? t('privateDisable') : t('privateEnable'))
            : null),
        direction === 'outbound' && hasDirty ? h('p', { className: 'dn-note' }, t('unsavedChangesHint')) : null,
        notice
          ? h('p', {
              className: notice.kind === 'ok' ? 'dn-successText' : 'dn-error',
              role: notice.kind === 'ok' ? 'status' : 'alert', 'aria-live': 'polite',
            }, notice.text)
          : null,
        outcome
          ? h('p', {
              className: outcome.kind === 'confirmed' || outcome.kind === 'sent' ? 'dn-successText' : outcome.kind === 'failed' ? 'dn-error' : 'dn-note',
              role: 'status', 'aria-live': 'polite',
            }, `${outcome.title} · ${outcome.message}`)
          : null)
    }

    // Telegram 备用连接：默认不铺大段解释；连接失败或用户主动展开「连接帮助」时才出现。
    function ConnectionHelp({ controller, t, disabled, onCustom }) {
      return h('div', { className: 'dn-connHelp' },
        h('p', { className: 'dn-note' }, t('connectionHelpHint')),
        h('div', { className: 'dn-formActions' },
          h(Button, {
            disabled,
            onClick: () => controller.navigate({ kind: 'cloudflare', type: 'telegram', activate: true }),
          }, t('telegramAutoFallback')),
          h(Button, { disabled, onClick: onCustom }, t('telegramCustomAddress'))))
    }

    // 账号卡：多账号时每条一卡，默认折叠；展开后按「基础设置 / 通知 / 私聊 / 更多设置」分段。
    function AccountCard({ ctx, controller, state, account, type, revision, t }) {
      const requiredFields = account.basicFields ?? []
      const optionalFields = account.moreFields ?? []
      const allFields = account.setupFields ?? []
      // 没有必填字段时，「基础设置」直接放全部字段，避免出现空区块。
      const basicFields = requiredFields.length > 0 ? requiredFields : allFields
      const moreFields = requiredFields.length > 0 ? optionalFields : []
      const hasMore = moreFields.length > 0
      const telegram = type === 'telegram'
      // Telegram 备用连接只在「连接出问题」或用户主动展开时出现。
      const helpNeeded = telegram && account.state === 'needs-attention'
      const [open, setOpen] = useState(state.view?.importDraft !== undefined)
      const [moreOpen, setMoreOpen] = useState(false)
      const [helpOpen, setHelpOpen] = useState(false)
      const [customAddress, setCustomAddress] = useState(false)
      const showHelp = telegram && (helpNeeded || helpOpen)
      const showMore = open && hasMore && (moreOpen || helpNeeded)
      const saveBusy = state?.busy?.[`save:${type}:outbound`] === true
      const toggleLabel = open ? t('accountCollapse') : t('accountExpand')

      return h('article', { className: `dn-accountCard ${open ? 'is-open' : ''}` },
        h('div', { className: 'dn-accountHead' },
          h('div', { className: 'dn-accountMain' },
            h('strong', { className: 'dn-rowTitle' }, account.displayName),
            account.maskedIdentity ? h('span', { className: 'dn-rowMeta' }, account.maskedIdentity) : null),
          h('span', { className: 'dn-badge' }, account.stateText),
          h(Button, {
            className: 'dn-accountToggle',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': `${toggleLabel} · ${account.displayName}`,
            onClick: () => setOpen(value => !value),
          }, open ? `${t('accountCollapse')} ▴` : `${t('accountMore')} ▾`)),
        h('div', { className: 'dn-accountTags' },
          account.notify?.enabled === true ? h('span', { className: 'dn-tag' }, t('overviewNotify')) : null,
          account.privateChat?.enabled === true ? h('span', { className: 'dn-tag' }, t('overviewPrivate')) : null),
        open
          ? h('div', { className: 'dn-accountBody' },
              h(Section, { title: t('accountBasic') },
                h(NativeDirectionForm, {
                  ctx, controller, state, t, type, direction: 'outbound',
                  fields: basicFields, values: account.notify?.values ?? {},
                  importDraft: state.view?.importDirection === 'outbound' ? state.view.importDraft : null,
                  revision, canTest: account.notify?.canTest === true,
                })),
              showMore
                ? h(Section, { title: t('accountMore') },
                    h(NativeDirectionForm, {
                      ctx, controller, state, t, type, direction: 'outbound',
                      fields: moreFields, values: account.notify?.values ?? {},
                      revision, canTest: account.notify?.canTest === true,
                      hiddenKeys: telegram && !customAddress ? ['apiBase', 'gatewayKey'] : [],
                    }))
                : hasMore
                  ? h('div', { className: 'dn-formActions' },
                      h(Button, { onClick: () => setMoreOpen(true) }, `${t('accountMore')} ▾`))
                  : null,
              telegram
                ? (showHelp
                    ? h(ConnectionHelp, {
                        controller, t, disabled: saveBusy,
                        onCustom: () => { setCustomAddress(true); setMoreOpen(true) },
                      })
                    : h('div', { className: 'dn-formActions' },
                        h(Button, { onClick: () => setHelpOpen(true) }, t('connectionHelp'))))
                : null,
              account.privateChat !== undefined
                ? h(Section, { title: t('overviewPrivate') },
                    h(NativeDirectionForm, {
                      ctx, controller, state, t, type, direction: 'inbound',
                      fields: account.privateChat.fields ?? [],
                      values: account.privateChat.values ?? {},
                      enabled: account.privateChat.enabled === true,
                      configured: account.privateChat.configured === true,
                      importDraft: state.view?.importDirection === 'inbound' ? state.view.importDraft : null,
                      revision,
                    }))
                : null)
          : null)
    }

    function ChannelPage({ ctx, controller, state, detail, type, revision, t, onOpen }) {
      if (detail === null) {
        return h('p', { className: 'dn-inlineStatus' }, h(StateDot, { state: 'ongoing' }), t('loading'))
      }
      const row = detail.channel
      const accounts = detail.accounts ?? []
      return h('div', { className: 'dn-channelPage' },
        h('header', { className: 'dn-channelHead' },
          h(ChannelLogo, { brand: row.brand, name: row.name, size: 40 }),
          h('div', { className: 'dn-channelHeadMain' },
            h('h2', { className: 'dn-channelName' }, row.name),
            h('span', { className: 'dn-channelUsage' }, row.usage)),
          h('span', { className: 'dn-badge' }, row.stateText)),
        // read-model 保证每个渠道至少一个 default 账号，这里直接逐卡渲染。
        accounts.map(account => h(AccountCard, {
          key: account.id, ctx, controller, state, account, type, revision, t,
        })))
    }

    // 添加渠道：不把全部渠道常驻左侧；picker 里按「常用 / 其他通知方式」分组，每条一句用途。
    function ChannelPicker({ channels, onClose, onPick, t }) {
      const [query, setQuery] = useState('')
      const needle = query.trim().toLowerCase()
      const match = (row) => needle === ''
        || String(row.name ?? '').toLowerCase().includes(needle)
        || String(row.usage ?? '').toLowerCase().includes(needle)
      const groups = [['common', t('pickerCommon')], ['other', t('pickerOther')]]
      const visible = channels.filter(match)
      return h('div', {
        className: 'dn-pickerOverlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('pickerTitle'),
      },
        h('div', { className: 'dn-picker' },
          h('div', { className: 'dn-pickerHead' },
            h('h2', { className: 'dn-pickerTitle' }, t('pickerTitle')),
            h('button', { type: 'button', className: 'dn-link', onClick: onClose }, t('pickerClose'))),
          h('label', { className: 'dn-field' },
            h('span', { className: 'dn-pickerGroup' }, t('pickerSearch')),
            h('input', {
              type: 'search', value: query, placeholder: t('pickerSearch'), 'aria-label': t('pickerSearch'),
              onChange: event => setQuery(event.target.value),
            })),
          ...groups.map(([group, label]) => {
            const rows = channels.filter(row => row.group === group && match(row))
            if (rows.length === 0) return null
            return h('div', { key: group },
              h('p', { className: 'dn-pickerGroup' }, label),
              h('div', { className: 'dn-channelPicker' }, ...rows.map(row => h('button', {
                key: row.id, type: 'button', className: 'dn-pickerItem', 'data-channel': row.id,
                onClick: () => onPick(row.id),
              },
                h(ChannelLogo, { brand: row.brand, name: row.name, size: 28 }),
                h('span', { className: 'dn-pickerMain' },
                  h('span', { className: 'dn-pickerName' }, row.name),
                  h('span', { className: 'dn-pickerUsage' }, row.usage)),
                row.state !== 'not-set' ? h('span', { className: 'dn-pickerAdded' }, t('pickerAdded')) : null))))
          }),
          visible.length === 0 ? h('p', { className: 'dn-empty' }, t('pickerEmpty')) : null))
    }

    // 唯一用户页面：通知与私聊。
    function NotifierSettings({ ctx, controller, state, t }) {
      const view = state.view
      const kind = view.kind
      const type = kind === 'native-channel' ? view.type : null
      const [pickerOpen, setPickerOpen] = useState(view.picker === true)

      useEffect(() => {
        if (kind === 'native-channel') {
          void controller.loadNativeChannel(type).catch(error => controller.reportError(error))
          // 深链直达某个渠道时，快照还没拉过——补一次，左侧渠道栏才有内容。
          if (state.native === null) void controller.loadNative().catch(error => controller.reportError(error))
        } else void controller.loadNative().catch(error => controller.reportError(error))
      }, [kind, type])

      // 从「设置第一个渠道」等入口带 picker 意图进入时，自动打开添加渠道选择器。
      useEffect(() => {
        if (view.picker === true) setPickerOpen(true)
      }, [view.picker])

      const native = state.native
      const rail = native?.rail ?? []
      const selected = type ?? 'all'
      const onSelect = (id) => controller.navigate(id === 'all' ? { kind: 'native' } : { kind: 'native-channel', type: id })
      // 概览里的渠道行也留在 Native v2 外壳内（账号卡），不再跳到旧的渠道详情页。
      const openChannel = (id) => controller.navigate({ kind: 'native-channel', type: id })
      const openPicker = () => setPickerOpen(true)

      return h('div', { className: 'dn-settings' },
        h(ProductHeader, { t, onAdd: openPicker, actions: h(MoreMenu, { controller, t }) }),
        native === null && state.error
          ? h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.refreshCurrent() })
          : null,
        state.connectionState === 'stale'
          ? h('p', { className: 'dn-error', role: 'status' }, t('staleData'))
          : state.connectionState === 'disconnected'
            ? h('p', { className: 'dn-error', role: 'alert' }, t('connectionLost'))
            : null,
        h('div', { className: 'dn-workspace' },
          h(ChannelRail, { items: rail, selected, onSelect, onAdd: openPicker, t }),
          h('div', { className: 'dn-railDivider', 'aria-hidden': true }),
          h('div', { className: 'dn-content' },
            h(ChannelStrip, { items: rail, selected, onSelect, onAdd: openPicker, t }),
            h(ChannelTopSelector, { items: rail, selected, onSelect, onAdd: openPicker, t }),
            // 私聊页与待处理页与主页共用同一份 native 快照，不占永久导航——从主页按钮 / 顶部提示进入。
            kind === 'native-private'
              ? h(PrivateChatPanel, { controller, state, t })
              : kind === 'native-pending'
                ? h(PendingPage, { controller, state, t })
                : type === null
                  ? h(Overview, { controller, state, native, t, onOpenChannel: openChannel, onAdd: openPicker })
                  // 切渠道时旧详情可能还在快照里；只渲染与当前 type 匹配的详情，避免串台。
                  : h(ChannelPage, {
                      ctx, controller, state, t,
                      detail: state.nativeChannel?.channel?.id === type ? state.nativeChannel : null,
                      type, revision: native?.cursor ?? null,
                    }))),
        pickerOpen
          ? h(ChannelPicker, {
              channels: native?.channels ?? [],
              onClose: () => setPickerOpen(false),
              onPick: (id) => { setPickerOpen(false); controller.navigate({ kind: 'native-channel', type: id }) },
              t,
            })
          : null)
    }

    // v0.15（T18 / U03 / U12）：保存与测试解耦——保存成立后即可「完成」，测试完全可选；
    // 测试只针对**已保存**的配置（绝不静默 save+send）；测试失败/无法确认不会困住用户。

    // v0.14（Stage E / P1-10）：Session Detail。只做投影与「写入口」编排——路由写权威在
    // agent-router、控制归一在 session-arbiter、生命周期在 session-registry，本视图不另造 authority。



    // v0.15（Stage 1 / S5）：帮助页。只讲用户能做的动作（现象 → 做什么），
    // 不再暴露 Host / Storage / Capabilities 等运行时细节；需要深入时生成一份不含密钥的摘要。
    function HelpView({ ctx, controller, state, t }) {
      const [report, setReport] = useState(null)
      const busy = state.busy['diagnostics:report'] === true
      const onGenerate = () => {
        void controller.generateSupportReport()
          .then(result => setReport(result ?? null))
          .catch(error => controller.reportError(error))
      }
      const back = h('div', { className: 'dn-detailBack' },
        h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'native' }) }, `← ${t('back')}`))
      const tips = [
        ['helpTipPhone', 'helpTipPhoneBody'],
        ['helpTipConnect', 'helpTipConnectBody'],
        ['helpTipReply', 'helpTipReplyBody'],
        ['helpTipRestart', 'helpTipRestartBody'],
      ]
      return h('div', { className: 'dn-page' }, back,
        h(PageHead, { title: t('helpTitle'), intro: t('helpIntro') }),
        h(Section, { title: t('helpTitle') },
          h('div', { className: 'dn-list' }, ...tips.map(([titleKey, bodyKey]) => h('div', {
            key: titleKey, className: 'dn-row',
          },
            h('span', { className: 'dn-rowMain' },
              h('strong', { className: 'dn-rowTitle' }, t(titleKey)),
              h('span', { className: 'dn-rowMeta' }, t(bodyKey))))))),
        h(Section, { title: t('supportReport') },
          h('p', { className: 'dn-note' }, t('reportIntro')),
          h('p', { className: 'dn-note' }, t('reportNotBackup')),
          h('div', { className: 'dn-formActions' },
            h(Button, { kind: 'primary', disabled: busy, onClick: onGenerate }, t('generateReport'))),
          report
            ? h('p', { className: 'dn-note', role: 'status' },
                report.type === 'copied' ? t('copiedOk')
                  : report.type === 'downloaded' ? t('downloadedOk')
                    : t('copyFailedDownload'))
            : null))
    }

    // v0.15（Stage 1 / S5）：通知总览。低频入口，只复用既有 authority——测试走 native.testChannel，
    // 设置跳回渠道页；不新增写路径、不改通知模型，也不把通知开/关做成破坏性删除。
    function NotifySettingsView({ ctx, controller, state, t }) {
      const native = state.native
      const [receipts, setReceipts] = useState({})
      const back = h('div', { className: 'dn-detailBack' },
        h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'native' }) }, `← ${t('back')}`))
      if (native === null) {
        return h('div', { className: 'dn-page' }, back,
          h(PageHead, { title: t('notifySettingsTitle'), intro: t('notifySettingsIntro') }),
          h('p', { className: 'dn-inlineStatus' }, h(StateDot, { state: 'ongoing' }), t('loading')))
      }
      const channels = (native.channels ?? []).filter(channel => channel?.canNotify === true)
      const runTest = (type) => {
        void controller.nativeTestChannel(type).then(result => {
          if (result === null) return
          setReceipts(current => ({ ...current, [type]: result }))
        }).catch(error => controller.reportError(error))
      }
      return h('div', { className: 'dn-page' }, back,
        h(PageHead, { title: t('notifySettingsTitle'), intro: t('notifySettingsIntro') }),
        channels.length === 0
          ? h('p', { className: 'dn-empty' }, t('notifySettingsEmpty'))
          : h('div', { className: 'dn-list' }, ...channels.map(channel => {
              const receipt = receipts[channel.id] ?? null
              return h('div', { key: channel.id, className: 'dn-row' },
                h(ChannelLogo, { brand: channel.brand, name: channel.name, size: 28 }),
                h('span', { className: 'dn-rowMain' },
                  h('strong', { className: 'dn-rowTitle' }, channel.name),
                  h('span', { className: 'dn-rowMeta' }, receipt ? receipt.message : channel.stateText)),
                h('span', { className: 'dn-rowAside' },
                  channel.notifyEnabled
                    ? h(Button, {
                        disabled: state?.busy?.[`test:${channel.id}`] === true,
                        onClick: () => runTest(channel.id),
                      }, t('test'))
                    : null,
                  h(Button, { onClick: () => controller.navigate({ kind: 'native-channel', type: channel.id }) }, t('notifySettingsOpen'))))
            })))
    }

    function MainPanel({ controller, ctx }) {
      const state = useController(controller)
      const t = useT(ctx)
      useEffect(() => {
        controller.startWait()
      }, [])
      // v0.15（Stage 1 / S2）：唯一用户页面「通知与私聊」。全部 / 某渠道都在这一页里切换，
      // 不再有 Home/Channels/Tasks/… 的多页 IA。S4 的私聊页与待处理页同属这一页，不占主导航。
      if (state.view.kind === 'native' || state.view.kind === 'native-channel'
        || state.view.kind === 'native-private' || state.view.kind === 'native-pending') {
        return h(NotifierSettings, { ctx, controller, state, t })
      }
      // v0.12.1（P1-12）：按渠道类型重建详情组件，避免草稿/测试结果跨渠道串台。
      // v0.15（Stage 1 / S5）：二级能力收口——通知总览 + 用户向帮助，全部从「更多」进入。
      if (state.view.kind === 'notify-settings') return h(NotifySettingsView, { ctx, controller, state, t })
      if (state.view.kind === 'help') return h(HelpView, { ctx, controller, state, t })
      if (state.view.kind === 'remote') return h(RemoteView, { ctx, controller, state, t })
      if (state.view.kind === 'portability') return h(PortabilityView, { ctx, controller, state, t })
      if (state.view.kind === 'cloudflare') return h(CloudflareView, { ctx, controller, state, t })
      // 兜底（含历史 `home` 视图）：单一用户页面。
      return h(NotifierSettings, { ctx, controller, state, t })
    }

    // v0.15（T24）：远程入口视图。URL 校验在后端（remote.validate，纯本地解析、零网络）；本视图
    // 只持有用户输入与校验结果，打开 / 复制是浏览器端动作。二维码不在此渲染——核心零强制依赖，
    // 且宿主当前未暴露浏览器端二维码能力，故只显示「与普通链接等价 / 不可用」提示（R04「服务能力缺失」）。
    function RemoteView({ ctx, controller, state, t }) {
      const [input, setInput] = useState('')
      const [entry, setEntry] = useState(null)
      const [localError, setLocalError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [copyState, setCopyState] = useState(null)

      const onChange = (event) => {
        setInput(event.target.value)
        setEntry(null)
        setLocalError(null)
        setCopyState(null)
      }
      const onGenerate = async () => {
        const text = input.trim()
        if (text === '') { setLocalError(null); return }
        setBusy(true)
        setLocalError(null)
        setEntry(null)
        try {
          setEntry(await controller.validateRemoteUrl(text))
        } catch (error) {
          setLocalError(error)
        } finally {
          setBusy(false)
        }
      }
      const onOpen = () => {
        if (!entry?.url) return
        const win = window.open(entry.url, '_blank', 'noopener,noreferrer')
        if (win) { try { win.opener = null } catch (error) { void error } }
      }
      const onCopy = () => {
        if (!entry?.url) return
        void copyText(entry.url).then(ok => setCopyState(ok ? 'copied' : 'unavailable'))
      }

      const back = h('div', { className: 'dn-detailBack' },
        h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'native' }) }, `← ${t('back')}`))

      return h('div', { className: 'dn-page' }, back,
        h(PageHead, { title: t('remoteEntry'), intro: t('remoteIntro') }),
        h('div', { className: 'dn-field' },
          h('label', null, t('remoteUrlLabel')),
          h('input', {
            type: 'url',
            value: input,
            placeholder: t('remoteUrlPlaceholder'),
            spellCheck: false,
            autoCapitalize: 'none',
            autoCorrect: 'off',
            'aria-label': t('remoteUrlLabel'),
            onChange,
            onKeyDown: (event) => { if (event.key === 'Enter') void onGenerate() },
          }),
          h('small', null, t('remoteNoSecret'))),
        h('div', { className: 'dn-formActions' },
          h(Button, { kind: 'primary', disabled: busy || input.trim() === '', onClick: onGenerate }, busy ? t('saving') : t('remoteGenerate'))),
        localError ? h('p', { className: 'dn-error', role: 'alert' }, localError.message || t('unknownError')) : null,
        entry ? h('div', { className: 'dn-code' },
          h('span', { className: 'dn-successText' }, t('remoteValid')),
          h('span', { className: 'dn-codeValue' }, entry.url),
          h('div', { className: 'dn-formActions' },
            h(Button, { kind: 'primary', onClick: onOpen }, t('remoteOpen')),
            h(Button, { onClick: onCopy }, t('remoteCopy'))),
          copyState === 'copied' ? h('span', { className: 'dn-note', role: 'status' }, t('remoteCopied'))
            : copyState === 'unavailable' ? h('span', { className: 'dn-note' }, t('remoteCopyUnavailable')) : null,
          h(Section, { title: t('remoteQrTitle') },
            entry.qrSupported === true
              ? h('p', { className: 'dn-note' }, t('remoteQrEquivalent'))
              : h('p', { className: 'dn-note' }, t('remoteQrUnavailable')))) : null,
        h('p', { className: 'dn-note' }, t('remoteHint')))
    }

    function PortabilityView({ ctx, controller, t }) {
      const [text, setText] = useState('')
      const [preview, setPreview] = useState(null)
      const [selected, setSelected] = useState({})
      const [readback, setReadback] = useState(null)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [fallback, setFallback] = useState(null)
      const token = useRef(null)
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        void controller.readImported().then(v => { if (alive.current) setReadback(v) }).catch(setError)
        return () => {
          alive.current = false
          if (token.current) void controller.cancelImport(token.current).catch(() => {})
        }
      }, [])
      const run = async action => {
        setBusy(true); setError(null)
        try { await action() } catch (e) { if (alive.current) setError(e) }
        finally { if (alive.current) setBusy(false) }
      }
      const cancel = async () => {
        if (token.current) await controller.cancelImport(token.current)
        token.current = null; setPreview(null); setSelected({})
      }
      const previewFile = () => run(async () => {
        await cancel()
        setResult(null)
        const v = await controller.previewImport(text)
        if (!alive.current) { await controller.cancelImport(v.token); return }
        token.current = v.token; setPreview(v)
        setSelected(Object.fromEntries(v.entries.map(e => [`${e.direction}:${e.type}`, e.selectedDefault === true])))
      })
      const commit = () => run(async () => {
        const selections = preview.entries.map(e => ({
          direction: e.direction, type: e.type,
          action: selected[`${e.direction}:${e.type}`] === true ? 'apply' : 'skip',
          fields: [...(e.changes?.added ?? []), ...(e.changes?.changed ?? [])],
        }))
        const v = await controller.commitImport(token.current, selections)
        token.current = null
        setResult(v); setPreview(null); setText('')
        // A committed import stays successful even if the read-back fails.
        try { setReadback(await controller.readImported()) } catch (e) { setError(e) }
      })
      const exportFile = () => run(async () => {
        const v = await controller.exportConfig()
        const content = JSON.stringify(v.document, null, 2)
        let url
        try {
          url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
          const a = document.createElement('a')
          a.href = url; a.download = v.filename
          document.body.appendChild(a); a.click(); a.remove()
          setFallback(null)
        } catch { setFallback(content) }
        finally { if (url) URL.revokeObjectURL(url) }
      })
      const chooseFile = event => {
        const file = event.target.files?.[0]
        if (!file) return
        void run(async () => {
          await cancel()
          if (file.size > 1024 * 1024) throw new Error('Max 1 MiB')
          const value = await file.text()
          if (alive.current) { setText(value); setResult(null) }
        })
      }
      const decisionKeys = { add: 'importAdd', patch: 'importPatch', conflict: 'importConflict', skip: 'importSkip', unsupported: 'importUnsupported' }
      return h('div', { className: 'dn-page' },
        h('button', { className: 'dn-link', disabled: busy, onClick: () => controller.navigate({ kind: 'native' }) }, `← ${t('back')}`),
        h(PageHead, { title: t('configTransfer'), intro: t('transferIntro'), actions: h(Button, { disabled: busy, onClick: exportFile }, t('exportConfig')) }),
        h('label', { className: 'dn-field' }, t('importConfig'), h('input', { type: 'file', accept: '.json,application/json', disabled: busy, onChange: chooseFile })),
        h('label', { className: 'dn-field' }, 'JSON', h('textarea', {
          rows: 6, value: text, disabled: busy || preview !== null, 'aria-label': 'JSON',
          onChange: e => { setText(e.target.value); setResult(null) },
        })),
        preview === null ? h(Button, { kind: 'primary', disabled: busy || !text.trim(), onClick: previewFile }, t('previewImport')) : null,
        error ? h('p', { role: 'alert', className: 'dn-error' }, error.message) : null,
        fallback !== null ? h('div', null, h('p', { role: 'status', className: 'dn-note' }, t('exportFailed')), h('textarea', { readOnly: true, rows: 8, value: fallback, 'aria-label': t('exportConfig') })) : null,
        preview ? h(Section, { title: t('previewImport') },
          ...preview.entries.map(e => {
            const id = `${e.direction}:${e.type}`
            return h('div', { className: 'dn-code', key: id },
              h('label', null, h('input', { type: 'checkbox', checked: selected[id] === true, disabled: busy || e.decision === 'unsupported' || e.decision === 'skip', 'aria-label': id, onChange: v => setSelected(s => ({ ...s, [id]: v.target.checked })) }), ` ${e.type} · ${t(e.direction === 'outbound' ? 'notify' : 'control')} · ${t(decisionKeys[e.decision])}`),
              h('span', { className: 'dn-note' }, `${t('importFields')}: ${[...(e.changes?.added ?? []), ...(e.changes?.changed ?? [])].join(', ') || '—'}`),
              e.missingCredentials?.length ? h('span', { className: 'dn-note' }, `${t('importMissing')}: ${e.missingCredentials.join(', ')}`) : null,
              ...[...(e.warnings ?? []), ...(e.machineSpecific ?? []).map(r => `${r.field}: ${r.name}`)].map((w, i) => h('span', { className: 'dn-note', key: i }, resolveText(ctx, w))))
          }),
          h('div', { className: 'dn-formActions' }, h(Button, { kind: 'primary', disabled: busy, onClick: commit }, t('confirmImport')), h(Button, { disabled: busy, onClick: () => run(cancel) }, t('cancelAction')))) : null,
        result ? h('div', { role: 'status', className: 'dn-code' }, h('strong', null, t('importDone')),
          ...result.results.map(r => h('span', { key: `${r.direction}:${r.type}` }, `${r.type} · ${r.action === 'staged' ? t('importStaged') : r.applied === false ? t('restartPending') : r.action === 'skipped' ? t('skipped') : t('savedOk')}`))) : null,
        h(Section, { title: t('importStaged') },
          readback === null ? h('p', { className: 'dn-note' }, t('loading')) : readback.staged?.length ? readback.staged.map(r => h('div', { className: 'dn-row', key: `${r.direction}:${r.type}` },
            h('span', { className: 'dn-rowMain' }, `${r.type} · ${t(r.direction === 'outbound' ? 'notify' : 'control')}`),
            h(Button, { disabled: busy, onClick: () => controller.navigate({ kind: 'native-channel', type: r.type === 'qq' ? 'qqbot' : r.type === 'wechat' ? 'weixin' : r.type, importDirection: r.direction, importDraft: r.config }) }, t('importConfigure')))) : h('p', { className: 'dn-note' }, t('importEmpty'))))
    }

    function TunnelSettings({ ctx, controller, data, disabled, onRead }) {
      const [values, setValues] = useState({ name: '', binary: '', credentialsSource: '', applicationId: '' })
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const words = (zh, en) => String(ctx?.locale?.current ?? 'zh').startsWith('en') ? en : zh
      const call = async method => {
        setBusy(true); setError(null)
        try {
          await controller.cloudCall(method, method === 'tunnelStart' ? { ...values, enabled: true, protected: true, access: { applicationId: values.applicationId } } : {})
          await onRead()
        } catch (e) { setError(e) } finally { setBusy(false) }
      }
      return h('details', { className: 'dn-detail' },
        h('summary', null, words('高级设置：连接已有隧道', 'Advanced: connect an existing tunnel')),
        h('p', { className: 'dn-note' }, words('使用已安装的 cloudflared 和已有命名隧道。先在 Cloudflare 设置访问保护。', 'Use your installed cloudflared and an existing named tunnel. Configure Cloudflare Access first.')),
        ...[['name', words('隧道名称', 'Tunnel name')], ['binary', words('cloudflared 完整路径', 'cloudflared full path')], ['credentialsSource', words('凭据文件完整路径', 'Credentials file full path')], ['applicationId', words('Access 应用 ID', 'Access application ID')]].map(([key, label]) => h('label', { key, className: 'dn-field' }, label, h('input', { 'aria-label': label, value: values[key], disabled: busy || disabled, onChange: e => setValues(current => ({ ...current, [key]: e.target.value })) }))),
        h('p', { role: 'status' }, data?.running ? words('已启动', 'Running') : words('未启动', 'Stopped')),
        error ? h('p', { role: 'alert', className: 'dn-error' }, error.message) : null,
        h('div', { className: 'dn-formActions' }, h(Button, { disabled: busy || disabled || data?.running, onClick: () => call('tunnelStart') }, words('保存并启动', 'Save and start')), h(Button, { disabled: busy, onClick: () => call('tunnelStop') }, words('停止', 'Stop'))))
    }

    function CloudflareView({ ctx, controller, state, t }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [account, setAccount] = useState('')
      const [type, setType] = useState(state?.view?.type ?? 'telegram')
      const [botToken, setBotToken] = useState('')
      const [barkKey, setBarkKey] = useState('')
      const [chatId, setChatId] = useState('')
      const [activate, setActivate] = useState(true)
      const [inbound, setInbound] = useState(false)
      const [enrollment, setEnrollment] = useState(false)
      const [receipt, setReceipt] = useState(null)
      const alive = useRef(true)
      const generation = useRef(0)
      const words = (zhText, enText) => String(ctx?.locale?.current ?? 'zh').startsWith('en') ? enText : zhText
      const read = async () => {
        const seq = ++generation.current
        try {
          const value = await controller.cloudCall('status')
          if (alive.current && generation.current === seq) {
            setData(value)
            setAccount(current => current || (value.accounts?.length === 1 ? value.accounts[0].id : ''))
          }
        } catch (e) { if (alive.current && generation.current === seq) setError(e) }
      }
      useEffect(() => {
        alive.current = true; void read()
        const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void read() }, 1500)
        return () => { alive.current = false; clearInterval(timer); generation.current += 1 }
      }, [])
      const call = async (method, payload) => {
        setBusy(true); setError(null); setReceipt(null)
        try {
          const value = await controller.cloudCall(method, payload)
          if (!alive.current) return
          if (method === 'link' || method === 'unbind') setReceipt(value)
          if (method === 'deploy') setBotToken('')
          await read()
        } catch (e) { if (alive.current) setError(e) }
        finally { if (alive.current) setBusy(false) }
      }
      const disabled = busy || !!data?.job
      const steps = { preparing: words('准备工具', 'Preparing tools'), login: words('等待登录', 'Awaiting login'), database: words('准备 Bark 服务', 'Preparing Bark'), migration: words('配置 Bark 服务', 'Configuring Bark'), deploy: words('设置服务', 'Setting up connection'), verify: words('检查服务', 'Checking service') }
      return h('div', { className: 'dn-page' },
        h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'native' }) }, `← ${t('back')}`),
        h(PageHead, { title: t('cloudflare'), intro: words('把 Bark 或 Telegram 备用连接设置到你的 Cloudflare 账号。', 'Set up Bark or a backup Telegram connection.') }),
        h('div', { className: 'dn-formActions' },
          h(Button, { disabled, onClick: () => call('loginDevice') }, words('登录 Cloudflare', 'Log in to Cloudflare')),
          h(Button, { disabled, onClick: () => call('refresh') }, t('refresh')),
          data?.job ? h(Button, { disabled: busy, onClick: () => call('cancel') }, t('cancelAction')) : null),
        data?.login ? h('div', { className: 'dn-code' }, h('a', { href: data.login.url, target: '_blank', rel: 'noopener noreferrer' }, words('打开授权页面', 'Open authorization page')), data.login.code ? h('strong', null, data.login.code) : null) : null,
        data?.job ? h('p', { role: 'status', className: 'dn-note' }, steps[data.job.step] || t('loading')) : null,
        ...(data?.recoveries ?? []).map(recovery => h('p', { key: recovery.id, role: 'alert', className: 'dn-note' }, words(
          `上次 ${recovery.type === 'telegram' ? 'Telegram' : 'Bark'} 操作的外部结果需要核对。重启不会自动重复部署；登录后点“设置 / 重试”会先读取现有服务。`,
          `The last ${recovery.type === 'telegram' ? 'Telegram' : 'Bark'} operation needs a result check. Restart will not redeploy automatically; after login, choose “Set up / retry” to read the existing service first.`,
        ))),
        error || data?.error ? h('p', { role: 'alert', className: 'dn-error' }, error?.message || data.error) : null,
        h('label', { className: 'dn-field' }, words('账号', 'Account'), h('select', { 'aria-label': 'Cloudflare account', value: account, disabled, onChange: e => setAccount(e.target.value) }, h('option', { value: '' }, '—'), ...(data?.accounts ?? []).map(a => h('option', { key: a.id, value: a.id }, a.name)))),
        h('label', { className: 'dn-field' }, words('服务', 'Service'), h('select', { 'aria-label': 'Cloudflare service', value: type, disabled, onChange: e => setType(e.target.value) }, h('option', { value: 'telegram' }, 'Telegram Fallback connection'), h('option', { value: 'bark' }, 'Bark'))),
        type === 'telegram' ? h('label', { className: 'dn-field' }, 'Bot Token', h('input', { type: 'password', autoComplete: 'off', 'aria-label': 'Bot Token', value: botToken, disabled, placeholder: words('已配置可留空', 'Leave blank to keep the current token'), onChange: e => setBotToken(e.target.value) })) : h('label', { className: 'dn-field dn-field--check' }, h('input', { type: 'checkbox', checked: enrollment, disabled, onChange: e => setEnrollment(e.target.checked) }), words('允许 Bark App 注册设备（添加设备后取消并重新设置）', 'Allow Bark App registration (turn off and set up again after adding devices)')),
        type === 'telegram' ? h('div', null,
          h('label', { className: 'dn-field' }, words('接收者（已配置可留空）', 'Recipient (leave blank to reuse)'), h('input', { 'aria-label': 'Fallback connection recipient', value: chatId, disabled, onChange: e => setChatId(e.target.value) })),
          h('label', { className: 'dn-field dn-field--check' }, h('input', { type: 'checkbox', checked: activate, disabled, onChange: e => setActivate(e.target.checked) }), words('设置后自动填写并保存 TG 配置', 'Automatically fill and save Telegram settings')),
          h('label', { className: 'dn-field dn-field--check' }, h('input', { type: 'checkbox', checked: inbound, disabled, onChange: e => setInbound(e.target.checked) }), words('也用于接收消息（完成后重启 DSH）', 'Also receive messages (restart DSH afterwards)'))) : null,
        h(Button, { kind: 'primary', disabled: disabled || !account, onClick: () => call('deploy', { type, accountId: account, botToken, enrollment, activate: type === 'telegram' && activate, chatId, inbound }) }, type === 'telegram' ? words('一键开启', 'Enable fallback connection') : words('设置 / 重试', 'Set up / retry')),
        h(TunnelSettings, { ctx, controller, data: data?.tunnel, disabled, onRead: read }),
        receipt ? h('p', { role: 'status', className: 'dn-successText' }, receipt.unbound ? words('已解除本地连接，云资源保留。', 'Original connection restored. Your online service is kept.') : receipt.results?.some(r => r.applied === false) ? t('restartPending') : t('savedOk')) : null,
        ...(data?.deployments ?? []).map(r => h(Section, { key: r.type, title: r.type === 'telegram' ? 'Telegram Fallback connection' : 'Bark' },
          h('p', { className: 'dn-note' }, r.endpoint || words('尚未完成设置', 'Setup incomplete')),
          h('p', { className: 'dn-note' }, r.state === 'bound' ? words('已连接', 'Linked') : words('未连接', 'Not linked')),
          r.type === 'telegram' ? h('div', null,
            h('label', { className: 'dn-field' }, 'Chat ID', h('input', { 'aria-label': 'Chat ID', value: chatId, disabled, onChange: e => setChatId(e.target.value) })),
            h('label', { className: 'dn-field dn-field--check' }, h('input', { type: 'checkbox', checked: inbound, disabled, onChange: e => setInbound(e.target.checked) }), words('同时用于入站控制（保存后重启 DSH）', 'Also use for inbound control (restart DSH after saving)'))) : h('label', { className: 'dn-field' }, 'Bark Key', h('input', { type: 'password', autoComplete: 'off', 'aria-label': 'Bark Key', value: barkKey, disabled, placeholder: words('在 Bark App 添加服务器后取得', 'Available after adding the server in Bark App'), onChange: e => setBarkKey(e.target.value) })),
          h('div', { className: 'dn-formActions' },
            h(Button, { disabled: disabled || r.health !== 'ready', onClick: () => call('link', { type: r.type, chatId, barkKey, directions: r.type === 'telegram' && inbound ? ['outbound', 'inbound'] : ['outbound'] }) }, words('使用此连接', 'Link channel')),
            r.state === 'bound' ? h(Button, { disabled, onClick: () => call('unbind', { type: r.type }) }, words('恢复原连接', 'Unbind')) : null))))
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
      useEffect(() => { if (view === 'page') void controller.loadNative().catch(error => controller.reportError(error)) }, [view])
      if (view !== 'page') return null
      // 就绪判定读取 Native 快照中的 notifyEnabled。
      const ready = (state.native?.channels ?? []).some(channel => channel?.notifyEnabled === true)
      return h('div', { className: 'dn-pluginConfig' },
        h('strong', null, ready ? t('pluginReady') : t('noChannels')),
        h('p', null, ready ? t('nativeIntro') : t('noChannelsHint')),
        h('div', { className: 'dn-formActions' },
          h(Button, {
            kind: 'primary',
            onClick: () => {
              try { ctx.layout.selectPanel(PANEL_ID) } catch (error) { controller.reportError(error) }
              // 未就绪时直接落到「通知与私聊」页并打开添加渠道选择器。
              controller.navigate(ready ? { kind: 'native' } : { kind: 'native', picker: true })
            },
          }, ready ? t('openControl') : t('setupFirst'))),
        null)
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
      .dn-button--danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
      .dn-confirm{display:inline-flex;gap:6px;align-items:center}
      .dn-subhead{margin:20px 0 6px;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}
      .dn-detail{margin-top:20px;font-size:13px}.dn-detail summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
      .dn-raw{overflow:auto;margin:8px 0 0;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
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
      .dn-code{display:flex;flex-direction:column;gap:6px;margin:12px 0;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
      .dn-codeValue{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:.04em;color:var(--dsw-alias-label-primary);word-break:break-all}
      .dn-code .dn-link{align-self:flex-start}
      .dn-error{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}.dn-successText,.dn-success{color:var(--dsw-alias-state-success-primary);font-size:13px}
      .dn-success{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-top:12px}
      .dn-inlineStatus{display:flex;gap:8px;align-items:center;font-size:13px}.dn-inlineStatus .dn-stateDot{margin-top:0}
      .dn-channelPicker{display:flex;flex-direction:column;gap:2px;margin-top:12px}.dn-pickerRow{display:flex;justify-content:space-between;border:0;background:transparent;color:inherit;padding:10px;border-radius:var(--dsw-radius-md);cursor:pointer;text-align:left}.dn-pickerRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dn-nav{display:flex;gap:6px;flex-wrap:wrap;margin:-12px 0 20px}
      .dn-navBtn{min-height:28px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:inherit;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}
      .dn-navBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dn-navCaption{margin:0 0 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dn-nav--manage{margin:0 0 20px}
      .dn-field select,.dn-field textarea{box-sizing:border-box;width:100%;max-width:560px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:7px 10px;font:inherit}
      .dn-field select{height:34px}
      .dn-field textarea{min-height:64px;resize:vertical;line-height:20px}
      .dn-field--check{flex-direction:row;align-items:center;gap:8px}
      .dn-field--check input{width:auto;height:auto;max-width:none;flex:0 0 auto}
      .dn-field--secret{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:10px 12px;margin:12px 0}
      .dn-secretModes{display:flex;gap:12px;flex-wrap:wrap}
      .dn-radio{display:inline-flex;gap:6px;align-items:center;font-size:13px;white-space:nowrap}
      .dn-field .dn-radio input{width:auto;flex:none}
      .dn-leaveGuard{border:.5px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:12px 14px;margin:12px 0}
      .dn-leaveGuard p{margin:6px 0 10px}
      .dn-page :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      @media(max-width:359px){.dn-page{padding:16px 12px 36px}.dn-navBtn{padding:4px 10px}}
      .dn-pluginConfig{display:flex;flex-direction:column;gap:8px;padding:8px 0}.dn-pluginConfig>p,.dn-activation>p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
      @keyframes dnPulse{0%,100%{opacity:.35}50%{opacity:1}}
      @media(max-width:719px){.dn-page{padding:20px 16px 40px}.dn-pageHead{gap:12px}.dn-row{align-items:flex-start}.dn-rowAside{align-items:flex-start}.dn-options{flex-direction:column}.dn-option{width:100%;text-align:left}}
      @media(prefers-reduced-motion:reduce){.dn-stateDot--ongoing{animation:none}}
      /* v0.15（Stage 1 / S2）：Native v2「通知与私聊」外壳。页面宽度受控、右侧 min-width:0，
         避免宿主内容区变窄时卡片被硬挤；窄屏不是把桌面版缩小，而是重新排布。 */
      .dn-settings{box-sizing:border-box;width:100%;max-width:1040px;margin:0 auto;padding:24px clamp(16px,3vw,40px) 40px;color:var(--dsw-alias-label-primary);font-family:inherit}
      .dn-settings :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      .dn-productHead{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin:0 0 20px}
      .dn-productTitle{min-width:0}
      .dn-productTitle h1{margin:0;font-size:20px;line-height:28px;font-weight:500}
      .dn-productTitle p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
      .dn-productActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .dn-moreWrap{position:relative}
      .dn-moreMenu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;min-width:168px;display:flex;flex-direction:column;padding:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 20px rgba(0,0,0,.08)}
      .dn-moreItem{border:0;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;padding:8px 10px;border-radius:var(--dsw-radius-md);cursor:pointer}
      .dn-moreItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dn-workspace{display:flex;align-items:flex-start;min-width:0}
      .dn-rail{flex:0 0 176px;display:flex;flex-direction:column;gap:2px;padding:4px}
      .dn-railDivider{flex:0 0 1px;align-self:stretch;background:var(--dsw-alias-border-l2);margin:0 16px}
      .dn-content{flex:1 1 auto;min-width:0}
      .dn-navItem{display:flex;align-items:center;gap:10px;min-height:46px;padding:6px 10px;border:.5px solid transparent;border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
      .dn-navItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dn-navItem.is-selected{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
      .dn-navGlyph{width:24px;height:24px;display:grid;place-items:center;color:var(--dsw-alias-label-secondary);flex:0 0 auto}
      .dn-navLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dn-navAdd{color:var(--dsw-alias-state-business-primary)}
      .dn-logo{flex:0 0 auto;border-radius:7px}
      .dn-strip{display:none;gap:6px;overflow-x:auto;margin:0 0 16px;padding-bottom:4px}
      .dn-strip .dn-navItem{min-height:40px;padding:4px 10px;flex:0 0 auto}
      .dn-strip .dn-navLabel{white-space:nowrap}
      .dn-channelSelect{display:none;position:relative;margin:0 0 16px}
      .dn-selectButton{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:6px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px;cursor:pointer}
      .dn-selectLabel{flex:1;text-align:left;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dn-selectCaret{color:var(--dsw-alias-label-secondary)}
      .dn-selectMenu{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:20;display:flex;flex-direction:column;padding:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 20px rgba(0,0,0,.08);max-height:60vh;overflow:auto}
      .dn-selectOption{display:flex;align-items:center;gap:10px;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;padding:8px 10px;border-radius:var(--dsw-radius-md);cursor:pointer}
      .dn-selectOption:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dn-selectOption[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2)}
      .dn-selectAdd{color:var(--dsw-alias-state-business-primary)}
      .dn-badge{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;white-space:nowrap}
      .dn-tag{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:2px 8px}
      .dn-accountCard{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;margin:10px 0}
      .dn-accountHead{display:flex;align-items:center;gap:12px}
      .dn-accountMain{flex:1;min-width:0;display:flex;flex-direction:column}
      .dn-accountTags{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}
      .dn-accountToggle{flex:0 0 auto}
      .dn-accountBody{margin-top:4px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
      .dn-accountForm{display:flex;flex-direction:column}
      .dn-connHelp{margin:8px 0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px}
      .dn-channelPage{min-width:0}
      .dn-channelHead{display:flex;align-items:center;gap:12px;padding:4px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin-bottom:8px}
      .dn-channelHeadMain{flex:1;min-width:0;display:flex;flex-direction:column}
      .dn-channelName{margin:0;font-size:16px;line-height:24px;font-weight:500}
      .dn-channelUsage{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dn-pickerOverlay{position:fixed;inset:0;z-index:40;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;background:rgba(0,0,0,.28)}
      .dn-picker{box-sizing:border-box;width:100%;max-width:560px;max-height:80vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;padding:20px}
      .dn-pickerHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .dn-pickerTitle{margin:0;font-size:16px;line-height:24px;font-weight:500}
      .dn-pickerGroup{margin:14px 0 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dn-pickerItem{display:flex;align-items:center;gap:12px;width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:10px;border-radius:10px;cursor:pointer}
      .dn-pickerItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dn-pickerMain{flex:1;min-width:0;display:flex;flex-direction:column}
      .dn-pickerName{font-size:14px;line-height:20px;font-weight:500}
      .dn-pickerUsage{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dn-pickerAdded{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
      /* 私聊页 / 待处理页（S4）。 */
      .dn-privatePage{min-width:0}
      .dn-detailBack{margin:0 0 8px}
      .dn-steps{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:0 0 16px;padding:0}
      .dn-step{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:2px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px}
      .dn-step.is-done{color:var(--dsw-alias-label-secondary)}
      .dn-step.is-active{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
      .dn-pendingBanner{display:flex;align-items:center;gap:10px;width:100%;margin:0 0 16px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
      .dn-pendingBanner:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dn-pendingMark{flex:0 0 auto;width:20px;height:20px;display:grid;place-items:center;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:#fff;font-size:12px}
      .dn-pendingText{flex:1;min-width:0}
      .dn-pendingGo{color:var(--dsw-alias-state-business-primary);white-space:nowrap}
      .dn-tryWord{font-size:14px;line-height:22px;margin:4px 0}
      .dn-codeBox{display:flex;flex-direction:column;gap:4px;margin:8px 0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px}
      .dn-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:.08em}
      /* 中等内容区（680–879px）：左栏换成顶部横向可滚动渠道条，主内容占满宽度。 */
      @media(max-width:879px){.dn-rail{display:none}.dn-railDivider{display:none}.dn-strip{display:flex}}
      /* 手机（<680px）：不保留常驻渠道栏，顶部是当前渠道按钮，点开弹出渠道选择。 */
      @media(max-width:679px){.dn-strip{display:none}.dn-channelSelect{display:block}}
      @media(max-width:519px){
        .dn-settings{padding:16px 14px 32px}
        .dn-productHead{flex-direction:column;gap:12px}
        .dn-productActions{width:100%}
        .dn-moreMenu{right:auto;left:0}
        .dn-pickerOverlay{padding:16px 10px}
        .dn-picker{padding:16px}
      }
      @media(max-width:389px){
        .dn-productActions{gap:6px}
        .dn-productActions .dn-button{flex:1 1 auto;justify-content:center}
      }
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

        const boundary = child => h(ErrorBoundary, {
          message: resolveText(ctx, { zh: zh.renderFailed, en: en.renderFailed }),
          retry: resolveText(ctx, { zh: zh.retry, en: en.retry }),
        }, child)
        const Main = () => boundary(h(MainPanel, { controller, ctx }))
        const Config = props => boundary(h(PluginConfig, { ...props, controller, ctx }))
        const ActivationView = props => boundary(h(Activation, { ...props, ctx }))

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
          label: () => resolveText(ctx, { en: 'Notify & Private chat', zh: '通知与私聊' }),
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
