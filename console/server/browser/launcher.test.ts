import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { edgeBrowser, findEdge, holdsProfile, keepBrowsers, parsePolicy, sharedBrowser } from './launcher.ts'
import type { Browser, BrowserStatus } from './launcher.ts'
import { tempDir } from '../testdirs.ts'

const FAKE = join(import.meta.dirname, 'fake-edge.mjs')
const dirs: string[] = []
const fresh = () => { const d = tempDir('edge'); dirs.push(d); return d }
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
const closes = (dir: string) => { const f = join(dir, 'fake-edge-closes.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').length : 0 }

after(() => {
  for (const d of dirs) {
    for (const r of runs(d)) if (alive(r.pid)) process.kill(r.pid)
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

test('while browsers are kept, stop leaves a launched Edge up and the next browser reattaches to it', async () => {
  const dir = fresh(), a = edge(dir)
  await a.start()
  const ep = a.endpoint()!
  keepBrowsers()
  try { await a.stop() } finally { keepBrowsers(false) }
  assert.equal(closes(dir), 0)
  assert.ok(await answers(ep), 'the kept Edge was closed')
  const b = edge(dir)
  await b.start()
  assert.equal(b.endpoint(), ep)
  assert.equal(runs(dir).length, 1)
  await b.stop()
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

test('stop asks an Edge it launched to close itself, so the profile is written out', async () => {
  const dir = fresh(), b = edge(dir)
  await b.start()
  const ep = b.endpoint()!
  await b.stop()
  assert.equal(closes(dir), 1)
  assert.ok(!(await answers(ep)))
})

test('stop returns once the closed Edge has let go of its profile', async () => {
  const dir = fresh(), b = edge(dir)
  await b.start()
  assert.ok(existsSync(join(dir, 'lockfile')))
  await b.stop()
  assert.equal(closes(dir), 1)
  assert.ok(!existsSync(join(dir, 'lockfile')), 'the profile is still held')
})

test('stop ends an Edge that relaunched itself under a new pid and ignores the close', async () => {
  const dir = fresh(), b = edge(dir, { env: { ...process.env, FAKE_EDGE_MODE: 'relaunch,noclose' }, closeMs: 300 })
  await b.start()
  const ep = b.endpoint()!
  assert.equal(runs(dir).length, 2)
  await b.stop()
  assert.ok(!(await answers(ep)))
  for (const r of runs(dir)) await until(() => !alive(r.pid))
})

test('an Edge that relaunched itself and opens no port is ended when the launch gives up', async () => {
  const dir = fresh(), b = edge(dir, { env: { ...process.env, FAKE_EDGE_MODE: 'relaunch,noport' }, portWaitMs: 1500 })
  await b.start()
  assert.equal(b.status().state, 'unavailable')
  assert.equal(runs(dir).length, 2)
  for (const r of runs(dir)) await until(() => !alive(r.pid))
})

test('holdsProfile matches a command line on exactly this profile dir', () => {
  const dir = String.raw`C:\Users\u\wc\browser`
  assert.ok(holdsProfile(String.raw`"C:\Edge\msedge.exe" --user-data-dir=C:\Users\u\wc\browser --no-first-run`, dir, true))
  assert.ok(holdsProfile('msedge.exe --type=renderer "--user-data-dir=c:/users/u/wc/browser"', dir, true))
  assert.ok(holdsProfile(String.raw`msedge.exe --user-data-dir="C:\Users\u\wc\browser"`, dir, true))
  assert.ok(!holdsProfile(String.raw`msedge.exe --user-data-dir=C:\Users\u\wc\browser2`, dir, true))
  assert.ok(!holdsProfile('msedge.exe --profile-directory=Default', dir, true))
  assert.ok(!holdsProfile('edge --user-data-dir=/home/U/wc/browser', '/home/u/wc/browser', false))
  assert.ok(holdsProfile('edge --user-data-dir=/home/u/wc/browser', '/home/u/wc/browser', false))
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
