import test from 'node:test'
import assert from 'node:assert/strict'
import * as wecom from '../src/adapters/wecom-app.mjs'

function mockFetch(responses) {
  const originalFetch = globalThis.fetch
  const calls = []
  let index = 0
  globalThis.fetch = async (url, init = {}) => {
    const response = responses[index] ?? responses[responses.length - 1]
    index += 1
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body,
    })
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch
    },
  }
}

test('wecom-app: canonical agentId/touser 继续生效', async () => {
  const rig = mockFetch([
    { body: { errcode: 0, access_token: 'TOKEN1', expires_in: 7200 } },
    { body: { errcode: 0, errmsg: 'ok', msgid: '1' } },
  ])
  try {
    const resolved = wecom.resolve({ corpid: 'corp-001', secret: 'sec-001', agentId: 1000002, touser: 'alice' })
    assert.equal(resolved.agentId, 1000002)
    assert.equal(resolved.touser, 'alice')
    await wecom.send(resolved, { title: '标题', content: '正文' })
    assert.equal(rig.calls.length, 2)
    assert.equal(rig.calls[0].url, 'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=corp-001&corpsecret=sec-001')
    assert.equal(rig.calls[0].method, 'GET')
    assert.equal(rig.calls[1].url, 'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=TOKEN1')
    assert.equal(rig.calls[1].method, 'POST')
    const body = JSON.parse(rig.calls[1].body)
    assert.equal(body.touser, 'alice')
    assert.equal(body.agentid, 1000002)
    assert.equal(body.text.content, '标题\n正文')
  } finally {
    rig.restore()
  }
})

test('wecom-app: AgentID/toUser 别名也生效', async () => {
  const rig = mockFetch([
    { body: { errcode: 0, access_token: 'TOKEN2', expires_in: 7200 } },
    { body: { errcode: 0, errmsg: 'ok', msgid: '2' } },
  ])
  try {
    const resolved = wecom.resolve({ corpid: 'corp-001', secret: 'sec-001', AgentID: '1000002', toUser: 'alice' })
    assert.equal(resolved.agentId, 1000002)
    assert.equal(resolved.touser, 'alice')
    await wecom.send(resolved, { title: '标题', content: '正文' })
    const body = JSON.parse(rig.calls[1].body)
    assert.equal(body.touser, 'alice')
    assert.equal(body.agentid, 1000002)
  } finally {
    rig.restore()
  }
})

test('wecom-app: expires_in=0 不再 ?? 7200 保 0 再被钳 1 秒——TTL 归一 fail-closed 抛错（G-55）', async () => {
  const rig = mockFetch([
    { body: { errcode: 0, access_token: 'TOKEN3', expires_in: 0 } },
    { body: { errcode: 0, errmsg: 'ok', msgid: '3' } },
  ])
  try {
    const resolved = wecom.resolve({ corpid: 'corp-001', secret: 'sec-001', agentId: 1000002, touser: 'alice' })
    // G-55 同值不同命：0 在本层曾被 ?? 7200 保留后 Math.max(1000,0) 钳成 1 秒——
    // 与 qq 层「活 7200s」互相矛盾；现在统一 fail-closed
    await assert.rejects(() => wecom.send(resolved, { title: '标题', content: '正文' }), /TTL 非法/)
    assert.equal(rig.calls.length, 1, 'token 换取失败即止，不发消息')
  } finally {
    rig.restore()
  }
})
