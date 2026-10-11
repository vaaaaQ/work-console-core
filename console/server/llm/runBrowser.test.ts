import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { BROWSER, BROWSER_TOOLS, WITHHELD, browserMcp, normRunBrowser, runBrowser, startProxy } from './runBrowser.ts'
import type { RunBrowser } from './runBrowser.ts'
import { tempDir } from '../testdirs.ts'

const FAKE = join(import.meta.dirname, '..', 'browser', 'fake-edge.mjs')
const closers: (() => Promise<unknown>)[] = []
after(async () => { for (const c of closers.reverse()) await c().catch(() => {}) })

/** a site on loopback that answers its own port */
async function site(): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`site ${req.url}`) })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise((ok) => { server.closeAllConnections(); server.close(ok) }))
  return { port: (server.address() as AddressInfo).port, server }
}

/** a plain http GET through the proxy: its status and body */
function viaProxy(proxy: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, no) => {
    const u = new URL(url)
    const r = request({ host: '127.0.0.1', port: proxy, method: 'GET', path: url, headers: { host: u.host } }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }))
    })
    r.on('error', no)
    r.end()
  })
}

/** a CONNECT through the proxy: the status line it answers */
function tunnel(proxy: number, target: string): Promise<string> {
  return new Promise((ok, no) => {
    const s = connect(proxy, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    s.once('data', (d) => { ok(String(d).split('\r\n')[0]); s.destroy() })
    s.on('error', no)
  })
}

test('normRunBrowser: off unless asked; true and {} are open mode; allow lists the hosts', () => {
  for (const x of [undefined, null, false]) assert.equal(normRunBrowser(x), null)
  assert.deepEqual(normRunBrowser(true), { allow: null })
  assert.deepEqual(normRunBrowser({}), { allow: null })
  assert.deepEqual(normRunBrowser({ allow: ['web.telegram.example', '*.corp.example', 'web.telegram.example'] }), { allow: ['web.telegram.example', '*.corp.example'] })
  assert.throws(() => normRunBrowser({ allow: [] }), /allow must list at least one host/)
  assert.throws(() => normRunBrowser({ allow: 'x' }), /allow must be a list of hosts/)
  assert.throws(() => normRunBrowser({ allow: ['https://a.example/'] }), /not a host: https:\/\/a.example\//)
  assert.throws(() => normRunBrowser({ hosts: [] }), /unknown key hosts/)
  assert.throws(() => normRunBrowser('open'), /browser is true or an object/)
})

test('the browser tools are an explicit list: pages, clicks, typing, snapshots and evaluate, never cookies, files or raw Playwright', () => {
  const bare = BROWSER_TOOLS.map((t) => t.replace(`mcp__${BROWSER}__`, ''))
  assert.ok(BROWSER_TOOLS.every((t) => t.startsWith('mcp__browser__browser_')))
  for (const t of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key',
    'browser_evaluate', 'browser_take_screenshot', 'browser_tabs', 'browser_wait_for', 'browser_console_messages', 'browser_network_requests'])
    assert.ok(bare.includes(t), t)
  // raw Playwright code runs in the server process; uploads and drops send the PC's files; a request's details carry its cookies and tokens
  for (const t of ['browser_run_code_unsafe', 'browser_file_upload', 'browser_drop', 'browser_network_request', 'browser_cookie_get', 'browser_cookie_list',
    'browser_storage_state', 'browser_localstorage_get', 'browser_sessionstorage_get', 'browser_set_storage_state'])
    assert.ok(!bare.includes(t) && WITHHELD.includes(t), t)
  assert.ok(!BROWSER_TOOLS.includes('mcp__browser'), 'never the whole server')
})

test('the browser server is Playwright MCP on the runs’ own browser: its CDP endpoint, output under the run, no extra capabilities', () => {
  const c = browserMcp({ cli: '/x/cli.js', cdp: 'http://127.0.0.1:9333', outDir: '/w/.browser' })
  assert.equal(c.type, 'stdio')
  assert.equal(c.command, process.execPath)
  assert.deepEqual(c.args, ['/x/cli.js', '--cdp-endpoint', 'http://127.0.0.1:9333', '--output-dir', '/w/.browser'])
  for (const a of ['--caps', '--allow-unrestricted-file-access', '--extension', '--user-data-dir']) assert.ok(!c.args.some((x) => x.startsWith(a)), a)
})

test('open mode: the proxy lets any site through, but never the console’s own ports on this PC', async () => {
  const a = await site(), con = await site()
  const p = await startProxy({ allow: null, deny: [con.port] })
  closers.push(() => p.close())
  assert.deepEqual(await viaProxy(p.port, `http://127.0.0.1:${a.port}/x`), { status: 200, body: 'site /x' })
  assert.equal(await tunnel(p.port, `127.0.0.1:${a.port}`), 'HTTP/1.1 200 Connection Established')
  const no = await viaProxy(p.port, `http://localhost:${con.port}/api/act`)
  assert.equal(no.status, 403)
  assert.match(no.body, /console_port: localhost:\d+/)
  assert.equal(await tunnel(p.port, `127.0.0.1:${con.port}`), 'HTTP/1.1 403 Forbidden')
})

test('allowlist mode: only listed hosts open, every other host is refused', async () => {
  const a = await site()
  const p = await startProxy({ allow: ['127.0.0.1'], deny: [] })
  closers.push(() => p.close())
  assert.equal((await viaProxy(p.port, `http://127.0.0.1:${a.port}/`)).status, 200)
  const no = await viaProxy(p.port, `http://localhost:${a.port}/`)
  assert.equal(no.status, 403)
  assert.match(no.body, /host_not_allowed: localhost/)
  assert.equal(await tunnel(p.port, `example.com:443`), 'HTTP/1.1 403 Forbidden')
})

const runs = (dir: string): { pid: number; args: string[] }[] => {
  const f = join(dir, 'fake-edge-runs.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const fakeBrowser = (dir: string, allow: string[] | null): RunBrowser => {
  const b = runBrowser({ dir, exe: process.execPath, args: [FAKE], allow, deny: [7410], cli: '/x/cli.js', policy: async () => null, probeMs: 60_000, portWaitMs: 5000 })
  closers.push(async () => { await b.stop(); for (const r of runs(dir)) if (alive(r.pid)) process.kill(r.pid) })
  return b
}

test('the runs’ browser starts headless on its own profile behind the proxy, loopback included, and hands Playwright MCP its endpoint', async () => {
  const dir = join(tempDir('runbrowser'), 'p'), b = fakeBrowser(dir, ['web.telegram.example'])
  const c = await b.mcp('/w/.browser')
  const [r] = runs(dir)
  assert.ok(r.args.includes(`--user-data-dir=${dir}`))
  assert.ok(r.args.includes('--headless=new'))
  const proxy = r.args.find((x) => x.startsWith('--proxy-server='))
  assert.match(proxy ?? '', /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(r.args.includes('--proxy-bypass-list=<-loopback>'), 'loopback goes through the proxy too, so the console page is refused')
  assert.equal(c.args[2], b.endpoint())
  // a second run shares the browser
  await b.mcp('/w2/.browser')
  assert.equal(runs(dir).length, 1)
})

test('sign-in opens the same profile with a window on the page, and done brings it back headless', async () => {
  const dir = join(tempDir('runbrowser'), 'p'), b = fakeBrowser(dir, null)
  await b.mcp('/w/.browser')
  await b.signIn('https://web.telegram.example/')
  assert.equal(b.status().signingIn, true)
  const head = runs(dir).at(-1)!
  assert.ok(!head.args.includes('--headless=new'))
  assert.ok(head.args.includes('https://web.telegram.example/'))
  assert.ok(head.args.some((x) => x.startsWith('--proxy-server=')), 'the window goes through the proxy too')
  await assert.rejects(b.mcp('/w/.browser'), /signing in/)
  await assert.rejects(b.signIn('javascript:alert(1)'), /only http and https/)
  await b.signedIn()
  assert.equal(b.status().signingIn, false)
  await b.mcp('/w/.browser')
  assert.ok(runs(dir).at(-1)!.args.includes('--headless=new'))
  assert.ok(!alive(head.pid), 'the window closed')
})
