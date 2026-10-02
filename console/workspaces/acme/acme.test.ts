import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install, itemOf, wsPage } from '../../src/workspace.ts'
import { PACKS, DEFAULT_WS } from '../../src/data/packs.ts'
import { JOBS } from '../../src/model/world.ts'
import acme from './page.ts'

test('install fills the packs and the world from the registered workspaces', () => {
  install([{ page: acme }])
  assert.deepEqual(Object.keys(PACKS), ['acme']); assert.equal(DEFAULT_WS, 'acme')
  assert.ok(JOBS.length > 0 && JOBS.every((j) => j.ws === 'acme'))
})
test('install refuses a duplicate or malformed id', () => {
  assert.throws(() => install([{ page: acme }, { page: acme }]), /acme.*twice/)
  assert.throws(() => install([{ page: { ...acme, id: 'Acme' } }]), /Acme/)
})
test('a board item is its key or a bare id the key round-trips', () => {
  assert.equal(itemOf(wsPage('acme').board, 'ACME-603'), 'ACME-603')
  assert.equal(itemOf(wsPage('acme').board, 'acme-603'), null)
})
