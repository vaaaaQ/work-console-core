import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertAt, swap } from './voiceText.ts'

test('insertAt puts the text at the cursor with a space, or at the end', () => {
  assert.deepEqual(insertAt('ab cd', 2, 'X'), { v: 'ab X cd', a: 3, b: 4 })
  assert.deepEqual(insertAt('ab', null, 'X'), { v: 'ab X', a: 3, b: 4 })
  assert.deepEqual(insertAt('', null, 'X'), { v: 'X', a: 0, b: 1 })
  assert.deepEqual(insertAt('ab\n', null, 'X'), { v: 'ab\nX', a: 3, b: 4 })
  assert.deepEqual(insertAt('ab', 99, 'X'), { v: 'ab X', a: 3, b: 4 })
})

test('swap replaces the raw span, finds it if it moved, and gives up if it was edited', () => {
  assert.equal(swap('a RAW b', 2, 5, 'RAW', 'Clean.'), 'a Clean. b')
  assert.equal(swap('typed a RAW b', 2, 5, 'RAW', 'Clean.'), 'typed a Clean. b')
  assert.equal(swap('a RAX b', 2, 5, 'RAW', 'Clean.'), null)
})
