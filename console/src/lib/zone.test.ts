import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayOf, wallIso, zone } from './zone.ts'

const wall = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: zone(), hour: '2-digit', minute: '2-digit' })

test('wallIso is a wall time of the home zone, today or `day` days on', () => {
  assert.equal(wall(wallIso('09:30')), '09:30')
  assert.equal(dayOf(Date.parse(wallIso('09:30'))), dayOf())
  assert.equal(dayOf(Date.parse(wallIso('09:30', -1))), dayOf(Date.now() - 864e5))
})

test('wallIso takes anything but HH:MM for yesterday noon', () => {
  assert.equal(wall(wallIso('yesterday')), '12:00')
  assert.equal(dayOf(Date.parse(wallIso('yesterday'))), dayOf(Date.now() - 864e5))
})
