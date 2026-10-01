import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, norm, saveThenClose, slugify, snip } from './util.ts'

test('a dialog stays open when its save fails, and closes once it succeeds', async () => {
  let closed = 0
  await assert.rejects(saveThenClose(() => Promise.reject(new Error('409')), () => { closed++ }))
  assert.equal(closed, 0, 'the typed text is still there to fix and resend')
  assert.equal(await saveThenClose(async () => 'saved', () => { closed++ }), 'saved')
  assert.equal(closed, 1)
})

test('slugify keeps letters and digits, dashes the rest, and caps the length', () => {
  assert.equal(slugify('Fix: the  Email dup!'), 'fix-the-email-dup')
  assert.equal(slugify('--a--'), 'a')
  assert.equal(slugify('x'.repeat(60)).length, 40)
})

test('ago speaks in the largest whole unit', () => {
  const now = Date.now()
  assert.equal(ago(now), 'just now')
  assert.equal(ago(now - 5 * 60000), '5 min ago')
  assert.equal(ago(now - 3 * 3600000), '3 h ago')
  assert.equal(ago(now - 26 * 3600000), 'yesterday')
})

test('snip and norm', () => {
  assert.equal(snip('a  b', 10), 'a b')
  assert.equal(snip('abcdef', 4), 'abc…')
  assert.equal(norm('Team Dev'), norm('team-dev'))
})
