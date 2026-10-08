import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bus } from '../events.ts'
import type { WsConfig } from '../workspace.ts'
import { localSource } from '../bridge/local.ts'
import { killProfile, profileHeld } from '../../scripts/edge.mjs'
import { edgeBrowser, findEdge } from './launcher.ts'
import type { StateDocs } from './state.ts'

/* One read through a real Edge: a headless Edge on a temp profile, a page on 127.0.0.1 that hands its tab a cookie,
   and a pack that reads with it. WC_TEST_NO_EDGE=1 skips it; WC_TEST_EDGE_DIR names the profile dir to use. */

const edge = findEdge()
const skip = process.env.WC_TEST_NO_EDGE === '1' ? 'WC_TEST_NO_EDGE=1' : !edge ? 'no Edge found' : false
const PACKS = join(import.meta.dirname, 'testdata', 'packs')
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

/** removes the temp profile once Edge lets go of its lock, retrying while its helpers still hold files, then ending them */
async function removeProfile(dir: string) {
  for (const end = Date.now() + 20_000; profileHeld(dir) && Date.now() < end;) await sleep(200)
  for (let i = 0; i < 40; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (e) {
      if (i === 19) await killProfile(dir)
      if (i === 39) console.error(`left ${dir}: ${(e as Error).message}`)
    }
    await sleep(250)
  }
}

const CFG = { gatewayUrl: 'http://127.0.0.1:1', consoleTokenPath: '', llmTokenPath: '', workDir: '', runTools: [], teamTz: null, maxSessions: 1 } as WsConfig

test('a live read from a local test page through a real Edge on a temp profile', { skip, timeout: 120_000 }, async () => {
  const given = process.env.WC_TEST_EDGE_DIR
  const dir = given || mkdtempSync(join(tmpdir(), 'wc-edge-'))
  mkdirSync(dir, { recursive: true })
  let port = 0
  const items = () => ['W-1', 'W-2'].map((id) => ({
    id, type: 'Task', title: `live ${id}`, state: 'Active', assignedTo: null, changedAt: '2026-10-08T10:00:00Z', link: `http://127.0.0.1:${port}/app/${id}`,
  }))
  const page = createServer((req, res) => {
    if (req.url === '/app/') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'wc=live-cookie; Path=/app; HttpOnly; SameSite=Strict' })
      return res.end('<!doctype html><title>live</title><p>live test page</p>')
    }
    if (req.url === '/app/data.json') {
      if (!/(^|;\s*)wc=live-cookie(;|$)/.test(String(req.headers.cookie ?? ''))) { res.writeHead(401); return res.end() }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(items()))
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((ok) => page.listen(0, '127.0.0.1', ok))
  port = (page.address() as AddressInfo).port

  const browser = edgeBrowser({ dir, exe: edge, headless: true })
  const docs: StateDocs = { load: async () => ({ docs: {}, seq: 0 }), put: async () => {}, seq: async () => {} }
  const src = localSource(CFG, {
    bus: new Bus(), ws: 'live', grants: () => ({ packs: ['live'], hosts: ['127.0.0.1'], config: { live: { port: String(port) } } }),
    docs, browser, packsDir: PACKS, tickMs: 250,
  })
  try {
    src.start()
    const end = Date.now() + 60_000
    while (Date.now() < end && src.concepts().work !== 'ready' && browser.status().state !== 'unavailable') await new Promise((ok) => setTimeout(ok, 100))
    assert.equal(src.concepts().work, 'ready', JSON.stringify({ browser: browser.status(), status: src.status(), read: await src.read(['work']) }))
    const r = await src.read(['work'])
    assert.equal(r.work.status, 'ok')
    assert.deepEqual(r.work.items, items())
    assert.deepEqual(src.status().tabs, [{ key: 'live/app', host: '127.0.0.1', signin: false }])
  } finally {
    src.stop()
    await browser.stop()
    await new Promise<void>((ok) => { page.closeAllConnections(); page.close(() => ok()) })
    if (!given) await removeProfile(dir)
  }
})
