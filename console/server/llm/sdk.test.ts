import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOW, permissions } from './sdk.ts'

test("a session loads no user or local settings, and may use only its own tools, A's reads and runTools", () => {
  const p = permissions(['mcp__my-tools', 'Bash(npm test)'])
  assert.deepEqual(p.settingSources, ['project'], "the user's shell allow rules must not reach a session")
  assert.equal(p.permissionMode, 'dontAsk')
  assert.deepEqual(p.allowedTools, [...ALLOW, 'mcp__my-tools', 'Bash(npm test)'])
  assert.ok(!p.allowedTools.includes('mcp__bridge__bridge_act'))
  for (const k of ['mcp__bridge__knowledge_search', 'mcp__bridge__knowledge_read', 'mcp__bridge__knowledge_propose']) assert.ok(p.allowedTools.includes(k), k)
  for (const d of ['mcp__bridge__bridge_act', 'Read(~/.bridge/**)', 'Read(~/.work-console/**)']) assert.ok(p.disallowedTools.includes(d), d)
})

test("a session gets no user-scope MCP servers and never the console's own job tools", () => {
  const p = permissions([])
  assert.equal(p.strictMcpConfig, true)
  for (const d of ['mcp__work-console', 'Bash(*mcp.token*)', 'PowerShell(*mcp.token*)']) assert.ok(p.disallowedTools.includes(d), d)
})
