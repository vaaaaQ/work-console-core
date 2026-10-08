import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_GRANTS } from '../grants.ts'
import { agentSystem } from './prompt.ts'

test('the agent system text names the workspace, its areas, its tools and its grants', () => {
  const t = agentSystem({ ws: 'crm', title: 'My CRM', interview: false, grants: { ...EMPTY_GRANTS, hosts: ['api.example.com'] } })
  for (const s of ['My CRM', 'workspaces/crm/', 'tools/', 'grants.json', 'check', 'apply', 'undo', 'propose_grants', 'create_workspace', 'ctx.http', '"api.example.com"'])
    assert.ok(t.includes(s), s)
  assert.doesNotMatch(t, /interview/i)
  assert.doesNotMatch(t, /claude|mcp__/i, 'no provider terms')
})

test('the first conversation of a new workspace is an interview that ends in grants, a board, playbooks and sign-ins', () => {
  const t = agentSystem({ ws: 'crm', title: 'My CRM', interview: true, grants: EMPTY_GRANTS })
  for (const s of [/interview/i, /one question at a time/i, /tools/i, /work item/i, /repeat/i, /propose_grants/, /board/i, /playbooks/i, /sign in/i, /password/i, /"Sign in to <host>" button/])
    assert.match(t, s)
})
