import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

/* The console's own Edge: one profile dir, a free debugging port read from DevToolsActivePort, reattached after a
   console restart, watched and relaunched when it closes. Stop closes an Edge it launched; nothing outside its profile is touched. */

export type BrowserStatus = { state: 'off' | 'starting' | 'up' | 'unavailable'; reason?: string }
export interface Browser {
  endpoint(): string | null
  status(): BrowserStatus
  start(): Promise<void>
  stop(): Promise<void>
  onChange(f: (s: BrowserStatus) => void): () => void
}
export type EdgeOptions = {
  dir: string
  /** undefined: find an installed Edge; null: there is none */
  exe?: string | null
  args?: string[]
  headless?: boolean
  /** a reason when a policy blocks remote debugging, else null */
  policy?: () => Promise<string | null>
  probeMs?: number
  portWaitMs?: number
  /** how long stop waits for Edge to close itself before ending its processes */
  closeMs?: number
  env?: NodeJS.ProcessEnv
}

const MISSES = 3, MAX_RESTARTS = 3, WINDOW = 10 * 60_000, PROBE_TIMEOUT = 5000
const SECRET = new Set(['SECRET', 'TOKEN', 'PAT', 'PASSWORD', 'PWD', 'KEY', 'CONNECTION', 'CREDENTIAL'])
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

/** the given path, else an installed Edge; null = none */
export function findEdge(path?: string | null): string | null {
  if (path) return path
  const env = process.env
  const paths = process.platform === 'win32'
    ? [env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', env.ProgramFiles ?? 'C:\\Program Files'].map((p) => join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    : process.platform === 'darwin' ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
  return paths.find((p) => existsSync(p)) ?? null
}

/** true when `reg query` output sets RemoteDebuggingAllowed to 0 */
export function parsePolicy(out: string): boolean {
  return /RemoteDebuggingAllowed\s+REG_DWORD\s+0x0+\s*$/im.test(out)
}

/** the Edge policy that blocks remote debugging, machine or user, as a reason; null when none does */
export async function edgePolicy(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  for (const hive of ['HKLM', 'HKCU']) {
    const out = await new Promise<string>((ok) => execFile('reg', ['query', `${hive}\\SOFTWARE\\Policies\\Microsoft\\Edge`, '/v', 'RemoteDebuggingAllowed'], { windowsHide: true }, (_e, so) => ok(String(so ?? ''))))
    if (parsePolicy(out)) return `remote debugging is turned off by the Edge policy RemoteDebuggingAllowed (${hive})`
  }
  return null
}

/** the environment without anything that looks like a secret */
function scrub(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    const u = k.toUpperCase()
    if (u.startsWith('AZURE_') || u.split('_').some((p) => SECRET.has(p))) continue
    out[k] = v
  }
  return out
}

async function probe(endpoint: string): Promise<boolean> {
  try { return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) })).ok } catch { return false }
}

/** true when a process command line runs on exactly this profile dir */
export function holdsProfile(cmd: string, dir: string, win = process.platform === 'win32'): boolean {
  const norm = (s: string) => (win ? s.toLowerCase().replace(/\//g, '\\') : s)
  const c = norm(cmd), d = norm(dir), flag = '--user-data-dir='
  for (let i = c.indexOf(flag); i >= 0; i = c.indexOf(flag, i + 1)) {
    const v = c.slice(i + flag.length).replace(/^"/, '')
    if (v.startsWith(d) && /^(["\s]|$)/.test(v.slice(d.length))) return true
  }
  return false
}

/** true while a browser holds the profile: Edge's lock file on Windows, its singleton link elsewhere */
const held = (dir: string) => ['lockfile', 'SingletonLock'].some((f) => { try { lstatSync(join(dir, f)); return true } catch { return false } })

/** asks the browser to close itself, which writes the profile out; true once its port is gone and the profile let go */
async function closeBrowser(endpoint: string, dir: string, ms: number): Promise<boolean> {
  try {
    const v = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) })).json() as { webSocketDebuggerUrl?: string }
    if (!v.webSocketDebuggerUrl) return false
    await new Promise<void>((ok) => {
      const ws = new WebSocket(v.webSocketDebuggerUrl!)
      const done = () => { clearTimeout(t); try { ws.close() } catch { /* closed */ } ok() }
      const t = setTimeout(done, ms)
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      ws.onmessage = done; ws.onclose = done; ws.onerror = done
    })
  } catch { return false }
  const end = Date.now() + ms
  while (Date.now() < end) { if (!held(dir) && !await probe(endpoint)) return true; await sleep(100) }
  return false
}

/** ends every process on this profile dir: Edge restarts itself under a new pid, so the spawned one may be gone */
async function killProfile(dir: string): Promise<void> {
  const win = process.platform === 'win32'
  const [cmd, args] = win
    ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }']]
    : ['ps', ['-eo', 'pid=,args=']]
  const out = await new Promise<string>((ok) => execFile(cmd, args, { windowsHide: true, maxBuffer: 64 << 20 }, (_e, so) => ok(String(so ?? ''))))
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m || Number(m[1]) === process.pid || !holdsProfile(m[2], dir, win)) continue
    try { process.kill(Number(m[1]), 'SIGKILL') } catch { /* already gone */ }
  }
}

function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve()
  const pid = child.pid
  if (process.platform === 'win32') return new Promise((ok) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => ok()))
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } }
  return Promise.resolve()
}

export function edgeBrowser(o: EdgeOptions): Browser {
  const dir = resolve(o.dir), portFile = join(dir, 'DevToolsActivePort')
  const probeMs = o.probeMs ?? 10_000, portWaitMs = o.portWaitMs ?? 20_000, closeMs = o.closeMs ?? 5000
  let st: BrowserStatus = { state: 'off' }, ep: string | null = null, child: ChildProcess | null = null, ours = false
  let starting: Promise<void> | null = null, watching = false, timer: NodeJS.Timeout | undefined
  let misses = 0, launches: number[] = []
  const subs = new Set<(s: BrowserStatus) => void>()

  const set = (state: BrowserStatus['state'], reason?: string) => {
    if (st.state === state && st.reason === reason) return
    st = reason === undefined ? { state } : { state, reason }
    for (const f of subs) f(st)
  }
  const readPort = (): string | null => {
    try {
      const port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim()
      return /^\d+$/.test(port) ? `http://127.0.0.1:${port}` : null
    } catch { return null }
  }

  /** spawns Edge and waits for its port; false (the process ended) when none answers in time */
  const launch = async (): Promise<boolean> => {
    if (child) await kill(child)
    mkdirSync(dir, { recursive: true })
    try { unlinkSync(portFile) } catch { /* none */ }
    const args = [...(o.args ?? []), `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', ...(o.headless ? ['--headless=new'] : []), 'about:blank']
    const c = spawn(o.exe as string, args, { env: scrub(o.env ?? process.env), detached: true, stdio: 'ignore', windowsHide: false })
    c.on('error', () => {})
    c.unref()
    child = c
    const end = Date.now() + portWaitMs
    while (Date.now() < end) {
      const e = readPort()
      if (e && await probe(e)) { ep = e; ours = true; return true }
      await sleep(50)
    }
    await kill(c)
    await killProfile(dir)
    if (child === c) child = null
    ep = null
    return false
  }

  const tick = async () => {
    if (!watching) return
    const ok = ep !== null && await probe(ep)
    if (!watching) return
    if (ok) {
      misses = 0
      if (launches.length && Date.now() - launches[launches.length - 1] > WINDOW) launches = []
      set('up')
    } else if (++misses >= MISSES) {
      misses = 0
      launches = launches.filter((t) => Date.now() - t < WINDOW)
      if (launches.length >= MAX_RESTARTS) {
        watching = false; ep = null
        set('unavailable', `Edge closed ${MAX_RESTARTS} times within 10 minutes; start it again from the console`)
        return
      }
      launches.push(Date.now())
      set('starting', 'Edge closed; starting it again')
      if (await launch() && watching) set('up')
    }
    if (watching) timer = setTimeout(tick, probeMs)
  }
  const watch = () => { watching = true; misses = 0; clearTimeout(timer); timer = setTimeout(tick, probeMs) }

  const run = async () => {
    const exe = o.exe === undefined ? findEdge() : o.exe
    if (!exe) return set('unavailable', 'no Edge found; install Microsoft Edge or set its path in the console settings')
    o = { ...o, exe }
    const blocked = await (o.policy ?? edgePolicy)()
    if (blocked) return set('unavailable', blocked)
    set('starting')
    const live = readPort()
    if (live && await probe(live)) { ep = live; ours = false; set('up'); return watch() }
    launches = []
    if (!await launch()) return set('unavailable', 'Edge opened no debugging port; a policy may block remote debugging')
    set('up')
    watch()
  }

  return {
    endpoint: () => (st.state === 'up' ? ep : null),
    status: () => st,
    onChange: (f) => { subs.add(f); return () => { subs.delete(f) } },
    start() {
      if (st.state === 'up') return Promise.resolve()
      starting ??= run().finally(() => { starting = null })
      return starting
    },
    async stop() {
      if (starting) await starting.catch(() => {})
      watching = false; clearTimeout(timer)
      if (ours && ep && !await closeBrowser(ep, dir, closeMs)) await killProfile(dir)
      if (child) await kill(child)
      child = null; ep = null; ours = false
      set('off')
    },
  }
}

const shared = new Map<string, { browser: Browser; users: Set<object> }>()

/** one browser per profile dir in this process; the last user's stop stops it */
export function sharedBrowser(dir: string, make: () => Browser): Browser {
  const key = process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir)
  const me = {}
  const entry = () => {
    let e = shared.get(key)
    if (!e) { e = { browser: make(), users: new Set() }; shared.set(key, e) }
    return e
  }
  const current = () => shared.get(key)?.browser
  return {
    endpoint: () => current()?.endpoint() ?? null,
    status: () => current()?.status() ?? { state: 'off' },
    onChange: (f) => entry().browser.onChange(f),
    async start() {
      const e = entry()
      e.users.add(me)
      const s = e.browser.status().state
      if (s !== 'up' && s !== 'starting') await e.browser.start()
    },
    async stop() {
      const e = shared.get(key)
      if (!e || !e.users.delete(me) || e.users.size) return
      shared.delete(key)
      await e.browser.stop()
    },
  }
}
