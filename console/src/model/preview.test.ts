import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PB0 } from '../data/playbooks.ts'
import { JOBS0, JR, OVR, TPL0 } from '../data/demo.ts'
import { clone } from '../lib/util.ts'
import { preview, ppLine } from './preview.ts'
import { apply, atOf, isClosed, phasesOf, seedFlow, stepsOf } from './transitions.ts'
import type { Ctx } from './transitions.ts'
import type { Cmd, Job } from './types.ts'

const T0 = new Date('2026-09-30T12:00:00Z')
const X: Ctx = { PB: PB0, TPL: TPL0, now: () => T0 }
const jobs = (): Job[] => clone(JOBS0).map((s) => { const j = s as Job; seedFlow(X, j, OVR[j.id], JR[j.id]); return j })
const find = (p: (j: Job) => boolean) => jobs().find(p)!
/** J-0412 resumed at its review step: current, two future steps on */
const roomy = () => { const j = find((j) => j.id === 'J-0412'); return apply(X, j, { op: 'stepResume', step: atOf(X, j)! }).job }
const later = (j: Job) => { const all = stepsOf(X, j), ai = all.findIndex((s) => s.id === atOf(X, j)); return all.slice(ai + 1) }
const pp = (j: Job, cmds: Cmd[]) => apply({ ...X, by: 'console' }, j, { op: 'ppSet', say: 'from the daily', cmds, by: 'conv-1' }).job
const ids = (ph: { s: { id: string }[] }[]) => ph.flatMap((p) => p.s.map((s) => s.id))
const llm = { t: 'Check the logs', m: 'llm' as const, x: 'Logs read', start: 'self' as const }

test('no pp, no preview', () => {
  assert.equal(preview(X, roomy()), null)
})

test('an added step is marked add in its place; a removed one stays in its old place, marked del', () => {
  const j = roomy(), at = atOf(X, j)!, [n1, n2] = later(j)
  const pj = pp(j, [{ op: 'stepAdd', after: at, step: llm }, { op: 'stepDel', step: n2.id }]), v = preview(X, pj)!
  const want = stepsOf(X, j).map((s) => s.id)
  want.splice(want.indexOf(at) + 1, 0, 'n1')
  assert.deepEqual(ids(v.ph), want, 'the removed step keeps its place')
  assert.deepEqual(v.mk, { n1: 'add', [n2.id]: 'del' })
  assert.equal(v.flow.n1.s, 'fut')
  assert.deepEqual(v.flow[n2.id], j.flow[n2.id], 'a removed step shows its flow as it is')
  assert.equal(v.err, undefined)
  assert.equal(v.flow[n1.id], pj.flow[n1.id], 'an untouched step keeps its own flow')
  assert.ok(!JSON.stringify([v.flow.n1, v.flow[at]]).includes('"nw"'), 'a touched flow marks nothing new')
})

test('an edited step is marked edit; a moved one is marked edit and shown in its new place', () => {
  const j = roomy(), [a, b] = later(j)
  const v = preview(X, pp(j, [{ op: 'stepEdit', step: a.id, t: 'Review it twice' }, { op: 'stepMove', step: b.id, before: a.id }]))!
  assert.deepEqual(v.mk, { [a.id]: 'edit', [b.id]: 'edit' })
  const order = ids(v.ph)
  assert.ok(order.indexOf(b.id) < order.indexOf(a.id))
  assert.equal(v.ph.flatMap((p) => p.s).find((s) => s.id === a.id)!.t, 'Review it twice')
})

test('a returnTo marks the steps it reopens and gives the round banner', () => {
  const j = find((j) => !isClosed(j) && !!atOf(X, j) && !Object.values(j.flow).some((f) => f.run) && stepsOf(X, j).filter((s) => j.flow[s.id].s === 'done').length >= 2)
  const done = stepsOf(X, j).filter((s) => j.flow[s.id].s === 'done'), to = done[done.length - 2]
  const v = preview(X, pp(j, [{ op: 'returnTo', step: to.id, why: 'scope changed' }]))!
  assert.equal(v.mk[to.id], 'reopen')
  assert.equal(v.mk[done[done.length - 1].id], 'reopen')
  assert.equal(v.banner, `Round ${(j.rounds?.length ?? 0) + 2} starts at “${to.t}”`)
  assert.equal(v.flow[to.id].s, 'cur')
})

test('a proposal that no longer applies gives err and the job\'s own phases', () => {
  const j = roomy(), at = atOf(X, j)!, nx = later(j)[0]
  const p = pp(j, [{ op: 'noteAdd', step: at, k: 'q', t: 'who owns it?' }, { op: 'stepDel', step: nx.id }])
  const moved = apply(X, p, { op: 'stepDone', step: at }).job
  const v = preview(X, moved)!
  assert.match(v.err!, /^2\. stepDel: /)
  assert.deepEqual([v.ph, v.mk, v.flow], [phasesOf(X, moved), {}, moved.flow])
})

test('ppLine writes one line per op, with the mode and start of an added llm step', () => {
  const j = roomy(), at = atOf(X, j)!, a = stepsOf(X, j).find((s) => s.id === at)!, [b] = later(j)
  const x: Ctx = { ...X, jobOf: (i) => (i === 'J-0007' ? { ...j, id: 'J-0007', t: 'Ask Imre' } : undefined) }
  const lines = ([
    { op: 'stepAdd', after: at, step: llm }, { op: 'stepAdd', before: at, step: { t: 'Call', m: 'you' } }, { op: 'stepDel', step: b.id },
    { op: 'stepEdit', step: at, t: 'New', start: 'auto', ask: null }, { op: 'stepMove', step: b.id, before: at },
    { op: 'returnTo', step: at, why: 'scope' }, { op: 'waitAdd', step: at, j: 'J-0007', plan: 'go on' }, { op: 'waitDel', step: at, j: 'J-0008' },
    { op: 'stepDone', step: at }, { op: 'describe', d: 'x' }, { op: 'ctxAdd', k: 'chat', id: '19:a', name: 'Team' }, { op: 'ctxDel', k: 'work', id: '42' },
    { op: 'noteAdd', step: at, k: 'q', t: 'who?' },
  ] as Cmd[]).map((c) => ppLine(x, j, c))
  const A = `“${a.t}”`, B = `“${b.t}”`
  assert.deepEqual(lines, [
    { sign: '+', t: `Check the logs, after ${A}`, mode: 'llm', start: 'self' }, { sign: '+', t: `Call, before ${A}`, mode: 'you' },
    { sign: '–', t: B }, { sign: '~', t: `${A}: title “New”, starts auto, no reply wait` }, { sign: '↕', t: `${B} before ${A}` },
    { sign: '↺', t: `Return to ${A}: scope` }, { sign: '⏳', t: `${A} waits for J-0007 “Ask Imre”; plan: go on` },
    { sign: '⏳', t: `${A} no longer waits for J-0008` }, { sign: '✓', t: `${A} done` }, { sign: '✎', t: 'Description' },
    { sign: '·', t: 'Context + chat “Team”' }, { sign: '·', t: 'Context – work 42' }, { sign: '·', t: `Note on ${A}: who?` },
  ])
})
