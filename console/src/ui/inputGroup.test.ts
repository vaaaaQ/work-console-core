import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { InputGroup } from './inputGroup.ts'

test('the Input group opens each link in a new tab by its name; no links, no group', () => {
  const h = renderToStaticMarkup(InputGroup({ links: [{ name: 'Login page', url: 'https://login.example/start?a=1&b=2' }] }))
  assert.match(h, /^<div class="ag"><h4>Input<\/h4><ul class="al">/)
  assert.match(h, /<a href="https:\/\/login\.example\/start\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Login page<\/a>/)
  assert.equal(InputGroup({ links: [] }), null)
})
