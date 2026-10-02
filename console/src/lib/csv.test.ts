import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from './csv.ts'

test('quoted fields keep commas, doubled quotes and line breaks', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n"x, y","say ""hi""","two\nlines"\n'), [['a', 'b', 'c'], ['x, y', 'say "hi"', 'two\nlines']])
})

test('a BOM is dropped and empty fields stay', () => {
  assert.deepEqual(parseCsv('﻿id,,n\n1,,\n'), [['id', '', 'n'], ['1', '', '']])
})

test('the separator comes from the first line: semicolon or tab when they outnumber commas', () => {
  assert.deepEqual(parseCsv('a;b\n1,5;2\n'), [['a', 'b'], ['1,5', '2']])
  assert.deepEqual(parseCsv('a\tb\nx\ty'), [['a', 'b'], ['x', 'y']])
})

test('an empty file has no rows', () => {
  assert.deepEqual(parseCsv(''), [])
})
