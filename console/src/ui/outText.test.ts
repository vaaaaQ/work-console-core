import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { OutSeg, OutText, outView, setOutView } from './outText.ts'

// the device's storage, as the page has it; outView reads it on first use
const mem = new Map<string, string>()
Object.assign(globalThis, { localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) } } })

const DRAFT = '## Open: 1\n\n| # | Ask |\n|---|---|\n| 1 | **server details** |\n'
const html = (t: string) => renderToStaticMarkup(OutText({ t }))

test('a choice the device stored earlier applies; anything else reads as Markdown', () => {
  mem.set('wc.outView', '"raw"')
  assert.equal(outView(), 'raw')
  mem.set('wc.outView', '"html"')
  assert.equal(outView(), 'md')
  mem.clear()
})

test('a draft reads as Markdown until the device chooses raw', () => {
  assert.equal(outView(), 'md')
  const h = html(DRAFT)
  assert.match(h, /^<div class="md out-md"><h2>Open: 1<\/h2>/)
  assert.match(h, /<td><strong>server details<\/strong><\/td>/)
  assert.match(renderToStaticMarkup(OutSeg()), /<button type="button" aria-pressed="true">MD<\/button><button type="button" aria-pressed="false">Raw<\/button>/)
})

test('raw shows the text as written, and the device keeps the choice', () => {
  setOutView('raw')
  assert.equal(mem.get('wc.outView'), '"raw"')
  assert.equal(html(DRAFT), '<pre class="out">## Open: 1\n\n| # | Ask |\n|---|---|\n| 1 | **server details** |\n</pre>')
  assert.match(renderToStaticMarkup(OutSeg()), /aria-pressed="false">MD<\/button><button type="button" aria-pressed="true">Raw/)
  setOutView('md')
  assert.equal(mem.get('wc.outView'), '"md"')
})
