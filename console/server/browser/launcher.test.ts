import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { edgeBrowser, findEdge, parsePolicy, sharedBrowser } from './launcher.ts'
import type { Browser, BrowserStatus } from './launcher.ts'

const FAKE = join(import.meta.dirname, 'fake-edge.mjs')
const dirs: string[] = []
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'wc-edge-')); dirs.push(d); return d }
type Run = { pid: number; args: string[]; env: string[] }
const runs = (dir: string): Run[] => {
  const f = join(dir, 'fake-edge-runs.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
}
const edge = (dir: string, o: Partial<Parameters<typeof edgeBrowser>[0]> = {}) =>
  edgeBrowser({ dir, exe: process.execPath, args: [FAKE], policy: async () => null, probeMs: 50, portWaitMs: 3000, ...o })
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
const until = async (f: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await f()) return; await sleep(25) }
  assert.fail('timed out')
}
const answers = async (ep: string) => {
  try { return (await fetch(`${ep}/json/version`, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

after(() => {
  for (const d of dirs) {
    for (const r of runs(d)) if (alive(r.pid)) process.kill(r.pid)
    try { rmSync(d, { recursive: true, force: true }) } catch { /* a dying fake may still hold it */ }
  }
})

test("start launches Edge on port 0 with the console's own profile, scrubs secret-looking env, and is up", async () => {
  const dir = fresh(), b = edge(dir, { env: { ...process.env, MY_TOKEN: 'x', AZURE_CLIENT_ID: 'y', WC_PLAIN: 'z' } })
  try {
    await b.start()
    assert.equal(b.status().state, 'up')
    assert.ok(await answers(b.endpoint()!))
    const [r] = runs(dir)
    assert.ok(r.args.includes(`--user-data-dir=${dir}`))
    assert.ok(r.args.includes('--remote-debugging-port=0'))
    assert.equal(r.args.at(-1), 'about:blank')
    assert.ok(r.env.includes('WC_PLAIN'))
    assert.ok(!r.env.includes('MY_TOKEN') && !r.env.includes('AZURE_CLIENT_ID'))
  } finally { await b.stop() }
  assert.equal(b.status().state, 'off')
  assert.equal(b.endpoint(), null)
})

test('a second browser on a live profile reattaches without launching; only the launcher stops that Edge', async () => {
  const dir = fresh(), a = edge(dir), b = edge(dir)
  await a.start(); await b.start()
  const ep = a.endpoint()!
  assert.equal(runs(dir).length, 1)
  assert.equal(b.endpoint(), ep)
  await b.stop()
  assert.ok(await answers(ep), 'a reattached browser leaves the process alone')
  await a.stop()
  await until(async () => !(await answers(ep)))
})

test('a stale port file is replaced by a fresh launch', async () => {
  const dir = fresh()
  writeFileSync(join(dir, 'DevToolsActivePort'), '1\n/devtools/browser/old\n')
  const b = edge(dir)
  try {
    await b.start()
    assert.equal(runs(dir).length, 1)
    assert.equal(b.status().state, 'up')
    assert.notEqual(b.endpoint(), 'http://127.0.0.1:1')
  } finally { await b.stop() }
})

test('no Edge is unavailable with the reason; a given path is used as is', async () => {
  const b = edgeBrowser({ dir: fresh(), exe: null, policy: async () => null })
  await b.start()
  assert.equal(b.status().state, 'unavailable')
  assert.match(b.status().reason!, /no Edge found/)
  assert.equal(findEdge('/opt/edge/msedge'), '/opt/edge/msedge')
})

test('a policy blocking remote debugging is unavailable with its reason, and nothing is launched', async () => {
  const dir = fresh(), b = edge(dir, { policy: async () => 'remote debugging is turned off by an Edge policy' })
  await b.start()
  assert.deepEqual(b.status(), { state: 'unavailable', reason: 'remote debugging is turned off by an Edge policy' })
  assert.equal(runs(dir).length, 0)
})

test('an Edge that opens no debugging port is unavailable after portWaitMs, and the process is ended', async () => {
  const dir = fresh(), b = edge(dir, { env: { ...process.env, FAKE_EDGE_MODE: 'noport' }, portWaitMs: 400 })
  await b.start()
  assert.equal(b.status().state, 'unavailable')
  assert.match(b.status().reason!, /no debugging port; a policy may block remote debugging/)
  const [r] = runs(dir)
  await until(() => !alive(r.pid))
})

test('the watchdog relaunches an Edge that was closed', async () => {
  const dir = fresh(), b = edge(dir)
  try {
    await b.start()
    process.kill(runs(dir)[0].pid)
    await until(async () => runs(dir).length === 2 && b.status().state === 'up' && await answers(b.endpoint()!))
  } finally { await b.stop() }
})

test('an Edge that keeps closing is relaunched 3 times, then unavailable', async () => {
  const dir = fresh(), b = edge(dir, { env: { ...process.env, FAKE_EDGE_MODE: 'die' } })
  const seen: string[] = []
  b.onChange((s) => seen.push(s.state))
  try {
    await b.start()
    await until(() => b.status().state === 'unavailable', 20_000)
    assert.equal(runs(dir).length, 4)
    assert.match(b.status().reason!, /closed 3 times within 10 minutes/)
    assert.ok(seen.includes('starting') && seen.includes('up'))
  } finally { await b.stop() }
})

test('parsePolicy reads RemoteDebuggingAllowed 0 as blocked', () => {
  assert.equal(parsePolicy('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge\r\n    RemoteDebuggingAllowed    REG_DWORD    0x0\r\n'), true)
  assert.equal(parsePolicy('    RemoteDebuggingAllowed    REG_DWORD    0x1\r\n'), false)
  assert.equal(parsePolicy(''), false)
})

test('sharedBrowser starts one browser per profile for two users and stops it on the last release', async () => {
  let made = 0
  const counts = { starts: 0, stops: 0 }
  const make = (): Browser => {
    made++
    let st: BrowserStatus = { state: 'off' }
    return {
      endpoint: () => null, status: () => st, onChange: () => () => {},
      start: async () => { counts.starts++; st = { state: 'up' } },
      stop: async () => { counts.stops++; st = { state: 'off' } },
    }
  }
  const u1 = sharedBrowser('X:/profile', make), u2 = sharedBrowser('X:/profile', make)
  await u1.start(); await u2.start()
  assert.deepEqual([made, counts.starts], [1, 1])
  await u1.stop()
  assert.equal(counts.stops, 0)
  await u2.stop()
  assert.equal(counts.stops, 1)
  const u3 = sharedBrowser('X:/profile', make)
  await u3.start()
  assert.equal(made, 2, 'a fresh browser after the last release')
  await u3.stop()
})
