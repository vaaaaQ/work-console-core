import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineDiff } from './diff.ts'

const k = (a: string, b: string) => lineDiff(a, b).map((l) => l.k + l.t)

test('one changed line shows as a removal and an addition between kept lines', () => {
  assert.deepEqual(k('a\nb\nc', 'a\nB\nc'), ['=a', '-b', '+B', '=c'])
})
test('a new note is all additions; the same text is all kept', () => {
  assert.deepEqual(k('', 'x\ny'), ['+x', '+y'])
  assert.deepEqual(k('x\ny', 'x\ny'), ['=x', '=y'])
})
test('a text too big to align is shown as replaced whole', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n'), b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n')
  const d = lineDiff(a, b)
  assert.equal(d.length, 6000); assert.equal(d[0].k, '-'); assert.equal(d[5999].k, '+')
})
