import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalog, PACKS_DIR } from './packs.ts'

test('every core pack loads into the catalog; each listed one has a title, an about and a guide', () => {
  const cat = catalog(PACKS_DIR)
  assert.deepEqual(cat.filter((e) => e.problem).map((e) => `${e.name}: ${e.problem}`), [])
  for (const e of cat.filter((x) => x.listed)) {
    assert.ok(e.manifest!.title && e.manifest!.about, `${e.name} has a title and an about`)
    assert.ok(e.guide.trim().length > 0, `${e.name} has a guide`)
  }
  assert.equal(cat.find((e) => e.name === 'example')!.listed, false)
  assert.equal(cat.find((e) => e.name === 'telegram-web')!.manifest!.scopeAbout !== undefined, true)
})
