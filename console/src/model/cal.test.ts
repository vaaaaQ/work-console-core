import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAL } from '../data/demo.ts'
import { dayOf, evDraft, evJobs, onDay, shownDays, todayOnly, weekDays } from './cal.ts'
import type { CalEvent, Job } from './types.ts'

const THU = Date.parse('2026-10-01T12:00:00Z')
const ev = (id: string, day: string, start: string): CalEvent => ({ id, day, start, b: '', v: '', t: `Meeting ${id}`, d: '30 min', n: '' })

test('weeks run Monday to Sunday in home-zone days, this one and the next', () => {
  assert.deepEqual(weekDays(0, THU), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
  assert.deepEqual(weekDays(1, THU)[0], '2026-10-05')
  // 23:00 Sunday at home (UTC−3) is already Monday in UTC
  assert.equal(dayOf(Date.parse('2026-10-05T02:00:00Z')), '2026-10-04')
  assert.deepEqual(weekDays(0, Date.parse('2026-10-05T02:00:00Z'))[0], '2026-09-28')
})

test('the weekend shows only when it holds a meeting; a day lists its meetings by start', () => {
  const days = weekDays(0, THU)
  assert.equal(shownDays(days, [ev('a', '2026-09-29', 'x')]).length, 5)
  assert.deepEqual(shownDays(days, [ev('a', '2026-10-04', 'x')]).slice(5), ['2026-10-04'])
  const evs = [ev('late', '2026-09-29', '2026-09-29T18:00:00.000Z'), ev('early', '2026-09-29', '2026-09-29T08:00:00.000Z'), ev('other', '2026-09-30', '2026-09-30T08:00:00.000Z')]
  assert.deepEqual(onDay(evs, '2026-09-29').map((e) => e.id), ['early', 'late'])
})

test('Today keeps today’s rows; an undated row from an older gateway still shows', () => {
  const evs = [ev('y', '2026-09-30', 'x'), ev('t', '2026-10-01', 'x'), { b: '05:00', v: '', t: 'old', d: '', n: '' }]
  assert.deepEqual(todayOnly(evs, THU).map((e) => e.t), ['Meeting t', 'old'])
})

test('a meeting shows its jobs and drafts a new one due at its start', () => {
  const e = ev('e1', '2026-10-01', '2026-10-01T13:00:00.000Z')
  const jobs = [{ id: 'J-1', ev: 'e1' }, { id: 'J-2', ev: 'e2' }, { id: 'J-3' }] as Job[]
  assert.deepEqual(evJobs(e, jobs).map((j) => j.id), ['J-1'])
  assert.deepEqual(evJobs({ ...e, id: undefined }, jobs), [])
  assert.deepEqual(evDraft(e, 'Zoom'), { t: 'Meeting e1', ev: 'e1', due: '2026-10-01T13:00:00.000Z', src: 'Zoom · Meeting e1' })
})

test('demo meetings sit in this week and next, with unique ids and today’s rows', () => {
  const evs = CAL.acme!, days = [...weekDays(0), ...weekDays(1)]
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length)
  assert.ok(evs.every((e) => days.includes(e.day!) && e.start && e.end && /^\d\d:\d\d$/.test(e.b)))
  assert.ok(todayOnly(evs).length >= 3)
  assert.ok(evs.some((e) => e.x))
})
