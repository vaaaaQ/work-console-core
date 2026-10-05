import { test } from 'node:test'
import assert from 'node:assert/strict'
import { S, resetWorld } from '../model/world.ts'
import { escNarrow, isWide, toggleWide } from './wide.ts'

test('the inspector opens at a third; widening covers the step it was widened on only', () => {
  resetWorld(); S.sel = 'a'
  assert.equal(isWide(), false)
  toggleWide()
  assert.equal(isWide(), true)
  S.sel = 'b'
  assert.equal(isWide(), false, 'another step starts at a third')
  S.sel = null
  assert.equal(isWide(), false, 'nothing selected, nothing wide')
})

test('the button narrows a widened inspector again', () => {
  resetWorld(); S.sel = 'a'
  toggleWide(); toggleWide()
  assert.equal(isWide(), false)
})

test('Esc narrows a widened inspector first; then it is left to close it', () => {
  resetWorld(); S.sel = 'a'
  toggleWide()
  assert.equal(escNarrow(), true)
  assert.equal(isWide(), false)
  assert.equal(escNarrow(), false)
  assert.equal(S.sel, 'a', 'narrowing keeps the step open')
})
