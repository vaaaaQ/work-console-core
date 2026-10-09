import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Job } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { EMPTY_GRANTS } from '../grants.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx } from '../testkit.ts'
import { tempDir } from '../testdirs.ts'
import { agentSystem, jobState, jobSystem, reintegrateAgain, reintegratePrompt, reintegrateSystem, wsState } from './prompt.ts'

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

test('an unmanaged agent names its job tools and proposals, and no code tools', () => {
  const t = agentSystem({ ws: 'crm', title: 'My CRM', interview: false, grants: EMPTY_GRANTS, managed: false })
  for (const s of ['My CRM', 'propose {job, say, cmds}', 'list_jobs', 'get_job', 'stepAdd', 'returnTo', 'waitAdd', 'you change no file'])
    assert.ok(t.includes(s), s)
  assert.doesNotMatch(t, /\bcheck\b|apply \{|\bundo\b|propose_grants|create_workspace/)
  assert.doesNotMatch(t, /claude|mcp__/i, 'no provider terms')
  assert.ok(agentSystem({ ws: 'crm', title: 'My CRM', interview: false, grants: EMPTY_GRANTS, managed: true }).includes('propose {job, say, cmds}'))
})

test('a job conversation names its job, proposes through the console and decides on a reply', () => {
  const t = jobSystem({ ws: 'crm', title: 'My CRM', job: { id: 'J-0006', t: 'Local stand' } })
  for (const s of ['J-0006 “Local stand”', 'propose {job: "J-0006", say, cmds}', 'never send', 'stepDone', 'waitAdd', 'start auto or self', 'ask: 1'])
    assert.ok(t.includes(s), s)
  assert.doesNotMatch(t, /claude|mcp__/i, 'no provider terms')
})

/** a started action job with an added ask step, a reply on the triage, 25 journal lines and an open proposal */
async function stateJob(): Promise<{ j: Job; all: Job[] }> {
  const jobs = new Jobs({ store: fileStore(join(tempDir('ps'), 's.json')), bus: new Bus(), ctx: demoCtx, gate: () => true })
  const c = await jobs.create({ t: 'Local stand', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' })
  const j0 = (await jobs.cmd(c.id, { op: 'start' }, c.v)).job
  await jobs.cmd(j0.id, { op: 'ppSet', say: 'after the daily', by: 'c1', cmds: [{ op: 'stepAdd', after: 'tr', step: { t: 'Ask Imre', m: 'llm', start: 'self', ask: 1 }, tpl: [['chat', 'the team chat', 'Can we go?']], why: 'the daily said ask first' }] }, undefined, 'console')
  await jobs.cmd(j0.id, { op: 'ppAccept' })
  await jobs.cmd(j0.id, { op: 'ppSet', say: 'one more question', by: 'c2', cmds: [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'who signs?' }] }, undefined, 'console')
  const j = structuredClone((await jobs.get(j0.id))!)
  j.flow.tr.rw = { src: 'chat', ch: '19:abc', at: '2026-10-09T12:00:00Z' }
  j.flow.tr.rp = [{ id: 'm1', at: '2026-10-09T12:05:00Z', from: 'Imre', t: 'yes, go' }]
  j.jr = Array.from({ length: 25 }, (_, i) => ({ ts: `2026-10-09T10:${String(i).padStart(2, '0')}:00Z`, a: 'x', o: `line ${i}`, c: '', n: '' }))
  const other = { ...structuredClone(j), id: 'J-0999', t: 'Other', pp: undefined, flow: { ...j.flow, dr: { ...j.flow.dr, s: 'wait' as const, w: [{ j: j.id, st: 'open' as const }] } } }
  return { j, all: [j, other] }
}

test('jobState lists the steps with mode and start, waits, replies, the last 20 journal lines and the open proposal', async () => {
  const { j, all } = await stateJob()
  const t = jobState(demoCtx(), j, { all, notes: [{ id: 'n1', v: 1, title: 'How the stand runs', tags: [], playbooks: [], updated: '', size: 1 }] })
  for (const s of [
    `# The job now: ${j.id} “Local stand”`, 'its own steps', '“Understand the request” · cur · LLM · start default',
    'n1 “Ask Imre” · tpl · LLM · start self · asks for a reply · added 2026-10-09 by you: the daily said ask first',
    'waits for a reply in chat since 2026-10-09T12:00:00Z', 'reply from Imre at 2026-10-09T12:05:00Z: yes, go', '“Send it” · tpl · you',
    '# Steps of other jobs that wait for this one', '- J-0999 “Other”, step dr',
    '# The open proposal', 'by c2)', 'say: one more question', '1. {"op":"noteAdd","step":"tr","k":"q","t":"who signs?"}',
    '# Knowledge notes', '- n1: How the stand runs',
  ]) assert.ok(t.includes(s), s)
  assert.ok(t.includes('line 0') && t.includes('line 19'))
  assert.ok(!t.includes('line 20'), 'only the last 20 journal lines')
  delete j.pp
  assert.match(jobState(demoCtx(), j, { all: [j], notes: [] }), /# No open proposal[\s\S]*# Knowledge notes\nnone$/)
})

test('wsState lists the open jobs and the notes', async () => {
  const { j, all } = await stateJob()
  const t = wsState(demoCtx(), all, [])
  assert.match(t, /^# Open jobs \(newest first\)/)
  for (const s of [j.id, 'J-0999', '# Knowledge notes\nnone']) assert.ok(t.includes(s), s)
})
