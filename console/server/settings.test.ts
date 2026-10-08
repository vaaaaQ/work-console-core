import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpError } from './events.ts'
import { Settings } from './settings.ts'
import { tempDir } from './testdirs.ts'

const home = () => tempDir('set')
const bad = (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === 'bad_args'

test('no file: Claude Code for both', () => {
  assert.deepEqual(new Settings(home()).read(), { auto: 'claude', manual: 'claude' })
})

test('a write is read back, by a new instance too', () => {
  const h = home()
  new Settings(h).write({ manual: 'cursor' })
  assert.deepEqual(new Settings(h).read(), { auto: 'claude', manual: 'cursor' })
})

test('a path must be an existing file; an empty one drops it', () => {
  const h = home(), s = new Settings(h), f = join(h, 'claude.exe')
  writeFileSync(f, '')
  assert.throws(() => s.write({ claudePath: join(h, 'missing.exe') }), bad)
  assert.throws(() => s.write({ cursorPath: h }), bad, 'a folder is not a file')
  assert.equal(s.write({ claudePath: f }).claudePath, f)
  assert.equal(s.write({ claudePath: '' }).claudePath, undefined)
})

test('auto takes only a provider that can run by itself; an unknown id is refused', () => {
  const s = new Settings(home())
  assert.throws(() => s.write({ auto: 'cursor' }), (e) => bad(e) && /cannot run by itself/.test((e as Error).message))
  assert.throws(() => s.write({ auto: 'x' }), bad)
  assert.throws(() => s.write({ manual: 'x' }), bad)
  assert.deepEqual(s.read(), { auto: 'claude', manual: 'claude' }, 'a refused write changes nothing')
})

test('a broken or hand-edited file reads as the defaults key by key', () => {
  const h = home(), f = join(h, 'providers.json')
  writeFileSync(f, 'not json')
  assert.deepEqual(new Settings(h).read(), { auto: 'claude', manual: 'claude' })
  writeFileSync(f, JSON.stringify({ auto: 'nope', manual: 'cursor', claudePath: 3 }))
  assert.deepEqual(new Settings(h).read(), { auto: 'claude', manual: 'cursor' })
})

test('a hand-edited auto without auto is kept as written, so its runs fail as provider_unavailable', () => {
  const h = home()
  writeFileSync(join(h, 'providers.json'), JSON.stringify({ auto: 'cursor' }))
  assert.equal(new Settings(h).read().auto, 'cursor')
})

test('the list says which provider can run by itself', () => {
  assert.deepEqual(new Settings(home()).list(), [{ id: 'claude', label: 'Claude Code', auto: true }, { id: 'cursor', label: 'Cursor', auto: false }])
})
