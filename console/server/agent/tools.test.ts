import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentCommit, Grants } from '../../src/model/agent.ts'
import { EMPTY_GRANTS } from '../grants.ts'
import { agentTools } from './tools.ts'
import type { AgentHooks, AgentOps } from './tools.ts'
import type { Applied } from './ops.ts'

function setup(o: Partial<AgentOps> = {}, commits: AgentCommit[] = []) {
  const calls: unknown[][] = [], done: AgentCommit[] = [], proposed: [Grants, string][] = []
  const ops: AgentOps = {
    check: async (ws) => { calls.push(['check', ws]); return { ok: true, failures: [] } },
    apply: async (ws, s) => { calls.push(['apply', ws, s]); return { ok: true, sha: 'a'.repeat(40), files: ['workspaces/w1/page.ts'], summary: s } },
    undo: async (ws, sha) => { calls.push(['undo', ws, sha]); return { ok: true, sha: 'b'.repeat(40), files: ['workspaces/w1/page.ts'], summary: 'undo — x' } },
    createWorkspace: async (ws, n, taken) => { calls.push(['create', ws, n, taken]); return { ok: true, sha: 'c'.repeat(40), files: [], summary: `create workspace ${n.id} — ${n.title}` } },
    ...o,
  }
  const hooks: AgentHooks = {
    grants: () => EMPTY_GRANTS, commits: () => commits, taken: () => ({ ids: ['w1'], prefixes: ['W'] }),
    committed: (c) => { done.push(c) }, propose: (g, r) => { proposed.push([g, r]) },
  }
  const tools = Object.fromEntries(agentTools({ ws: 'w1', ops, hooks }).map((t) => [t.name, t]))
  return { tools, calls, done, proposed }
}

test('the agent has five console tools with neutral names', () => {
  assert.deepEqual(Object.keys(setup().tools).sort(), ['apply', 'check', 'create_workspace', 'propose_grants', 'undo'])
})

test('check says passed, or lists the failures', async () => {
  assert.equal(await setup().tools.check.run({}), 'The check passed.')
  const s = setup({ check: async () => ({ ok: false, failures: ['tools/a.ts:1: imports node:net'] }) })
  assert.equal(await s.tools.check.run({}), 'The check failed:\ntools/a.ts:1: imports node:net')
})

test('apply records the commit and says the console restarts after the turn; a failure says why and records nothing', async () => {
  const s = setup()
  const t = await s.tools.apply.run({ summary: 'show the counter' })
  assert.match(t, /^Applied aaaaaaaa: show the counter\./)
  assert.match(t, /restarts when this turn ends/)
  assert.deepEqual(s.done.map((c) => [c.sha, c.kind, c.summary, c.files]), [['a'.repeat(40), 'apply', 'show the counter', ['workspaces/w1/page.ts']]])
  const bad: Applied = { ok: false, error: 'the check failed', failures: ['x: y'] }
  const f = setup({ apply: async () => bad })
  assert.equal(await f.tools.apply.run({ summary: 's' }), 'Not applied: the check failed\nx: y')
  assert.deepEqual(f.done, [])
})

test('undo takes only a commit this agent made and has not undone, by a prefix of its sha', async () => {
  const mine: AgentCommit = { sha: 'abcdef1234', summary: 'x', files: [], at: '', kind: 'apply' }
  const gone: AgentCommit = { sha: 'fedcba9876', summary: 'y', files: [], at: '', kind: 'apply', undoneBy: '1111' }
  const s = setup({}, [mine, gone])
  assert.match(await s.tools.undo.run({ sha: 'abcdef1' }), /^Undone abcdef12 with bbbbbbbb/)
  assert.deepEqual(s.calls.at(-1), ['undo', 'w1', 'abcdef1234'])
  assert.equal(s.done[0].kind, 'undo')
  assert.match(await s.tools.undo.run({ sha: 'fedcba9' }), /already undone/)
  assert.match(await s.tools.undo.run({ sha: '1234567' }), /not one of your commits/)
  assert.match(await s.tools.undo.run({ sha: 'ab' }), /at least 7/)
})

test('propose_grants puts the whole grants up for approval; malformed or unchanged grants are refused', async () => {
  const s = setup()
  const t = await s.tools.propose_grants.run({ change: { hosts: ['api.example.com'] }, reason: 'read the tracker' })
  assert.match(t, /Approvals/)
  assert.deepEqual(s.proposed, [[{ ...EMPTY_GRANTS, hosts: ['api.example.com'] }, 'read the tracker']])
  assert.match(await s.tools.propose_grants.run({ change: { bogus: 1 }, reason: 'r' }), /unknown key bogus/)
  assert.match(await s.tools.propose_grants.run({ change: {}, reason: 'r' }), /already/)
  assert.match(await s.tools.propose_grants.run({ change: { packs: ['x'] }, reason: ' ' }), /reason/)
})

test('create_workspace passes the registered ids and prefixes and records the commit', async () => {
  const s = setup()
  assert.match(await s.tools.create_workspace.run({ id: 'crm', prefix: 'CRM', title: 'CRM' }), /^Created workspace crm/)
  assert.deepEqual(s.calls.at(-1), ['create', 'w1', { id: 'crm', prefix: 'CRM', title: 'CRM' }, { ids: ['w1'], prefixes: ['W'] }])
  assert.equal(s.done[0].kind, 'create')
})
