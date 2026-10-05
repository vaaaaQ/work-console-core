import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PB0 } from '../data/playbooks.ts'
import { JOBS0, JR, OVR, TPL0 } from '../data/demo.ts'
import { clone } from '../lib/util.ts'
import { KINDS } from './context.ts'
import type { Job } from './types.ts'
import { CmdError, DESC_MAX, apply, askText, atOf, freshJob, isClosed, isLive, needsYou, nextMonth, seedFlow, steps } from './transitions.ts'
import type { Ctx, NewJob } from './transitions.ts'

const T0 = new Date('2026-09-30T12:00:00Z')
const X: Ctx = { PB: PB0, TPL: TPL0, now: () => T0 }
const jobs = (): Job[] => clone(JOBS0).map((s) => { const j = s as Job; seedFlow(X, j, OVR[j.id], JR[j.id]); return j })
const find = (p: (j: Job) => boolean) => jobs().find(p)!
const open = () => find((j) => !isClosed(j) && j.st !== 'recurring' && j.st !== 'draft' && !!atOf(X, j))
const code = (f: () => unknown, c: string) => assert.throws(f, (e: unknown) => e instanceof CmdError && e.code === c)

test('stepDone moves the job to the next live step and starts it', () => {
  const j = open(), at = atOf(X, j)!
  const { job, nx } = apply(X, j, { op: 'stepDone', step: at })
  assert.equal(job.flow[at].s, 'done')
  assert.equal(nx, atOf(X, job))
  if (nx) assert.equal(job.flow[nx].s === 'fut' || job.flow[nx].s === 'tpl', false)
  assert.match(job.jr[0].o, /^Marked “.+” done/)
  assert.equal(job.jr[0].l, 'ok')
  assert.equal(job.jr[0].ts, T0.toISOString())
})

test('apply never mutates the job it is given', () => {
  const j = open(), before = JSON.stringify(j)
  apply(X, j, { op: 'stepDone', step: atOf(X, j)! })
  assert.equal(JSON.stringify(j), before)
})

test('commands on a closed job are refused; reopen is not', () => {
  const j = find((j) => j.st === 'done')
  code(() => apply(X, j, { op: 'stepDone', step: steps(X, j.pb)[0].id }), 'bad_state')
  code(() => apply(X, j, { op: 'close', st: 'done' }), 'bad_state')
  assert.equal(apply(X, j, { op: 'reopen' }).job.st, 'active')
})

test('an unknown step is bad_step, a missing draft is bad_state, a bad note index is bad_args', () => {
  const j = open(), at = atOf(X, j)!
  code(() => apply(X, j, { op: 'stepDone', step: 'nope' }), 'bad_step')
  const noDraft = apply(X, j, { op: 'stepReopen', step: at }).job
  noDraft.flow[at].dr = null
  code(() => apply(X, noDraft, { op: 'acceptDraft', step: at }), 'bad_state')
  code(() => apply(X, j, { op: 'noteAnswer', step: at, i: 99, r: 'x' }), 'bad_args')
  code(() => apply(X, j, { op: 'bogus' } as never), 'bad_args')
})

test('an LLM run: start → draft → accept with edits', () => {
  const j = open(), at = atOf(X, j)!
  let r = apply(X, j, { op: 'runStart', step: at, q: 'do it', id: 'r1' }).job
  assert.deepEqual(r.flow[at].run, { q: 'do it', at: T0.getTime(), id: 'r1' })
  assert.equal(r.st, 'active')
  code(() => apply(X, r, { op: 'runStart', step: at, q: 'again', id: 'r2' }), 'bad_state')
  r = apply(X, r, { op: 'runDraft', step: at, t: 'the draft' }).job
  assert.equal(r.flow[at].run, null)
  assert.equal(r.flow[at].dr!.t, 'the draft')
  assert.equal(r.flow[at].s, 'wait')
  assert.equal(r.st, 'waiting-user')
  assert.equal(r.jr[0].a, 'LLM')
  assert.ok(needsYou(X, r))
  r = apply(X, r, { op: 'acceptDraft', step: at, text: 'edited' }).job
  assert.equal(r.flow[at].out, 'edited')
  assert.equal(r.flow[at].s, 'done')
  assert.match(r.jr[0].o, /with edits/)
})

test('runEnd puts the step back and journals why; without a run it changes nothing', () => {
  const j = open(), at = atOf(X, j)!
  const r = apply(X, j, { op: 'runStart', step: at, q: 'q', id: 'r1' }).job
  for (const why of ['cancelled', 'failed', 'interrupted'] as const) {
    const e = apply(X, r, { op: 'runEnd', step: at, why, detail: 'rate limit' }).job
    assert.equal(e.flow[at].run, null)
    assert.equal(e.flow[at].s, 'cur')
    assert.equal(e.jr[0].l, why === 'cancelled' ? 'off' : why === 'failed' ? 'bad' : 'wait')
  }
  assert.equal(apply(X, j, { op: 'runEnd', step: at, why: 'failed' }).job.jr.length, j.jr.length)
})

test('askText is the step in its own words: what to do, when it is done, what it produces', () => {
  const s = { id: 'a', t: 'Read the issue', m: 'llm' as const, x: 'Criteria clear' }
  assert.equal(askText(s), 'Do: Read the issue.\nDone when: Criteria clear.')
  assert.equal(askText({ ...s, a: ['analysis.md', 'notes.md'] }), 'Do: Read the issue.\nDone when: Criteria clear.\nProduce: analysis.md, notes.md.')
})

test("askText ends each line once, whatever the step's own words end with", () => {
  const s = { id: 'a', t: 'Read the issue.', m: 'llm' as const, x: 'Criteria are clear!' }
  assert.equal(askText(s), 'Do: Read the issue.\nDone when: Criteria are clear!')
  assert.equal(askText({ ...s, x: 'A note, submitted with submit_draft. Use no other tools.' }), 'Do: Read the issue.\nDone when: A note, submitted with submit_draft. Use no other tools.')
})

test('a run the console starts or resumes by itself is signed console; an interrupted run that will resume says so', () => {
  const j = open(), at = atOf(X, j)!
  const mine = apply(X, j, { op: 'runStart', step: at, q: 'q', id: 'r1' }).job.jr[0]
  assert.equal(mine.a, 'you'); assert.equal(mine.c, 'LLM run started.')
  const auto = apply(X, j, { op: 'runStart', step: at, q: 'q', id: 'r1', auto: true }).job
  assert.equal(auto.jr[0].a, 'console'); assert.match(auto.jr[0].o, /^Asked the LLM for “/); assert.equal(auto.jr[0].c, 'LLM run started by itself.')
  const back = apply(X, j, { op: 'runStart', step: at, q: 'q', id: 'r1', resumed: true, auto: true }).job.jr[0]
  assert.equal(back.a, 'console'); assert.match(back.o, /^Resumed the LLM run for “/); assert.equal(back.c, 'LLM run continues its session by itself.')
  assert.equal(apply(X, auto, { op: 'runEnd', step: at, why: 'interrupted', due: true }).job.jr[0].n, 'nothing; it resumes by itself when the console is back.')
  assert.equal(apply(X, auto, { op: 'runEnd', step: at, why: 'interrupted' }).job.jr[0].n, 'resume it when the console is back.')
})

test('runEnd and artifact still apply on a closed job (a run can end after close)', () => {
  const j = find((j) => j.st === 'done'), sid = steps(X, j.pb)[0].id
  assert.doesNotThrow(() => apply(X, j, { op: 'runEnd', step: sid, why: 'cancelled' }))
  assert.equal(apply(X, j, { op: 'artifact', step: sid, n: 'notes.md', link: 'C:/x/notes.md' }).job.flow[sid].arts.at(-1)!.link, 'C:/x/notes.md')
})

test('sent records the planned message with an ISO time and the channel in the journal', () => {
  const sid = Object.keys(TPL0).find((k) => jobs().some((j) => !isClosed(j) && j.flow[k] && j.st !== 'draft'))!
  const j = find((j) => !isClosed(j) && !!j.flow[sid] && j.st !== 'draft')
  const r = apply(X, j, { op: 'sent', step: sid, i: 0, t: 'hello', to: 'Slack · PO' }).job
  assert.deepEqual(r.flow[sid].sent[0], { at: T0.toISOString(), t: 'hello' })
  assert.equal(r.jr[0].o, 'Sent to Slack · PO.')
  code(() => apply(X, j, { op: 'sent', step: sid, i: 9, t: 'x', to: 'y' }), 'bad_args')
})

test('a recurring job starts its flow again after the last step', () => {
  let j = find((j) => j.st === 'recurring')
  for (let i = 0; i < 50; i++) {
    const at = atOf(X, j)!
    const r = apply(X, j, { op: 'stepDone', step: at })
    j = r.job
    if (j.jr.some((e) => e.o === 'Period complete.')) break
  }
  const first = steps(X, j.pb)[0].id
  assert.equal(j.flow[first].s, 'cur')
  assert.equal(j.st, 'recurring')
})

test("a new period's artifacts are planned again and lose last period's links", () => {
  let j = find((j) => j.st === 'recurring')
  const sid = steps(X, j.pb)[0].id
  j = apply(X, j, { op: 'artifact', step: sid, n: 'report.md', link: '/api/artifacts/x/report.md' }).job
  for (let i = 0; i < 50 && !j.jr.some((e) => e.o === 'Period complete.'); i++) j = apply(X, j, { op: 'stepDone', step: atOf(X, j)! }).job
  assert.deepEqual(j.flow[sid].arts.find((a) => a.n === 'report.md'), { n: 'report.md', ok: false, nw: 1 })
})

test('an artifact with ok: false goes back to planned and drops its link', () => {
  const j = find((j) => j.st === 'done'), sid = steps(X, j.pb)[0].id
  const k = apply(X, j, { op: 'artifact', step: sid, n: 'a.pdf', link: '/api/artifacts/x/a.pdf' }).job
  const a = apply(X, k, { op: 'artifact', step: sid, n: 'a.pdf', ok: false }).job.flow[sid].arts.find((a) => a.n === 'a.pdf')!
  assert.equal(a.ok, false); assert.equal(a.link, undefined)
  assert.equal(apply(X, k, { op: 'artifact', step: sid, n: 'none.pdf', ok: false }).job.flow[sid].arts.some((a) => a.n === 'none.pdf'), false)
})

test('a missing file leaves its artifact unticked and the step live', () => {
  const j = open(), at = atOf(X, j)!
  const made = apply(X, j, { op: 'artifact', step: at, n: 'out.pdf', link: '/api/artifacts/x/out.pdf' }).job
  assert.equal(made.flow[at].arts.find((a) => a.n === 'out.pdf')!.ok, true)
  const gone = apply(X, made, { op: 'artifact', step: at, n: 'out.pdf', ok: false }).job
  assert.deepEqual(gone.flow[at].arts.filter((a) => a.n === 'out.pdf').map((a) => [a.ok, a.link]), [[false, undefined]])
  assert.equal(isLive(gone.flow[at]), true)
  assert.equal(atOf(X, gone), at)
})

test('votes follow the pack rule', () => {
  const j = find((j) => j.ws === 'acme' && Object.values(j.flow).some((f) => f.rv))
  const sid = Object.keys(j.flow).find((k) => j.flow[k].rv)!
  const r = apply(X, j, { op: 'vote', step: sid, n: 'Tom Becker', v: 1 }).job
  assert.equal(r.flow[sid].m, 'approvals 2/2')
  code(() => apply(X, j, { op: 'vote', step: sid, n: 'x', v: 3 }), 'bad_args')
})

test('freshJob builds a ready job at the first step; unknown playbooks are refused', () => {
  const j = freshJob(X, 'J-9000', { t: 'New thing', key: 'ACME-1', pb: 'action', prj: 'platform', ws: 'acme', src: 'Slack · Anna', chat: 'c4' })
  assert.equal(j.st, 'ready')
  assert.equal(j.at, steps(X, 'action')[0].id)
  assert.equal(j.flow[j.at!].s === 'fut' || j.flow[j.at!].s === 'tpl', true)
  assert.equal(j.jr[0].o, 'Created the job from Slack · Anna.')
  assert.equal(j.chat, 'c4')
  code(() => freshJob(X, 'J-9001', { t: 'x', key: '', pb: 'nope', prj: '', ws: 'acme' }), 'bad_args')
  const started = apply(X, j, { op: 'start' })
  assert.equal(started.job.st === 'active' || started.job.st === 'waiting-user', true)
  code(() => apply(X, started.job, { op: 'start' }), 'bad_state')
})

test('freshJob keeps a given description and context list instead of the defaults', () => {
  const base: NewJob = { t: 'New thing', key: 'ACME-1', pb: 'action', prj: 'platform', ws: 'acme', chat: 'c4' }
  assert.ok(freshJob(X, 'J-9000', base).ctx!.length > 0, 'the key and the chat give defaults')
  const j = freshJob(X, 'J-9001', { ...base, d: ' Why: the **quota**. ',
    ctx: [{ k: 'note', id: 'tracker-rest', n: 1, name: 'Tracker REST' }, { k: 'chat', id: 'c9' }, { k: 'chat', id: 'c9', n: 3 }] as never })
  assert.equal(j.d, 'Why: the **quota**.')
  assert.deepEqual(j.ctx, [{ k: 'note', id: 'tracker-rest', n: 1, name: 'Tracker REST' }, { k: 'chat', id: 'c9', n: KINDS.chat.def }])
  assert.deepEqual(freshJob(X, 'J-9002', { ...base, ctx: [] }).ctx, [], 'an empty list is kept: no defaults')
  assert.equal(freshJob(X, 'J-9003', { ...base, d: '  ' }).d, undefined)
  code(() => freshJob(X, 'J-9004', { ...base, ctx: 'c4' as never }), 'bad_args')
  code(() => freshJob(X, 'J-9005', { ...base, ctx: [{ k: 'file', id: 'x' }] as never }), 'bad_args')
  code(() => freshJob(X, 'J-9006', { ...base, ctx: [{ k: 'mail', id: 'm-1', n: 4 }] }), 'bad_args')
  code(() => freshJob(X, 'J-9007', { ...base, ctx: [{ k: 'work', id: 'not a key', n: 1 }] }), 'bad_args')
  code(() => freshJob(X, 'J-9008', { ...base, ctx: [null] as never }), 'bad_args')
  code(() => freshJob(X, 'J-9009', { ...base, d: 'x'.repeat(DESC_MAX + 1) }), 'bad_args')
})

test('describe sets, changes and clears the description; the same text changes nothing', () => {
  const j = open()
  const a = apply(X, j, { op: 'describe', d: '  Fix the **quota** check.\n' }).job
  assert.equal(a.d, 'Fix the **quota** check.')
  assert.deepEqual([a.jr[0].o, a.jr[0].c, a.jr[0].l], ['Changed the description.', 'the next LLM runs get the new text.', 'ok'])
  assert.equal(apply(X, a, { op: 'describe', d: 'Fix the **quota** check.' }).job.jr.length, a.jr.length)
  const b = apply(X, a, { op: 'describe', d: ' ' }).job
  assert.equal(b.d, undefined); assert.equal('d' in b, false)
  assert.equal(b.jr[0].o, 'Removed the description.')
  code(() => apply(X, j, { op: 'describe', d: 'x'.repeat(DESC_MAX + 1) }), 'bad_args')
  code(() => apply(X, j, { op: 'describe', d: 5 as never }), 'bad_args')
  code(() => apply(X, find((j) => j.st === 'done'), { op: 'describe', d: 'late' }), 'bad_state')
})

test('returnTo keeps the pass as a round and starts the steps from the target again', () => {
  const j = open(), all = steps(X, j.pb), ai = all.findIndex((s) => s.id === atOf(X, j))
  assert.ok(ai > 0, 'the demo job has passed steps')
  const tgt = all[0].id
  const withNote = apply(X, j, { op: 'noteAdd', step: tgt, k: 'q', t: 'still open' }).job
  const r = apply({ ...X, by: 'Claude Code' }, withNote, { op: 'returnTo', step: tgt, why: 'QA found a gap' })
  const k = r.job
  assert.equal(r.nx, tgt)
  assert.equal(k.rf, tgt)
  assert.equal(k.rounds!.length, 1)
  const kept = k.rounds![0]
  assert.deepEqual([kept.n, kept.from, kept.by, kept.why, kept.st], [1, all[0].id, 'Claude Code', 'QA found a gap', withNote.st])
  assert.deepEqual(Object.keys(kept.flow), all.map((s) => s.id))
  assert.equal(kept.flow[tgt].s, withNote.flow[tgt].s)
  assert.equal(k.flow[tgt].s, 'cur')
  for (const s of all.slice(1)) assert.equal(k.flow[s.id].s, s.msg ? 'tpl' : 'fut')
  assert.ok(Object.values(k.flow).every((f) => f.arts.every((a) => !a.ok) && !f.dr && !f.out))
  assert.deepEqual(k.flow[tgt].b.map((b) => b.t), withNote.flow[tgt].b.filter((b) => b.o).map((b) => b.t))
  assert.equal(k.jr[0].a, 'Claude Code')
  assert.match(k.jr[0].o, /^Returned to “.+”: QA found a gap$/)
})

test('a second return keeps only the steps of the round it ends', () => {
  const j = open(), all = steps(X, j.pb), at = atOf(X, j)!, ai = all.findIndex((s) => s.id === at)
  let k = apply(X, j, { op: 'returnTo', step: all[ai - 1].id, why: 'one' }).job
  k = apply(X, k, { op: 'stepDone', step: all[ai - 1].id }).job
  k = apply(X, k, { op: 'returnTo', step: all[ai - 1].id, why: 'two' }).job
  assert.equal(k.rounds!.length, 2)
  assert.deepEqual(Object.keys(k.rounds![1].flow), all.slice(ai - 1).map((s) => s.id))
  assert.equal(k.rounds![1].from, all[ai - 1].id)
  assert.equal(k.jr[0].a, 'you')
})

test('returnTo refuses a step not yet passed, a run in flight, no reason and an unstarted job; a closed job reopens', () => {
  const j = open(), all = steps(X, j.pb), at = atOf(X, j)!
  code(() => apply(X, j, { op: 'returnTo', step: at, why: 'x' }), 'bad_step')
  code(() => apply(X, j, { op: 'returnTo', step: all[0].id, why: ' ' }), 'bad_args')
  const running = apply(X, j, { op: 'runStart', step: at, q: 'q', id: 'r1' }).job
  code(() => apply(X, running, { op: 'returnTo', step: all[0].id, why: 'x' }), 'bad_state')
  const fresh = freshJob(X, 'J-9002', { t: 'x', key: '', pb: j.pb, prj: '', ws: 'acme' })
  code(() => apply(X, fresh, { op: 'returnTo', step: all[0].id, why: 'x' }), 'bad_state')
  const done = find((j) => j.st === 'done'), last = steps(X, done.pb).at(-1)!.id
  const back = apply(X, done, { op: 'returnTo', step: last, why: 'reopened by QA' }).job
  assert.equal(isClosed(back), false)
  assert.equal(back.flow[last].s, 'cur')
  assert.equal(back.rounds![0].st, 'done')
})

test('schedule sets a due date; the job needs you from home-zone midnight of due minus lead', () => {
  const j = find((j) => !isClosed(j) && !needsYou(X, j))
  const at = (iso: string): Ctx => ({ ...X, now: () => new Date(iso) })
  // 3 Oct 18:00 at home (UTC−3) = 21:00Z; lead 2 → needs you from 1 Oct 00:00 = 03:00Z
  const s = apply(X, j, { op: 'schedule', due: '2026-10-03T21:00:00Z', lead: 2, remind: 3420, every: 'month' }).job
  assert.deepEqual([s.due, s.lead, s.remind, s.every], ['2026-10-03T21:00:00.000Z', 2, 3420, 'month'])
  assert.equal(needsYou(at('2026-10-01T02:59:00Z'), s), false)
  assert.equal(needsYou(at('2026-10-01T03:00:00Z'), s), true)
  assert.equal(needsYou(at('2026-10-05T12:00:00Z'), s), true, 'overdue still needs you')
  code(() => apply(X, j, { op: 'schedule', due: 'soon' }), 'bad_args')
  code(() => apply(X, j, { op: 'schedule', due: '2026-10-03T21:00:00Z', lead: -1 }), 'bad_args')
  const off = apply(X, s, { op: 'schedule', due: null }).job
  assert.equal(off.due, undefined); assert.equal(off.every, undefined)
})

test('a monthly recurring job moves its due date on when its period completes', () => {
  let j = apply(X, find((j) => j.st === 'recurring'), { op: 'schedule', due: '2026-10-03T21:00:00Z', lead: 2, every: 'month' }).job
  for (let i = 0; i < 50 && !j.jr.some((e) => e.o === 'Period complete.'); i++) j = apply(X, j, { op: 'stepDone', step: atOf(X, j)! }).job
  assert.equal(j.due, '2026-11-03T21:00:00.000Z')
  assert.equal(nextMonth('2027-01-31T15:00:00.000Z'), '2027-02-28T15:00:00.000Z', 'a short month keeps the last day')
  assert.equal(nextMonth('2026-12-01T02:00:00.000Z'), '2026-12-31T02:00:00.000Z', 'counts in the home-zone day (30 Nov 23:00), not the UTC day')
})

test('a monthly schedule makes the job recurring; dropping the repeat puts it back on its step', () => {
  const j = open()
  const r = apply(X, j, { op: 'schedule', due: '2026-10-03T21:00:00Z', lead: 2, every: 'month' }).job
  assert.equal(r.st, 'recurring')
  assert.ok(!['fut', 'tpl'].includes(r.flow[atOf(X, r)!].s), 'its step is under way')
  assert.notEqual(apply(X, r, { op: 'schedule', due: '2026-10-03T21:00:00Z' }).job.st, 'recurring')
  assert.notEqual(apply(X, r, { op: 'schedule', due: null }).job.st, 'recurring')
})

test('the timesheet playbook runs through its steps into the next period', () => {
  let j = freshJob(X, 'J-9100', { t: 'Month end timesheet', key: 'NEW', pb: 'acme-timesheet', prj: '', ws: 'acme' })
  j = apply(X, j, { op: 'schedule', due: '2026-10-03T21:00:00Z', lead: 2, remind: 3420, every: 'month' }).job
  assert.equal(atOf(X, j), 'ts1')
  for (const s of ['ts1', 'ts2']) j = apply(X, j, { op: 'stepDone', step: s }).job
  assert.equal(j.st, 'recurring')
  assert.equal(j.due, '2026-11-03T21:00:00.000Z')
  assert.equal(atOf(X, j), 'ts1')
  assert.equal(steps(X, 'acme-timesheet')[0].act, 'time')
})

test('a job made from a calendar event keeps the event and its start as due', () => {
  const j = freshJob(X, 'J-9001', { t: 'Prep sprint review', key: 'NEW', pb: Object.keys(PB0)[0], prj: 'platform', ws: 'acme', ev: 'ev1', due: '2026-10-02T13:00:00Z' })
  assert.equal(j.ev, 'ev1'); assert.equal(j.due, '2026-10-02T13:00:00.000Z')
  assert.throws(() => freshJob(X, 'J-9002', { t: 'x', key: 'NEW', pb: Object.keys(PB0)[0], prj: 'platform', ws: 'acme', due: 'later' }))
})

/** an open job whose current step holds a draft from run r1 */
function drafted() {
  const j0 = open(), at = atOf(X, j0)!
  let j = apply(X, j0, { op: 'runStart', step: at, q: 'go', id: 'r1' }).job
  j = apply(X, j, { op: 'runDraft', step: at, t: 'v1' }).job
  return { j, at }
}

test('runReply keeps the draft while it runs; runDraft on it revises the draft', () => {
  const { j, at } = drafted()
  const r = apply(X, j, { op: 'runReply', step: at, q: 'shorter', id: 'r2', intent: 'revise' }).job
  assert.equal(r.flow[at].dr!.t, 'v1')
  assert.deepEqual(r.flow[at].run, { q: 'shorter', at: T0.getTime(), id: 'r2', reply: 1 })
  assert.equal(r.st, 'active')
  assert.match(r.jr[0].o, /^Replied to the LLM draft for “.+”: shorter$/)
  const d = apply(X, r, { op: 'runDraft', step: at, t: 'v2' }).job
  assert.equal(d.flow[at].dr!.t, 'v2'); assert.equal(d.flow[at].run, null); assert.equal(d.flow[at].s, 'wait')
  assert.match(d.jr[0].o, /revised/)
  const back = apply(X, j, { op: 'runReply', step: at, q: 'shorter', id: 'r2', intent: 'revise', resumed: true }).job
  assert.match(back.jr[0].o, /^Resumed the reply/)
})

test('runReply needs a draft and no run', () => {
  const { j, at } = drafted()
  const r = apply(X, j, { op: 'runReply', step: at, q: 'q', id: 'r2', intent: 'ask' }).job
  code(() => apply(X, r, { op: 'runReply', step: at, q: 'q', id: 'r3', intent: 'ask' }), 'bad_state')
  const none = apply(X, j, { op: 'rejectDraft', step: at }).job
  code(() => apply(X, none, { op: 'runReply', step: at, q: 'q', id: 'r3', intent: 'ask' }), 'bad_state')
})

test('runAnswer and runEnd on a reply clear the run and keep the draft waiting', () => {
  const { j, at } = drafted()
  const r = apply(X, j, { op: 'runReply', step: at, q: 'why?', id: 'r2', intent: 'ask' }).job
  const a = apply(X, r, { op: 'runAnswer', step: at, a: 'Because of X.' }).job
  assert.equal(a.flow[at].run, null); assert.equal(a.flow[at].dr!.t, 'v1'); assert.equal(a.flow[at].s, 'wait')
  assert.equal(a.st, 'waiting-user'); assert.equal(a.jr[0].a, 'LLM'); assert.match(a.jr[0].c, /Because of X/)
  const f = apply(X, r, { op: 'runEnd', step: at, why: 'failed', detail: 'boom' }).job
  assert.equal(f.flow[at].dr!.t, 'v1'); assert.equal(f.flow[at].s, 'wait'); assert.match(f.jr[0].c, /draft is unchanged/)
  assert.equal(f.st, 'waiting-user')
})

test('accept, edit and reject are refused while a reply runs', () => {
  const { j, at } = drafted()
  const r = apply(X, j, { op: 'runReply', step: at, q: 'q', id: 'r2', intent: 'revise' }).job
  code(() => apply(X, r, { op: 'acceptDraft', step: at }), 'bad_state')
  code(() => apply(X, r, { op: 'acceptDraft', step: at, text: 'x' }), 'bad_state')
  code(() => apply(X, r, { op: 'rejectDraft', step: at }), 'bad_state')
})

test('rejectDraft with why journals the reason; acceptDraft said journals the word', () => {
  const { j, at } = drafted()
  const r = apply(X, j, { op: 'rejectDraft', step: at, why: ' wrong scope ' }).job
  assert.equal(r.flow[at].dr, null); assert.match(r.jr[0].o, /^Rejected the LLM draft for “.+”: wrong scope\.$/)
  assert.match(r.jr[0].n, /new draft/)
  assert.match(apply(X, j, { op: 'rejectDraft', step: at, why: 'Too dry.' }).job.jr[0].o, /: Too dry\.$/)
  const a = apply({ ...X, by: 'Claude Code' }, j, { op: 'acceptDraft', step: at, said: true }).job
  assert.match(a.jr[0].o, /as said in the reply/); assert.equal(a.jr[0].a, 'Claude Code')
})
