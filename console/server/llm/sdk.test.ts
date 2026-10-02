import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOW, mcpServers, permissions } from './sdk.ts'

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
