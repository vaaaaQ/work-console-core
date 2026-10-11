import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect, isIP } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { dirname, join } from 'node:path'
import { closeProfile } from '../../scripts/edge.mjs'
import { edgeBrowser, findEdge } from '../browser/launcher.ts'
import type { Browser, EdgeOptions } from '../browser/launcher.ts'
import { HttpError } from '../events.ts'
import { hostAllowed } from '../grants.ts'
import type { Plugin } from '../workspace.ts'

/* The runs' browser: one per workspace that turns it on, with its own persistent profile, so a person signs in to a
   site once and every run of the workspace works in that session. Runs reach it only through Playwright MCP, with an
   explicit list of its tools: pages, clicks, typing, snapshots, evaluate; never cookies, storage, the PC's files or
   raw Playwright code. Every request goes through the console's own proxy: in open mode it lets any site through, in
   allowlist mode only the listed hosts; in both it refuses the console's own ports on this PC, since the console's
   page trusts loopback and could accept a run's own grants. The window shows only while the person signs in. */

/** allow null = open mode: any site */
export type RunBrowserCfg = { allow: string[] | null }

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/** a workspace's or grants.json's browser setting: off (undefined, null, false), open (true, {}), or {allow: hosts} */
export function normRunBrowser(x: unknown): RunBrowserCfg | null {
  if (x === undefined || x === null || x === false) return null
  if (x === true) return { allow: null }
  if (typeof x !== 'object' || Array.isArray(x)) throw new Error('browser is true or an object {allow?: hosts}')
  for (const k of Object.keys(x)) if (k !== 'allow') throw new Error(`browser: unknown key ${k}`)
  const a = (x as { allow?: unknown }).allow
  if (a === undefined || a === null) return { allow: null }
  if (!Array.isArray(a) || a.some((h) => typeof h !== 'string')) throw new Error('browser: allow must be a list of hosts')
  if (!a.length) throw new Error('browser: allow must list at least one host; leave it out for any site')
  for (const h of a as string[]) if (!HOST.test(h)) throw new Error(`browser: not a host: ${h}`)
  return { allow: [...new Set((a as string[]).map((h) => h.toLowerCase()))] }
}

/** the MCP server's name in a run's session */
export const BROWSER = 'browser'
/** the Playwright MCP tools a run may call, by bare name */
const TOOLS = ['navigate', 'navigate_back', 'snapshot', 'find', 'click', 'hover', 'drag', 'type', 'fill_form', 'press_key', 'select_option',
  'handle_dialog', 'evaluate', 'take_screenshot', 'tabs', 'wait_for', 'resize', 'close', 'console_messages', 'network_requests', 'emulate_media']
export const BROWSER_TOOLS = TOOLS.map((t) => `mcp__${BROWSER}__browser_${t}`)
/** never a run's, for the record: raw Playwright code runs in the server's process; an upload or a drop sends the PC's files;
    a request's details carry its cookies and tokens; the storage tools read them outright (the server is not started with --caps) */
export const WITHHELD = ['browser_run_code_unsafe', 'browser_file_upload', 'browser_drop', 'browser_network_request',
  ...['cookie_clear', 'cookie_delete', 'cookie_get', 'cookie_list', 'cookie_set', 'storage_state', 'set_storage_state']
    .map((t) => `browser_${t}`),
  ...['localstorage', 'sessionstorage'].flatMap((s) => ['clear', 'delete', 'get', 'list', 'set'].map((v) => `browser_${s}_${v}`))]

export type StdioServer = { type: 'stdio'; command: string; args: string[] }
/** Playwright MCP attached to the runs' browser; automatically named files go under the run's dir */
export function browserMcp(o: { cli: string; cdp: string; outDir: string }): StdioServer {
  return { type: 'stdio', command: process.execPath, args: [o.cli, '--cdp-endpoint', o.cdp, '--output-dir', o.outDir] }
}

/** the installed @playwright/mcp's cli.js */
export function playwrightCli(): string {
  try { return createRequire(import.meta.url).resolve('@playwright/mcp/cli.js') } catch {
    try { return dirname(createRequire(import.meta.url).resolve('@playwright/mcp/package.json')) + '/cli.js' } catch {
      throw new Error('the runs’ browser needs @playwright/mcp: run npm install in the console folder')
    }
  }
}

const loopback = (ip: string) => ip.startsWith('127.') || ip === '::1' || ip === '0.0.0.0' || ip === '::' || ip.startsWith('::ffff:127.')

/** null and the address to connect to when the host may be reached, else why not */
async function gate(o: { allow: string[] | null; deny: number[] }, host: string, port: number): Promise<{ addr: string } | { no: string }> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (o.allow && !hostAllowed(o.allow, h)) return { no: `host_not_allowed: ${h}` }
  let addr = h
  if (!isIP(h)) {
    try { addr = (await lookup(h)).address } catch { return { no: `no such host: ${h}` } }
  }
  // the console's page trusts loopback: a run there could act, or accept its own grants
  if (o.deny.includes(port) && (loopback(addr) || h === 'localhost')) return { no: `console_port: ${h}:${port}` }
  return { addr }
}

export type Proxy = { url: string; port: number; close(): Promise<void> }

/** an http proxy on loopback that lets through what gate allows; port = try this one first (a relaunch keeps the browser's) */
export async function startProxy(o: { allow: string[] | null; deny: number[]; port?: number }): Promise<Proxy> {
  const refuse = (res: ServerResponse, why: string) => { res.writeHead(403, { 'content-type': 'text/plain' }); res.end(why) }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let u: URL
    try { u = new URL(req.url ?? '') } catch { return refuse(res, 'a proxy request needs an absolute url') }
    if (u.protocol !== 'http:') return refuse(res, `only http through the proxy, not ${u.protocol}`)
    const port = Number(u.port || 80), g = await gate(o, u.hostname, port)
    if ('no' in g) return refuse(res, g.no)
    const up = request({ host: g.addr, port, method: req.method, path: u.pathname + u.search, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(e.message) } else res.destroy() })
    req.pipe(up)
  })
  server.on('connect', async (req: IncomingMessage, sock: Socket, head: Buffer) => {
    sock.on('error', () => {})
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '')
    if (!m) return sock.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    const port = Number(m[2]), g = await gate(o, m[1], port)
    if ('no' in g) return sock.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${g.no}`)
    const up = connect(port, g.addr, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) up.write(head)
      up.pipe(sock); sock.pipe(up)
    })
    up.on('error', () => sock.destroy())
    sock.on('close', () => up.destroy())
  })
  const listen = (port: number) => new Promise<boolean>((ok) => {
    const fail = () => ok(false)
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => { server.off('error', fail); ok(true) })
  })
  if (!(o.port && await listen(o.port)) && !await listen(0)) throw new Error('the runs’ browser proxy found no port')
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()) }) }
}

export interface RunBrowser {
  /** the browser up, headless, and the Playwright MCP server a run's session gets; outDir = where its own files go */
  mcp(outDir: string): Promise<StdioServer>
  /** the browser again with a window on url, for the person to sign in */
  signIn(url: string): Promise<void>
  /** the window closes; the next run gets the browser headless again */
  signedIn(): Promise<void>
  endpoint(): string | null
  status(): { state: string; reason?: string; signingIn: boolean; allow: string[] | null }
  stop(): Promise<void>
}

export type RunBrowserOpts = Omit<EdgeOptions, 'headless'> & RunBrowserCfg & {
  /** the console's own ports, refused on this PC in every mode */
  deny: number[]
  /** Playwright MCP's cli.js; default: the installed one */
  cli?: string
  /** the browser to launch, asked at each launch so a changed setting applies; wins over exe */
  findExe?: () => string | null
}

export type BrowserKind = 'edge' | 'chrome'
export const BROWSER_KINDS: readonly BrowserKind[] = ['edge', 'chrome']
/** the configured path, else an installed browser of the kind the settings name (Edge by default); null = none */
export function findRunBrowser(kind: BrowserKind = 'edge', path?: string | null): string | null {
  if (path) return path
  if (kind === 'edge') return findEdge()
  const env = process.env
  const paths = process.platform === 'win32'
    ? [env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', ...(env.LOCALAPPDATA ? [env.LOCALAPPDATA] : [])].map((p) => join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
  return paths.find((p) => existsSync(p)) ?? null
}

/** the routes the Sign in button uses: the browser's status, a window on a page to sign in at, and done */
export function runBrowserPlugin(b: RunBrowser | null): Plugin[] {
  if (!b) return []
  return [{
    name: 'run-browser',
    routes: [
      ['GET', /^\/run-browser\/status$/, async () => b.status()],
      ['POST', /^\/run-browser\/signin$/, async (r) => {
        const { url } = await r.body()
        if (typeof url !== 'string' || !url) throw new HttpError(400, 'bad_args', 'sign-in needs a url to sign in at')
        try { await b.signIn(url) } catch (e) { throw new HttpError(409, 'browser_unavailable', (e as Error).message) }
        return b.status()
      }],
      ['POST', /^\/run-browser\/done$/, async () => { await b.signedIn(); return b.status() }],
    ],
    state: () => b.status(),
  }]
}

/** a profile of the runs' own: left alone, Edge signs a fresh profile in to the PC's Microsoft account and syncs that account's
    passwords, history, tabs and extensions (a password manager among them) into it, and the runs' history back out */
const ALONE = ['--disable-sync', '--disable-extensions', '--disable-features=msImplicitSignin,msEdgeAutoSignin']

/** how the live browser was launched, beside its profile: a console that restarts relaunches one that does not match */
type Launch = { proxy: number; headless: boolean }

export function runBrowser(o: RunBrowserOpts): RunBrowser {
  const rec = `${o.dir}.launch.json`
  let proxy: Proxy | null = null, b: Browser | null = null, signingIn = false
  let busy: Promise<unknown> = Promise.resolve()
  /** one change at a time: two runs starting together share one launch */
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = busy.then(f, f); busy = p.catch(() => {}); return p }
  const saved = (): Launch | null => { try { return JSON.parse(readFileSync(rec, 'utf8')) as Launch } catch { return null } }

  const ensureProxy = async () => {
    proxy ??= await startProxy({ allow: o.allow, deny: o.deny, port: saved()?.proxy })
    return proxy
  }
  const launch = async (headless: boolean, url?: string) => {
    const p = await ensureProxy(), want: Launch = { proxy: p.port, headless }, was = saved()
    // a browser left by the console before, launched otherwise, would keep its old proxy or window
    if (!b && (!was || was.proxy !== want.proxy || was.headless !== headless || url)) await closeProfile(o.dir).catch(() => {})
    mkdirSync(dirname(o.dir), { recursive: true })
    writeFileSync(rec, JSON.stringify(want))
    const args = [...(o.args ?? []), `--proxy-server=${p.url}`, '--proxy-bypass-list=<-loopback>', ...ALONE, ...(url ? [url] : [])]
    b = edgeBrowser({ ...o, ...(o.findExe ? { exe: o.findExe() } : {}), args, headless })
    await b.start()
    const s = b.status()
    if (s.state !== 'up') { const why = s.reason ?? s.state; await b.stop(); b = null; throw new Error(`the runs’ browser did not start: ${why}`) }
  }
  const close = async () => {
    if (b) { await b.stop(); b = null }
    if (existsSync(o.dir)) await closeProfile(o.dir).catch(() => {})
  }

  return {
    mcp: (outDir) => serial(async () => {
      if (signingIn) throw new Error('the runs’ browser is open for signing in; finish it and press Done first')
      if (!b || b.status().state !== 'up') { if (b) { await b.stop(); b = null } await launch(true) }
      return browserMcp({ cli: o.cli ?? playwrightCli(), cdp: b!.endpoint()!, outDir })
    }),
    signIn: (url) => serial(async () => {
      let u: URL
      try { u = new URL(url) } catch { throw new Error(`not a url: ${url}`) }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http and https pages, not ${u.protocol}`)
      await close()
      signingIn = true
      try { await launch(false, u.href) } catch (e) { signingIn = false; throw e }
    }),
    signedIn: () => serial(async () => { await close(); signingIn = false }),
    endpoint: () => b?.endpoint() ?? null,
    status: () => ({ ...(b?.status() ?? { state: 'off' }), signingIn, allow: o.allow }),
    stop: () => serial(async () => {
      if (b) { await b.stop(); b = null }
      if (proxy) { await proxy.close(); proxy = null }
    }),
  }
}
