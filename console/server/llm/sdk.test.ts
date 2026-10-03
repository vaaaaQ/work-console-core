import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOW, mcpServers, permissions, runToolDefs } from './sdk.ts'
import type { RunTools } from './sdk.ts'

test("a session loads no user or local settings, and may use only its own tools, A's reads and runTools", () => {
  const p = permissions(['mcp__my-tools', 'Bash(npm test)'])
  assert.deepEqual(p.settingSources, ['project'], "the user's shell allow rules must not reach a session")
  assert.equal(p.permissionMode, 'dontAsk')
  assert.deepEqual(p.allowedTools, [...ALLOW, 'mcp__my-tools', 'Bash(npm test)'])
  assert.ok(!p.allowedTools.includes('mcp__bridge__bridge_act'))
  for (const k of ['mcp__bridge__knowledge_search', 'mcp__bridge__knowledge_read', 'mcp__bridge__knowledge_propose']) assert.ok(p.allowedTools.includes(k), k)
  for (const d of ['mcp__bridge__bridge_act', 'Read(~/.bridge/**)', 'Read(~/.work-console/**)']) assert.ok(p.disallowedTools.includes(d), d)
})

test("a session's MCP servers: A's bridge with the LLM token, its run tools, and the workspace's own", () => {
  const run = { type: 'sdk' } as never, tracker = { type: 'http', url: 'http://127.0.0.1:1/mcp' }
  const s = mcpServers({ gatewayUrl: 'http://127.0.0.1:47821/', llmToken: () => 'llm-tok', mcp: { tracker } }, run)
  assert.deepEqual(Object.keys(s), ['bridge', 'run', 'tracker'])
  assert.deepEqual(s.bridge, { type: 'http', url: 'http://127.0.0.1:47821/mcp', headers: { Authorization: 'Bearer llm-tok' } })
  assert.equal(s.run, run); assert.equal(s.tracker, tracker)
  assert.deepEqual(Object.keys(mcpServers({ gatewayUrl: 'http://g', llmToken: () => '' }, run)), ['bridge', 'run'])
})

test("a session gets no user-scope MCP servers and never the console's own job tools", () => {
  const p = permissions([])
  assert.equal(p.strictMcpConfig, true)
  for (const d of ['mcp__work-console', 'Bash(*mcp.token*)', 'PowerShell(*mcp.token*)']) assert.ok(p.disallowedTools.includes(d), d)
})

test('a workspace without a gateway: no bridge server, no bridge tools, and the deny list still holds', () => {
  const run = { type: 'sdk' } as never, tracker = { type: 'http', url: 'http://127.0.0.1:1/mcp' }
  let read = false
  const s = mcpServers({ gatewayUrl: 'http://g', llmToken: () => { read = true; return '' }, mcp: { tracker }, bridge: false }, run)
  assert.deepEqual(Object.keys(s), ['run', 'tracker'])
  assert.equal(read, false, 'no LLM token is read without a bridge')
  const p = permissions(['Edit'], false)
  assert.ok(!p.allowedTools.some((t) => t.startsWith('mcp__bridge__')), p.allowedTools.join(', '))
  for (const t of ['mcp__run__submit_draft', 'mcp__run__journal', 'Edit']) assert.ok(p.allowedTools.includes(t), t)
  assert.deepEqual(p.disallowedTools, permissions([]).disallowedTools)
})

test('the run server has its own four tools, and screenshot only when the run carries it', () => {
  const none = async () => {}
  const base: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.deepEqual(runToolDefs(base).map((d) => d.name), ['submit_draft', 'add_artifact', 'add_artifact_file', 'journal'])
  assert.deepEqual(runToolDefs({ ...base, screenshot: none }).map((d) => d.name).at(-1), 'screenshot')
  for (const d of runToolDefs({ ...base, screenshot: none })) assert.ok(ALLOW.includes(`mcp__run__${d.name}`), d.name)
})

test('create_job and start_job only when the run carries them; create_job answers with the new id', async () => {
  const none = async () => {}
  const base: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.ok(!runToolDefs(base).some((d) => d.name === 'create_job' || d.name === 'start_job'))
  const defs = runToolDefs({ ...base, createJob: async () => 'AD-0009', startJob: none })
  assert.deepEqual(defs.map((d) => d.name).slice(-2), ['create_job', 'start_job'])
  for (const d of defs) assert.ok(ALLOW.includes(`mcp__run__${d.name}`), d.name)
  const create = defs.find((d) => d.name === 'create_job')!.handler as (a: unknown, x: unknown) => Promise<{ content: unknown }>
  const r = await create({ title: 'x' }, {})
  assert.deepEqual(r.content, [{ type: 'text', text: 'created AD-0009' }])
})

test('a run reads nothing of the console home: its tokens, its config and the database password', () => {
  const deny = permissions([]).disallowedTools
  for (const d of ['Read(~/.work-console/**)', 'Read(**/.work-console/**)', 'Bash(*.work-console*)', 'PowerShell(*.work-console*)']) assert.ok(deny.includes(d), d)
})
