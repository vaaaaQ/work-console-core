import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmContent, confirmFields } from './confirm.ts'

const schema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', title: 'Run it', default: true },
    why: { type: 'string', description: 'a note for the log' },
    mode: { type: 'string', enum: ['now', 'later'], enumNames: ['Now', 'Later'] },
    n: { type: 'integer', title: 'Times' },
  },
  required: ['ok', 'mode'],
}

test("a server's flat schema becomes form fields: each with its kind, label, choices, default and whether it is required", () => {
  assert.deepEqual(confirmFields(schema), [
    { key: 'ok', kind: 'boolean', label: 'Run it', required: true, value: true },
    { key: 'why', kind: 'text', label: 'why', about: 'a note for the log', required: false, value: '' },
    { key: 'mode', kind: 'choice', label: 'mode', required: true, choices: [{ v: 'now', label: 'Now' }, { v: 'later', label: 'Later' }], value: 'now' },
    { key: 'n', kind: 'number', label: 'Times', required: false, integer: true, value: '' },
  ])
  assert.deepEqual(confirmFields(undefined), [])
  assert.deepEqual(confirmFields({ type: 'object', properties: { x: { type: 'object' } } }), [{ key: 'x', kind: 'text', label: 'x', required: false, value: '' }])
})

test("the form's values as the answer's content: numbers as numbers, an empty optional field left out; what is missing is said", () => {
  const f = confirmFields(schema)
  assert.deepEqual(confirmContent(f, { ok: true, why: '', mode: 'later', n: '3' }), { content: { ok: true, mode: 'later', n: 3 }, missing: [] })
  assert.deepEqual(confirmContent(f, { ok: false, why: 'x', mode: '', n: 'abc' }), { content: { ok: false, why: 'x' }, missing: ['mode', 'Times'] })
})

test('an optional checkbox the person did not touch is left out: a server may read an explicit false as no', () => {
  // a catalog server's form: an optional boolean, and Accept with confirm: false is its refusal
  const f = confirmFields({ type: 'object', properties: { confirm: { type: 'boolean', title: 'Approve this command?' } } })
  assert.deepEqual(confirmContent(f, {}), { content: {}, missing: [] })
  assert.deepEqual(confirmContent(f, { confirm: true }), { content: { confirm: true }, missing: [] })
  assert.deepEqual(confirmContent(f, { confirm: false }), { content: { confirm: false }, missing: [] })
  // a required one always goes, with its default when untouched
  assert.deepEqual(confirmContent(confirmFields({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }), {}), { content: { ok: false }, missing: [] })
})
