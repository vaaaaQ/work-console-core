import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from '../events.ts'
import { formatter } from './format.ts'

const KEY = 'sk-proj-0123456789abcdefghij'
type Call = { url: string; init: RequestInit; body: Record<string, unknown> }
function setup(answer: (c: Call) => Response | Promise<Response>, o: { key?: string | null; timeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-fmt-')), keyPath = join(dir, 'openai.key')
  if (o.key !== null) writeFileSync(keyPath, o.key ?? KEY)
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit) => {
    const c = { url, init, body: JSON.parse(String(init.body)) }; calls.push(c)
    if (init.signal?.aborted) throw new Error('aborted')
    return answer(c)
  }) as unknown as typeof fetch
  return { fmt: formatter({ keyPath, fetch: f, timeoutMs: o.timeoutMs }), calls }
}
const ok = (out: unknown) => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }] }), { status: 200 })
/** never answers; fails once the call is aborted */
const hang = (c: Call) => new Promise<Response>((_, no) => c.init.signal!.addEventListener('abort', () => no(new Error('aborted'))))
const refused = (p: Promise<unknown>, status: number, code: string) => assert.rejects(p, (e) => e instanceof HttpError && e.status === status && e.code === code)

test('one call to the model with a strict schema; ctx, field and the say go in', async () => {
  const s = setup(() => ok({ text: '- a\n- b' }))
  const r = await s.fmt.format({ text: 'uh a and b', ctx: 'the draft', field: 'typed', target: 'llm' })
  assert.deepEqual(r, { text: '- a\n- b' })
  const b = s.calls[0].body as { model: string; instructions: string; input: string; text: { format: { strict: boolean; schema: { required: string[] } } } }
  assert.equal(s.calls[0].url, 'https://api.openai.com/v1/responses'); assert.equal(b.model, 'gpt-6-luna')
  assert.equal((s.calls[0].init.headers as Record<string, string>).authorization, `Bearer ${KEY}`)
  assert.ok(b.text.format.strict); assert.deepEqual(b.text.format.schema.required, ['text'])
  assert.match(b.input, /the draft/); assert.match(b.input, /typed/); assert.match(b.input, /uh a and b/)
  assert.match(b.instructions, /language it was spoken in/); assert.match(b.instructions, /never return it, or a changed copy of it/)
})

test('people get plain English; intents ask for the intent; an unknown intent is dropped', async () => {
  const s = setup(() => ok({ text: 'Fine.', intent: 'accept' }))
  assert.deepEqual(await s.fmt.format({ text: 'ok', target: 'people', intents: true }), { text: 'Fine.', intent: 'accept' })
  const b = s.calls[0].body as { instructions: string; text: { format: { schema: { required: string[] } } } }
  assert.match(b.instructions, /plain English/); assert.deepEqual(b.text.format.schema.required, ['text', 'intent'])
  assert.deepEqual(await setup(() => ok({ text: 'x', intent: 'ship' })).fmt.format({ text: 'x', target: 'llm', intents: true }), { text: 'x' })
})

test('ctx is clipped to 8000; an empty say or a long one is refused', async () => {
  const s = setup(() => ok({ text: 't' }))
  await s.fmt.format({ text: 'x', ctx: 'c'.repeat(9000), target: 'llm' })
  assert.ok(!(s.calls[0].body.input as string).includes('c'.repeat(8001)))
  await refused(s.fmt.format({ text: ' ', target: 'llm' }), 400, 'bad_args')
  await refused(s.fmt.format({ text: 'x'.repeat(20_001), target: 'llm' }), 400, 'bad_args')
  assert.equal(s.calls.length, 1)
})

test('no key, a refused key, a bad model, no text, a timeout and a dropped page each end as their own error, with the key scrubbed', async () => {
  await refused(setup(() => ok({}), { key: null }).fmt.format({ text: 'x', target: 'llm' }), 503, 'no_key')
  await refused(setup(() => new Response('{}', { status: 401 })).fmt.format({ text: 'x', target: 'llm' }), 502, 'bad_key')
  const bad = setup(() => new Response(JSON.stringify({ error: { message: `model gpt-6-luna not found for ${KEY}` } }), { status: 404 }))
  await assert.rejects(bad.fmt.format({ text: 'x', target: 'llm' }), (e) => e instanceof HttpError && e.code === 'format_failed' && !e.message.includes(KEY) && /not found/.test(e.message))
  await refused(setup(() => ok({ nope: 1 })).fmt.format({ text: 'x', target: 'llm' }), 502, 'format_failed')
  await refused(setup(hang, { timeoutMs: 30 }).fmt.format({ text: 'x', target: 'llm' }), 504, 'timeout')
  const ac = new AbortController(), p = setup(hang).fmt.format({ text: 'x', target: 'llm' }, ac.signal)
  setTimeout(() => ac.abort(), 10)
  await refused(p, 499, 'aborted')
})
