import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Projection, checkItems } from './projection.ts'
import { SourceFail } from './runtime.ts'

const a = { id: 'a', t: 1 }, b = { id: 'b', t: 1 }

test('the first apply makes the concept ready at rev 1 with every item an upsert', () => {
  const p = new Projection()
  assert.deepEqual(p.reply(), { status: 'warming_up', rev: 0, message: 'warming up' })
  assert.deepEqual(p.apply([a, b]), { upserts: [a, b], removes: [] })
  assert.deepEqual(p.reply(), { status: 'ok', rev: 1, items: [a, b] })
})

test('the same items again change nothing and keep the rev', () => {
  const p = new Projection()
  p.apply([a, b])
  assert.equal(p.apply([{ t: 1, id: 'a' }, b]), null, 'key order does not count as a change')
  assert.equal(p.rev, 1)
})

test('a changed item is the only upsert; a missing one is a remove', () => {
  const p = new Projection()
  p.apply([a, b])
  assert.deepEqual(p.apply([{ id: 'a', t: 2 }, b]), { upserts: [{ id: 'a', t: 2 }], removes: [] })
  assert.deepEqual(p.apply([{ id: 'a', t: 2 }]), { upserts: [], removes: ['b'] })
  assert.equal(p.rev, 3)
})

test('fail keeps the items but answers the error with its host; recovery with no change still moves the rev', () => {
  const p = new Projection()
  p.apply([a])
  assert.equal(p.fail('signin_required', 'sign in at mail.example', 'mail.example'), true)
  assert.equal(p.fail('signin_required', 'sign in at mail.example', 'mail.example'), false, 'the same state again is no change')
  assert.deepEqual(p.reply(), { status: 'signin_required', rev: 1, message: 'sign in at mail.example', host: 'mail.example' })
  assert.deepEqual(p.items, [a])
  assert.deepEqual(p.apply([a]), { upserts: [], removes: [] })
  assert.deepEqual(p.reply(), { status: 'ok', rev: 2, items: [a] })
})

test('checkItems refuses a non-list, a list over the cap, an id that is not a string, a duplicate id and a schema error', () => {
  const code = (f: () => unknown) => { try { f() } catch (e) { assert.ok(e instanceof SourceFail); return [e.code, e.message] } assert.fail('expected a refusal') }
  assert.match(code(() => checkItems({ id: 'a' }, 5))[1], /not a list/)
  assert.match(code(() => checkItems([a, b], 1))[1], /2 items, over the cap of 1/)
  assert.match(code(() => checkItems([{ id: 7 }], 5))[1], /item 0 needs a string id/)
  assert.match(code(() => checkItems([a, a], 5))[1], /duplicate id a/)
  assert.deepEqual(code(() => checkItems([a], 5, () => ['$.t: not allowed'])), ['source_error', 'item 0: $.t: not allowed'])
  assert.deepEqual(checkItems([a, b], 2), [a, b])
})
