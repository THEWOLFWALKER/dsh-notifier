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
