import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Recorder } from './voice.ts'
import type { Recording } from './voice.ts'

function fake() {
  let ok!: (r: Recording) => void, cancelled = 0
  const rec: Recording = { stop: async () => ({ audio: 'AA==', mime: 'audio/webm' }), cancel: () => { cancelled++ } }
  return { record: () => new Promise<Recording>((r) => { ok = r }), give: () => ok(rec), cancelled: () => cancelled }
}

test('start, stop: the audio; the cap stops it', async () => {
  const f = fake()
  let capped = 0
  const r = new Recorder({ max: 20, onCap: () => { capped++ }, record: f.record })
  const p = r.start(); f.give()
  assert.equal(await p, true); assert.equal(r.on, true)
  await new Promise((x) => setTimeout(x, 40)); assert.equal(capped, 1)
  assert.deepEqual(await r.stop(), { audio: 'AA==', mime: 'audio/webm' }); assert.equal(r.on, false)
  assert.equal(await r.stop(), null)
})

test('cancel while the browser asks for the mic drops the recording when it comes', async () => {
  const f = fake(), r = new Recorder({ max: 1000, onCap: () => {}, record: f.record })
  const p = r.start(); r.cancel(); f.give()
  assert.equal(await p, false); assert.equal(f.cancelled(), 1); assert.equal(r.on, false)
})

test('a mic that does not start throws and leaves it off', async () => {
  const r = new Recorder({ max: 1000, onCap: () => {}, record: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) })
  await assert.rejects(r.start(), /no/)
  assert.equal(r.on, false)
})
