import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acme } from '../testkit.ts'
import { install } from '../workspace.ts'
import type { WorkspacePage } from '../workspace.ts'
import { actOf, homeCal, homeLog, homeNeeds, opener } from './home.ts'
import { JOBS, LOG, initFlow } from './world.ts'
import type { Job } from './types.ts'

const acme2: WorkspacePage = { ...acme, id: 'acme2', pack: { ...acme.pack, n: 'Acme 2' }, playbooks: {}, demo: { ...acme.demo, jobs: [] } }
const setup = (...l: Parameters<typeof install>[0]) => { install(l); JOBS.forEach(initFlow) }
const starts = (l: { e: { start?: string } }[]) => l.map((x) => x.e.start || '')

test('with one workspace Home is that workspace: every label is null', () => {
  setup({ page: acme })
  const cal = homeCal(), need = homeNeeds(), log = homeLog()
  assert.ok(cal.length && need.length && log.length, 'the demo has meetings today, jobs that need you and activity')
  assert.ok([...cal, ...need, ...log].every((r) => r.ws === 'acme' && r.label === null))
  assert.deepEqual(log.map((r) => r.e), LOG.acme, 'the activity keeps its order')
})

test('with two workspaces Home holds both calendars, labelled, sorted by start; jobs only where they are', () => {
  setup({ page: acme }, { page: acme2 })
  const cal = homeCal()
  assert.deepEqual([...new Set(cal.map((r) => r.label))].sort(), ['Acme', 'Acme 2'])
  assert.equal(cal.filter((r) => r.ws === 'acme').length, cal.filter((r) => r.ws === 'acme2').length)
  assert.ok(cal.every((r) => r.label === (r.ws === 'acme' ? 'Acme' : 'Acme 2') && r.e.tzl === acme.pack.tzl))
  assert.deepEqual(starts(cal), starts(cal).slice().sort())
  const need = homeNeeds()
  assert.ok(need.length && need.every((r) => r.ws === 'acme' && r.j.ws === 'acme' && r.label === 'Acme'))
  assert.deepEqual(need.map((r) => r.j.ts), need.map((r) => r.j.ts).slice().sort((a, b) => b - a))
})

test('Home activity merges the workspaces newest first and keeps each one in its order', () => {
  setup({ page: acme }, { page: acme2 })
  const e = (at: string, t: string, ts?: string) => ({ at, job: 'J-0301', a: 'you', l: 'ok' as const, t, ...(ts ? { ts } : {}) })
  // live logs span days: yesterday's 23:50 is older than today's 09:00
  LOG.acme = [e('09:00', 'a today', '2026-10-02T09:00:00Z'), e('23:50', 'a yesterday', '2026-10-01T23:50:00Z')]
  LOG.acme2 = [e('10:00', 'b today', '2026-10-02T10:00:00Z'), e('08:00', 'b today early', '2026-10-02T08:00:00Z')]
  assert.deepEqual(homeLog().map((r) => `${r.label}: ${r.e.t}`), ['Acme 2: b today', 'Acme: a today', 'Acme 2: b today early', 'Acme: a yesterday'])
  // the demo's seeded rows carry only the time of day
  LOG.acme = [e('10:48', 'a2'), e('09:12', 'a1')]
  LOG.acme2 = [e('10:05', 'b2'), e('08:02', 'b1')]
  assert.deepEqual(homeLog().map((r) => r.e.t), ['a2', 'b2', 'a1', 'b1'])
})

test('a step act is the core one, a workspace one with its handlers, or nothing', () => {
  let ran: Job | null = null
  setup({
    page: { ...acme, acts: { 'acme.go': { icon: 'file', label: 'Go…' }, 'acme.half': { icon: 'mail', label: 'Half' } } },
    ui: { acts: { 'acme.go': { run: (j) => { ran = j }, busy: () => true, blocked: () => 'Not yet.', eyebrow: () => 'June' } } },
  })
  assert.equal(actOf('nope'), null)
  const t = actOf('time')!
  assert.equal(t.icon, 'hourglass'); assert.equal(t.label, 'Open Time')
  assert.throws(() => t.run(JOBS[0]), /^Error: opener not wired$/, 'nothing has wired the opener in Node')
  const opened: string[] = []
  opener.go = (v) => { opened.push(v) }
  void t.run(JOBS[0])
  assert.deepEqual(opened, ['time'], 'the core act opens the Time view')
  const a = actOf('acme.go')!, j = JOBS[0]
  assert.equal(a.icon, 'file'); assert.equal(a.label, 'Go…')
  assert.equal(a.busy?.(j), true); assert.equal(a.blocked?.(j), 'Not yet.'); assert.equal(a.eyebrow?.(j), 'June')
  void a.run(j)
  assert.equal(ran, j)
  assert.equal(actOf('acme.half'), null, 'a button with nothing behind it is not shown')
})

test('act names are unique across the core and every workspace', () => {
  const page = (p: WorkspacePage, acts: string[]) => ({ ...p, acts: Object.fromEntries(acts.map((n) => [n, { icon: 'file', label: n }])) })
  const ui = (acts: string[]) => ({ acts: Object.fromEntries(acts.map((n) => [n, { run: () => {} }])) })
  assert.throws(() => install([{ page: page(acme, ['go']) }, { page: page(acme2, ['go']) }]), /^Error: act go is declared by both acme and acme2$/)
  assert.throws(() => install([{ page: page(acme, ['go']), ui: ui(['go']) }, { page: acme2, ui: ui(['go']) }]), /^Error: act go is declared by both acme and acme2$/)
  assert.throws(() => install([{ page: page(acme, ['time']) }]), /^Error: act time of acme shadows the core act time$/)
  assert.throws(() => install([{ page: acme }, { page: acme2, ui: ui(['time']) }]), /^Error: act time of acme2 shadows the core act time$/)
  assert.doesNotThrow(() => setup({ page: page(acme, ['acme.go']), ui: ui(['acme.go']) }, { page: page(acme2, ['acme2.go']), ui: ui(['acme2.go']) }))
  assert.equal(actOf('acme.go')?.label, 'acme.go'); assert.equal(actOf('acme2.go')?.label, 'acme2.go')
})
