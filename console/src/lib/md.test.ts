import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { md, safeHref } from './md.ts'

const html = (s: string) => renderToStaticMarkup(md(s))

test('headings, emphasis, code and lists render as elements', () => {
  const h = html('# Title\n\nSome **bold** and *em* and `x<y`.\n\n1. one\n2. two\n\n```\nlet a = 1\n```\n')
  assert.match(h, /<h1>Title<\/h1>/)
  assert.match(h, /<strong>bold<\/strong> and <em>em<\/em> and <code>x&lt;y<\/code>/)
  assert.match(h, /<ol><li>one<\/li><li>two<\/li><\/ol>/)
  assert.match(h, /<pre><code>let a = 1<\/code><\/pre>/)
})

test('raw HTML in the file shows as text, never as markup', () => {
  const h = html('<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)> there')
  assert.ok(!/<script|<img/i.test(h), h)
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(h, /hi &lt;img src=x onerror=alert\(1\)&gt; there/)
})

test('links open only for web and mail; other schemes keep just their text', () => {
  const h = html('[ok](https://x.example/a) [bad](javascript:alert(1)) [m](mailto:a@b.c) ![pic](data:image/png;base64,AA)')
  assert.match(h, /<a href="https:\/\/x.example\/a" target="_blank" rel="noopener noreferrer">ok<\/a>/)
  assert.ok(!/javascript:|data:/.test(h), h)
  assert.match(h, /<a href="mailto:a@b.c"/)
  assert.equal(safeHref(' HTTP://x '), 'HTTP://x')
  assert.equal(safeHref('//evil.example'), null)
})

test('tables and task lists', () => {
  const h = html('| a | b |\n|:-|-:|\n| 1 | **2** |\n\n- [x] done\n- [ ] open\n')
  assert.match(h, /<table class="mt"><thead><tr><th style="text-align:left">a<\/th><th style="text-align:right">b<\/th><\/tr><\/thead><tbody><tr><td style="text-align:left">1<\/td><td style="text-align:right"><strong>2<\/strong><\/td><\/tr><\/tbody><\/table>/)
  assert.match(h, /<li><input type="checkbox"[^>]* checked=""\/>done<\/li>/)
  assert.match(h, /<li><input type="checkbox" disabled=""[^>]*\/>open<\/li>/)
  assert.ok(!/checked=""\/>open/.test(h))
})
