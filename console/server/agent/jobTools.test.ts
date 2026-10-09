import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Cmd, Job } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { notesStore } from '../knowledge/notes.ts'
import type { AskTool } from '../llm/sdk.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx } from '../testkit.ts'
import { tempDir } from '../testdirs.ts'
import { PROPOSED, jobAgentTools } from './jobTools.ts'
import type { JobDeps } from './jobTools.ts'

/** a started action job with its own steps: an ask step added after the triage, a reply watch on the triage
    with one reply in, and an open proposal */
async function setup() {
  const jobs = new Jobs({ store: fileStore(join(tempDir('jt'), 's.json')), bus: new Bus(), ctx: demoCtx, gate: () => true })
  const c = await jobs.create({ t: 'Local stand', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' })
  const j0 = (await jobs.cmd(c.id, { op: 'start' }, c.v)).job
  const add: Cmd = { op: 'stepAdd', after: 'tr', step: { t: 'Ask Imre', m: 'llm', start: 'self', ask: 1 }, tpl: [['chat', 'the team chat', 'Can we go?']] }
  await jobs.cmd(j0.id, { op: 'ppSet', say: 'from the daily', cmds: [add], by: 'c1' }, undefined, 'console')
  await jobs.cmd(j0.id, { op: 'ppAccept' })
  await jobs.cmd(j0.id, { op: 'ppSet', say: 'one more question', cmds: [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'who signs?' }], by: 'c2' }, undefined, 'console')
  const j: Job = structuredClone((await jobs.get(j0.id))!)
  j.flow.tr.rw = { src: 'chat', ch: '19:abc', at: '2026-10-09T12:00:00Z' }
  j.flow.tr.rp = [{ id: 'm1', at: '2026-10-09T12:05:00Z', from: 'Imre', t: 'yes, go' }]
  const proposed: [string, string, Cmd[], string][] = []
  const d: JobDeps = {
    jobs: { get: async (id) => (id === j.id ? j : undefined), all: async () => [j] }, runs: async () => [], ctx: demoCtx,
    notes: notesStore(join(tempDir('jt-kn'), 'kn')), source: null, key: (id) => id,
    proposer: { propose: async (id, say, cmds, by) => { proposed.push([id, say, cmds, by]); return id === j.id ? '' : `Not proposed: there is no job ${id} in this workspace.` } },
  }
  const tools = jobAgentTools({ ws: 'acme', conv: 'conv-9', d })
  return { j, d, tools, proposed, tool: (n: string) => tools.find((t) => t.name === n)! }
}
const steps = (d: { phases: { steps: Record<string, unknown>[] }[] }) => d.phases.flatMap((p) => p.steps)

test("get_job shows the own steps, an added step's why, the reply watch and the open proposal", async () => {
  const { j, tool } = await setup()
  const d = JSON.parse(await tool('get_job').run({ id: j.id }))
  const ss = steps(d), added = ss.find((s) => s.title === 'Ask Imre')!, tr = ss.find((s) => s.id === 'tr')!
  assert.deepEqual(ss.map((s) => s.title), ['Understand the request', 'Ask Imre', 'Draft the answer', 'Send it'])
  assert.deepEqual([added.start, added.asks, (added.added as { why: string }).why], ['self', true, 'from the daily'])
  assert.deepEqual(tr.waitsReply, { src: 'chat', ch: '19:abc', at: '2026-10-09T12:00:00Z' })
  assert.deepEqual(tr.replies, [{ at: '2026-10-09T12:05:00Z', from: 'Imre', t: 'yes, go' }])
  assert.deepEqual(d.proposal.by, 'c2')
  assert.deepEqual([d.proposal.say, d.proposal.changes], ['one more question', [JSON.stringify({ op: 'noteAdd', step: 'tr', k: 'q', t: 'who signs?' })]])
  assert.equal(await tool('get_job').run({ id: 'J-0404' }), 'no job J-0404 in this workspace')
  assert.match(await tool('list_jobs').run({}), new RegExp(`^- ${j.id}: Local stand · Action · \\S+ · at “Understand the request” · needs the person$`))
  assert.equal(await tool('list_jobs').run({ filter: 'closed' }), 'no closed jobs')
})

test('step_output gives the draft, the output and the artifact names', async () => {
  const { j, tool } = await setup()
  j.flow.dr.dr = { t: 'Dear Imre, …', at: '2026-10-09T12:00:00Z' }
  j.flow.dr.out = 'o'.repeat(25_000)
  j.flow.dr.arts = [{ n: 'draft.md', ok: true }, { n: 'notes.md', ok: false }]
  const t = await tool('step_output').run({ id: j.id, step: 'Draft the answer' })
  assert.match(t, new RegExp(`^${j.id} step dr “Draft the answer” \\(fut\\)\\n## Draft\\nDear Imre, …\\n## Output\\no{20000} … \\(5000 more characters\\)\\n## Artifacts\\ndraft.md\\nnotes.md \\(planned\\)$`))
  assert.match(await tool('step_output').run({ id: j.id, step: 'tr' }), /## Draft\nnone\n## Output\nnone\n## Artifacts\nnone$/)
  assert.equal(await tool('step_output').run({ id: j.id, step: 'nope' }), `${j.id} has no step nope`)
})

test('there are no send, act or job_command tools; propose answers Proposed and signs with the conversation', async () => {
  const { j, d, tools, proposed, tool } = await setup()
  assert.deepEqual(tools.map((t: AskTool) => t.name), ['list_jobs', 'get_job', 'step_output', 'propose', 'knowledge_search', 'knowledge_read'])
  const withSource = jobAgentTools({ ws: 'acme', conv: 'c', d: { ...d, source: { read: async () => ({}), get: async () => ({ status: 'ok' }) } } }).map((t) => t.name)
  assert.deepEqual(withSource.slice(-2), ['source_list', 'source_get'])
  for (const n of withSource) assert.doesNotMatch(n, /send|act|command|reply|submit|undo/)
  assert.match(tool('propose').description, /stepAdd .*returnTo .*waitAdd/s)
  const cmds = [{ op: 'returnTo', step: 'tr', why: 'back to design' }]
  assert.equal(await tool('propose').run({ job: j.id, say: 'Back to design', cmds }), PROPOSED)
  assert.deepEqual(proposed[0], [j.id, 'Back to design', cmds, 'conv-9'])
  assert.match(await tool('propose').run({ job: 'B-1', say: 'x', cmds }), /^Not proposed: there is no job B-1/)
})
