import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { runToolDefs } from '../sdk.ts'
import type { RunTools } from '../sdk.ts'
import { answerTool, askTool, sdkTool, serveSession } from './serve.ts'
import type { Served } from './serve.ts'

const post = async (s: Served, path: 'mcp' | 'guard', body: unknown, token = s.token) => {
  const r = await fetch(s[path], { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, sid: r.headers.get('mcp-session-id'), body: r.status === 202 ? undefined : await r.json() as any }
}
const call = (s: Served, name: string, args: unknown, id = 1) => post(s, 'mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

function runTools() {
  const did: string[] = []
  const t: RunTools = {
    submitDraft: async (x) => { did.push(`draft ${x}`) }, addArtifact: async (n) => { did.push(`artifact ${n}`) }, addArtifactFile: async () => {},
    journal: async () => { throw new Error('the journal is shut') },
  }
  return { t, did }
}

test('the run\'s tools as the CLI sees them: listed with JSON schemas, called with checked input, failures as tool errors', async () => {
  const { t, did } = runTools(), s = await serveSession({ name: 'run', tools: runToolDefs(t).map(sdkTool), guard: () => ({}) })
  try {
    const init = await post(s, 'mcp', { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c' } } })
    assert.equal(init.body.result.protocolVersion, '2025-03-26')
    assert.equal(init.body.result.serverInfo.name, 'run')
    assert.ok(init.sid)
    assert.equal((await post(s, 'mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
    const list = (await post(s, 'mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools
    assert.deepEqual(list.map((x: { name: string }) => x.name), ['submit_draft', 'add_artifact', 'add_artifact_file', 'journal'])
    assert.deepEqual(list[0].inputSchema, { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] })
    assert.deepEqual((await call(s, 'submit_draft', { text: 'done' })).body.result, { content: [{ type: 'text', text: 'draft submitted' }] })
    const bad = (await call(s, 'submit_draft', { text: '' })).body.result
    assert.equal(bad.isError, true)
    assert.match(bad.content[0].text, /^invalid input: .*text/s)
    assert.deepEqual(did, ['draft done'])
    const shut = (await call(s, 'journal', { observed: 'o', changed: 'c', next: 'n' })).body.result
    assert.equal(shut.isError, true)
    assert.match(shut.content[0].text, /the journal is shut/)
    assert.equal((await call(s, 'nope', {})).body.error.code, -32602)
    const batch = await post(s, 'mcp', [{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }])
    assert.deepEqual(batch.body, [{ jsonrpc: '2.0', id: 7, result: {} }])
  } finally { await s.close() }
})

test('without its token nothing answers, a GET is refused, and the guard posts get the verdict', async () => {
  const seen: unknown[] = []
  const s = await serveSession({ name: 'run', tools: [], guard: (x) => { seen.push(x); if ((x as { boom?: true }).boom) throw new Error('bad'); return { permission: 'deny', user_message: 'no', agent_message: 'no' } } })
  try {
    assert.equal((await post(s, 'mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong')).status, 401)
    assert.equal((await post(s, 'guard', { tool_name: 'Read' }, '')).status, 401)
    assert.equal((await fetch(s.mcp, { headers: { authorization: `Bearer ${s.token}` } })).status, 405)
    assert.deepEqual((await post(s, 'guard', { tool_name: 'Read', tool_input: { file_path: 'x' } })).body, { permission: 'deny', user_message: 'no', agent_message: 'no' })
    assert.equal((await post(s, 'guard', { boom: true })).body.permission, 'deny', 'a guard that throws denies')
    assert.deepEqual(seen[0], { tool_name: 'Read', tool_input: { file_path: 'x' } })
    assert.match(s.mcp, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  } finally { await s.close() }
})

test('an ask\'s tools answer text; the answer tool takes the asked shape, refuses another, and keeps the last good one', async () => {
  let got: unknown[] = []
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false }
  const s = await serveSession({ name: 'ask', guard: () => ({}), tools: [
    askTool({ name: 'knowledge_read', description: 'd', input: { id: z.string().min(1) }, run: async (a) => `note ${a.id}` }),
    answerTool(schema, (v) => got.push(v)),
  ] })
  try {
    assert.deepEqual((await call(s, 'knowledge_read', { id: 'k1' })).body.result, { content: [{ type: 'text', text: 'note k1' }] })
    const list = (await post(s, 'mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools
    assert.ok(!('$schema' in list[1].inputSchema))
    assert.equal((await call(s, 'answer', { n: 'five' })).body.result.isError, true)
    assert.equal((await call(s, 'answer', { n: 5, extra: 1 })).body.result.isError, true)
    assert.deepEqual(got, [])
    await call(s, 'answer', { n: 5 })
    await call(s, 'answer', { n: 6 })
    assert.deepEqual(got, [{ n: 5 }, { n: 6 }])
  } finally { await s.close() }
  got = []
  const list = answerTool({ type: 'array', items: { type: 'string' } }, (v) => got.push(v))
  assert.deepEqual(list.inputSchema, { type: 'object', properties: { value: { type: 'array', items: { type: 'string' } } }, required: ['value'] })
  assert.equal((await list.call({ value: [1] })).isError, true)
  await list.call({ value: ['a'] })
  assert.deepEqual(got, [['a']])
})
