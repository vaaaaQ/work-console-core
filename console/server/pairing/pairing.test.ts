import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pairing, qrSvg } from './pairing.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'wc-pair-'))

test('a code is 32 random bytes and redeems exactly once', () => {
  const p = new Pairing(dir()), { code } = p.newCode()
  assert.equal(Buffer.from(code, 'base64url').length, 32)
  const d = p.redeem(code, 'iPhone')!
  assert.ok(d.token && d.id)
  assert.equal(p.redeem(code, 'again'), null)
  assert.equal(p.redeem('made-up', 'x'), null)
  assert.deepEqual(p.check(d.token), { id: d.id })
})

test('a code is dead 5 minutes and 1 ms later', () => {
  let t = 1_000_000
  const p = new Pairing(dir(), () => t), { code } = p.newCode()
  t += 5 * 60e3 + 1
  assert.equal(p.redeem(code, 'late'), null)
})

test('the file holds only the hash; tokens survive a reload; revoke kills a token', () => {
  const d0 = dir(), p = new Pairing(d0), d = p.redeem(p.newCode().code, 'phone')!
  const raw = readFileSync(join(d0, 'devices.json'), 'utf8')
  assert.ok(!raw.includes(d.token), 'the raw token is never written')
  const again = new Pairing(d0)
  assert.deepEqual(again.check(d.token), { id: d.id })
  assert.equal(again.devices()[0].name, 'phone')
  assert.ok(!('hash' in again.devices()[0]))
  assert.equal(again.revoke(d.id), true)
  assert.equal(again.check(d.token), null)
  assert.equal(new Pairing(d0).check(d.token), null)
  assert.equal(again.revoke(d.id), false)
  assert.equal(again.check(undefined), null)
})

test('qrSvg draws an svg', async () => {
  assert.match(await qrSvg('https://pc:7411/pair?code=abc'), /^<svg/)
})
