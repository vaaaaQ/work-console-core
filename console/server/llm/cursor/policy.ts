import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, canWrite, caseInsensitive, globRe, relPath } from '../../agent/limits.ts'
import type { Limits } from '../../agent/limits.ts'
import { ALLOW, DENY } from '../sdk.ts'

/* What a Cursor session may do, decided here from the same lists as the Claude provider's. Three layers: the CLI's
   own config denies (it matches them case-sensitively, so they only back the rest up), the preToolUse hook for file,
   shell and fetch tools (guard), and the answer to each permission request the CLI sends (permit). */

/** start = a run, ask = a one-shot answer, agent = a workspace agent's turn; own = the tools of the session's own server */
export type Mode =
  | { kind: 'start'; runTools: string[]; bridge: boolean }
  | { kind: 'ask'; own: string[] }
  | { kind: 'agent'; limits: Limits; own: string[] }
/** hidden = folders a session never reads or writes: the console's home and the run's own; rg = the CLI's ripgrep,
    which checks what a search would reach */
export interface Policy { cwd: string; mode: Mode; hidden: string[]; rg?: string }
export const OWN = { start: 'run', ask: 'ask', agent: 'agent' } as const
export type Verdict = { permission: 'deny'; user_message: string; agent_message: string } | Record<string, never>

const HOME = homedir()
const fwd = (p: string) => p.split(sep).join('/').replace(/\\/g, '/')
/** a path with its links resolved, as limits.ts matches it */
const real = (p: string) => fwd(canonical(p) ?? resolve(p))
const rule = (r: string) => { const m = /^([A-Za-z]+)\((.*)\)$/s.exec(r); return m ? { tool: m[1], arg: m[2] } : { tool: r, arg: undefined } }
const rulesOf = (p: Policy, ...tools: string[]) => (p.mode.kind === 'start' ? p.mode.runTools.map(rule).filter((r) => tools.includes(r.tool)) : [])

/** a Claude Code path rule as an absolute glob: ~/ the home, // the root, ** any, else relative to cwd */
export function absGlob(g: string, cwd: string): string {
  if (g.startsWith('~/')) return `${real(HOME)}/${g.slice(2)}`
  if (g.startsWith('//')) return g.slice(1)
  if (g.startsWith('**')) return g
  const rel = g.replace(/^\.?\//, '')
  return isAbsolute(g) && !g.startsWith('/') ? fwd(g) : `${real(cwd)}/${rel}`
}

/** the read denies: DENY's Read rules, the hidden folders and the user's own Cursor folder, each with and without its contents */
export function hiddenGlobs(p: Policy): string[] {
  const reads = DENY.map(rule).filter((r) => r.tool === 'Read' && r.arg).map((r) => absGlob(r.arg!, p.cwd))
  const dirs = [...p.hidden, join(HOME, '.cursor')].map(real)
  return [...reads, ...reads.filter((g) => g.endsWith('/**')).map((g) => g.slice(0, -3)), ...dirs, ...dirs.map((d) => `${d}/**`)]
}
const hiddenRes = new WeakMap<Policy, RegExp[]>()
const hiddenRe = (p: Policy) => { let r = hiddenRes.get(p); if (!r) hiddenRes.set(p, r = hiddenGlobs(p).map((g) => globRe(g, true))); return r }

/** ~ is the run's own home, hidden whole, as the CLI reads it; a file: URL is its path, one it cannot read none */
const TILDE = /^~(?=$|[\\/])/
function absOf(p: Policy, path: string): string | null {
  if (TILDE.test(path)) return null
  let f = path
  if (/^file:/i.test(path)) try { f = fileURLToPath(path) } catch { return null }
  return real(resolve(p.cwd, f))
}
/** folded always: a deny that ignores case only denies more */
const hiddenAbs = (p: Policy, a: string) => hiddenRe(p).some((r) => r.test(a))
export const isHidden = (p: Policy, path: string) => { const a = absOf(p, path); return a === null || hiddenAbs(p, a) }

function pathRule(p: Policy, tools: string[], path: string, unscoped: (a: string) => boolean) {
  const fold = caseInsensitive(p.cwd), a = absOf(p, path)
  if (a === null) return false
  return rulesOf(p, ...tools).some((r) => (r.arg === undefined ? unscoped(a) : globRe(absGlob(r.arg, p.cwd), fold).test(a)))
}
export function canRead(p: Policy, path: string): boolean {
  if (isHidden(p, path)) return false
  if (p.mode.kind === 'agent') return true
  return pathRule(p, ['Read'], path, () => true)
}
/** a run's unscoped Edit or Write reaches its cwd only, as Claude Code's does */
export function canChange(p: Policy, path: string): boolean {
  if (isHidden(p, path)) return false
  if (p.mode.kind === 'agent') return canWrite(p.mode.limits, path)
  return pathRule(p, ['Edit', 'Write', 'MultiEdit'], path, () => relPath(p.cwd, path, caseInsensitive(p.cwd)) !== null)
}
/** Grep and List search a folder: allowed where it is readable and the run has the tool. The CLI's file search (Find)
    is its Grep with no pattern that names files only, so Glob's as much as Grep's */
export function canSearch(p: Policy, tool: 'Grep' | 'List', path: string, find = false): boolean {
  if (isHidden(p, path)) return false
  if (p.mode.kind === 'agent') return true
  return rulesOf(p, ...(tool === 'List' ? ['Glob', 'LS'] : find ? ['Glob', 'Grep'] : ['Grep'])).length > 0
}

const REACH_FILES = 200_000, REACH_MS = 10_000
type Real = { real: string | null; links: Set<string> }
/** a listed file with its links resolved: its folder's once, the file's own only when it is a link itself */
function realFile(dirs: Map<string, Real>, f: string): string | null {
  const dir = dirname(f)
  let d = dirs.get(dir)
  if (!d) {
    let links = new Set<string>()
    try { links = new Set(readdirSync(dir, { withFileTypes: true }).filter((e) => e.isSymbolicLink()).map((e) => e.name)) } catch { /* listed, then gone */ }
    dirs.set(dir, d = { real: canonical(dir), links })
  }
  if (d.real === null || d.links.has(basename(f))) return canonical(f) === null ? null : real(f)
  return fwd(join(d.real, basename(f)))
}
/** why a search from root may not run: the CLI's ripgrep lists the files its Grep or List would read there, links
    followed and ignore files kept as it keeps them, and none may be hidden; null = it may */
export function reach(p: Policy, root: string, glob = ''): Promise<string | null> {
  const rg = p.rg
  if (!rg) return Promise.resolve('no ripgrep to check the search with')
  const target = relative(p.cwd, resolve(p.cwd, root)) || '.'
  return new Promise((done) => {
    const c = spawn(rg, ['--files', '--hidden', '--follow', '--no-config', '--no-messages', '--null', ...(glob ? ['--iglob', glob] : []), '--', target], { cwd: p.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const dirs = new Map<string, Real>()
    let n = 0, rest = '', over = false
    const end = (why: string | null) => { if (over) return; over = true; clearTimeout(timer); if (c.exitCode === null) c.kill(); done(why) }
    const timer = setTimeout(() => end('it holds more than can be checked in time; search a narrower folder'), REACH_MS)
    const ok = (f: string) => {
      if (++n > REACH_FILES) { end('it holds more files than can be checked; search a narrower folder'); return false }
      const a = realFile(dirs, resolve(p.cwd, f))
      if (a === null || hiddenAbs(p, a)) { end('it reaches a folder this session may not read'); return false }
      return true
    }
    c.stdout.setEncoding('utf8')
    c.stdout.on('data', (s: string) => {
      const fs = (rest + s).split('\0')
      rest = fs.pop()!
      for (const f of fs) if (f && !ok(f)) return
    })
    c.on('error', (e) => end(`ripgrep did not start: ${e.message}`))
    c.on('close', () => { if (!rest || ok(rest)) end(null) })
  })
}
/** the CLI's Grep searches only within its folder: a path outside it, by name or by its links, is searched as the folder */
function within(cwd: string, path: string): boolean {
  const r = relative(resolve(cwd), resolve(cwd, path))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r) && relPath(cwd, path, caseInsensitive(cwd)) !== null)
}

const OPS = /[;&|`\n<>]|\$\(/
const wild = (body: string, fold: boolean) => new RegExp(`^${body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, fold ? 'is' : 's')
/** a Bash or PowerShell rule's command: cmd:* a prefix, * a wildcard, else the exact command; a scoped allow never
    matches a command that chains another */
export function shellRule(arg: string | undefined, cmd: string, deny = false): boolean {
  if (arg === undefined) return true
  if (!deny && OPS.test(cmd)) return false
  if (arg.endsWith(':*')) { const pre = arg.slice(0, -2); return cmd === pre || cmd.startsWith(`${pre} `) }
  return arg.includes('*') ? wild(arg, deny).test(cmd) : cmd === arg
}
export function canShell(p: Policy, command: unknown): boolean {
  const cmd = typeof command === 'string' ? command.trim() : ''
  if (!cmd || DENY.map(rule).some((r) => ['Bash', 'PowerShell'].includes(r.tool) && shellRule(r.arg, cmd, true))) return false
  return rulesOf(p, 'Bash', 'PowerShell').some((r) => shellRule(r.arg, cmd))
}
export const anyShell = (p: Policy) => rulesOf(p, 'Bash', 'PowerShell').length > 0

export function canFetch(p: Policy, url: unknown): boolean {
  let host = ''
  try { host = new URL(String(url)).hostname.toLowerCase() } catch { return false }
  return rulesOf(p, 'WebFetch').some((r) => {
    if (r.arg === undefined) return true
    const d = /^domain:(.+)$/.exec(r.arg)?.[1]?.toLowerCase()
    return !!d && (host === d || host.endsWith(`.${d}`))
  })
}
export const canSearchWeb = (p: Policy) => rulesOf(p, 'WebSearch').length > 0

/** a session's MCP tool by its server and name: its own tools, or a run's ALLOW and runTools less DENY */
export function canMcp(p: Policy, server: string, tool: string): boolean {
  const name = `mcp__${server}__${tool}`, of = (xs: string[]) => xs.includes(name) || xs.includes(`mcp__${server}`)
  if (of(DENY)) return false
  if (p.mode.kind !== 'start') return server === OWN[p.mode.kind] && p.mode.own.includes(tool)
  const allow = p.mode.bridge ? ALLOW : ALLOW.filter((t) => !t.startsWith('mcp__bridge__'))
  return of([...allow, ...p.mode.runTools])
}

const str = (x: unknown) => (typeof x === 'string' ? x : '')
function no(p: Policy, what: string, change = false): Verdict {
  const l = p.mode.kind === 'agent' && change ? p.mode.limits : null
  const why = l ? `${what} is not yours to change: only ${l.write.join(', ')}${l.deny.length ? `, less ${l.deny.join(', ')}` : ''}` : `${what} is not allowed in this session`
  return { permission: 'deny', user_message: why, agent_message: why }
}

/** the hook's verdict on a tool call: deny, or no opinion. A tool it does not know that names a path is held to
    the write rule, the strictest */
export async function guard(p: Policy, input: { tool_name?: unknown; tool_input?: unknown }): Promise<Verdict> {
  const name = str(input.tool_name), ti = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>
  const path = str(ti.file_path) || str(ti.path)
  if (name.startsWith('MCP:') || name === 'ListMcpResources') return {}
  switch (name) {
    case 'Read': case 'ReadLints': return path && canRead(p, path) ? {} : no(p, `reading ${path || 'that'}`)
    case 'Grep': case 'List': {
      const root = path || p.cwd, what = `searching ${root}`
      if (!canSearch(p, name, root, name === 'Grep' && !str(ti.pattern) && str(ti.output_mode) === 'files_with_matches')) return no(p, what)
      const roots = name === 'List' || within(p.cwd, root) ? [root] : [root, p.cwd]
      const why = (await Promise.all(roots.map((r) => reach(p, r, name === 'Grep' ? str(ti.glob) : '')))).find((w) => w !== null)
      return why ? no(p, `${what}: ${why}`) : {}
    }
    case 'Write': case 'Delete': return path && canChange(p, path) ? {} : no(p, path || 'that path', true)
    case 'Shell': return canShell(p, ti.command) ? {} : no(p, `the command ${str(ti.command).slice(0, 200)}`)
    case 'WriteShellStdin': return anyShell(p) ? {} : no(p, 'a shell')
    case 'Fetch': return canFetch(p, ti.url) ? {} : no(p, `fetching ${str(ti.url).slice(0, 200)}`)
    case 'FetchMcpResource': case 'ComputerUse': case 'RecordScreen': return no(p, name)
    default: return path && !canChange(p, path) ? no(p, path, true) : {}
  }
}

/** a permission request the CLI sends: the tool call as it shows it, plus the raw input its updates carried */
export interface Asked { title?: string; kind?: string; content?: unknown; rawInput?: Record<string, unknown> }
const unquote = (t: string) => t.replace(/^`|`$/g, '')
export function permit(p: Policy, a: Asked): boolean {
  const title = a.title ?? '', raw = a.rawInput ?? {}
  if (a.kind === 'execute') return canShell(p, str(raw.command) || unquote(title))
  if (a.kind === 'edit' || a.kind === 'delete') {
    const c = Array.isArray(a.content) ? (a.content[0] as { path?: unknown } | undefined) : undefined
    const path = str(c?.path) || str(raw.path) || unquote(/^(?:Write|Delete|Edit) (.+)$/s.exec(title)?.[1] ?? '')
    return !!path && canChange(p, path)
  }
  if (a.kind === 'read') { const path = str(raw.path); return !!path && canRead(p, path) }
  if (a.kind === 'fetch') return str(raw.url) ? canFetch(p, raw.url) : canSearchWeb(p)
  if (a.kind === 'search' && !str(raw.path)) return canSearchWeb(p)
  if (a.kind === 'other') {
    if (str(raw.providerIdentifier) && str(raw.toolName)) return canMcp(p, str(raw.providerIdentifier), str(raw.toolName))
    // "<server>-<tool>: <tool>", the server's name may hold dashes
    const m = /^(.+): (.+)$/s.exec(title)
    if (m && m[1].endsWith(`-${m[2]}`)) return canMcp(p, m[1].slice(0, -m[2].length - 1), m[2])
  }
  return false
}

/** the CLI's own config for the session: allowlist mode, so what no rule allows is asked and permit answers it;
    no model, so the account's own default runs */
export function cliConfig(p: Policy) {
  const mcp = DENY.filter((t) => t.startsWith('mcp__')).map((t) => { const [, s, n] = t.split('__'); return `Mcp(${s}:${n ?? '*'})` })
  const hidden = hiddenGlobs(p).filter((g) => !g.startsWith('**')).flatMap((g) => [`Read(${g})`, `Write(${g})`])
  const m = p.mode, none = (...tools: string[]) => m.kind === 'ask' || (m.kind === 'start' && !rulesOf(p, ...tools).length)
  const wide = [...(none('Read') ? ['Read(*)'] : []), ...(none('Edit', 'Write', 'MultiEdit') ? ['Write(*)'] : []), ...(m.kind === 'agent' || none('Bash', 'PowerShell') ? ['Shell(*)'] : [])]
  return {
    version: 1, editor: { vimMode: false }, approvalMode: 'allowlist',
    permissions: { allow: [] as string[], deny: [...mcp, ...hidden, ...wide] },
    sandbox: { mode: 'disabled' }, attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false }, autoAcceptWebSearch: false,
  }
}
