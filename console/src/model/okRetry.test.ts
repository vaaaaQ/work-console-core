import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CmdError, apply, checkPlaybook, fillOk, fixRoundText, fixRounds, okPreview } from './transitions.ts'
import type { Ctx } from './transitions.ts'
import type { Cmd, DraftReport, Job, Playbook } from './types.ts'
import { freshJob } from './transitions.ts'

/* AD-0017: the one-time approval (Playbook.ok), fix rounds (Step.retry) and an Accept that no longer closes a step
   whose commands never ran */

const T0 = new Date('2026-10-23T09:00:00Z')
const SHIP: Playbook = {
  n: 'Ship', ok: { at: 'a1', cmds: ['git status', 'git push origin {branch}', 'gh pr create --base {base} --head {branch}'] },
  ph: [
    { c: 'AN', n: 'Analysis', s: [{ id: 'a1', t: 'Analysis', m: 'llm', x: 'spec agreed' }] },
    { c: 'BD', n: 'Build', s: [{ id: 'a2', t: 'Build', m: 'llm', x: 'tests green', start: 'auto' }] },
    { c: 'SH', n: 'Ship', s: [
      { id: 'a3', t: 'Live check', m: 'llm', x: 'the check passes', start: 'auto', retry: { to: 'a2' } },
      { id: 'a4', t: 'Look at it live', m: 'you', x: 'it works' }] }],
}
const X: Ctx = { PB: { ship: SHIP }, TPL: {}, now: () => T0 }
const as = (by: string): Ctx => ({ ...X, by })
const WD = { branch: 'job/s-1', base: 'main' }
const FILLED = ['git status', 'git push origin job/s-1', 'gh pr create --base main --head job/s-1']
const code = (f: () => unknown, c: string, m?: RegExp) =>
  assert.throws(f, (e: unknown) => e instanceof CmdError && e.code === c && (!m || m.test(e.message)))

const run = (x: Ctx, j: Job, c: Cmd) => apply(x, j, c).job
const started = () => run(X, freshJob(X, 'S-1', { t: 'Ship it', key: 'K-1', pb: 'ship', prj: 'core', ws: 'acme' }), { op: 'start' })
/** a run on sid that hands in a draft; the runner names the job's work dir as it starts */
const drafted = (j: Job, sid: string, rep: DraftReport = {}, t = 'the draft') =>
  run(X, run(X, j, { op: 'runStart', step: sid, q: 'go', id: `r-${sid}`, wd: WD }), { op: 'runDraft', step: sid, t, ...rep })
/** Analysis accepted by the person on the page */
const granted = () => run(X, drafted(started(), 'a1'), { op: 'acceptDraft', step: 'a1' })
/** at Live check, with a draft that reports failed */
const failedAt = (j: Job, why = 'the health check answers 500') => drafted(j, 'a3', { o: 'failed', why })

test('the runner names the job\'s branch and base as a run starts; the job keeps them', () => {
  const j = run(X, started(), { op: 'runStart', step: 'a1', q: 'go', id: 'r1', wd: WD })
  assert.deepEqual(j.wd, WD)
  assert.equal(run(X, started(), { op: 'runStart', step: 'a1', q: 'go', id: 'r1' }).wd, undefined)
})

test('fillOk fills {branch} and {base}, and nothing without a work dir', () => {
  assert.deepEqual(fillOk(SHIP.ok!.cmds, WD), FILLED)
  assert.deepEqual(fillOk(['merge {branch} into {base} and {base}'], { branch: 'b', base: 'master' }), ['merge b into master and master'])
  assert.equal(fillOk(SHIP.ok!.cmds, undefined), null)
})

test('the person\'s Accept of the ok step grants the filled commands to the job, and the journal lists them', () => {
  const j = granted()
  assert.deepEqual(j.ok, { at: 'a1', by: 'you', cmds: FILLED })
  const line = j.jr.find((e) => e.o.startsWith('Approved for this job'))!
  assert.equal(line.o, `Approved for this job: 3 commands: ${FILLED.join('; ')}`)
  assert.equal(line.a, 'you')
  assert.equal(j.flow.a1.s, 'done')
  assert.deepEqual(okPreview(X, drafted(started(), 'a1'), 'a1'), { cmds: FILLED })
  assert.equal(okPreview(X, drafted(started(), 'a1'), 'a2'), null, 'only the ok step\'s card shows it')
})

test('an Accept that is automatic, said in a reply or a session\'s grants nothing; nor one without a work dir', () => {
  const d = drafted(started(), 'a1')
  assert.equal(run(X, d, { op: 'acceptDraft', step: 'a1', auto: true }).ok, undefined)
  assert.equal(run(X, d, { op: 'acceptDraft', step: 'a1', said: true }).ok, undefined)
  assert.equal(run(as('Claude Code'), d, { op: 'acceptDraft', step: 'a1' }).ok, undefined)
  const bare = run(X, run(X, run(X, started(), { op: 'runStart', step: 'a1', q: 'go', id: 'r1' }), { op: 'runDraft', step: 'a1', t: 'd' }), { op: 'acceptDraft', step: 'a1' })
  assert.equal(bare.ok, undefined)
  assert.match(bare.jr[0].o, /^Approved nothing for this job: the job has no work dir yet/)
  assert.deepEqual(okPreview(X, run(X, run(X, started(), { op: 'runStart', step: 'a1', q: 'go', id: 'r1' }), { op: 'runDraft', step: 'a1', t: 'd' }), 'a1'),
    { why: 'the job has no work dir yet, so {branch} and {base} do not fill' })
})

test('okDrop withdraws the approval; a Return to the ok step drops it too, a Return to a later step keeps it', () => {
  const j = granted()
  const w = run(X, j, { op: 'okDrop' })
  assert.equal(w.ok, undefined)
  assert.equal(w.jr[0].o, 'Withdrew the one-time approval of 3 commands.')
  code(() => apply(X, w, { op: 'okDrop' }), 'bad_state')
  const at3 = run(X, j, { op: 'stepDone', step: 'a2' })
  assert.equal(run(X, at3, { op: 'returnTo', step: 'a1', why: 'the shape changed' }).ok, undefined)
  assert.deepEqual(run(X, at3, { op: 'returnTo', step: 'a2', why: 'the build is wrong' }).ok, j.ok)
})

test('a failed draft on a step with retry goes back to retry.to unless it names a step itself; not done does not', () => {
  const j = run(X, granted(), { op: 'stepDone', step: 'a2' })
  assert.equal(failedAt(j).flow.a3.dr!.rt, 'a2')
  assert.equal(drafted(j, 'a3', { o: 'failed', rt: 'a1' }).flow.a3.dr!.rt, 'a1')
  assert.equal(drafted(j, 'a3', { o: 'not_done' }).flow.a3.dr!.rt, undefined)
  assert.equal(drafted(j, 'a3').flow.a3.dr!.rt, undefined)
})

test('the console\'s accept of a failed retry draft opens a fix round: counted, journaled, at most max; the 4th is refused', () => {
  let j = run(X, granted(), { op: 'stepDone', step: 'a2' })
  for (let n = 1; n <= 3; n++) {
    j = run(as('console'), failedAt(j), { op: 'acceptDraft', step: 'a3', auto: true })
    assert.equal(fixRounds(j), n)
    assert.deepEqual(j.rounds!.at(-1)!.fx, { n, max: 3, step: 'a3' })
    assert.equal(j.flow.a2.s, 'cur')
    const line = j.jr.find((e) => e.o.startsWith('Fix round'))!
    assert.equal(line.o, `Fix round ${n} of 3: “Live check” failed, back to “Build”: the health check answers 500`)
    assert.equal(line.a, 'console')
    j = run(X, j, { op: 'stepDone', step: 'a2' })
  }
  code(() => apply(as('console'), failedAt(j), { op: 'acceptDraft', step: 'a3', auto: true }), 'bad_state', /the job has had its 3 fix rounds/)
  // the person may still send it back: that round is theirs, and the count starts again
  const back = run(X, failedAt(j), { op: 'acceptDraft', step: 'a3' })
  assert.equal(back.rounds!.at(-1)!.fx, undefined)
  assert.equal(fixRounds(back), 0)
})

test('a Return to by the person resets the fix-round count; a step\'s own max counts', () => {
  let j = run(X, granted(), { op: 'stepDone', step: 'a2' })
  j = run(as('console'), failedAt(j), { op: 'acceptDraft', step: 'a3', auto: true })
  j = run(X, j, { op: 'stepDone', step: 'a2' })
  j = run(as('console'), failedAt(j), { op: 'acceptDraft', step: 'a3', auto: true })
  assert.equal(fixRounds(j), 2)
  j = run(X, j, { op: 'returnTo', step: 'a1', why: 'rethink' })
  assert.equal(fixRounds(j), 0)
  const one: Ctx = { ...X, PB: { ship: { ...SHIP, ph: SHIP.ph.map((p) => ({ ...p, s: p.s.map((s) => (s.id === 'a3' ? { ...s, retry: { to: 'a2', max: 1 } } : s)) })) } } }
  let k = run(X, granted(), { op: 'stepDone', step: 'a2' })
  k = run({ ...one, by: 'console' }, run(one, run(one, k, { op: 'runStart', step: 'a3', q: 'go', id: 'r', wd: WD }), { op: 'runDraft', step: 'a3', t: 'red', o: 'failed' }), { op: 'acceptDraft', step: 'a3', auto: true })
  assert.match(k.jr.find((e) => e.o.startsWith('Fix round'))!.o, /^Fix round 1 of 1:/)
  k = run(one, k, { op: 'stepDone', step: 'a2' })
  k = run(one, run(one, k, { op: 'runStart', step: 'a3', q: 'go', id: 'r', wd: WD }), { op: 'runDraft', step: 'a3', t: 'red', o: 'failed' })
  code(() => apply({ ...one, by: 'console' }, k, { op: 'acceptDraft', step: 'a3', auto: true }), 'bad_state', /its 1 fix round\b/)
})

test('the console never accepts a not-done draft, nor a failed one that goes elsewhere or has no retry', () => {
  const j = run(X, granted(), { op: 'stepDone', step: 'a2' })
  code(() => apply(as('console'), drafted(j, 'a3', { o: 'not_done' }), { op: 'acceptDraft', step: 'a3', auto: true }), 'bad_state')
  code(() => apply(as('console'), drafted(j, 'a3', { o: 'failed', rt: 'a1' }), { op: 'acceptDraft', step: 'a3', auto: true }), 'bad_state')
  const at2 = granted()
  code(() => apply(as('console'), drafted(at2, 'a2', { o: 'failed', rt: 'a1' }), { op: 'acceptDraft', step: 'a2', auto: true }), 'bad_state')
})

test('fixRoundText holds the round, the limit, the failed step, where it went back and why, and the failed draft', () => {
  let j = run(X, granted(), { op: 'stepDone', step: 'a2' })
  j = run(as('console'), failedAt(j, 'smoke red'), { op: 'acceptDraft', step: 'a3', auto: true })
  const t = fixRoundText(X, j, j.rounds!.at(-1)!)
  assert.match(t, /^## Fix round 1 of 3\n/)
  assert.match(t, /“Live check” failed; the job went back to “Build”\./)
  assert.match(t, /Why: smoke red/)
  assert.match(t, /the draft\s*$/)
})

test('an Accept of a draft that waits for commands is refused; "I ran them" closes it; auto and said never do', () => {
  const j = drafted(started(), 'a1', { cm: ['update.ps1'] })
  code(() => apply(X, j, { op: 'acceptDraft', step: 'a1' }), 'bad_state', /approve its commands, or say you ran them/)
  code(() => apply(X, j, { op: 'acceptDraft', step: 'a1', said: true, ran: true }), 'bad_state')
  code(() => apply(as('console'), j, { op: 'acceptDraft', step: 'a1', auto: true, ran: true }), 'bad_state')
  const k = run(X, j, { op: 'acceptDraft', step: 'a1', ran: true })
  assert.equal(k.flow.a1.s, 'done')
  assert.equal(k.jr.find((e) => e.o.startsWith('Accepted'))!.o, 'Accepted the LLM draft for “Analysis”; you ran its 1 command yourself.')
})

test('the console approves a draft\'s commands only when every one is in the job\'s approval; the run and its draft say ok', () => {
  let j = run(X, granted(), { op: 'stepDone', step: 'a2' })
  j = drafted(j, 'a3', { cm: ['git status', 'git push origin job/s-1'] })
  const q = 'Approved, run exactly these commands'
  const a = run(as('console'), j, { op: 'runReply', step: 'a3', q, id: 'r2', intent: 'approve', ok: true })
  assert.equal(a.flow.a3.run!.ap, 'ok')
  assert.equal(a.jr[0].o, 'Approved 2 commands under this job\'s one-time approval: git status; git push origin job/s-1')
  assert.equal(a.jr[0].a, 'console')
  assert.equal(run(X, a, { op: 'runDraft', step: 'a3', t: 'pushed' }).flow.a3.dr!.ap, 'ok')
  const off = drafted(run(X, granted(), { op: 'stepDone', step: 'a2' }), 'a3', { cm: ['git status', 'git push --force'] })
  code(() => apply(as('console'), off, { op: 'runReply', step: 'a3', q, id: 'r2', intent: 'approve', ok: true }), 'bad_state', /git push --force/)
  const none = drafted(run(X, run(X, drafted(started(), 'a1'), { op: 'acceptDraft', step: 'a1', auto: true }), { op: 'stepDone', step: 'a2' }), 'a3', { cm: ['git status'] })
  code(() => apply(as('console'), none, { op: 'runReply', step: 'a3', q, id: 'r2', intent: 'approve', ok: true }), 'bad_state', /no one-time approval/)
})

test('checkPlaybook refuses a bad ok or retry', () => {
  const pb = (o: Partial<Playbook>, retry?: unknown, m: 'llm' | 'you' = 'llm'): Playbook => ({
    ...SHIP, ...o, ph: SHIP.ph.map((p) => ({ ...p, s: p.s.map((s) => (s.id === 'a3' ? { ...s, m, ...(m === 'you' ? { start: undefined } : {}), retry: retry as never } : s)) })),
  })
  assert.doesNotThrow(() => checkPlaybook('ship', SHIP))
  assert.doesNotThrow(() => checkPlaybook('ship', pb({}, { to: 'a1', max: 10 })))
  for (const [p, m] of [
    [pb({ ok: { at: 'zz', cmds: ['x'] } }), /ok\.at/],
    [pb({ ok: { at: 'a1', cmds: [] } }), /1 to 10/],
    [pb({ ok: { at: 'a1', cmds: Array.from({ length: 11 }, (_, i) => `c${i}`) } }), /1 to 10/],
    [pb({ ok: { at: 'a1', cmds: ['gh pr merge {pr}'] } }), /\{pr\}/],
    [pb({ ok: { at: 'a1', cmds: [' '] } }), /empty/],
    [pb({}, { to: 'a4' }), /earlier step/],
    [pb({}, { to: 'a3' }), /earlier step/],
    [pb({}, { to: 'nope' }), /earlier step/],
    [pb({}, { to: 'a2', max: 0 }), /1–10/],
    [pb({}, { to: 'a2', max: 11 }), /1–10/],
    [pb({}, { to: 'a2', max: 1.5 }), /1–10/],
    [pb({}, { to: 'a2' }, 'you'), /llm step/],
  ] as [Playbook, RegExp][]) assert.throws(() => checkPlaybook('ship', p), m)
})
