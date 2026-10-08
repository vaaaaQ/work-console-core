import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_GRANTS } from '../grants.ts'
import { agentSystem, reintegrateAgain, reintegratePrompt, reintegrateSystem } from './prompt.ts'

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

test('a reintegration names the worktree, the branch, its three tools, and puts the output and the diff in its first prompt', () => {
  const t = reintegrateSystem({ ws: 'crm', title: 'My CRM', core: 'e'.repeat(40), from: 'f'.repeat(40), branch: 'update/eeeeeee' })
  for (const s of ['fffffff to eeeeeee', 'update/eeeeeee', 'workspaces/crm/', 'tools/', 'EXTENDING.md', 'check', 'apply', 'give_up', 'another workspace'])
    assert.ok(t.includes(s), s)
  assert.doesNotMatch(t, /propose_grants|create_workspace|undo/)
  assert.doesNotMatch(t, /claude|mcp__/i, 'no provider terms')
  const p = reintegratePrompt({ ws: 'crm', core: 'e'.repeat(40), from: 'f'.repeat(40), step: 'tests', output: 'not ok 1\n', diff: '-a\n+b\n' })
  assert.match(p, /failed at tests[\s\S]*not ok 1[\s\S]*```diff\n-a\n\+b\n```/)
  assert.match(reintegrateAgain({ step: 'build', output: 'x' }), /failed again at build/)
})
