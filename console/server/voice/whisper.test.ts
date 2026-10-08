import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HttpError } from '../events.ts'
import { whisper } from './whisper.ts'
import { tempDir } from '../testdirs.ts'

const KEY = 'sk-proj-0123456789abcdefghijklmnopqrstuvwxyz'
const AUDIO = Buffer.from('not really opus').toString('base64')

/** a key file in a temp folder, and an OpenAI stand-in that records each call */
function setup(answer: (init: RequestInit) => Response | Promise<Response> = () => Response.json({ text: ' Hola, armá el job. ' })) {
  const dir = tempDir('voice'), keyPath = join(dir, 'openai.key')
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer(init) }) as unknown as typeof globalThis.fetch
  return { keyPath, calls, v: whisper({ keyPath, fetch, url: 'http://openai.test/v1/audio/transcriptions', timeoutMs: 200 }) }
}
async function refused(p: Promise<unknown>, status: number, code: string) {
  const e = await p.then(() => assert.fail('it should have failed'), (x: unknown) => x)
  assert.ok(e instanceof HttpError, String(e))
  assert.equal(e.status, status, e.message)
  assert.equal(e.code, code, e.message)
  return e.message
}

test('ready follows the key file, read anew each time', () => {
  const { keyPath, v } = setup()
  assert.equal(v.ready(), false, 'no file')
  writeFileSync(keyPath, '  \n')
  assert.equal(v.ready(), false, 'a blank file')
  writeFileSync(keyPath, `${KEY}\n`)
  assert.equal(v.ready(), true, 'a key placed later turns voice on without a restart')
})

test('a recording goes to whisper-1 as a file of its own type, with the key as bearer; the text comes back trimmed', async () => {
  const { keyPath, calls, v } = setup()
  writeFileSync(keyPath, KEY)
  assert.equal(await v.transcribe(AUDIO, 'audio/webm;codecs=opus'), 'Hola, armá el job.')
  assert.equal(calls.length, 1)
  const { url, init } = calls[0], form = init.body as FormData, file = form.get('file') as File
  assert.equal(url, 'http://openai.test/v1/audio/transcriptions')
  assert.equal(init.method, 'POST')
  assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${KEY}`)
  assert.equal(form.get('model'), 'whisper-1')
  assert.equal(file.name, 'speech.webm')
  assert.equal(file.type, 'audio/webm')
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'not really opus')
  // a phone's recorder names mp4; a data URL is read as its base64
  await v.transcribe(`data:audio/mp4;base64,${AUDIO}`, 'audio/mp4')
  assert.equal((calls[1].init.body as FormData).get('file') instanceof File && ((calls[1].init.body as FormData).get('file') as File).name, 'speech.mp4')
})

test('no key: 503 no_key, and OpenAI is never called', async () => {
  const { calls, v } = setup()
  await refused(v.transcribe(AUDIO, 'audio/webm'), 503, 'no_key')
  assert.equal(calls.length, 0)
})

test('a type whisper cannot read, audio that is not base64, or none: 400 before any call', async () => {
  const { keyPath, calls, v } = setup()
  writeFileSync(keyPath, KEY)
  assert.match(await refused(v.transcribe(AUDIO, 'video/quicktime'), 400, 'bad_args'), /webm/)
  await refused(v.transcribe(AUDIO, ''), 400, 'bad_args')
  await refused(v.transcribe('%%% not base64 %%%', 'audio/webm'), 400, 'bad_args')
  await refused(v.transcribe('', 'audio/webm'), 400, 'bad_args')
  assert.equal(calls.length, 0)
})

test('the key never appears in an error, whole or as OpenAI quotes it', async () => {
  const masked = `${KEY.slice(0, 8)}*****************${KEY.slice(-4)}`
  const say = (status: number, message: string) => () => Response.json({ error: { message } }, { status })
  const cases: [ReturnType<typeof setup>, number, string][] = [
    [setup(say(401, `Incorrect API key provided: ${masked}. You can find your API key at the dashboard.`)), 502, 'bad_key'],
    [setup(say(500, `upstream echoed Bearer ${KEY}`)), 502, 'transcribe_failed'],
    [setup(say(429, `Rate limit reached for ${masked}`)), 503, 'busy'],
    [setup(() => { throw new Error(`connect failed for ${KEY}`) }), 502, 'unreachable'],
  ]
  for (const [{ keyPath, v }, status, code] of cases) {
    writeFileSync(keyPath, KEY)
    const msg = await refused(v.transcribe(AUDIO, 'audio/webm'), status, code)
    assert.ok(!msg.includes(KEY) && !msg.includes(masked) && !msg.includes(KEY.slice(0, 12)) && !msg.includes(KEY.slice(-4)), msg)
  }
})

test('a reply without text, a page that drops the request, and a slow OpenAI each end the call', async () => {
  const hang = (init: RequestInit) => new Promise<Response>((_ok, no) => init.signal!.addEventListener('abort', () => no(init.signal!.reason)))
  const odd = setup(() => Response.json({ nope: 1 }))
  writeFileSync(odd.keyPath, KEY)
  await refused(odd.v.transcribe(AUDIO, 'audio/webm'), 502, 'bad_reply')
  const dropped = setup(hang), page = new AbortController()
  writeFileSync(dropped.keyPath, KEY)
  const p = dropped.v.transcribe(AUDIO, 'audio/webm', page.signal)
  page.abort()
  await refused(p, 499, 'aborted')
  const slow = setup(hang)
  writeFileSync(slow.keyPath, KEY)
  await refused(slow.v.transcribe(AUDIO, 'audio/webm'), 504, 'timeout')
})
