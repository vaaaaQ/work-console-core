import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkUrl, findBrowser, shoot } from './shot.ts'

const skip = findBrowser() ? false : 'no Edge or Chrome installed'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('a local page renders to a png with the installed browser', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-shot-')), page = join(dir, 'p.html'), out = join(dir, 'p.png')
  writeFileSync(page, '<!doctype html><title>t</title><h1 style="color:#c00">Hello</h1>')
  await shoot({ url: pathToFileURL(page).href, out, width: 400, height: 300 })
  assert.deepEqual(readFileSync(out).subarray(0, 8), PNG)
})

test('only http, https and file urls are taken, before any browser starts', async () => {
  for (const u of ['javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'not a url'])
    await assert.rejects(shoot({ url: u, out: join(tmpdir(), 'never.png'), browserPath: 'C:/nowhere/browser.exe' }), /only http, https and file urls|not a url/)
  assert.equal(checkUrl('http://127.0.0.1:7420/jobs').protocol, 'http:')
})
