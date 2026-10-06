import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TrackerCache } from './tracker.ts'
import type { TrackerGet } from '../src/model/tracker.ts'

/** a get that counts its work reads; up = false makes every read fail as a down bridge would */
function source() {
  const s = { up: true, reads: 0, title: 'One' }
  const get: TrackerGet = async (c, id) => {
    if (c === 'work') s.reads++
    if (!s.up) throw Object.assign(new Error('the gateway did not answer'), { code: 'unavailable' })
    return c === 'work' ? { status: 'ok', items: { title: s.title, prs: [] } } : { status: 'not_found', message: `no ${c} ${id}` }
  }
  return { s, get }
}

test('a read within five minutes is the cached one; fresh, a later read or other ids read again', async () => {
  let ms = 0
  const c = new TrackerCache({ now: () => ms }), { s, get } = source()
  assert.equal((await c.read('J-1', ['1'], get)).items[0].title, 'One')
  s.title = 'Two'
  ms = 4 * 60_000
  assert.equal((await c.read('J-1', ['1'], get)).items[0].title, 'One')
  assert.equal(s.reads, 1)
  assert.equal((await c.read('J-1', ['1'], get, true)).items[0].title, 'Two')
  s.title = 'Three'
  ms += 5 * 60_000 + 1
  assert.equal((await c.read('J-1', ['1'], get)).items[0].title, 'Three')
  assert.equal((await c.read('J-1', ['1', '2'], get)).items.length, 2, 'a changed context is a new read')
  assert.equal(s.reads, 5)
})

test('a down bridge answers the last snapshot with why; without one, the failed read itself', async () => {
  let ms = 0
  const c = new TrackerCache({ now: () => ms }), { s, get } = source()
  s.up = false
  const none = await c.read('J-1', ['1'], get)
  assert.equal(none.items[0].err, 'the gateway did not answer')
  assert.equal(none.offline, 'the gateway did not answer')
  s.up = true
  const first = await c.read('J-1', ['1'], get, true)
  assert.equal(first.offline, undefined)
  s.up = false
  ms = 10 * 60_000
  const snap = await c.read('J-1', ['1'], get)
  assert.equal(snap.items[0].title, 'One')
  assert.equal(snap.at, first.at)
  assert.equal(snap.offline, 'the gateway did not answer')
  s.up = true
  assert.equal((await c.read('J-1', ['1'], get)).offline, undefined, 'the next read after the bridge is back is live')
})
