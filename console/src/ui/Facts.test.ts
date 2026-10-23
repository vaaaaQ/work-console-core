import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* The branch fact's copy button sits on the name's line: .iconbtn is a block-level grid elsewhere, so a fact row
   makes it inline, or the button breaks the line between the sha and "repo core". */
test('a fact row keeps its copy button inline, on the name\'s line', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  const rule = css.match(/\.fx-row \.iconbtn\{([^}]*)\}/)
  assert.ok(rule, 'a .fx-row .iconbtn rule')
  assert.match(rule[1], /display:inline-grid/)
  assert.match(rule[1], /vertical-align:middle/)
})
