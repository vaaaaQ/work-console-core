import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Restarter, swapDist } from './restart.ts'

const dir = (r: string, name: string, text: string) => { mkdirSync(join(r, name)); writeFileSync(join(r, name, 'index.html'), text) }

test('swapDist puts the staged build in place; done() drops the old one, back() restores it', async () => {
  const r = mkdtempSync(join(tmpdir(), 'wc-swap-'))
  dir(r, 'dist', 'old'); dir(r, 'stage', 'new')
  const s = await swapDist(join(r, 'stage'), join(r, 'dist'))
  assert.equal(readFileSync(join(r, 'dist', 'index.html'), 'utf8'), 'new')
  assert.equal(existsSync(join(r, 'stage')), false)
  await s.back()
  assert.equal(readFileSync(join(r, 'dist', 'index.html'), 'utf8'), 'old')
  dir(r, 'stage', 'newer')
  ;(await swapDist(join(r, 'stage'), join(r, 'dist'))).done()
  assert.equal(readFileSync(join(r, 'dist', 'index.html'), 'utf8'), 'newer')
  assert.equal(existsSync(join(r, 'dist.old')), false)
})

test('swapDist with no build served yet', async () => {
  const r = mkdtempSync(join(tmpdir(), 'wc-swap-'))
  dir(r, 'stage', 'first')
  const s = await swapDist(join(r, 'stage'), join(r, 'dist'))
  assert.equal(readFileSync(join(r, 'dist', 'index.html'), 'utf8'), 'first')
  await s.back()
  assert.equal(existsSync(join(r, 'dist')), false)
})

test('a restart waits for every held turn to end, and fires once', () => {
  let n = 0
  const r = new Restarter(() => { n++ })
  const a = r.hold(), b = r.hold()
  r.want(); r.want()
  assert.equal(n, 0)
  a(); a()
  assert.equal(n, 0)
  b()
  assert.equal(n, 1)
  r.hold()()
  assert.equal(n, 1, 'no second restart without a second want')
  r.want()
  assert.equal(n, 2, 'nothing held: at once')
})
