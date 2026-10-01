window.__ModuleLoader__.load({
  id: 'dsh-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const {
      Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React

    const PANEL_ID = 'dsh-notifier'
    // v0.15（T19 / U11）：导航分层——日常一步可达（待处理提问 / 任务 / 渠道 / 活动），
    // 其余管理能力（成员 / 待确认身份 / 配对码 / 会话 / 诊断）单独一组，仍全部在 Native 可达；
    // 不为「减导航」把日常能力塞回 Recovery。
    const NAV_DAILY = Object.freeze([
      ['questions', 'questions'],
      ['tasks', 'tasks'],
      ['channels', 'channels'],
      ['activity', 'activity'],
    ])
    const NAV_MANAGE = Object.freeze([
      ['members', 'members'],
      ['pending', 'pendingIdentities'],
      ['pairing', 'pairingCodes'],
      ['sessions', 'sessions'],
      ['diagnostics', 'diagnosticsCenter'],
      // v0.15（T24）：远程入口（手机访问）。属管理组，日常一步可达项不受影响。
      ['remote', 'remoteEntry'],
      ['portability', 'configTransfer'],
      ['cloudflare', 'cloudflare'],
    ])
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
      exportFailed: '下载失败，请复制下方内容。', cloudflare: 'Cloudflare 部署',
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
      setupIntro: '选择你已经在使用的渠道并保存；测试是可选的，稍后也可以。',
      save: '保存',
      test: '发送测试通知',
      testing: '正在发送测试通知…',
      testDelivered: '测试通知已送达',
      testAccepted: '测试消息已发送',
      // v0.15（T18 / U01–U12）：保存回执与刷新分离；测试证据分级；列表三态。
      saving: '正在保存…',
      savedOk: '配置已保存',
      savedRefreshFailed: '已保存，但详情刷新失败。重试只会重新读取。',
      savedPendingTest: '配置已保存。可立即发送测试通知，或稍后再试。',
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
      noAccountNote: '无需账号即可保存，测试完全可选。',
      unavailableList: '当前能力不可用',
      staleUpdatedAt: '数据可能已过期',
      // v0.15（T19 / U06–U13）：按 schema 控件、secret 保留/替换/清除、离开草稿确认、
      // 配对码复制、导航分层、删除/降权影响确认。
      secretConfiguredKeep: '已配置（默认保留）',
      secretNotShown: '出于安全，不显示已保存的值',
      secretKeep: '保留',
      secretReplace: '替换',
      secretClear: '清除',
      listHint: '每行一项，也可用逗号分隔',
      unsavedLeaveTitle: '有未保存的修改',
      unsavedLeaveBody: '离开将丢弃这些草稿修改；已保存的配置不受影响。',
      leaveStay: '留在本页',
      leaveDiscard: '放弃修改并离开',
      copyCode: '复制配对码',
      codeCopied: '配对码已复制',
      copyUnavailableSelect: '无法访问剪贴板，请手动选中上方配对码复制。',
      navDaily: '常用',
      navManage: '管理',
      confirmDemote: '确认降权',
      memberDemoteImpact: '降为普通成员后不再拥有所有者权限',
      memberRemoveImpact: '将从成员名单中移除',
      updating: '正在更新…',
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
      questions: '待处理提问',
      noQuestions: '暂无待处理提问',
      members: '成员',
      noMembers: '暂无成员',
      owner: '所有者',
      roleMember: '普通成员',
      promote: '设为所有者',
      demote: '降为普通成员',
      remove: '移除',
      removing: '正在移除…',
      memberUpdated: '已更新',
      memberRemoved: '已移除',
      pendingIdentities: '待确认身份',
      noPending: '暂无待确认身份',
      approve: '转正',
      dismiss: '忽略',
      pairingCodes: '配对码',
      noCodes: '暂无在铸配对码',
      mintCode: '生成配对码',
      minting: '正在生成…',
      revoke: '撤销',
      revoking: '正在撤销…',
      labelOptional: '备注（可选）',
      codeShownOnce: '此配对码只显示一次，请立即保存。',
      clearCode: '清除',
      sessions: '会话',
      noSessions: '暂无会话',
      sessionActive: '活跃',
      sessionIdle: '空闲',
      silence: '静默',
      resumeNotify: '恢复通知',
      noChannelsResolved: '无渠道',
      advancedBindings: '高级绑定',
      bindings: '路由绑定',
      noBindings: '暂无路由绑定',
      agentBindings: '工作区 → 渠道',
      channelBindings: '入站通道 → 默认工作区',
      defaultAgent: '默认工作区',
      viewRawIdentifiers: '查看原始标识',
      bindingsSaved: '绑定已保存',
      // v0.14（Stage E / P1-09）：破坏性操作二次确认（成员移除 / 配对码撤销 / 绑定移除 / 入站默认绑定移除）。
      confirmRemove: '确认移除',
      confirmRevoke: '确认撤销',
      cancelAction: '取消',
      // v0.14（Stage E / P1-10）：Session Detail（路由 / 出站 / 静默 / 控制 / 绑定）。
      openSession: '查看详情',
      sessionDetail: '会话详情',
      routingSection: '路由',
      outboundSection: '通知渠道',
      quietSection: '静默',
      controlSection: '控制策略',
      bindingsSection: '绑定',
      workspaceLabel: '工作区',
      inheritLabel: '继承',
      resolvedByLabel: '解析来源',
      sourceSession: '会话覆盖',
      sourceWorkspace: '工作区绑定',
      sourceGlobal: '全局默认',
      lastActiveLabel: '最近活动',
      disposedLabel: '已释放',
      modeLabel: '控制模式',
      modeTeam: '团队',
      modePersonal: '个人',
      modeUnset: '未设置',
      approvalOwnerOnlyLabel: '仅所有者审批',
      ownerConfiguredLabel: '已指定所有者',
      approvalMembersCountLabel: '审批成员数',
      saveControl: '保存控制策略',
      controlSaved: '控制策略已保存',
      rawIdentifiersNote: '显示完整标识',
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
      outboundRestartHint: '已保存，重启 DSH 后生效',
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
      staleData: '连接中断，当前显示的是上次成功读取的数据。',
      renderFailed: '通知与控制界面发生错误',
      diagnosticsCenter: '诊断中心',
      diagnosticsIntro: '是否需要处理、为什么，以及最近一次检查',
      attentionQuestion: '现在是否需要注意？',
      noneRequired: '运行正常，无需处理',
      why: '原因',
      lastChecked: '最近检查',
      notAvailableYet: '暂时无法读取',
      pluginVersion: '插件版本',
      hostVersion: '宿主版本',
      processId: '进程标识',
      eventsMode: '事件模式',
      questionsMode: '提问模式',
      imageInput: '图片入站',
      storageState: '存储状态',
      storageWritable: '可写入',
      migration: '状态迁移',
      channelSummaryTitle: '渠道摘要',
      totalChannels: '渠道总数',
      notifyConfiguredActive: '通知（已配置/运行）',
      controlConfiguredActive: '远程控制（已配置/运行）',
      evidenceLevel: '证据等级',
      evidenceNone: '无投递证据',
      evidenceAccepted: '已发送到提供方',
      evidenceConfirmed: '已确认送达',
      restartPendingList: '等待重启生效',
      noEvidenceList: '尚无投递证据',
      inactiveList: '已配置未激活',
      degradedList: '最近失败渠道',
      noneList: '无',
      capabilityTitle: '能力',
      capQuestions: '待处理提问',
      capSessions: '会话',
      capBindings: '路由绑定',
      capMembers: '成员',
      capAdvanced: '高级管理台',
      available: '可用',
      yes: '是',
      no: '否',
      supportReport: '支持报告',
      reportIntro: '生成诊断报告',
      reportNotBackup: '诊断报告不包含密钥。',
      generateReport: '生成支持报告',
      copyReport: '复制',
      downloadReport: '下载',
      copiedOk: '已复制到剪贴板',
      downloadedOk: '已下载报告文件',
      copyFailedDownload: '无法复制，已改为下载',
      failuresTitle: '最近失败',
      noFailures: '暂无失败记录',
      hostTitle: '宿主',
      storageTitle: '存储',
      controlTitle: '控制面',
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
    })

    const en = Object.freeze({
      configTransfer: 'Import & export',
      transferIntro: 'Exports omit credentials. Complete new channels before saving.',
      exportConfig: 'Export config', importConfig: 'Choose config file', previewImport: 'Preview import',
      confirmImport: 'Confirm import', importDone: 'Import complete', importStaged: 'Pending setup',
      importAdd: 'New (inactive)', importPatch: 'Add fields', importConflict: 'Replace existing fields',
      importSkip: 'No changes', importUnsupported: 'Unsupported', importMissing: 'Required',
      importFields: 'Changed fields', importConfigure: 'Complete setup', importEmpty: 'No pending channels',
      exportFailed: 'Download failed. Copy the content below.', cloudflare: 'Cloudflare deploy',
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
      setupIntro: 'Choose a channel you already use and save it; testing is optional and can wait.',
      save: 'Save',
      test: 'Send test notification',
      testing: 'Sending test notification…',
      testDelivered: 'Test notification delivered',
      testAccepted: 'Test message sent',
      // v0.15 (T18 / U01–U12): save receipt vs refresh; delivery evidence levels; list tri-state.
      saving: 'Saving…',
      savedOk: 'Configuration saved',
      savedRefreshFailed: 'Saved, but refreshing details failed. Retry only re-reads.',
      savedPendingTest: 'Saved. Send a test notification now, or do it later.',
      testCommittedConfig: 'Tests the saved configuration.',
      unsavedChangesHint: 'You have unsaved changes — save before testing.',
      testUnconfirmed: 'Could not confirm delivery',
      testConfirmedHint: 'Delivered',
      testAcceptedDetail: 'Sent. Check your device.',
      testReasonAuth: 'Credential or permission rejected',
      testReasonTimeout: 'Request timed out',
      testReasonNetwork: 'Network unreachable',
      testReasonProvider: 'Provider returned an error',
      unknownNoRetry: 'Send result unknown',
      noAccountNote: 'No account needed to save — testing is entirely optional.',
      unavailableList: 'This capability is unavailable',
      staleUpdatedAt: 'Data may be out of date',
      // v0.15 (T19 / U06–U13): schema controls, secret keep/replace/clear, leave-draft
      // confirmation, pairing-code copy, nav layering, destructive-impact confirmation.
      secretConfiguredKeep: 'Configured (kept by default)',
      secretNotShown: 'The saved value is never shown, for safety',
      secretKeep: 'Keep',
      secretReplace: 'Replace',
      secretClear: 'Clear',
      listHint: 'One item per line, or comma-separated',
      unsavedLeaveTitle: 'You have unsaved changes',
      unsavedLeaveBody: 'Leaving discards these draft edits; saved configuration is unaffected.',
      leaveStay: 'Stay here',
      leaveDiscard: 'Discard and leave',
      copyCode: 'Copy pairing code',
      codeCopied: 'Pairing code copied',
      copyUnavailableSelect: 'Clipboard is unavailable — select the pairing code above and copy it manually.',
      navDaily: 'Daily',
      navManage: 'Manage',
      confirmDemote: 'Confirm demote',
      memberDemoteImpact: 'Loses owner privileges once demoted to member',
      memberRemoveImpact: 'Will be removed from the member list',
      updating: 'Updating…',
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
      questions: 'Questions',
      noQuestions: 'No pending questions',
      members: 'Members',
      noMembers: 'No members yet',
      owner: 'Owner',
      roleMember: 'Member',
      promote: 'Make owner',
      demote: 'Make member',
      remove: 'Remove',
      removing: 'Removing…',
      memberUpdated: 'Updated',
      memberRemoved: 'Removed',
      pendingIdentities: 'Pending identities',
      noPending: 'No pending identities',
      approve: 'Approve',
      dismiss: 'Dismiss',
      pairingCodes: 'Pairing codes',
      noCodes: 'No active pairing codes',
      mintCode: 'Generate code',
      minting: 'Generating…',
      revoke: 'Revoke',
      revoking: 'Revoking…',
      labelOptional: 'Label (optional)',
      codeShownOnce: 'This pairing code is shown only once — save it now.',
      clearCode: 'Clear',
      sessions: 'Sessions',
      noSessions: 'No sessions',
      sessionActive: 'Active',
      sessionIdle: 'Idle',
      silence: 'Silence',
      resumeNotify: 'Resume',
      noChannelsResolved: 'No channels',
      advancedBindings: 'Advanced bindings',
      bindings: 'Routing bindings',
      noBindings: 'No routing bindings',
      agentBindings: 'Workspace → channels',
      channelBindings: 'Inbound channel → default workspace',
      defaultAgent: 'Default workspace',
      viewRawIdentifiers: 'View raw identifiers',
      bindingsSaved: 'Bindings saved',
      // v0.14 (Stage E / P1-09): destructive confirmation (member remove / pairing revoke / binding remove).
      confirmRemove: 'Confirm remove',
      confirmRevoke: 'Confirm revoke',
      cancelAction: 'Cancel',
      // v0.14 (Stage E / P1-10): Session Detail (routing / outbound / quiet / control / bindings).
      openSession: 'Open details',
      sessionDetail: 'Session detail',
      routingSection: 'Routing',
      outboundSection: 'Notification channels',
      quietSection: 'Quiet',
      controlSection: 'Control policy',
      bindingsSection: 'Bindings',
      workspaceLabel: 'Workspace',
      inheritLabel: 'Inherit',
      resolvedByLabel: 'Resolved by',
      sourceSession: 'Session override',
      sourceWorkspace: 'Workspace binding',
      sourceGlobal: 'Global default',
      lastActiveLabel: 'Last active',
      disposedLabel: 'Disposed',
      modeLabel: 'Control mode',
      modeTeam: 'Team',
      modePersonal: 'Personal',
      modeUnset: 'Not set',
      approvalOwnerOnlyLabel: 'Owner-only approval',
      ownerConfiguredLabel: 'Owner configured',
      approvalMembersCountLabel: 'Approval members',
      saveControl: 'Save control policy',
      controlSaved: 'Control policy saved',
      rawIdentifiersNote: 'Raw identifiers are redacted by default; expand to reveal the full value.',
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
      outboundRestartHint: 'Saved, but the runtime has not converged yet (e.g. a required credential was cleared). Restart DSH to apply the latest config.',
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
      staleData: 'Connection interrupted; showing the last successfully loaded data.',
      renderFailed: 'Notify & Control could not render',
      diagnosticsCenter: 'Diagnostics',
      diagnosticsIntro: 'Whether anything needs attention, why, and when we last checked',
      attentionQuestion: 'Does anything need attention right now?',
      noneRequired: 'Running normally — nothing to do',
      why: 'Why',
      lastChecked: 'Last checked',
      notAvailableYet: 'Not available yet',
      pluginVersion: 'Plugin version',
      hostVersion: 'Host version',
      processId: 'Process id',
      eventsMode: 'Events mode',
      questionsMode: 'Questions mode',
      imageInput: 'Image input',
      storageState: 'Storage state',
      storageWritable: 'Writable',
      migration: 'State migration',
      channelSummaryTitle: 'Channel summary',
      totalChannels: 'Total channels',
      notifyConfiguredActive: 'Notify (configured / active)',
      controlConfiguredActive: 'Remote control (configured / active)',
      evidenceLevel: 'Evidence level',
      evidenceNone: 'No delivery evidence',
      evidenceAccepted: 'Sent to provider',
      evidenceConfirmed: 'Delivery confirmed',
      restartPendingList: 'Awaiting restart',
      noEvidenceList: 'No delivery evidence yet',
      inactiveList: 'Configured but inactive',
      degradedList: 'Recently failed',
      noneList: 'None',
      capabilityTitle: 'Capabilities',
      capQuestions: 'Pending questions',
      capSessions: 'Sessions',
      capBindings: 'Routing bindings',
      capMembers: 'Members',
      capAdvanced: 'Advanced console',
      available: 'Available',
      yes: 'Yes',
      no: 'No',
      supportReport: 'Support report',
      reportIntro: 'Generate a diagnostic report.',
      reportNotBackup: 'The report contains no credentials.',
      generateReport: 'Generate support report',
      copyReport: 'Copy',
      downloadReport: 'Download',
      copiedOk: 'Copied to clipboard',
      downloadedOk: 'Report downloaded',
      copyFailedDownload: 'Could not copy — downloaded instead',
      failuresTitle: 'Recent failures',
      noFailures: 'No recent failures',
      hostTitle: 'Host',
      storageTitle: 'Storage',
      controlTitle: 'Control plane',
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
        view: { kind: 'home' },
        home: null,
        channels: null,
        tasks: null,
        questions: null,
        members: null,
        pending: null,
        pairing: null,
        sessions: null,
        bindings: null,
        activity: null,
        diagnostics: null,
        channel: null,
        session: null,
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
      const generations = { home: 0, channels: 0, channel: 0, tasks: 0, questions: 0, members: 0, pending: 0, pairing: 0, sessions: 0, session: 0, bindings: 0, activity: 0, diagnostics: 0 }
      let paused = false

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
            ...(epochChanged ? { home: null, channels: null, tasks: null, questions: null, members: null, pending: null, pairing: null, sessions: null, session: null, bindings: null, activity: null, diagnostics: null, channel: null } : {}),
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

      async function loadHome() {
        const generation = ++generations.home
        try {
          const value = await rpc.call('surface.home')
          if (generation !== generations.home) return value
          commit('home', value)
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
          commit('channels', value)
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
          commit('channel', value)
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
          commit('tasks', value)
          return value
        } catch (error) {
          if (generation !== generations.tasks) return null
          throw error
        }
      }
      async function loadQuestions() {
        const generation = ++generations.questions
        try {
          const value = await rpc.call('questions.list')
          if (generation !== generations.questions) return value
          commit('questions', value)
          return value
        } catch (error) {
          if (generation !== generations.questions) return null
          throw error
        }
      }
      async function loadMembers() {
        const generation = ++generations.members
        try {
          const value = await rpc.call('members.list')
          if (generation !== generations.members) return value
          commit('members', value)
          return value
        } catch (error) {
          if (generation !== generations.members) return null
          throw error
        }
      }
      async function loadPending() {
        const generation = ++generations.pending
        try {
          const value = await rpc.call('members.pending')
          if (generation !== generations.pending) return value
          commit('pending', value)
          return value
        } catch (error) {
          if (generation !== generations.pending) return null
          throw error
        }
      }
      async function loadPairingCodes() {
        const generation = ++generations.pairing
        try {
          const value = await rpc.call('pairing.list')
          if (generation !== generations.pairing) return value
          commit('pairing', value)
          return value
        } catch (error) {
          if (generation !== generations.pairing) return null
          throw error
        }
      }
      async function loadSessions() {
        const generation = ++generations.sessions
        try {
          const value = await rpc.call('sessions.list')
          if (generation !== generations.sessions) return value
          commit('sessions', value)
          return value
        } catch (error) {
          if (generation !== generations.sessions) return null
          throw error
        }
      }
      // v0.14（Stage E / P1-10）：Session Detail 单行读取；导航切走时丢弃迟到响应。
      async function loadSession(id) {
        const generation = ++generations.session
        try {
          const value = await rpc.call('sessions.detail', { id })
          if (generation !== generations.session) return value
          if (snapshot.view.kind !== 'session' || snapshot.view.id !== id) return value
          commit('session', value)
          return value
        } catch (error) {
          if (generation !== generations.session) return null
          throw error
        }
      }
      async function loadActivity() {
        const generation = ++generations.activity
        try {
          const value = await rpc.call('activity.list', { limit: 100 })
          if (generation !== generations.activity) return value
          commit('activity', value)
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
          else if (kind === 'questions') await loadQuestions()
          else if (kind === 'members') await loadMembers()
          else if (kind === 'pending') await loadPending()
          else if (kind === 'pairing') await loadPairingCodes()
          else if (kind === 'sessions') await loadSessions()
          else if (kind === 'session') await loadSession(snapshot.view.id)
          else if (kind === 'bindings') await loadBindings()
          else if (kind === 'activity') await loadActivity()
          else if (kind === 'diagnostics') await loadDiagnostics()
          else await loadHome()
          emit({ staleAt: null, connectionState: 'connected' })
          return true
        } catch {
          const hasData = snapshot.home !== null || snapshot.channels !== null || snapshot.channel !== null || snapshot.tasks !== null || snapshot.questions !== null || snapshot.members !== null || snapshot.pending !== null || snapshot.pairing !== null || snapshot.sessions !== null || snapshot.session !== null || snapshot.bindings !== null || snapshot.activity !== null || snapshot.diagnostics !== null
          emit({ staleAt: Date.now(), connectionState: hasData ? 'stale' : 'disconnected' })
          return false
        }
      }
      async function saveChannel(type, direction, patch) {
        const key = `save:${type}:${direction}`
        // v0.15（T18 / U02）：busy 期间同一业务提交不再重入（RPC 慢时连点不产生第二次提交）。
        if (snapshot.busy[key] === true) return { saved: false, duplicate: true, refreshed: false }
        setBusy(key, true)
        try {
          const value = await rpc.call('channels.save', { type, direction, patch })
          setError(null)
          // v0.15（T18 / U01）：durable receipt 就是落盘结果本身；刷新详情是**另一件事**——
          // 刷新失败绝不能上报成「保存失败」（旧实现把 loadChannel 的异常直接冒泡，导致
          // 已落盘的保存被当成失败、草稿不清理）。这里分开，仅回传 refreshed 供视图区分提示。
          const refreshed = await loadChannel(type).then(() => true).catch(() => false)
          return { ...(value && typeof value === 'object' ? value : {}), refreshed }
        } finally {
          setBusy(key, false)
        }
      }
      async function testChannel(type) {
        const key = `test:${type}`
        if (snapshot.busy[key] === true) return null
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
          await refreshCurrent().catch(() => {})
          return value
        } catch (error) {
          if (error?.code === 'dsh-notifier/conflict' || error?.code === 'dsh-notifier/already-handled') {
            await refreshCurrent().catch(() => {})
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
      // v0.15（T24）：远程入口 URL 校验。纯只读 RPC（零写、零网络、不 touch revision）。
      async function validateRemoteUrl(url) {
        return rpc.call('remote.validate', { url })
      }
      async function updateMember(key, diff) {
        const busyKey = `member:${key}`
        setBusy(busyKey, true)
        try {
          const value = await rpc.call('members.update', { key, ...diff })
          await loadMembers().catch(() => {})
          return value
        } finally {
          setBusy(busyKey, false)
        }
      }
      async function removeMember(key) {
        const busyKey = `member:${key}`
        setBusy(busyKey, true)
        try {
          const value = await rpc.call('members.remove', { key })
          await loadMembers().catch(() => {})
          return value
        } finally {
          setBusy(busyKey, false)
        }
      }
      async function approvePending(key) {
        const busyKey = `pending:${key}`
        setBusy(busyKey, true)
        try {
          const value = await rpc.call('members.approve', { key })
          await loadPending().catch(() => {})
          return value
        } finally {
          setBusy(busyKey, false)
        }
      }
      async function dismissPending(key) {
        const busyKey = `pending:${key}`
        setBusy(busyKey, true)
        try {
          const value = await rpc.call('members.dismiss', { key })
          await loadPending().catch(() => {})
          return value
        } finally {
          setBusy(busyKey, false)
        }
      }
      async function mintPairingCode(label = '') {
        setBusy('pairing:mint', true)
        try {
          const value = await rpc.call('pairing.mint', { label })
          await loadPairingCodes().catch(() => {})
          return value
        } finally {
          setBusy('pairing:mint', false)
        }
      }
      async function revokePairingCode(id) {
        const busyKey = `pairing:${id}`
        setBusy(busyKey, true)
        try {
          const value = await rpc.call('pairing.revoke', { id })
          await loadPairingCodes().catch(() => {})
          return value
        } finally {
          setBusy(busyKey, false)
        }
      }
      async function patchSessionOutbound(id, diff) {
        const busyKey = `session:${id}`
        setBusy(busyKey, true)
        try {
          const value = await rpc.call('sessions.patch', { id, diff })
          await loadSessions().catch(() => {})
          return value
        } finally {
          setBusy(busyKey, false)
        }
      }
      // v0.14（Stage E / P1-10）：控制覆盖层写入；写到当前 Session Detail 时重载详情而非列表。
      async function patchSessionControl(id, diff) {
        const busyKey = `session-control:${id}`
        setBusy(busyKey, true)
        try {
          const value = await rpc.call('sessions.control', { id, diff })
          if (snapshot.view.kind === 'session' && snapshot.view.id === id) await loadSession(id).catch(() => {})
          return value
        } finally {
          setBusy(busyKey, false)
        }
      }
      async function loadBindings() {
        const generation = ++generations.bindings
        try {
          const value = await rpc.call('bindings.get')
          if (generation !== generations.bindings) return value
          commit('bindings', value)
          return value
        } catch (error) {
          if (generation !== generations.bindings) return null
          throw error
        }
      }
      // v0.14（S11）：诊断快照是只读 canonical 读；不写 revision、不记 activity。
      async function loadDiagnostics() {
        const generation = ++generations.diagnostics
        try {
          const value = await rpc.call('diagnostics.snapshot')
          if (generation !== generations.diagnostics) return value
          commit('diagnostics', value)
          return value
        } catch (error) {
          if (generation !== generations.diagnostics) return null
          throw error
        }
      }
      async function generateSupportReport() {
        setBusy('diagnostics:report', true)
        try {
          const value = await loadDiagnostics()
          return await deliverReport(buildSupportReport(value))
        } finally {
          setBusy('diagnostics:report', false)
        }
      }
      async function putBindings(patch) {
        setBusy('bindings:save', true)
        try {
          const value = await rpc.call('bindings.put', patch)
          await loadBindings().catch(() => {})
          return value
        } finally {
          setBusy('bindings:save', false)
        }
      }
      function navigate(view) {
        // v0.12.1（P2-10）：导航只负责切视图；目标视图的 mount effect 是唯一加载 owner。
        const changingChannel = view?.kind === 'channel'
          && (snapshot.view.kind !== 'channel' || snapshot.view.type !== view.type)
        if (changingChannel) generations.channel += 1
        // v0.14（Stage E）：切换 Session Detail 时先清缓存，避免 A 的详情在 B 加载前短暂显示。
        const changingSession = view?.kind === 'session'
          && (snapshot.view.kind !== 'session' || snapshot.view.id !== view.id)
        if (changingSession) generations.session += 1
        emit({
          view,
          error: null,
          ...(changingChannel ? { channel: null } : {}),
          ...(changingSession ? { session: null } : {}),
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
        loadHome, loadChannels, loadChannel, loadTasks, loadQuestions, loadMembers, loadPending, loadPairingCodes, loadSessions, loadSession, loadBindings, loadActivity, loadDiagnostics,
        refreshCurrent, saveChannel, testChannel, settleQuestion, createStandaloneLaunch, validateRemoteUrl,
        exportConfig: () => rpc.call('portability.export'),
        previewImport: text => rpc.call('portability.preview', { text }),
        commitImport: (token, selections) => rpc.call('portability.commit', { token, selections }),
        cancelImport: token => rpc.call('portability.cancel', { token }),
        readImported: () => rpc.call('portability.readBack'),
        cloudCall: (method, payload = {}) => rpc.call(`cloudflare.${method}`, payload),
        updateMember, removeMember, approvePending, dismissPending, mintPairingCode, revokePairingCode, patchSessionOutbound, patchSessionControl, putBindings, generateSupportReport,
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
    function ConfirmButton({ children, confirmLabel, busy, disabled, onConfirm, t, kind = 'default', impact }) {
      const [armed, setArmed] = useState(false)
      useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(false), 4000)
        return () => clearTimeout(timer)
      }, [armed])
      if (!armed) {
        return h(Button, { kind, disabled, onClick: () => setArmed(true) }, children)
      }
      return h('span', { className: 'dn-confirm' },
        impact ? h('span', { className: 'dn-confirmImpact' }, impact) : null,
        h(Button, {
          kind: 'danger',
          disabled,
          onClick: () => { setArmed(false); onConfirm() },
        }, busy ? children : (confirmLabel ?? children)),
        h(Button, { autoFocus: true, disabled, onClick: () => setArmed(false) }, t('cancelAction')))
    }

    // v0.14（Stage E / P1-10）：原始标识默认脱敏——保留首尾少量字符，中间打码。
    // 仅在用户显式展开 raw 区时渲染完整值（见 RawIdentifiers）。
    function redactIdentifier(value) {
      const raw = String(value ?? '')
      if (raw === '') return ''
      if (raw.length <= 4) return `${raw.slice(0, 1)}***`
      if (raw.length <= 10) return `${raw.slice(0, 2)}***${raw.slice(-2)}`
      return `${raw.slice(0, 3)}***${raw.slice(-3)}`
    }

    function RawIdentifiers({ t, value }) {
      return h('details', { className: 'dn-detail' },
        h('summary', null, t('viewRawIdentifiers')),
        h('p', { className: 'dn-note' }, t('rawIdentifiersNote')),
        h('pre', { className: 'dn-raw' }, JSON.stringify(value, (key, item) => (
          typeof item === 'string' && key !== '' && /id|key|user|owner|member|account/i.test(key)
            ? redactIdentifier(item)
            : item
        ), 2)))
    }

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
    function listBody({ data, error, connectionState, staleAt, t, rows, emptyKey, render }) {
      if (data === null || data === undefined) {
        if (error) {
          return [h('p', { className: 'dn-empty', role: 'alert', key: 'nodata' }, `${t('unavailableList')} · ${error?.message || t('unknownError')}`)]
        }
        return [h('p', { className: 'dn-inlineStatus', key: 'loading' }, h(StateDot, { state: 'ongoing' }), t('loading'))]
      }
      if (!rows.length) return [h('p', { className: 'dn-empty', key: 'empty' }, t(emptyKey))]
      return [
        connectionState === 'stale' && staleAt
          ? h('p', { className: 'dn-rowMeta dn-stale', role: 'status', key: 'stale' }, `${t('staleUpdatedAt')} · ${new Date(staleAt).toLocaleTimeString()}`)
          : null,
        ...rows.map(render),
      ]
    }

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
    function TelegramConnection({ ctx, controller, value, onChange, onDirect, hasGatewayKey, disabled, enableDisabled = disabled }) {
      const words = (zh, en) => String(ctx?.locale?.current ?? 'zh').startsWith('en') ? en : zh
      const [custom, setCustom] = useState(!!value && value !== 'https://api.telegram.org')
      useEffect(() => { if (value && value !== 'https://api.telegram.org') setCustom(true) }, [value])
      return h('div', { className: 'dn-field' },
        h('label', null, words('连接方式', 'Connection'), h('select', {
          'aria-label': 'Telegram connection', value: custom ? 'custom' : 'direct', disabled,
          onChange: e => { const next = e.target.value === 'custom'; setCustom(next); if (!next) onDirect() },
        }, h('option', { value: 'direct' }, words('直连', 'Direct')), h('option', { value: 'custom' }, words('自定义网关地址', 'Custom gateway address')))),
        custom ? h('label', null, words('网关地址', 'Gateway address'), h('input', { type: 'url', 'aria-label': 'Telegram gateway address', value: value ?? '', placeholder: 'https://…', disabled, onChange: e => onChange(e.target.value) })) : null,
        custom && hasGatewayKey ? h('p', { className: 'dn-note' }, words('已使用自建网关。更换机器人凭证后，请重新开启网关。', 'Using a private gateway. Enable it again after changing the bot token.')) : null,
        h(Button, { disabled: enableDisabled, onClick: () => controller.navigate({ kind: 'cloudflare', type: 'telegram', activate: true }) }, words('一键开启网关', 'Enable gateway')),
        enableDisabled ? h('p', { className: 'dn-note' }, words('先保存当前修改，再开启网关。', 'Save your changes before enabling the gateway.')) : null)
    }

    function ChannelDirectionSection({ ctx, controller, state, t, type, direction, section, onDirtyChange, importDraft }) {
      const fields = section?.fields ?? {}
      const [patch, setPatch] = useState({})
      const [dirty, setDirty] = useState(new Set())
      const [secretModes, setSecretModes] = useState({})
      const [saveNotice, setSaveNotice] = useState(null)
      const [testResult, setTestResult] = useState(null)
      const dirtyRef = useRef(dirty)
      const revisions = useRef(null)

      // 服务端 revision 变化时，把**未编辑**字段同步到最新投影；dirty 字段保留本地草稿。
      useEffect(() => {
        const nextRevision = section?.configRevision ?? null
        if (revisions.current === nextRevision) return
        revisions.current = nextRevision
        setPatch(current => {
          const next = { ...current }
          for (const [key, value] of Object.entries(section?.editableValues ?? {})) {
            if (!dirtyRef.current.has(key)) next[key] = value
          }
          return next
        })
      }, [section?.configRevision])

      // 挂载时恢复本方向非 secret 短时草稿（secret 从不落盘）。
      useEffect(() => {
        const restored = importDraft ?? loadDraft(direction, type, fields)
        if (restored === null) return
        setPatch(current => ({ ...current, ...restored }))
        const set = new Set(Object.keys(restored))
        dirtyRef.current = set
        setDirty(set)
      }, [])

      // 非 secret 短时草稿持久化；无 dirty 时清除，避免把服务端值误当草稿。
      useEffect(() => {
        if (dirty.size > 0) saveDraft(direction, type, patch, fields)
      }, [patch, dirty])

      useEffect(() => { onDirtyChange?.(direction, dirty.size > 0) }, [dirty, direction, onDirtyChange])

      const setField = (key, value) => {
        setDirty(current => {
          const set = new Set(current); set.add(key)
          dirtyRef.current = set
          return set
        })
        setPatch(current => ({ ...current, [key]: value }))
      }
      const setSecretMode = (key, mode) => {
        setSecretModes(current => ({ ...current, [key]: mode }))
        setDirty(current => {
          const set = new Set(current)
          if (mode === 'keep') set.delete(key); else set.add(key)
          dirtyRef.current = set
          return set
        })
        if (mode !== 'replace') {
          setPatch(current => {
            if (!Object.prototype.hasOwnProperty.call(current, key)) return current
            const next = { ...current }; delete next[key]; return next
          })
        }
      }
      const save = async () => {
        const payload = {}
        const clear = []
        for (const key of dirty) {
          // U06：secret 显式「清除」→ 走 patch 的 clear 列表；不把掩码当值写回。
          if (fields[key]?.secret === true && (secretModes[key] ?? 'keep') === 'clear') { clear.push(key); continue }
          payload[key] = patch[key]
        }
        if (Object.keys(payload).length === 0 && clear.length === 0) return
        setSaveNotice(null)
        try {
          const receipt = await controller.saveChannel(type, direction, clear.length > 0 ? { ...payload, clear } : payload)
          if (receipt?.duplicate === true) return
          if (receipt?.saved !== false) {
            setPatch(current => {
              const next = { ...current }
              for (const key of Object.keys(payload)) if (fields[key]?.secret === true) delete next[key]
              for (const key of clear) delete next[key]
              return next
            })
            setSecretModes({})
            const set = new Set()
            dirtyRef.current = set
            setDirty(set)
            clearDraft(direction, type)
            setSaveNotice(receipt?.refreshed === false
              ? { kind: 'warn', text: t('savedRefreshFailed') }
              : { kind: 'ok', text: t('savedOk') })
          }
        } catch (error) {
          // 落盘/校验失败：草稿保留（U02），错误经统一出口展示。
          controller.reportError(error)
        }
      }

      const saveBusy = state?.busy?.[`save:${type}:${direction}`] === true
      const testBusy = state?.busy?.[`test:${type}`] === true
      const hasDirty = dirty.size > 0
      const outcome = testResult ? testOutcome(ctx, testResult, t) : null
      const runTest = () => {
        void controller.testChannel(type).then(setTestResult).catch(error => {
          // channels.test 的失败也走证据分级：unknown（无法确认），而不是「失败可重发」。
          if (error?.code === 'dsh-notifier/not-supported' || error?.code === 'not-supported') {
            controller.reportError(error)
            return
          }
          setTestResult({ status: 'unknown', reasonCode: 'provider-error', detail: { en: String(error?.message ?? ''), zh: String(error?.message ?? '') } })
        })
      }
      if (!section) return null
      return h(Section, { title: direction === 'outbound' ? t('notify') : t('control') },
        type === 'telegram' ? h(TelegramConnection, { ctx, controller, value: patch.apiBase, onChange: value => setField('apiBase', value), onDirect: () => { setField('apiBase', ''); setSecretMode('gatewayKey', 'clear') }, hasGatewayKey: fields.gatewayKey?.configured === true, disabled: saveBusy, enableDisabled: saveBusy || hasDirty }) : null,
        ...Object.entries(fields).filter(([key]) => type !== 'telegram' || !['apiBase', 'gatewayKey'].includes(key)).map(([key, meta]) => h(SchemaField, {
          key, ctx, name: key, meta,
          value: patch[key],
          onChange: value => setField(key, value),
          secretMode: secretModes[key],
          onSecretMode: mode => setSecretMode(key, mode),
          t,
        })),
        h('div', { className: 'dn-formActions' },
          h(Button, { kind: 'primary', disabled: saveBusy || !hasDirty, onClick: () => void save() }, saveBusy ? t('saving') : t('save')),
          direction === 'outbound'
            ? h(Button, {
                // v0.15（T18 / U03）：只测已保存配置；有未保存修改时先保存，绝不静默 save+send。
                disabled: testBusy || hasDirty,
                title: hasDirty ? t('unsavedChangesHint') : t('testCommittedConfig'),
                onClick: runTest,
              }, testBusy ? t('testing') : t('test')) : null),
        saveNotice
          ? h('p', {
              className: saveNotice.kind === 'ok' ? 'dn-successText' : 'dn-error',
              role: saveNotice.kind === 'ok' ? 'status' : 'alert',
              'aria-live': 'polite',
            }, saveNotice.text)
          : null,
        direction === 'outbound' && hasDirty ? h('p', { className: 'dn-note' }, t('unsavedChangesHint')) : null,
        h('p', { className: 'dn-rowMeta' }, section.applyMode === 'hot' ? t('applyHot') : section.applyMode === 'restart' ? t('applyRestart') : ''),
        direction === 'inbound' && section.applyMode === 'restart' ? h('p', { className: 'dn-note' }, t('inboundRestartHint')) : null,
        direction === 'outbound' && section.restartPending === true ? h('p', { className: 'dn-note' }, t('outboundRestartHint')) : null,
        direction === 'outbound' && outcome
          ? h('p', {
              className: outcome.ok ? 'dn-successText' : 'dn-error',
              role: outcome.ok ? 'status' : 'alert',
              'aria-live': 'polite',
            }, `${outcome.title} · ${outcome.note}`)
          : null)
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
      const navRow = (items, className, labelKey) => h('nav', { className: `dn-nav ${className}`, 'aria-label': t(labelKey) },
        ...items.map(([kind, key]) =>
          h('button', { key: kind, type: 'button', className: 'dn-navBtn', onClick: () => controller.navigate({ kind }) }, t(key))))
      return h('div', { className: 'dn-page' },
        h(PageHead, { title: t('title'), intro: t('intro'), actions }),
        // v0.15（T19 / U11）：日常一步可达；管理组独立但仍在 Native 内全部可达。
        navRow(NAV_DAILY, 'dn-nav--daily', 'navDaily'),
        h('p', { className: 'dn-navCaption' }, t('navManage')),
        navRow(NAV_MANAGE, 'dn-nav--manage', 'navManage'),
        h(StatusRow, { ctx, summary: home?.summary, t, onRetry: () => void controller.refreshCurrent() }),
        state.connectionState === 'stale'
          ? h('p', { className: 'dn-error', role: 'status' }, t('staleData'))
          : state.connectionState === 'disconnected'
            ? h('p', { className: 'dn-error', role: 'alert' }, t('connectionLost'))
          : null,
        home === null && state.error
          ? h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadHome().catch(error => controller.reportError(error)) })
          : null,
        (home?.questions?.length ?? 0) > 0
          ? h(Section, {
              title: `${t('needsAttention')}  ${home.questions.length}`,
              action: h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'questions' }) }, `${t('viewAll')} →`),
            },
              ...home.questions.slice(0, 3).map(question =>
                h(QuestionCard, {
                  key: question.ref, ctx, question, controller, t,
                  busy: state.busy[`question:${question.ref}`] === true,
                })))
          : null,
        h(Section, {
          title: t('running'),
          action: h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'tasks' }) }, `${t('viewAll')} →`),
        }, ...(home?.tasks?.length ? home.tasks.slice(0, 5).map(task => h(TaskRow, { key: task.taskRef, ctx, task })) : home === null ? [h('p', { className: 'dn-inlineStatus', key: 'loading' }, h(StateDot, { state: 'ongoing' }), t('loading'))] : [h('p', { className: 'dn-empty', key: 'empty' }, t('noTasks'))])),
        h(Section, {
          title: t('channels'),
          action: h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'channels' }) }, `${t('manageChannels')} →`),
        }, ...(home?.channels?.length ? home.channels.slice(0, 5).map(channel =>
          h(ChannelRow, { key: channel.type, ctx, channel, t, onOpen: () => controller.navigate({ kind: 'channel', type: channel.type }) }))
          : home === null ? [h('p', { className: 'dn-inlineStatus', key: 'loading' }, h(StateDot, { state: 'ongoing' }), t('loading'))]
            : [h('div', { className: 'dn-emptyState', key: 'empty' },
              h('strong', null, t('noChannels')),
              h('span', null, t('noChannelsHint')),
              h(Button, { kind: 'primary', onClick: () => controller.navigate({ kind: 'channels', setup: true }) }, t('setupChannel')))])),
        h(Section, {
          title: t('activity'),
          action: h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'activity' }) }, `${t('viewAll')} →`),
        }, ...(home?.activity?.length ? home.activity.slice(0, 5).map(item => h(ActivityRow, { key: item.id, ctx, item })) : home === null ? [h('p', { className: 'dn-inlineStatus', key: 'loading' }, h(StateDot, { state: 'ongoing' }), t('loading'))] : [h('p', { className: 'dn-empty', key: 'empty' }, t('noActivity'))])))
    }

    // v0.15（T18 / U03 / U12）：保存与测试解耦——保存成立后即可「完成」，测试完全可选；
    // 测试只针对**已保存**的配置（绝不静默 save+send）；测试失败/无法确认不会困住用户。
    function SetupFlow({ ctx, controller, state, channels, onDone, t }) {
      const [type, setType] = useState(null)
      const [draft, setDraft] = useState({})
      const [phase, setPhase] = useState('choose') // choose | form | saved | testing | done
      const [saved, setSaved] = useState(null)
      const [testResult, setTestResult] = useState(null)
      const [error, setError] = useState(null)
      // v0.15（T19 / U07）：离开未保存草稿需可取消。
      const [leaveArmed, setLeaveArmed] = useState(false)
      const candidates = (channels ?? []).filter(channel => channel?.notify?.editable !== false)
      const selected = candidates.find(channel => channel.type === type)
      const fields = selected?.notify?.fields ?? {}
      const setField = (key, value) => setDraft(current => ({ ...current, [key]: value }))
      // 非 secret 短时草稿保留；secret 明文永不落 Web 存储（U07）。
      useEffect(() => {
        if (phase === 'form' && type !== null && Object.keys(draft).length > 0) saveDraft('setup', type, draft, fields)
      }, [draft, phase, type])
      const saveBusy = type !== null && state?.busy?.[`save:${type}:outbound`] === true
      const testBusy = type !== null && state?.busy?.[`test:${type}`] === true
      const save = async () => {
        setError(null)
        setTestResult(null)
        try {
          const receipt = await controller.saveChannel(type, 'outbound', draft)
          // Secret 明文只写：保存成立后立即从 React state 驱逐（刷新投影只带 configured）。
          setDraft(current => Object.fromEntries(
            Object.entries(current).filter(([key]) => fields[key]?.secret !== true),
          ))
          clearDraft('setup', type)
          setSaved(receipt ?? null)
          setPhase('saved')
        } catch (err) {
          setError(err)
          setPhase('form')
        }
      }
      const test = async () => {
        setError(null)
        setTestResult(null)
        setPhase('testing')
        try {
          const result = await controller.testChannel(type)
          setTestResult(result)
          const good = result?.confirmed === true || result?.accepted === true
            || result?.status === 'delivered' || result?.status === 'accepted' || result?.delivered === true
          setPhase(good ? 'done' : 'saved')
        } catch (err) {
          setError(err)
          setPhase('saved')
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
                onClick: () => {
                  setType(channel.type)
                  // 恢复该类型此前的非 secret 短时草稿（若有）。
                  setDraft(loadDraft('setup', channel.type, channel?.notify?.fields ?? {}) ?? {})
                  setPhase('form')
                },
              }, resolveText(ctx, channel.label) || channel.type, h('span', null, '›')))))
      }
      const outcome = testResult ? testOutcome(ctx, testResult, t) : null
      const body = phase === 'form'
        ? [
            type === 'telegram' ? h(TelegramConnection, { key: 'connection', ctx, controller, value: draft.apiBase, onChange: value => setField('apiBase', value), onDirect: () => setField('apiBase', ''), disabled: saveBusy, enableDisabled: true }) : null,
            ...Object.entries(fields).filter(([key]) => type !== 'telegram' || !['apiBase', 'gatewayKey'].includes(key)).map(([key, meta]) => h(SchemaField, {
              key, ctx, name: key, meta,
              value: draft[key],
              onChange: value => setField(key, value),
              t,
            })),
            error ? h('p', { className: 'dn-error', role: 'alert', key: 'err' }, error?.message || t('unknownError')) : null,
            h('p', { className: 'dn-note', key: 'note' }, t('noAccountNote')),
            h('div', { className: 'dn-formActions', key: 'actions' },
              h(Button, {
                kind: 'primary',
                disabled: saveBusy || Object.keys(draft).length === 0,
                onClick: () => void save(),
              }, saveBusy ? t('saving') : t('save'))),
          ]
        : [
            h('p', { className: 'dn-successText', key: 'saved' }, t('savedOk')),
            saved?.restartPending === true || saved?.applyMode === 'restart-pending'
              ? h('p', { className: 'dn-note', key: 'restart' }, t('outboundRestartHint')) : null,
            h('p', { className: 'dn-note', key: 'pendingTest' }, t('savedPendingTest')),
            outcome
              ? h('p', {
                  className: outcome.ok ? 'dn-successText' : 'dn-error',
                  role: outcome.ok ? undefined : 'alert',
                  key: 'outcome',
                }, `${outcome.title} · ${outcome.note}`)
              : null,
            error ? h('p', { className: 'dn-error', role: 'alert', key: 'err' }, error?.message || t('unknownError')) : null,
            phase === 'testing' ? h('p', { className: 'dn-inlineStatus', key: 'testing' }, h(StateDot, { state: 'ongoing' }), t('testing')) : null,
            h('div', { className: 'dn-formActions', key: 'actions' },
              h(Button, {
                disabled: testBusy || phase === 'testing',
                onClick: () => void test(),
              }, testBusy || phase === 'testing' ? t('testing') : t('test')),
              h(Button, { kind: 'primary', onClick: onDone }, t('complete'))),
          ]
      const goBack = () => {
        // U07：未保存草稿时离开需可取消；确认后才丢弃。
        if (phase === 'form' && Object.keys(draft).length > 0) { setLeaveArmed(true); return }
        setPhase('choose'); setType(null)
      }
      return h('div', { className: 'dn-setupCard' },
        h('div', { className: 'dn-detailBack' },
          h('button', { className: 'dn-link', onClick: goBack }, `← ${t('back')}`)),
        h('h2', null, resolveText(ctx, selected?.label) || type),
        leaveArmed
          ? h('div', { className: 'dn-leaveGuard', role: 'alertdialog', 'aria-label': t('unsavedLeaveTitle') },
              h('strong', null, t('unsavedLeaveTitle')),
              h('p', { className: 'dn-note' }, t('unsavedLeaveBody')),
              h('div', { className: 'dn-formActions' },
                h(Button, { autoFocus: true, onClick: () => setLeaveArmed(false) }, t('leaveStay')),
                h(Button, {
                  kind: 'danger',
                  onClick: () => {
                    setLeaveArmed(false)
                    if (type !== null) clearDraft('setup', type)
                    setDraft({})
                    setPhase('choose')
                    setType(null)
                  },
                }, t('leaveDiscard'))))
          : null,
        ...body)
    }

    function ChannelsView({ ctx, controller, state, t }) {
      const data = state.channels
      useEffect(() => { void controller.loadChannels().catch(error => controller.reportError(error)) }, [])
      const [setup, setSetup] = useState(state.view.setup === true)
      const channels = data?.channels ?? []
      if (setup) return h('div', { className: 'dn-page' },
        h(PageHead, { title: t('setupChannel') }),
        h(SetupFlow, { ctx, controller, state, channels, t, onDone: () => { setSetup(false); void controller.loadChannels().catch(error => controller.reportError(error)) } }))
      return h('div', { className: 'dn-page' },
        h(PageHead, {
          title: t('channels'),
          actions: h('div', { className: 'dn-formActions' },
            h(Button, { onClick: () => controller.navigate({ kind: 'portability' }) }, t('configTransfer')),
            h(Button, { onClick: () => controller.navigate({ kind: 'cloudflare' }) }, t('cloudflare')),
            h(Button, { kind: 'primary', onClick: () => setSetup(true) }, t('addChannel'))),
        }),
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadChannels().catch(error => controller.reportError(error)) }),
        h('div', { className: 'dn-list' },
          ...listBody({
            data, error: state.error, connectionState: state.connectionState, staleAt: state.staleAt, t,
            rows: channels, emptyKey: 'noChannels',
            render: channel => h(ChannelRow, {
              key: channel.type, ctx, channel, t,
              onOpen: () => controller.navigate({ kind: 'channel', type: channel.type }),
            }),
          })))
    }

    function ChannelDetailView({ ctx, controller, state, t }) {
      const type = state.view.type
      const backRef = useRef(null)
      // v0.15（T19 / U07）：聚合两个方向的 dirty，用于离开确认；写权威仍在 authority。
      const [dirtyMap, setDirtyMap] = useState({ outbound: false, inbound: false })
      const [leaveArmed, setLeaveArmed] = useState(false)
      useEffect(() => { void controller.loadChannel(type).catch(error => controller.reportError(error)) }, [type])
      const onDirtyChange = useCallback((direction, isDirty) => {
        setDirtyMap(current => current[direction] === isDirty ? current : { ...current, [direction]: isDirty })
      }, [])

      const channel = state.channel?.channel
      const hasUnsaved = dirtyMap.outbound === true || dirtyMap.inbound === true
      const closeLeave = () => {
        setLeaveArmed(false)
        try { backRef.current?.focus?.() } catch { /* 焦点回退是增强，不是必需 */ }
      }
      const goBack = () => {
        if (hasUnsaved) { setLeaveArmed(true); return }
        controller.navigate({ kind: 'channels' })
      }
      if (!channel) {
        // v0.15（T18 / U04）：读取中与读取失败必须可区分——服务缺失/失败不能显示成「正在读取」。
        return h('div', { className: 'dn-page' },
          h('div', { className: 'dn-detailBack' },
            h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'channels' }) }, `← ${t('back')}`)),
          h(PageHead, { title: type }),
          h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadChannel(type).catch(error => controller.reportError(error)) }),
          state.error
            ? null
            : h('p', { className: 'dn-inlineStatus', 'aria-live': 'polite' }, h(StateDot, { state: 'ongoing' }), t('loading')))
      }

      const health = channel.health ?? {}
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' },
          h('button', { ref: backRef, className: 'dn-link', onClick: goBack }, `← ${t('back')}`)),
        h(PageHead, { title: resolveText(ctx, channel.label) || type }),
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadChannel(type).catch(error => controller.reportError(error)) }),
        leaveArmed
          ? h('div', { className: 'dn-leaveGuard', role: 'alertdialog', 'aria-label': t('unsavedLeaveTitle') },
              h('strong', null, t('unsavedLeaveTitle')),
              h('p', { className: 'dn-note' }, t('unsavedLeaveBody')),
              h('div', { className: 'dn-formActions' },
                h(Button, { autoFocus: true, onClick: closeLeave }, t('leaveStay')),
                h(Button, {
                  kind: 'danger',
                  onClick: () => { setLeaveArmed(false); controller.navigate({ kind: 'channels' }) },
                }, t('leaveDiscard'))))
          : null,
        // U05：模块级稳定组件——父级轮询/状态更新不会让它 remount，输入焦点与 caret 保留。
        h(ChannelDirectionSection, { ctx, controller, state, t, type, direction: 'outbound', section: channel.notify, onDirtyChange, importDraft: state.view.importDirection === 'outbound' ? state.view.importDraft : null }),
        h(ChannelDirectionSection, { ctx, controller, state, t, type, direction: 'inbound', section: channel.control, onDirtyChange, importDraft: state.view.importDirection === 'inbound' ? state.view.importDraft : null }),
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
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadTasks().catch(error => controller.reportError(error)) }),
        h('div', { className: 'dn-list' },
          ...listBody({
            data: state.tasks, error: state.error, connectionState: state.connectionState, staleAt: state.staleAt, t,
            rows: state.tasks?.tasks ?? [], emptyKey: 'noTasks',
            render: task => h(TaskRow, { key: task.taskRef, ctx, task }),
          })))
    }

    function QuestionsView({ ctx, controller, state, t }) {
      useEffect(() => { void controller.loadQuestions().catch(error => controller.reportError(error)) }, [])
      const rows = state.questions?.questions ?? []
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'home' }) }, `← ${t('back')}`)),
        h(PageHead, { title: t('questions') }),
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadQuestions().catch(error => controller.reportError(error)) }),
        h('div', { className: 'dn-list' },
          ...listBody({
            data: state.questions, error: state.error, connectionState: state.connectionState, staleAt: state.staleAt, t,
            rows, emptyKey: 'noQuestions',
            render: question => h(QuestionCard, {
              key: question.ref, ctx, question, controller, t,
              busy: state.busy[`question:${question.ref}`] === true,
            }),
          })))
    }

    function MemberRow({ ctx, member, controller, t, busy, canUpdate, canRemove }) {
      const isOwner = member?.role === 'owner'
      const name = String(member?.label || member?.userId || member?.key || '')
      const meta = [member?.channel, member?.accountId, isOwner ? t('owner') : t('roleMember')].filter(Boolean).join(' · ')
      return h('div', { className: 'dn-row' },
        h(StateDot, { state: isOwner ? 'done' : 'idle' }),
        h('div', { className: 'dn-rowMain' },
          h('strong', { className: 'dn-rowTitle' }, name),
          h('span', { className: 'dn-rowMeta' }, meta)),
        h('div', { className: 'dn-rowAside' },
          // v0.15（T19 / U13）：降权（owner→member）是破坏性操作，需确认并说明后果；
          // 升权不改权限边界，保持一步直达。last-owner 由 authority 在事务内拦住，UI 预检不独自保证。
          canUpdate
            ? (isOwner
                ? h(ConfirmButton, {
                    t,
                    kind: 'default',
                    confirmLabel: t('confirmDemote'),
                    impact: `${name} · ${t('memberDemoteImpact')}`,
                    busy,
                    disabled: busy,
                    onConfirm: () => void controller.updateMember(member.key, { role: 'member' }).catch(error => controller.reportError(error)),
                  }, busy ? t('updating') : t('demote'))
                : h(Button, {
                    disabled: busy,
                    onClick: () => void controller.updateMember(member.key, { role: 'owner' }).catch(error => controller.reportError(error)),
                  }, t('promote')))
            : null,
          canRemove
            ? h(ConfirmButton, {
                t,
                kind: 'default',
                confirmLabel: t('confirmRemove'),
                impact: `${name} · ${t('memberRemoveImpact')}`,
                busy,
                disabled: busy,
                onConfirm: () => void controller.removeMember(member.key).catch(error => controller.reportError(error)),
              }, busy ? t('removing') : t('remove'))
            : null))
    }

    function MembersView({ ctx, controller, state, t }) {
      useEffect(() => { void controller.loadMembers().catch(error => controller.reportError(error)) }, [])
      const rows = state.members?.members ?? []
      const canUpdate = state.members?.canUpdate === true
      const canRemove = state.members?.canRemove === true
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'home' }) }, `← ${t('back')}`)),
        h(PageHead, { title: t('members') }),
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadMembers().catch(error => controller.reportError(error)) }),
        h('div', { className: 'dn-list' },
          ...listBody({
            data: state.members, error: state.error, connectionState: state.connectionState, staleAt: state.staleAt, t,
            rows, emptyKey: 'noMembers',
            render: member => h(MemberRow, {
              key: member.key, ctx, member, controller, t,
              busy: state.busy[`member:${member.key}`] === true, canUpdate, canRemove,
            }),
          })))
    }

    function PendingRow({ member, controller, t, busy, canApprove, canDismiss }) {
      const meta = [member?.channel, member?.accountId, member?.origin].filter(Boolean).join(' · ')
      return h('div', { className: 'dn-row' },
        h(StateDot, { state: 'warn' }),
        h('div', { className: 'dn-rowMain' },
          h('strong', { className: 'dn-rowTitle' }, String(member?.userId || member?.key || '')),
          h('span', { className: 'dn-rowMeta' }, meta)),
        h('div', { className: 'dn-rowAside' },
          canApprove
            ? h(Button, {
                disabled: busy,
                onClick: () => void controller.approvePending(member.key).catch(error => controller.reportError(error)),
              }, t('approve'))
            : null,
          canDismiss
            ? h(Button, {
                disabled: busy,
                onClick: () => void controller.dismissPending(member.key).catch(error => controller.reportError(error)),
              }, t('dismiss'))
            : null))
    }

    function PendingIdentitiesView({ ctx, controller, state, t }) {
      useEffect(() => { void controller.loadPending().catch(error => controller.reportError(error)) }, [])
      const rows = state.pending?.pending ?? []
      const canApprove = state.pending?.canApprove === true
      const canDismiss = state.pending?.canDismiss === true
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'home' }) }, `← ${t('back')}`)),
        h(PageHead, { title: t('pendingIdentities') }),
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadPending().catch(error => controller.reportError(error)) }),
        h('div', { className: 'dn-list' },
          ...listBody({
            data: state.pending, error: state.error, connectionState: state.connectionState, staleAt: state.staleAt, t,
            rows, emptyKey: 'noPending',
            render: member => h(PendingRow, {
              key: member.key, member, controller, t,
              busy: state.busy[`pending:${member.key}`] === true, canApprove, canDismiss,
            }),
          })))
    }

    function PairingCodeRow({ code, controller, t, busy, canRevoke }) {
      const meta = [code?.origin, code?.mintedBy, code?.state].filter(Boolean).join(' · ')
      return h('div', { className: 'dn-row' },
        h(StateDot, { state: 'idle' }),
        h('div', { className: 'dn-rowMain' },
          h('strong', { className: 'dn-rowTitle' }, String(code?.label || code?.id || '')),
          h('span', { className: 'dn-rowMeta' }, meta)),
        h('div', { className: 'dn-rowAside' },
          canRevoke
            ? h(ConfirmButton, {
                t,
                confirmLabel: t('confirmRevoke'),
                busy,
                disabled: busy,
                onConfirm: () => void controller.revokePairingCode(code.id).catch(error => controller.reportError(error)),
              }, busy ? t('revoking') : t('revoke'))
            : null))
    }

    function PairingCodesView({ ctx, controller, state, t }) {
      useEffect(() => { void controller.loadPairingCodes().catch(error => controller.reportError(error)) }, [])
      // 码面只在本次响应出现一次：本地持有、刷新即丢（不落任何持久层）。
      const [minted, setMinted] = useState(null)
      const [label, setLabel] = useState('')
      // v0.15（T19 / U10）：复制结果的**局部**状态（null | 'copied' | 'unavailable'）。
      const [copyState, setCopyState] = useState(null)
      const codeRef = useRef(null)
      const onCopy = () => {
        void copyText(String(minted?.code ?? '')).then(ok => {
          setCopyState(ok ? 'copied' : 'unavailable')
          // 无剪贴板能力时给出**手动 fallback**：选中码面，用户可直接 Ctrl/Cmd-C。
          if (!ok && codeRef.current && typeof window?.getSelection === 'function') {
            try {
              const range = document.createRange()
              range.selectNodeContents(codeRef.current)
              const selection = window.getSelection()
              selection.removeAllRanges()
              selection.addRange(range)
            } catch {}
          }
        })
      }
      const rows = state.pairing?.codes ?? []
      const canMint = state.pairing?.canMint === true
      const canRevoke = state.pairing?.canRevoke === true
      const busyMint = state.busy['pairing:mint'] === true
      const onMint = () => {
        void controller.mintPairingCode(label).then(value => {
          setMinted(value ?? null)
          setCopyState(null)
          setLabel('')
        }).catch(error => controller.reportError(error))
      }
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'home' }) }, `← ${t('back')}`)),
        h(PageHead, { title: t('pairingCodes') }),
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadPairingCodes().catch(error => controller.reportError(error)) }),
        canMint
          ? h('div', { className: 'dn-field' },
              h('input', {
                type: 'text', value: label, maxLength: 64, placeholder: t('labelOptional'),
                onChange: event => setLabel(event.target.value),
              }),
              h(Button, { kind: 'primary', disabled: busyMint, onClick: onMint }, busyMint ? t('minting') : t('mintCode')))
          : null,
        minted
          ? h('div', { className: 'dn-code', key: 'minted' },
              h('p', { className: 'dn-note' }, t('codeShownOnce')),
              h('code', { className: 'dn-codeValue', ref: codeRef, tabIndex: 0 }, String(minted.code ?? '')),
              h('div', { className: 'dn-formActions' },
                h(Button, { kind: 'primary', onClick: onCopy }, t('copyCode')),
                h('button', { className: 'dn-link', onClick: () => { setMinted(null); setCopyState(null) } }, t('clearCode'))),
              copyState
                ? h('p', { className: 'dn-note', role: 'status', 'aria-live': 'polite' },
                    copyState === 'copied' ? t('codeCopied') : t('copyUnavailableSelect'))
                : null)
          : null,
        h('div', { className: 'dn-list' },
          ...listBody({
            data: state.pairing, error: state.error, connectionState: state.connectionState, staleAt: state.staleAt, t,
            rows, emptyKey: 'noCodes',
            render: code => h(PairingCodeRow, {
              key: code.id, ctx, code, controller, t,
              busy: state.busy[`pairing:${code.id}`] === true, canRevoke,
            }),
          })))
    }

    function SessionRow({ ctx, controller, t, row, busy, canPatch }) {
      const active = row?.active === true
      const channels = row?.resolved?.channelTypes ?? []
      const quiet = row?.resolved?.quiet === true
      const meta = [
        active ? t('sessionActive') : t('sessionIdle'),
        channels.length ? channels.join(', ') : t('noChannelsResolved'),
        quiet ? t('silence') : null,
      ].filter(Boolean).join(' · ')
      return h('div', { className: 'dn-row' },
        h(StateDot, { state: active ? 'done' : 'idle' }),
        h('div', { className: 'dn-rowMain' },
          h('strong', { className: 'dn-rowTitle' }, String(row?.workspace || row?.id || '')),
          h('span', { className: 'dn-rowMeta' }, meta)),
        h('div', { className: 'dn-rowAside' },
          canPatch
            ? h(Button, {
                disabled: busy,
                onClick: () => void controller.patchSessionOutbound(row.id, { quiet: !quiet }).catch(error => controller.reportError(error)),
              }, quiet ? t('resumeNotify') : t('silence'))
            : null,
          // v0.14（Stage E / P1-10）：进入 Session Detail（路由 / 出站 / 控制 / 绑定）。
          h('button', {
            type: 'button', className: 'dn-link',
            onClick: () => controller.navigate({ kind: 'session', id: row.id }),
          }, t('openSession'))))
    }

    // v0.14（Stage E / P1-10）：Session Detail。只做投影与「写入口」编排——路由写权威在
    // agent-router、控制归一在 session-arbiter、生命周期在 session-registry，本视图不另造 authority。
    function SessionDetailSection({ title, children }) {
      return h('section', { className: 'dn-section' },
        h('h3', { className: 'dn-subhead' }, title),
        ...children)
    }

    function SourceLabel(source, t) {
      return source === 'session' ? t('sourceSession')
        : source === 'agent-workspace' ? t('sourceWorkspace')
          : source === 'global' ? t('sourceGlobal')
            : String(source ?? '')
    }

    function SessionDetailView({ ctx, controller, state, t }) {
      const id = state.view.id
      useEffect(() => { void controller.loadSession(id).catch(error => controller.reportError(error)) }, [id])
      const detail = state.session ?? null
      const session = detail?.session ?? null
      const canPatch = detail?.canPatch === true
      const canControl = detail?.canControl === true
      const busy = state.busy[`session:${id}`] === true
      const controlBusy = state.busy[`session-control:${id}`] === true
      const back = h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'sessions' }) }, `← ${t('back')}`))
      if (session === null) {
        return h('div', { className: 'dn-page' }, back,
          h(PageHead, { title: t('sessionDetail') }),
          h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadSession(id).catch(error => controller.reportError(error)) }),
          h('p', { className: 'dn-empty' }, t('loading')))
      }
      const resolved = session.resolved ?? {}
      const channels = Array.isArray(resolved.channelTypes) ? resolved.channelTypes : []
      const quiet = resolved.quiet === true
      const control = session.control ?? {}
      const modeValue = control.mode ?? null
      const nextMode = modeValue === 'team' ? 'personal' : 'team'
      const writeControl = (diff) => void controller.patchSessionControl(id, diff).catch(error => controller.reportError(error))
      const rowLine = (label, value) => h('p', { className: 'dn-rowMeta' }, `${label}: ${value}`)
      return h('div', { className: 'dn-page' },
        back,
        h(PageHead, { title: t('sessionDetail'), intro: String(session.workspace || session.id || '') }),
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadSession(id).catch(error => controller.reportError(error)) }),
        h(SessionDetailSection, { title: t('routingSection') }, [
          rowLine(t('workspaceLabel'), String(session.workspace || t('modeUnset'))),
          rowLine(t('inheritLabel'), String(session.inherit ?? t('modeUnset'))),
          rowLine(t('resolvedByLabel'), SourceLabel(resolved.source, t)),
          rowLine(t('outboundSection'), channels.length ? channels.join(', ') : t('noChannelsResolved')),
          rowLine(t('lastActiveLabel'), String(session.lastActiveAt ?? t('modeUnset'))),
          session.disposedAt !== undefined ? rowLine(t('disposedLabel'), String(session.disposedAt)) : null,
        ]),
        h(SessionDetailSection, { title: t('outboundSection') }, [
          canPatch
            ? h('div', { className: 'dn-formActions' },
                h(Button, {
                  disabled: busy,
                  onClick: () => void controller.patchSessionOutbound(id, { quiet: !quiet }).catch(error => controller.reportError(error)),
                }, quiet ? t('resumeNotify') : t('silence')))
            : h('p', { className: 'dn-note' }, t('unavailable')),
        ]),
        h(SessionDetailSection, { title: t('controlSection') }, [
          rowLine(t('modeLabel'), modeValue === 'team' ? t('modeTeam') : modeValue === 'personal' ? t('modePersonal') : t('modeUnset')),
          rowLine(t('approvalOwnerOnlyLabel'), control.approvalOwnerOnly === true ? t('yes') : t('no')),
          rowLine(t('ownerConfiguredLabel'), control.ownerConfigured === true ? t('yes') : t('no')),
          rowLine(t('approvalMembersCountLabel'), String(control.approvalMembersCount ?? 0)),
          canControl
            ? h('div', { className: 'dn-formActions' },
                h(Button, {
                  disabled: controlBusy,
                  onClick: () => writeControl({ mode: nextMode }),
                }, `${t('modeLabel')}: ${nextMode === 'team' ? t('modeTeam') : t('modePersonal')}`),
                h(Button, {
                  disabled: controlBusy,
                  onClick: () => writeControl({ approvalOwnerOnly: control.approvalOwnerOnly !== true }),
                }, `${t('approvalOwnerOnlyLabel')}: ${control.approvalOwnerOnly === true ? t('no') : t('yes')}`))
            : h('p', { className: 'dn-note' }, t('unavailable')),
        ]),
        h(SessionDetailSection, { title: t('bindingsSection') }, [
          h('p', { className: 'dn-rowMeta' }, `${t('inheritLabel')}: ${String(session.inherit ?? t('modeUnset'))}`),
          h('div', { className: 'dn-formActions' },
            h(Button, { onClick: () => controller.navigate({ kind: 'bindings' }) }, t('advancedBindings'))),
        ]),
        // 原始标识默认折叠 + 脱敏。
        h(RawIdentifiers, {
          t,
          value: { id: session.id, workspace: session.workspace, outbound: session.outbound ?? null, inbound: session.inbound ?? null, control: session.control ?? null },
        }))
    }

    function SessionsView({ ctx, controller, state, t }) {
      useEffect(() => { void controller.loadSessions().catch(error => controller.reportError(error)) }, [])
      const rows = state.sessions?.sessions ?? []
      const canPatch = state.sessions?.canPatch === true
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'home' }) }, `← ${t('back')}`)),
        h(PageHead, { title: t('sessions') }),
        h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'bindings' }) }, t('advancedBindings'))),
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadSessions().catch(error => controller.reportError(error)) }),
        h('div', { className: 'dn-list' },
          ...listBody({
            data: state.sessions, error: state.error, connectionState: state.connectionState, staleAt: state.staleAt, t,
            rows, emptyKey: 'noSessions',
            render: row => h(SessionRow, {
              key: row.id, ctx, controller, t, row,
              busy: state.busy[`session:${row.id}`] === true, canPatch,
            }),
          })))
    }

    function BindingAgentRow({ ctx, controller, t, table, name, entry, canEdit, busy }) {
      const channels = Array.isArray(entry?.channels) ? entry.channels : []
      const quiet = entry?.quiet === true
      const meta = [
        channels.length ? channels.join(', ') : t('noChannelsResolved'),
        quiet ? t('silence') : null,
      ].filter(Boolean).join(' · ')
      const write = (next) => {
        const nextTable = { ...table, [name]: next }
        return void controller.putBindings({ agents: nextTable }).catch(error => controller.reportError(error))
      }
      const remove = () => {
        const nextTable = { ...table }
        delete nextTable[name]
        return void controller.putBindings({ agents: nextTable }).catch(error => controller.reportError(error))
      }
      return h('div', { className: 'dn-row' },
        h(StateDot, { state: quiet ? 'idle' : 'done' }),
        h('div', { className: 'dn-rowMain' },
          h('strong', { className: 'dn-rowTitle' }, String(name)),
          h('span', { className: 'dn-rowMeta' }, meta)),
        h('div', { className: 'dn-rowAside' },
          canEdit
            ? h(Button, { disabled: busy, onClick: () => write({ ...entry, quiet: !quiet }) }, quiet ? t('resumeNotify') : t('silence'))
            : null,
          canEdit
            ? h(ConfirmButton, {
                t,
                confirmLabel: t('confirmRemove'),
                busy,
                disabled: busy,
                onConfirm: remove,
              }, t('remove'))
            : null))
    }

    function BindingChannelRow({ ctx, controller, t, table, name, entry, canEdit, busy }) {
      const [draft, setDraft] = useState(entry?.defaultAgent ?? '')
      const save = () => {
        const nextTable = { ...table, [name]: { defaultAgent: draft.trim() } }
        return void controller.putBindings({ channels: nextTable }).catch(error => controller.reportError(error))
      }
      const remove = () => {
        const nextTable = { ...table }
        delete nextTable[name]
        return void controller.putBindings({ channels: nextTable }).catch(error => controller.reportError(error))
      }
      return h('div', { className: 'dn-row' },
        h(StateDot, { state: 'idle' }),
        h('div', { className: 'dn-rowMain' },
          h('strong', { className: 'dn-rowTitle' }, String(name)),
          h('span', { className: 'dn-rowMeta' }, String(entry?.defaultAgent ?? ''))),
        canEdit
          ? h('div', { className: 'dn-rowAside' },
              h('input', {
                type: 'text', value: draft, maxLength: 256, placeholder: t('defaultAgent'),
                onChange: event => setDraft(event.target.value),
              }),
              h(Button, { disabled: busy || draft.trim() === '', onClick: save }, t('save')),
              h(ConfirmButton, {
                t,
                confirmLabel: t('confirmRemove'),
                busy,
                disabled: busy,
                onConfirm: remove,
              }, t('remove')))
          : null)
    }

    function BindingsView({ ctx, controller, state, t }) {
      useEffect(() => { void controller.loadBindings().catch(error => controller.reportError(error)) }, [])
      const agents = state.bindings?.agents ?? {}
      const channels = state.bindings?.channels ?? {}
      const canEdit = state.bindings?.canEdit === true
      const busy = state.busy['bindings:save'] === true
      const agentNames = Object.keys(agents)
      const channelNames = Object.keys(channels)
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'sessions' }) }, `← ${t('back')}`)),
        h(PageHead, { title: t('bindings') }),
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadBindings().catch(error => controller.reportError(error)) }),
        h('h3', { className: 'dn-subhead' }, t('agentBindings')),
        h('div', { className: 'dn-list' },
          ...listBody({
            data: state.bindings, error: state.error, connectionState: state.connectionState, staleAt: state.staleAt, t,
            rows: agentNames, emptyKey: 'noBindings',
            render: name => h(BindingAgentRow, { key: name, ctx, controller, t, table: agents, name, entry: agents[name], canEdit, busy }),
          })),
        h('h3', { className: 'dn-subhead' }, t('channelBindings')),
        h('div', { className: 'dn-list' },
          ...(state.bindings === null ? [] : listBody({
            data: state.bindings, error: state.error, connectionState: state.connectionState, staleAt: state.staleAt, t,
            rows: channelNames, emptyKey: 'noBindings',
            render: name => h(BindingChannelRow, { key: name, ctx, controller, t, table: channels, name, entry: channels[name], canEdit, busy }),
          }))),
        // v0.14（Stage E / P1-10）：原始标识默认折叠 + 脱敏（展开也只显示打码值）。
        h(RawIdentifiers, { t, value: { agents, channels } }))
    }

    function ActivityView({ ctx, controller, state, t }) {
      useEffect(() => { void controller.loadActivity().catch(error => controller.reportError(error)) }, [])
      return h('div', { className: 'dn-page' },
        h('div', { className: 'dn-detailBack' }, h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'home' }) }, `← ${t('back')}`)),
        h(PageHead, { title: t('activity') }),
        h(ErrorNotice, { error: state.error, t, onRetry: () => void controller.loadActivity().catch(error => controller.reportError(error)) }),
        h('div', { className: 'dn-list' },
          ...listBody({
            data: state.activity, error: state.error, connectionState: state.connectionState, staleAt: state.staleAt, t,
            rows: state.activity?.items ?? [], emptyKey: 'noActivity',
            render: item => h(ActivityRow, { key: item.id, ctx, item }),
          })))
    }

    function evidenceText(t, value) {
      return value === 'confirmed' ? t('evidenceConfirmed')
        : value === 'accepted' ? t('evidenceAccepted')
          : t('evidenceNone')
    }

    // v0.14（S11）：只读诊断中心。顶部先回答「是否需要注意 / 为什么 / 最近何时检查」，
    // 再分层展示 Host / Storage / Channels / Capabilities / Recent failures，并可导出脱敏报告。
    function DiagnosticsView({ ctx, controller, state, t }) {
      useEffect(() => { void controller.loadDiagnostics().catch(error => controller.reportError(error)) }, [])
      const [report, setReport] = useState(null)
      const snapshot = state.diagnostics
      const busy = state.busy['diagnostics:report'] === true
      const onGenerate = () => {
        void controller.generateSupportReport()
          .then(result => setReport(result ?? null))
          .catch(error => controller.reportError(error))
      }
      const back = h('div', { className: 'dn-detailBack' },
        h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'home' }) }, `← ${t('back')}`))
      const retry = () => void controller.loadDiagnostics().catch(error => controller.reportError(error))
      if (!snapshot) {
        return h('div', { className: 'dn-page' }, back,
          h(PageHead, { title: t('diagnosticsCenter'), intro: t('diagnosticsIntro') }),
          h(ErrorNotice, { error: state.error, t, onRetry: retry }),
          state.error ? null : h('p', { className: 'dn-empty' }, t('notAvailableYet')))
      }

      const attention = snapshot.attention ?? {}
      const reasons = Array.isArray(attention.reasons) ? attention.reasons : []
      const host = snapshot.host ?? {}
      const storage = snapshot.storage ?? {}
      const channels = snapshot.channels ?? {}
      const capabilities = snapshot.capabilities ?? {}
      const failures = Array.isArray(snapshot.recentFailures) ? snapshot.recentFailures : []
      const listRow = (key, title, list) => h('div', { className: 'dn-row', key },
        h('div', { className: 'dn-rowMain' },
          h('strong', { className: 'dn-rowTitle' }, title),
          h('span', { className: 'dn-rowMeta' }, Array.isArray(list) && list.length ? list.join(', ') : t('noneList'))))
      const capText = (entry, detail) => entry?.available === true ? detail : t('unavailable')

      return h('div', { className: 'dn-page' }, back,
        h(PageHead, { title: t('diagnosticsCenter'), intro: t('diagnosticsIntro') }),
        h(ErrorNotice, { error: state.error, t, onRetry: retry }),
        h('div', { className: 'dn-statusLine' },
          h(StateDot, { state: attention.required === true ? 'warn' : 'done' }),
          h('div', null,
            h('strong', null, t('attentionQuestion')),
            h('span', null, attention.required === true ? t('needsAction') : t('noneRequired')))),
        reasons.length
          ? h('div', { className: 'dn-list' }, ...reasons.map((reason, index) => h('div', { className: 'dn-row', key: reason?.code || index },
              h(StateDot, { state: 'warn' }),
              h('div', { className: 'dn-rowMain' },
                h('strong', { className: 'dn-rowTitle' }, String(reason?.code || '')),
                h('span', { className: 'dn-rowMeta' }, resolveText(ctx, reason?.detail))))))
          : null,
        h('p', { className: 'dn-note' }, `${t('lastChecked')}: ${String(snapshot.generatedAt ?? '')}`),
        h(Section, { title: t('hostTitle') },
          h('div', { className: 'dn-healthGrid' },
            h('span', null, `${t('pluginVersion')}: ${String(snapshot.version ?? '')}`),
            h('span', null, `${t('hostVersion')}: ${String(host.version ?? '')}`),
            h('span', null, `${t('eventsMode')}: ${String(host.eventsMode ?? '')}`),
            h('span', null, `${t('questionsMode')}: ${String(host.questionsMode ?? '')}`),
            h('span', null, `${t('imageInput')}: ${String(host.mediaImageInput ?? '')}`),
            h('span', null, `${t('processId')}: ${String(snapshot.process?.epoch ?? '')} #${String(snapshot.process?.revision ?? '')}`))),
        h(Section, { title: t('storageTitle') },
          h('div', { className: 'dn-healthGrid' },
            h('span', null, `${t('storageState')}: ${String(storage.state ?? '')}`),
            h('span', null, `${t('storageWritable')}: ${storage.writable === true ? t('yes') : t('no')}`),
            storage.migration
              ? h('span', null, `${t('migration')}: ${String(storage.migration.status ?? '')} (${String(storage.migration.migratedCount ?? 0)})`)
              : null)),
        h(Section, { title: t('channelSummaryTitle') },
          h('div', { className: 'dn-healthGrid' },
            h('span', null, `${t('totalChannels')}: ${String(channels.total ?? 0)}`),
            h('span', null, `${t('notifyConfiguredActive')}: ${String(channels.notifyConfigured ?? 0)}/${String(channels.notifyActive ?? 0)}`),
            h('span', null, `${t('controlConfiguredActive')}: ${String(channels.controlConfigured ?? 0)}/${String(channels.controlActive ?? 0)}`),
            h('span', null, `${t('evidenceLevel')}: ${evidenceText(t, channels.latestEvidence)}`)),
          h('div', { className: 'dn-list' },
            listRow('restart', t('restartPendingList'), channels.restartPending),
            listRow('noEvidence', t('noEvidenceList'), channels.noEvidenceTypes),
            listRow('inactive', t('inactiveList'), channels.inactive),
            listRow('degraded', t('degradedList'), channels.degradedTypes))),
        h(Section, { title: t('capabilityTitle') },
          h('div', { className: 'dn-healthGrid' },
            h('span', null, `${t('capQuestions')}: ${capText(capabilities.questions, String(capabilities.questions?.pending ?? 0))}`),
            h('span', null, `${t('capSessions')}: ${capText(capabilities.sessions, String(capabilities.sessions?.count ?? 0))}`),
            h('span', null, `${t('capBindings')}: ${capText(capabilities.bindings, capabilities.bindings?.editable === true ? t('yes') : t('no'))}`),
            h('span', null, `${t('capMembers')}: ${capText(capabilities.members, capabilities.members?.removable === true ? t('yes') : t('no'))}`),
            h('span', null, `${t('capAdvanced')}: ${capabilities.advancedConsole === 'available' ? t('available') : t('unavailable')}`))),
        h(Section, { title: t('failuresTitle') },
          failures.length
            ? h('div', { className: 'dn-list' }, ...failures.map((failure, index) => h('div', { className: 'dn-row', key: `${String(failure?.at ?? '')}-${index}` },
                h(StateDot, { state: 'error' }),
                h('div', { className: 'dn-rowMain' },
                  h('strong', { className: 'dn-rowTitle' }, String(failure?.action ?? '')),
                  h('span', { className: 'dn-rowMeta' }, [
                    failure?.category,
                    failure?.at,
                    failure?.detail ? resolveText(ctx, failure.detail) : null,
                  ].filter(Boolean).join(' · '))))))
            : h('p', { className: 'dn-empty' }, t('noFailures'))),
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
      if (state.view.kind === 'questions') return h(QuestionsView, { ctx, controller, state, t })
      if (state.view.kind === 'members') return h(MembersView, { ctx, controller, state, t })
      if (state.view.kind === 'pending') return h(PendingIdentitiesView, { ctx, controller, state, t })
      if (state.view.kind === 'pairing') return h(PairingCodesView, { ctx, controller, state, t })
      if (state.view.kind === 'sessions') return h(SessionsView, { ctx, controller, state, t })
      if (state.view.kind === 'session') return h(SessionDetailView, { key: state.view.id, ctx, controller, state, t })
      if (state.view.kind === 'bindings') return h(BindingsView, { ctx, controller, state, t })
      if (state.view.kind === 'activity') return h(ActivityView, { ctx, controller, state, t })
      if (state.view.kind === 'diagnostics') return h(DiagnosticsView, { ctx, controller, state, t })
      if (state.view.kind === 'remote') return h(RemoteView, { ctx, controller, state, t })
      if (state.view.kind === 'portability') return h(PortabilityView, { ctx, controller, state, t })
      if (state.view.kind === 'cloudflare') return h(CloudflareView, { ctx, controller, state, t })
      return h(HomeView, { ctx, controller, state, t })
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
        h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'home' }) }, `← ${t('back')}`))

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
        h('button', { className: 'dn-link', disabled: busy, onClick: () => controller.navigate({ kind: 'channels' }) }, `← ${t('back')}`),
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
            h(Button, { disabled: busy, onClick: () => controller.navigate({ kind: 'channel', type: r.type === 'qq' ? 'qqbot' : r.type === 'wechat' ? 'weixin' : r.type, importDirection: r.direction, importDraft: r.config }) }, t('importConfigure')))) : h('p', { className: 'dn-note' }, t('importEmpty'))))
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
      const steps = { preparing: words('准备工具', 'Preparing tools'), login: words('等待登录', 'Awaiting login'), database: words('准备 Bark 服务', 'Preparing Bark'), migration: words('配置 Bark 服务', 'Configuring Bark'), deploy: words('部署服务', 'Deploying service'), verify: words('检查服务', 'Checking service') }
      return h('div', { className: 'dn-page' },
        h('button', { className: 'dn-link', onClick: () => controller.navigate({ kind: 'channels' }) }, `← ${t('back')}`),
        h(PageHead, { title: t('cloudflare'), intro: words('把 Bark 或 Telegram 网关部署到你的 Cloudflare 账号。', 'Deploy Bark or a Telegram gateway to your Cloudflare account.') }),
        h('div', { className: 'dn-formActions' },
          h(Button, { disabled, onClick: () => call('loginDevice') }, words('登录 Cloudflare', 'Log in to Cloudflare')),
          h(Button, { disabled, onClick: () => call('refresh') }, t('refresh')),
          data?.job ? h(Button, { disabled: busy, onClick: () => call('cancel') }, t('cancelAction')) : null),
        data?.login ? h('div', { className: 'dn-code' }, h('a', { href: data.login.url, target: '_blank', rel: 'noopener noreferrer' }, words('打开授权页面', 'Open authorization page')), data.login.code ? h('strong', null, data.login.code) : null) : null,
        data?.job ? h('p', { role: 'status', className: 'dn-note' }, steps[data.job.step] || t('loading')) : null,
        error || data?.error ? h('p', { role: 'alert', className: 'dn-error' }, error?.message || data.error) : null,
        h('label', { className: 'dn-field' }, words('账号', 'Account'), h('select', { 'aria-label': 'Cloudflare account', value: account, disabled, onChange: e => setAccount(e.target.value) }, h('option', { value: '' }, '—'), ...(data?.accounts ?? []).map(a => h('option', { key: a.id, value: a.id }, a.name)))),
        h('label', { className: 'dn-field' }, words('服务', 'Service'), h('select', { 'aria-label': 'Cloudflare service', value: type, disabled, onChange: e => setType(e.target.value) }, h('option', { value: 'telegram' }, 'Telegram Gateway'), h('option', { value: 'bark' }, 'Bark'))),
        type === 'telegram' ? h('label', { className: 'dn-field' }, 'Bot Token', h('input', { type: 'password', autoComplete: 'off', 'aria-label': 'Bot Token', value: botToken, disabled, placeholder: words('已配置可留空', 'Leave blank to reuse configured token'), onChange: e => setBotToken(e.target.value) })) : h('label', { className: 'dn-field dn-field--check' }, h('input', { type: 'checkbox', checked: enrollment, disabled, onChange: e => setEnrollment(e.target.checked) }), words('允许 Bark App 注册设备（添加设备后取消并重新部署）', 'Allow Bark App registration (turn off and redeploy after enrollment)')),
        type === 'telegram' ? h('div', null,
          h('label', { className: 'dn-field' }, words('接收者（已配置可留空）', 'Recipient (leave blank to reuse)'), h('input', { 'aria-label': 'Gateway recipient', value: chatId, disabled, onChange: e => setChatId(e.target.value) })),
          h('label', { className: 'dn-field dn-field--check' }, h('input', { type: 'checkbox', checked: activate, disabled, onChange: e => setActivate(e.target.checked) }), words('部署后自动填写并保存 TG 配置', 'Automatically fill and save Telegram settings')),
          h('label', { className: 'dn-field dn-field--check' }, h('input', { type: 'checkbox', checked: inbound, disabled, onChange: e => setInbound(e.target.checked) }), words('也用于接收消息（完成后重启 DSH）', 'Also receive messages (restart DSH afterwards)'))) : null,
        h(Button, { kind: 'primary', disabled: disabled || !account, onClick: () => call('deploy', { type, accountId: account, botToken, enrollment, activate: type === 'telegram' && activate, chatId, inbound }) }, type === 'telegram' ? words('一键开启', 'Enable gateway') : words('部署 / 重试', 'Deploy / retry')),
        h(TunnelSettings, { ctx, controller, data: data?.tunnel, disabled, onRead: read }),
        receipt ? h('p', { role: 'status', className: 'dn-successText' }, receipt.unbound ? words('已解除本地绑定，云资源保留。', 'Local binding removed. Cloud resources retained.') : receipt.results?.some(r => r.applied === false) ? t('restartPending') : t('savedOk')) : null,
        ...(data?.deployments ?? []).map(r => h(Section, { key: r.type, title: r.type === 'telegram' ? 'Telegram Gateway' : 'Bark' },
          h('p', { className: 'dn-note' }, r.endpoint || words('尚未完成部署', 'Deployment pending')),
          h('p', { className: 'dn-note' }, r.state === 'bound' ? words('已绑定', 'Linked') : words('未绑定', 'Not linked')),
          r.type === 'telegram' ? h('div', null,
            h('label', { className: 'dn-field' }, 'Chat ID', h('input', { 'aria-label': 'Chat ID', value: chatId, disabled, onChange: e => setChatId(e.target.value) })),
            h('label', { className: 'dn-field dn-field--check' }, h('input', { type: 'checkbox', checked: inbound, disabled, onChange: e => setInbound(e.target.checked) }), words('同时用于入站控制（保存后重启 DSH）', 'Also use for inbound control (restart DSH after saving)'))) : h('label', { className: 'dn-field' }, 'Bark Key', h('input', { type: 'password', autoComplete: 'off', 'aria-label': 'Bark Key', value: barkKey, disabled, placeholder: words('在 Bark App 添加服务器后取得', 'Available after adding the server in Bark App'), onChange: e => setBarkKey(e.target.value) })),
          h('div', { className: 'dn-formActions' },
            h(Button, { disabled: disabled || r.health !== 'ready', onClick: () => call('link', { type: r.type, chatId, barkKey, directions: r.type === 'telegram' && inbound ? ['outbound', 'inbound'] : ['outbound'] }) }, words('绑定渠道', 'Link channel')),
            r.state === 'bound' ? h(Button, { disabled, onClick: () => call('unbind', { type: r.type }) }, words('解除绑定', 'Unbind')) : null))))
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
      .dn-radio{display:inline-flex;gap:6px;align-items:center;font-size:13px}
      .dn-leaveGuard{border:.5px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:12px 14px;margin:12px 0}
      .dn-leaveGuard p{margin:6px 0 10px}
      .dn-page :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      @media(max-width:359px){.dn-page{padding:16px 12px 36px}.dn-navBtn{padding:4px 10px}}
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
