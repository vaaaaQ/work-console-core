import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactDays, dayLabel, demoTime, fillMonth, monthAdd, workdays } from './time.ts'

test('working days are Mon–Fri, cut at a date; months step across a year', () => {
  assert.equal(workdays('2026-09').length, 22)
  assert.deepEqual(workdays('2026-08', '2026-08-04'), ['2026-08-03', '2026-08-04'])
  assert.deepEqual(workdays('2026-08', '2026-08-02'), [])
  assert.equal(monthAdd('2026-01', -1), '2025-12')
  assert.equal(dayLabel('2026-09-28'), 'Mon 28')
})

test('empty days read as runs of days', () => {
  assert.equal(compactDays(['2026-08-31', '2026-08-20', '2026-08-21', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28']), 'Aug 20–21, 24–28, 31')
  assert.equal(compactDays([]), '')
})

test('the demo months: this one up to today, the last one short of its last three working days', () => {
  const [cur, prev] = demoTime('2026-10-01')
  assert.deepEqual([cur.id, cur.period, cur.state, cur.hours, cur.workdays, cur.emptyDays], ['2026-10', 'October 2026', 'empty', 0, 1, ['2026-10-01']])
  assert.deepEqual([prev.id, prev.state, prev.hours, prev.workdays, prev.emptyDays], ['2026-09', 'partial', 152, 22, ['2026-09-28', '2026-09-29', '2026-09-30']])
  assert.equal(prev.top?.hours, 8 * 21)
  assert.equal(cur.top?.hours, 152)
})

test('a fill gives hours to empty days only and says which it skipped', () => {
  const prev = demoTime('2026-10-01')[1]
  const { item, result } = fillMonth(prev, { month: '2026-09', days: ['2026-09-28', '2026-09-29', '2026-09-25'], workItemId: 4230, activityId: 1343, hours: 8 })
  assert.deepEqual(result, { month: '2026-09', filled: ['2026-09-28', '2026-09-29'], skipped: ['2026-09-25'], failed: [] })
  assert.deepEqual([item.hours, item.emptyDays, item.state], [168, ['2026-09-30'], 'partial'])
  assert.equal(fillMonth(item, { month: '2026-09', days: ['2026-09-30'], workItemId: 4230, activityId: 1343, hours: 8 }).item.state, 'entered')
})
