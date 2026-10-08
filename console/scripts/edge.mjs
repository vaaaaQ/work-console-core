import { execFile } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/* The console's own Edge seen from its profile dir: which port it debugs on, whether it holds the profile, and
   closing it so it writes the profile out. The server's launcher and run.mjs --stop share these. */

const PROBE_TIMEOUT = 5000
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

export const edgeProfile = (home) => join(home, 'browser')

export async function probe(endpoint) {
  try { return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) })).ok } catch { return false }
}

export function profileEndpoint(dir) {
  try {
    const port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0].trim()
    return /^\d+$/.test(port) ? `http://127.0.0.1:${port}` : null
  } catch { return null }
}

export function holdsProfile(cmd, dir, win = process.platform === 'win32') {
  const norm = (s) => (win ? s.toLowerCase().replace(/\//g, '\\') : s)
  const c = norm(cmd), d = norm(dir), flag = '--user-data-dir='
  for (let i = c.indexOf(flag); i >= 0; i = c.indexOf(flag, i + 1)) {
    const v = c.slice(i + flag.length).replace(/^"/, '')
    if (v.startsWith(d) && /^(["\s]|$)/.test(v.slice(d.length))) return true
  }
  return false
}

export const profileHeld = (dir) => ['lockfile', 'SingletonLock'].some((f) => { try { lstatSync(join(dir, f)); return true } catch { return false } })

export async function closeEdge(endpoint, dir, ms) {
  try {
    const v = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) })).json()
    if (!v.webSocketDebuggerUrl) return false
    await new Promise((ok) => {
      const ws = new WebSocket(v.webSocketDebuggerUrl)
      const done = () => { clearTimeout(t); try { ws.close() } catch { /* closed */ } ok() }
      const t = setTimeout(done, ms)
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      ws.onmessage = done; ws.onclose = done; ws.onerror = done
    })
  } catch { return false }
  const end = Date.now() + ms
  while (Date.now() < end) { if (!profileHeld(dir) && !await probe(endpoint)) return true; await sleep(100) }
  return false
}

export async function killProfile(dir) {
  const win = process.platform === 'win32'
  const [cmd, args] = win
    ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }']]
    : ['ps', ['-eo', 'pid=,args=']]
  const out = await new Promise((ok) => execFile(cmd, args, { windowsHide: true, maxBuffer: 64 << 20 }, (_e, so) => ok(String(so ?? ''))))
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m || Number(m[1]) === process.pid || !holdsProfile(m[2], dir, win)) continue
    try { process.kill(Number(m[1]), 'SIGKILL') } catch { /* already gone */ }
  }
}

export async function closeProfile(dir, ms = 5000) {
  const ep = profileEndpoint(dir)
  const up = ep !== null && await probe(ep)
  if (up && await closeEdge(ep, dir, ms)) return true
  if (!up && !profileHeld(dir)) return false
  await killProfile(dir)
  return true
}
