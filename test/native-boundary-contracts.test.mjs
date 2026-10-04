// dsh-notifier v0.15 Stage 1 — 新 Native 边界契约测试（TASKPACK DSH-NOTIFIER-V015-STAGE1-NATIVE-REWRITE-V2）。
//
// 锁定 07_BACKEND_CONTRACTS 的公开行为，不锁实现细节：
//   - secret 永不返回浏览器（只有 presence，没有 value）；
//   - accepted / confirmed / unknown / failed 四态映射（accepted 绝不冒充 confirmed）；
//   - accountId 不丢失（禁止拿 channel 顶替账号）；
//   - 渠道四态用户词，不出现内部状态名；
//   - Native 快照不泄漏内部对象字段（sessionId/bindingKey/principal/claim/epoch/revision）；
//   - 列表有显式上限与截断语义；
//   - 写动作只调一个 authority，且记账归属不双记；
//   - 三态密钥补丁（keep / replace / clear）没有第四种语义；
//   - 宿主能力缺失时 fail-closed（不返回空表冒充「暂无数据」，不起独立端口）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { channelFieldsOf } from '../src/config.mjs'
import { INBOUND_FIELDS } from '../src/inbound/channel-config.mjs'
import { createChannelProjection } from '../src/control-surface/channels.mjs'
import { createChannelView, channelState, testReceipt, receiptKind } from '../src/native/channel-view.mjs'
import { createPrivateChatView } from '../src/native/private-chat-view.mjs'
import { createNativeReadModel, CHANNEL_CAP, RAIL_CAP } from '../src/native/read-model.mjs'
import { createNativeActions, secretPatch } from '../src/native/actions.mjs'
import { createNativeSurfaceService, registerNativeSurface } from '../src/native/register.mjs'

// ————————————————————————————— 夹具 —————————————————————————————

const SECRET_TOKEN = 'SECRET-BOT-TOKEN-VALUE'
const SECRET_GATEWAY = 'SECRET-GATEWAY-KEY-VALUE'

/** 真投影（不是手写行）：契约测试必须打在真实脱敏/折叠行为上。 */
function makeChannels({ extra = [] } = {}) {
  const outboundConfig = {
    raw: (type) => (type === 'telegram'
      ? { botToken: SECRET_TOKEN, gatewayKey: SECRET_GATEWAY, chatId: '12345' }
      : {}),
    describe: (type) => ({
      configured: type === 'telegram',
      active: type === 'telegram',
      fields: channelFieldsOf(type),
      applyMode: 'hot',
      configRevision: 3,
    }),
  }
  const adminApi = {
    getChannels: () => [
      {
        type: 'telegram',
        direction: 'inbound',
        configured: true,
        active: true,
        editable: true,
        fields: INBOUND_FIELDS.telegram,
        config: { botToken: '***' },
      },
      ...extra,
    ],
  }
  const health = {
    snapshot: () => ({ delivered: 0, accepted: 2, unknown: 0, failed: 0, skipped: 0, epoch: 1 }),
  }
  return createChannelProjection({
    outboundSource: { has: () => true, version: 3 },
    outboundConfig,
    inboundConfig: { version: 1 },
    adminApi,
    health,
  })
}

const MEMBER_ROWS = [
  {
    key: 'telegram:work:owner-1', channel: 'telegram', accountId: 'work', userId: '123456789',
    label: '我', role: 'owner', origin: 'paired', pairedAt: 1, lastSeenAt: 2,
  },
  {
    key: 'telegram:tg-app:owner-2', channel: 'telegram', accountId: 'tg-app', userId: '987654321',
    label: '', role: 'member', origin: 'confirmed', pairedAt: 3, lastSeenAt: 4,
  },
]

const makeMembers = ({ pending = [] } = {}) => ({
  list: () => MEMBER_ROWS,
  listPending: () => pending,
})

const QUESTION_ROWS = [{
  ref: 'abc123abc123', question: '要部署到生产吗？', multiple: false,
  options: [{ value: '0', label: '部署' }, { value: '1', label: '先等等' }],
  status: 'pending', createdAt: Date.now() - 90_000,
}]

const makeQuestions = () => ({ list: () => QUESTION_ROWS })
const makeTasks = () => ({ list: () => [{ taskRef: 'task-1', workspace: 'dsh-notifier', status: 'active', attention: true }] })

const makeReadModel = (overrides = {}) => createNativeReadModel({
  channels: makeChannels(),
  members: makeMembers(),
  questions: makeQuestions(),
  tasks: makeTasks(),
  revision: { current: () => ({ epoch: 'epoch-abc', revision: 7 }), wait: async () => ({ revision: 8 }) },
  ...overrides,
})

/** 递归收集所有键名（用于「内部字段不泄漏」断言）。 */
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) { for (const item of value) keysOf(item, out); return out }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { out.add(key); keysOf(child, out) }
  }
  return out
}

// ————————————————————————— 1. secret 永不返回 —————————————————————————

test('secret 字段只暴露 presence：值绝不进入渠道详情', () => {
  const view = createChannelView({ channels: makeChannels(), members: makeMembers() })
  const detail = view.detail('telegram')
  const serialized = JSON.stringify(detail)

  assert.doesNotMatch(serialized, new RegExp(SECRET_TOKEN), 'Bot Token 明文不得出现在详情里')
  assert.doesNotMatch(serialized, new RegExp(SECRET_GATEWAY), '网关密钥明文不得出现在详情里')

  const account = detail.accounts[0]
  const botToken = account.setupFields.find((field) => field.key === 'botToken')
  assert.equal(botToken.secret, true)
  assert.equal(botToken.present, true, 'secret 字段要能表达「已经填过」')
  assert.equal(Object.prototype.hasOwnProperty.call(botToken, 'value'), false, 'secret 字段不得带 value')

  // 公共字段可以带值（用于回填），但 secret 结构上不可能出现。
  assert.deepEqual(account.notify.values, { chatId: '12345' })
})

test('secret 值不出现在任何 RPC 载荷（快照 + 详情）', () => {
  const readModel = makeReadModel()
  const payload = JSON.stringify({ snapshot: readModel.snapshot(), detail: readModel.channel('telegram') })
  assert.doesNotMatch(payload, new RegExp(SECRET_TOKEN))
  assert.doesNotMatch(payload, new RegExp(SECRET_GATEWAY))
})

// ————————————————— 2. accepted / confirmed / unknown 映射 —————————————————

test('测试结果四态映射：accepted→sent，confirmed→confirmed，timeout→unknown，错误→failed', () => {
  assert.equal(receiptKind({ ok: true }), 'sent', 'provider 接受请求只是「已发出」')
  assert.equal(receiptKind({ ok: true, confirmed: true }), 'confirmed')
  assert.equal(receiptKind({ ok: true, receipt: true }), 'confirmed')
  assert.equal(receiptKind({ ok: false, uncertain: true }), 'unknown')
  assert.equal(receiptKind({ ok: false, detail: 'auth failed' }), 'failed')

  // 归一化形状（control-surface 的 testResult）：failed 统一是 status:'unknown'，靠 reasonCode 区分。
  assert.equal(receiptKind({ status: 'accepted' }), 'sent')
  assert.equal(receiptKind({ status: 'delivered' }), 'confirmed')
  assert.equal(receiptKind({ status: 'unknown', reasonCode: 'timeout' }), 'unknown')
  assert.equal(receiptKind({ status: 'unknown', reasonCode: 'auth-failed' }), 'failed')
})

test('测试回执用用户话术，且 accepted 绝不显示「已确认收到」', () => {
  const sent = testReceipt({ ok: true })
  assert.equal(sent.kind, 'sent')
  assert.match(sent.title, /测试已发出/)
  assert.doesNotMatch(sent.title, /确认收到/)

  const confirmed = testReceipt({ ok: true, confirmed: true })
  assert.equal(confirmed.kind, 'confirmed')
  assert.match(confirmed.title, /已确认收到/)

  const unknown = testReceipt({ ok: false, uncertain: true }, { reason: { en: 'timed out', zh: '超时' } })
  assert.equal(unknown.kind, 'unknown')
  assert.match(unknown.message, /稍后|再发一次/)

  const failed = testReceipt({ ok: false, detail: '认证失败' }, { reason: { en: 'bad token', zh: '凭证无效' } })
  assert.equal(failed.kind, 'failed')
  assert.match(failed.message, /再试一次（凭证无效）/, '先给下一步动作，再给原因')
})

// ————————————————————— 3. accountId 不丢失 ————————————————————————

test('账号卡保留真实 accountId，且不拿 channel 顶替', () => {
  const view = createChannelView({ channels: makeChannels(), members: makeMembers() })
  const detail = view.detail('telegram')
  const ids = detail.accounts.map((account) => account.id).sort()
  assert.deepEqual(ids, ['telegram:tg-app', 'telegram:work'].sort(), '配置中声明的账号与显式 accountId 都要出现')

  const work = detail.accounts.find((account) => account.id === 'telegram:work')
  assert.equal(work.accountId, 'work', 'accountId 必须原样保留')
  assert.equal(work.displayName, 'work')
  assert.equal(work.maskedIdentity, '12•••89', '身份只给掩码')

  const fallback = detail.accounts.find((account) => account.id === 'telegram:tg-app')
  assert.equal(fallback.accountId, 'tg-app', '列表中的稳定 accountId 原样保留')
  assert.notEqual(fallback.id, fallback.accountId, '账号 id 带渠道维度，不拿 channel 顶替账号')
  assert.match(fallback.id, /^telegram:/, '账号 id 以渠道为前缀，与私聊视图的 channel.id 同口径')
})

// ————————————— 3b. 账号卡的字段分组与私聊字段（S3） —————————————

test('账号卡把出站字段拆成「基础 / 更多」，且基础段只放必填字段', () => {
  const view = createChannelView({ channels: makeChannels(), members: makeMembers() })
  const account = view.detail('telegram').accounts.find((row) => row.id === 'telegram:tg-app')

  const basicKeys = account.basicFields.map((field) => field.key)
  const moreKeys = account.moreFields.map((field) => field.key)
  assert.deepEqual(basicKeys.sort(), ['botToken', 'chatId'].sort(), '必填字段进「基础设置」')
  assert.deepEqual(moreKeys.sort(), ['apiBase', 'gatewayKey'].sort(), '选填字段进「更多设置」')
  assert.equal(account.moreAvailable, true, '有选填字段就说明「还有更多」')
  assert.deepEqual(
    [...basicKeys, ...moreKeys].sort(),
    account.setupFields.map((field) => field.key).sort(),
    '两段合起来就是完整字段清单，不重不漏',
  )
  // 分组不改变 secret 语义：基础段里的 botToken 仍只有 presence。
  const botToken = account.basicFields.find((field) => field.key === 'botToken')
  assert.equal(botToken.secret, true)
  assert.equal(botToken.present, true)
  assert.equal(Object.prototype.hasOwnProperty.call(botToken, 'value'), false)
})

test('支持私聊的渠道给账号卡一份入站字段与公共值；secret 结构上不出现', () => {
  const view = createChannelView({ channels: makeChannels(), members: makeMembers() })
  const telegram = view.detail('telegram').accounts.find((row) => row.id === 'telegram:tg-app')
  const pc = telegram.privateChat
  assert.ok(pc, '支持私聊的渠道要带上私聊字段')
  assert.equal(pc.enabled, true)
  assert.deepEqual(pc.fields.map((field) => field.key).sort(), ['apiBase', 'botToken', 'gatewayKey'].sort(), '入站字段清单完整')
  const inboundToken = pc.fields.find((field) => field.key === 'botToken')
  assert.equal(inboundToken.secret, true, '入站 token 仍是 secret')
  assert.equal(inboundToken.present, true, '只表达「已经填过」')
  assert.deepEqual(pc.values, {}, '入站公共值里不含 secret 的掩码或明文')
  assert.doesNotMatch(JSON.stringify(pc), /SECRET-BOT-TOKEN-VALUE|\*\*\*/, '私聊投影不泄漏任何密钥材料')

  // 不支持私聊的渠道不编造私聊段。
  assert.deepEqual(view.detail('bark').accounts, [], '没有已配对身份时不编造渠道账号')
})

// ————————————————————— 4. 渠道四态用户词 ————————————————————————

test('渠道状态折叠为四种用户词，且不出现内部状态名', () => {
  const view = createChannelView({ channels: makeChannels(), members: makeMembers() })
  const rows = view.list()
  const telegram = rows.find((row) => row.id === 'telegram')
  const bark = rows.find((row) => row.id === 'bark')

  assert.equal(telegram.state, 'ready')
  assert.equal(telegram.stateText, '可以使用')
  assert.equal(bark.state, 'not-set')
  assert.equal(bark.stateText, '还没设置')

  for (const row of rows) {
    assert.ok(['not-set', 'connecting', 'ready', 'needs-attention'].includes(row.state))
    assert.doesNotMatch(JSON.stringify(row), /configured|healthy|degraded|restartPending|epoch|revision/)
  }
})

test('渠道状态判定：未配置 / 已配置未运行 / 失败证据 / 未收敛', () => {
  assert.equal(channelState({ notify: { configured: false }, control: null }), 'not-set')
  assert.equal(channelState({ notify: { configured: true, active: false }, control: null }), 'connecting')
  assert.equal(channelState({
    notify: { configured: true, active: true }, control: null, health: { state: 'degraded' },
  }), 'needs-attention')
  assert.equal(channelState({
    notify: { configured: true, active: true, restartPending: true }, control: null, health: { state: 'healthy' },
  }), 'needs-attention', '已保存但没生效 = 需要处理')
  assert.equal(channelState({
    notify: { configured: true, active: true }, control: null, health: { state: 'unsupported' },
  }), 'needs-attention')
})

// ————————————————— 5. 内部对象不泄漏 + 上限/截断 —————————————————

test('Native 快照不含内部字段名', () => {
  const snapshot = makeReadModel().snapshot()
  const keys = keysOf(snapshot)
  for (const forbidden of ['sessionId', 'bindingKey', 'principal', 'claim', 'epoch', 'revision', 'policy', 'ledger']) {
    assert.equal(keys.has(forbidden), false, `快照不得出现内部字段 ${forbidden}`)
  }
})

test('列表有显式上限并显式告知截断', () => {
  // 真投影只遍历固定渠道表（≤ SURFACE_TYPES），造不出超上限行；上限与截断是 read-model 的
  // 职责，故这里直接喂已折叠形状的行，专测 read-model 的显式上限语义。
  const many = Array.from({ length: CHANNEL_CAP + 5 }, (_, index) => ({
    type: `channel-${index}`,
    notify: { configured: true, active: true, fields: {}, editableValues: {} },
    control: null,
    health: { state: 'healthy' },
  }))
  const readModel = createNativeReadModel({
    channels: { list: () => many },
    members: makeMembers(),
    questions: makeQuestions(),
    tasks: makeTasks(),
    revision: { current: () => ({ epoch: 'e', revision: 1 }), wait: async () => ({ revision: 1 }) },
  })
  const snapshot = readModel.snapshot()
  assert.equal(snapshot.channels.length, CHANNEL_CAP, '渠道列表必须被显式截断')
  assert.equal(snapshot.truncated.channels, true, '截断必须显式告知，不静默丢数据')
  assert.equal(snapshot.rail.length, RAIL_CAP, '左侧渠道栏同样有显式上限')
  assert.equal(snapshot.truncated.rail, true, '渠道栏截断同样要显式告知')
})

// ————————————————————— 6. 私聊视图不泄漏内部键 ————————————————————

test('私聊摘要只给不透明使用者 id 与用户词权限', () => {
  const view = createPrivateChatView({
    members: makeMembers(),
    questions: makeQuestions(),
    tasks: makeTasks(),
    // R1：当前任务只来自显式选择（owner 维度的 bind 键读投影）。
    selectedTaskRef: () => 'task-1',
  })
  const summary = view.summary()

  assert.equal(summary.verified, true)
  assert.equal(summary.channel.id, 'telegram:work', '账号维度来自真实 accountId')
  assert.equal(summary.currentTask.title, 'dsh-notifier')
  assert.equal(summary.users.length, 2)
  for (const user of summary.users) {
    assert.match(user.id, /^u_[0-9a-f]{12}$/, '使用者 id 必须是不透明 id')
    assert.doesNotMatch(user.id, /telegram|owner-1/, '不得泄漏内部成员键')
  }
  assert.deepEqual(summary.users.map((user) => user.permissionText), ['可以管理', '可以接收通知'])
  assert.doesNotMatch(JSON.stringify(summary), /"role"|"origin"|"userId"|"binding"|"principal"/)

  // 不透明 id 必须能在服务端解析回真实键（动作才能生效）。
  assert.equal(view.memberKeyOf(summary.users[0].id), 'telegram:work:owner-1')
})

test('待处理项给标题/来源/时间/可选项，不给 ledger 行', () => {
  const view = createPrivateChatView({
    members: makeMembers({ pending: [{ key: 'feishu:fs-app:ou_x', channel: 'feishu', accountId: 'fs-app', userId: 'ou_x', origin: 'learned', at: Date.now() }] }),
    questions: makeQuestions(),
    tasks: makeTasks(),
  })
  const items = view.pendingItems()
  assert.equal(items.length, 2, '提问 + 待确认身份')
  const question = items[0]
  assert.equal(question.id, 'abc123abc123')
  assert.deepEqual(question.choices.map((choice) => choice.kind), ['choose', 'choose', 'reject'])
  assert.match(items[1].sourceText, /来自 飞书/)
  assert.doesNotMatch(JSON.stringify(items), /pushedTo|agentId|multiSelect|origin/)
})

test('首次启用向导：步骤派生不落盘，候选任务去重有界，待确认身份用不透明 id', () => {
  // 派生规则（R1）：未确认本人 → confirm；已确认但**无显式选择** → task；已确认且有显式选择 → ready。
  const noOwner = createPrivateChatView({
    members: { list: () => [{ key: 'telegram:tg-app:member-1', channel: 'telegram', accountId: 'fs-app', userId: '1', role: 'member' }], listPending: () => [] },
    tasks: makeTasks(),
  })
  assert.equal(noOwner.summary().setup.step, 'confirm', '没有本人 → 先确认本人')

  const ownerNoTask = createPrivateChatView({ members: makeMembers(), tasks: { list: () => [] } })
  assert.equal(ownerNoTask.summary().setup.step, 'task', '已确认但无任务 → 选择任务')

  // R1：有活跃任务但用户未显式选择 → 仍需选择（绝不自动绑定 attention/首个任务）。
  const ownerNoSelection = createPrivateChatView({ members: makeMembers(), tasks: makeTasks() })
  assert.equal(ownerNoSelection.summary().setup.step, 'task', 'R1：未显式选择 → 选择任务')
  assert.equal(ownerNoSelection.summary().currentTask, undefined, 'R1：未显式选择不得有当前任务')

  const ready = createPrivateChatView({ members: makeMembers(), tasks: makeTasks(), selectedTaskRef: () => 'task-1' })
  const setup = ready.summary().setup
  assert.equal(setup.step, 'ready', '已确认且有显式选择 → 可以用了')
  assert.deepEqual(setup.tasks, [{ id: 'task-1', title: 'dsh-notifier' }])
  assert.doesNotMatch(JSON.stringify(setup), /"role"|"origin"|"key"|"userId"/, '向导载荷不泄漏内部字段')

  // 待确认身份只给不透明 id，不给成员键。
  const withPending = createPrivateChatView({
    members: makeMembers({ pending: [{ key: 'feishu:fs-app:ou_x', channel: 'feishu', accountId: 'fs-app', userId: 'ou_x', at: 1 }] }),
    tasks: makeTasks(),
  })
  const identity = withPending.summary().setup.pendingIdentities[0]
  assert.match(identity.id, /^u_[0-9a-f]{12}$/)
  assert.doesNotMatch(identity.id, /feishu|ou_x/)

  // 候选任务去重、有界（超出上限只影响选择步）。
  const many = createPrivateChatView({
    members: makeMembers(),
    tasks: { list: () => Array.from({ length: 14 }, (_, i) => ({ taskRef: `t-${i}`, workspace: `ws-${i}` })) },
  })
  assert.equal(many.summary().setup.tasks.length, 10, '候选任务有显式上限')
  const dup = createPrivateChatView({
    members: makeMembers(),
    tasks: { list: () => [{ taskRef: 'a', workspace: 'one' }, { taskRef: 'a', workspace: 'one' }] },
  })
  assert.equal(dup.summary().setup.tasks.length, 1, '候选任务按 ref 去重')
})

// ————————————————————— 7. 写动作：单一 authority ————————————————————

function makeActionRig() {
  const calls = []
  const channelControl = {
    saveOutbound: (type, patch) => { calls.push(['saveOutbound', type, patch]); return { saved: true, applied: true } },
    saveInbound: async (type, patch) => { calls.push(['saveInbound', type, patch]); return { saved: true } },
    removeOutbound: (type, options) => { calls.push(['removeOutbound', type, options]); return { deleted: true, applied: true } },
    removeInbound: (type) => { calls.push(['removeInbound', type]); return { deleted: true } },
    rawOutbound: () => ({ botToken: SECRET_TOKEN }),
    testOutbound: async () => ({ ok: true, confirmed: true }),
  }
  const touches = []
  const records = []
  const healthRecords = []
  const actions = createNativeActions({
    channelControl,
    health: { recordTest: (type, result) => healthRecords.push([type, result]) },
    revision: { touch: (topic) => touches.push(topic) },
    activity: { record: (...args) => records.push(args) },
    questions: { settle: (payload) => ({ settled: true, alreadyHandled: false }) },
    members: {
      update: () => { throw new Error('should not be called') },
      remove: () => { throw new Error('should not be called') },
      approve: () => { throw new Error('should not be called') },
      dismiss: () => { throw new Error('should not be called') },
      mintCode: () => ({ id: 'p1', code: 'ABC', expiresAt: 1 }),
      revokeCode: () => ({ revoked: true }),
    },
    resolveUserId: (id) => (id === 'u_known' ? 'feishu:owner-1' : null),
  })
  return { actions, calls, touches, records, healthRecords }
}

test('保存通知渠道：只调 channelControl，且不重复记账（domain event 是唯一 owner）', () => {
  const { actions, calls, touches, records } = makeActionRig()
  const result = actions.saveChannel({ type: 'telegram', patch: { chatId: '999' } })

  assert.deepEqual(result, { saved: true, needsRestart: false })
  assert.deepEqual(calls, [['saveOutbound', 'telegram', { chatId: '999' }]])
  assert.deepEqual(touches, [], '出站保存不得再 touch revision')
  assert.deepEqual(records, [], '出站保存不得再记 activity')
})

test('保存私聊渠道：无 domain event → 记一次 revision 与 activity', () => {
  const { actions, calls, touches, records } = makeActionRig()
  return actions.saveInboundChannel({ type: 'feishu', patch: { appId: 'x' } }).then((result) => {
    assert.equal(result.saved, true)
    assert.deepEqual(calls, [['saveInbound', 'feishu', { appId: 'x' }]])
    assert.deepEqual(touches, ['channels'])
    assert.equal(records.length, 1)
    assert.equal(records[0][1], 'channel-saved')
  })
})

test('测试渠道：回执是用户话术，且记录测试证据', async () => {
  const { actions, healthRecords, touches } = makeActionRig()
  const receipt = await actions.testChannel({ type: 'telegram' })
  assert.equal(receipt.kind, 'confirmed')
  assert.equal(receipt.title, '已确认收到')
  assert.equal(healthRecords.length, 1)
  assert.equal(healthRecords[0][0], 'telegram')
  assert.deepEqual(touches, ['health'])
  // 回执里绝不能带出 provider 原始凭证。
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(SECRET_TOKEN))
})

test('使用者动作只接受不透明 id；未知 id fail-closed', () => {
  const { actions } = makeActionRig()
  assert.throws(() => actions.updateUser({ id: 'u_unknown', label: 'x' }), /刷新后重试/)
})

test('三态密钥补丁只有 keep / replace / clear，没有第四种语义', () => {
  assert.deepEqual(
    secretPatch({
      botToken: { mode: 'replace', value: 'new-token' },
      gatewayKey: { mode: 'keep' },
      apiBase: { mode: 'clear' },
    }),
    { patch: { botToken: 'new-token' }, clearSecrets: ['apiBase'] },
  )
  assert.throws(() => secretPatch({ botToken: { mode: 'replace', value: '   ' } }), /清除/)
  assert.throws(() => secretPatch({ botToken: { mode: 'update', value: 'x' } }), /保留、替换或清除/)
})

// ————————————————————— 8. 宿主能力缺失 fail-closed ————————————————————

test('能力缺失返回 not-supported，绝不返回空表冒充「暂无数据」', async () => {
  const service = createNativeSurfaceService({ readModel: null, actions: null })
  const read = await service.call('native.snapshot', {})
  assert.equal(read.ok, false)
  assert.equal(read.error.code, 'dsh-notifier/not-supported')

  const write = await service.call('native.saveChannel', { type: 'telegram' })
  assert.equal(write.ok, false)
  assert.equal(write.error.code, 'dsh-notifier/not-supported')
})

test('未知方法 bad-request；已知方法返回 ok 包装', async () => {
  const readModel = makeReadModel()
  const service = createNativeSurfaceService({ readModel, actions: null })

  const unknown = await service.call('native.nope', {})
  assert.equal(unknown.error.code, 'dsh-notifier/bad-request')

  const snapshot = await service.call('native.snapshot', {})
  assert.equal(snapshot.ok, true)
  assert.ok(Array.isArray(snapshot.value.rail))

  const missing = await service.call('native.channel', { type: 'does-not-exist' })
  assert.equal(missing.error.code, 'dsh-notifier/not-found')
})

test('宿主没有可用接缝时返回 null（降级），绝不自行起端口', () => {
  const ctx = { connection: {}, effect: (fn) => fn() }
  assert.equal(registerNativeSurface(ctx, createNativeSurfaceService({ readModel: makeReadModel() })), null)
})

test('宿主 webServer 可用时挂到既有前缀路由（与旧 service 同一传输）', () => {
  const routes = []
  const ctx = {
    connection: { rpc: {}, admit: () => ({ peer: {} }) },
    webServer: { register(route) { routes.push(route); return () => {} } },
    effect: (fn) => fn(),
  }
  const dispose = registerNativeSurface(ctx, createNativeSurfaceService({ readModel: makeReadModel() }))
  assert.equal(typeof dispose, 'function')
  assert.deepEqual({ kind: routes[0].kind, path: routes[0].path }, { kind: 'prefix', path: '/dsh-notifier' })
})

// ————————————————————————— 9. 长轮询游标 —————————————————————————

test('游标不透明；宿主实例变化即视为有更新（客户端不卡住）', async () => {
  const readModel = makeReadModel()
  const first = readModel.snapshot().cursor
  assert.match(first, /^[0-9a-f]{8}\.\d+$/)
  assert.doesNotMatch(first, /revision|epoch/i)

  const waited = await readModel.wait({ cursor: first })
  assert.equal(waited.changed, true)
  assert.equal(waited.cursor, `${first.split('.')[0]}.8`, '同一实例内游标推进到新序号')

  const stale = await readModel.wait({ cursor: 'deadbeef.99' })
  assert.equal(stale.changed, true, '实例令牌不同 → 立即返回有更新')
})
