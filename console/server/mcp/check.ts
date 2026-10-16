import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { killTree } from '../llm/cursor/cli.ts'
import { stdioCommand } from '../llm/mcpRun.ts'
import { HttpError } from '../events.ts'
import { literalSecrets, resolveEnv, scrubSecrets } from './env.ts'

/* Check: start an MCP server the way a run would, ask it initialize and tools/list, and stop it, so the person sees its
   tools before granting them, or why it does not start. A small client of the protocol's two transports a workspace
   server uses: stdio (one JSON message a line) and streamable HTTP (a JSON answer or an event stream). */

export type ToolInfo = { name: string; readOnly?: boolean; destructive?: boolean; about?: string }
export type CheckResult = { ok: true; tools: ToolInfo[]; server?: string } | { ok: false; error: string }
/** a first start through npx downloads the package: 80 s measured for a catalog server, a cold install near 3 minutes. Killing npx
    mid-install leaves a broken entry in its cache, after which every start fails at once, so Check waits long */
export const CHECK_WAIT = 300_000
/** the hint for a server npx started that exited: a half-finished install in npx's cache makes every later start fail */
export function npxHint(c: Record<string, unknown>, error: string): string {
  if (!/^npx(\.cmd)?$/i.test(String(c.command ?? '')) || !error.startsWith('the server exited')) return ''
  const pkg = (Array.isArray(c.args) ? c.args.map(String) : []).find((a) => !a.startsWith('-')) ?? 'the package'
  return ` (if it did not get as far as starting, npx's cache may hold a half-finished install of ${pkg}: delete its folder under %LOCALAPPDATA%\\npm-cache\\_npx, or ~/.npm/_npx, and Check again)`
}
const PROTOCOL = '2025-06-18'
const STDERR_MAX = 2048
const PAGES_MAX = 20
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strMap = (v: unknown) => (isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : {})

type Rpc = (method: string, params?: unknown) => Promise<unknown>
type Notify = (method: string) => Promise<void>

/** each tool by name, with its hints: readOnly and destructive as the server marks them, its description's first line */
function toolsOf(xs: unknown[]): ToolInfo[] {
  return xs.filter(isObj).filter((t) => typeof t.name === 'string').map((t) => {
    const a = isObj(t.annotations) ? t.annotations : {}, about = typeof t.description === 'string' ? t.description.split('\n')[0].trim().slice(0, 200) : ''
    return { name: t.name as string, ...(a.readOnlyHint === true ? { readOnly: true } : {}), ...(a.destructiveHint === true ? { destructive: true } : {}), ...(about ? { about } : {}) }
  })
}

async function talk(call: Rpc, notify: Notify): Promise<CheckResult> {
  const init = await call('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'work-console-check', version: '1.0.0' } })
  await notify('notifications/initialized')
  const info = isObj(init) && isObj(init.serverInfo) ? init.serverInfo : null
  const tools: unknown[] = []
  let cursor: string | undefined
  for (let i = 0; i < PAGES_MAX; i++) {
    const r = await call('tools/list', cursor ? { cursor } : {})
    if (isObj(r) && Array.isArray(r.tools)) tools.push(...r.tools)
    cursor = isObj(r) && typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined
    if (!cursor) break
  }
  const server = info && typeof info.name === 'string' ? [info.name, typeof info.version === 'string' ? info.version : ''].filter(Boolean).join(' ') : undefined
  return { ok: true, tools: toolsOf(tools), ...(server ? { server } : {}) }
}

const rpcError = (m: Record<string, unknown>) => {
  const e = isObj(m.error) ? m.error : {}
  return new Error(`${String(e.message ?? 'error')}${e.code !== undefined ? ` (${String(e.code)})` : ''}`)
}

/** a stdio server: spawned with its env over the console's, stopped with its whole tree */
async function stdio(c: Record<string, unknown>, timeoutMs: number, scrub: (t: string) => string): Promise<CheckResult> {
  const args = Array.isArray(c.args) ? c.args.map(String) : []
  const child = spawn(String(c.command), args, { env: { ...process.env, ...strMap(c.env) }, ...(typeof c.cwd === 'string' ? { cwd: c.cwd } : {}), stdio: 'pipe', windowsHide: true })
  let stderr = '', next = 1
  const waiting = new Map<number, { ok(v: unknown): void; no(e: Error): void }>()
  const tail = () => scrub(stderr.trim()).slice(-STDERR_MAX)
  child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b).slice(-STDERR_MAX * 4) })
  child.stdin.on('error', () => { /* the server went; its exit says why */ })
  const ended = new Promise<CheckResult>((res) => {
    child.on('error', (e) => res({ ok: false, error: scrub(`the server did not start: ${e.message}`) }))
    child.on('close', (code) => { const t = tail(); res({ ok: false, error: `the server exited${code == null ? '' : ` with code ${code}`}${t ? `: ${t}` : ''}` }) })
  })
  createInterface({ input: child.stdout }).on('line', (l) => {
    let m: Record<string, unknown>
    try { m = JSON.parse(l) } catch { return }
    const w = typeof m.id === 'number' ? waiting.get(m.id) : undefined
    if (!w) return
    waiting.delete(m.id as number)
    if (m.error) w.no(rpcError(m)); else w.ok(m.result)
  })
  const write = (m: unknown) => { child.stdin.write(`${JSON.stringify(m)}\n`) }
  const call: Rpc = (method, params) => new Promise((ok, no) => { const id = next++; waiting.set(id, { ok, no }); write({ jsonrpc: '2.0', id, method, params }) })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<CheckResult>((res) => { timer = setTimeout(() => res({ ok: false, error: `the server did not answer in ${timeoutMs / 1000} s` }), timeoutMs) })
  try {
    return await Promise.race([talk(call, async (method) => write({ jsonrpc: '2.0', method })).catch((e: Error) => ({ ok: false as const, error: scrub(e.message) })), ended, late])
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) killTree(child.pid)
  }
}

/** a streamable HTTP server: each message a POST; the answer is JSON or an event stream; its session id goes on every later one */
async function http(c: Record<string, unknown>, timeoutMs: number, scrub: (t: string) => string): Promise<CheckResult> {
  const url = String(c.url), headers = strMap(c.headers), ac = new AbortController()
  let session: string | undefined, next = 1
  const post = async (m: Record<string, unknown>) => {
    const r = await fetch(url, { method: 'POST', signal: ac.signal, body: JSON.stringify(m),
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, ...(session ? { 'mcp-session-id': session } : {}) } })
    session = r.headers.get('mcp-session-id') ?? session
    return r
  }
  const call: Rpc = async (method, params) => {
    const id = next++, r = await post({ jsonrpc: '2.0', id, method, params })
    const text = await r.text()
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}${text ? ` ${text.slice(0, 300)}` : ''}`)
    const msgs = (r.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean)
      : [text]
    for (const s of msgs) {
      let m: unknown
      try { m = JSON.parse(s) } catch { continue }
      if (isObj(m) && m.id === id) { if (m.error) throw rpcError(m); return m.result }
    }
    throw new Error(`${method}: no answer in the reply`)
  }
  const notify: Notify = async (method) => { await (await post({ jsonrpc: '2.0', method })).text() }
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try { return await talk(call, notify) } catch (e) {
    return { ok: false, error: ac.signal.aborted ? `the server did not answer in ${timeoutMs / 1000} s` : scrub((e as Error).message) }
  } finally {
    clearTimeout(timer)
    if (session) void fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session } }).catch(() => {})
  }
}

/** one server, started as a run starts it: its ${env:…} put in from vars, its command fit to the platform. Never throws */
export async function checkServer(config: Record<string, unknown>, o: { vars: Record<string, string>; timeoutMs?: number }): Promise<CheckResult> {
  let c: Record<string, unknown>, secrets: string[]
  try { ({ config: c, secrets } = resolveEnv(config, o.vars)) } catch (e) { return { ok: false, error: (e as Error).message } }
  const scrub = (t: string) => scrubSecrets(t, secrets), wait = o.timeoutMs ?? CHECK_WAIT
  const type = c.type ?? (typeof c.command === 'string' ? 'stdio' : undefined)
  if (type === 'stdio' && typeof c.command === 'string') {
    const r = await stdio(stdioCommand(c), wait, scrub)
    return r.ok ? r : { ok: false, error: r.error + npxHint(c, r.error) }
  }
  if (type === 'http' && typeof c.url === 'string') return http(c, wait, scrub)
  if (type === 'sse') return { ok: false, error: 'Check speaks stdio and streamable HTTP, not the older SSE transport; a run may still reach it' }
  return { ok: false, error: 'a server is a command (stdio) or an http url' }
}

/** the server a Check names: name = a catalog mcp pack (with the workspace's settings put in) or a granted server,
    config = one not saved yet. Throws a 404 for an unknown name and a 400 for a body that names neither */
export function checkTarget(b: Record<string, unknown>, o: { mcp: Record<string, unknown>; pack(name: string): Record<string, unknown> | null }): { config: Record<string, unknown>; name?: string } {
  if (typeof b.name === 'string' && b.name) {
    const p = o.pack(b.name)
    if (p) return { config: p, name: b.name }
    const g = o.mcp[b.name]
    if (isObj(g)) return { config: g, name: b.name }
    throw new HttpError(404, 'not_found', `no MCP server or pack ${b.name} here`)
  }
  if (isObj(b.config)) {
    const bad = literalSecrets(b.config)
    if (bad.length) throw new HttpError(400, 'bad_args', bad.join('; '))
    return { config: b.config }
  }
  throw new HttpError(400, 'bad_args', 'send name (a granted server or a pack) or config (a server not saved yet)')
}

let busy = false
/** Checks go one at a time: each may download a package and start a process */
export async function oneCheck(f: () => Promise<CheckResult>): Promise<CheckResult> {
  if (busy) throw new HttpError(409, 'busy', 'another Check is running; try again when it ends')
  busy = true
  try { return await f() } finally { busy = false }
}
