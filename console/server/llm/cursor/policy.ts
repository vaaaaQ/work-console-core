import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
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
/** hidden = folders a session never reads or writes: the console's home and the run's own */
export interface Policy { cwd: string; mode: Mode; hidden: string[] }
export const OWN = { start: 'run', ask: 'ask', agent: 'agent' } as const
export type Verdict = { permission: 'deny'; user_message: string; agent_message: string } | Record<string, never>

const HOME = homedir()
const fwd = (p: string) => p.split(sep).join('/').replace(/\\/g, '/')
const rule = (r: string) => { const m = /^([A-Za-z]+)\((.*)\)$/s.exec(r); return m ? { tool: m[1], arg: m[2] } : { tool: r, arg: undefined } }
const rulesOf = (p: Policy, ...tools: string[]) => (p.mode.kind === 'start' ? p.mode.runTools.map(rule).filter((r) => tools.includes(r.tool)) : [])

/** a Claude Code path rule as an absolute glob: ~/ the home, // the root, ** any, else relative to cwd */
export function absGlob(g: string, cwd: string): string {
  if (g.startsWith('~/')) return `${fwd(HOME)}/${g.slice(2)}`
  if (g.startsWith('//')) return g.slice(1)
  if (g.startsWith('**')) return g
  const rel = g.replace(/^\.?\//, '')
  return isAbsolute(g) && !g.startsWith('/') ? fwd(g) : `${fwd(cwd)}/${rel}`
}

/** the read denies: DENY's Read rules, the hidden folders and the user's own Cursor folder, each with and without its contents */
export function hiddenGlobs(p: Policy): string[] {
  const reads = DENY.map(rule).filter((r) => r.tool === 'Read' && r.arg).map((r) => absGlob(r.arg!, p.cwd))
  const dirs = [...p.hidden, `${HOME}/.cursor`].map((d) => fwd(resolve(d)))
  return [...reads, ...reads.filter((g) => g.endsWith('/**')).map((g) => g.slice(0, -3)), ...dirs, ...dirs.map((d) => `${d}/**`)]
}

const absOf = (p: Policy, path: string) => fwd(canonical(resolve(p.cwd, path)) ?? resolve(p.cwd, path))
/** folded always: a deny that ignores case only denies more */
export const isHidden = (p: Policy, path: string) => { const a = absOf(p, path); return hiddenGlobs(p).some((g) => globRe(g, true).test(a)) }

function pathRule(p: Policy, tools: string[], path: string, unscoped: (a: string) => boolean) {
  const fold = caseInsensitive(p.cwd), a = absOf(p, path)
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
/** Grep and List search a folder: allowed where it is readable and the run has the tool */
export function canSearch(p: Policy, tool: 'Grep' | 'List', path: string): boolean {
  if (isHidden(p, path)) return false
  if (p.mode.kind === 'agent') return true
  return rulesOf(p, ...(tool === 'Grep' ? ['Grep'] : ['Glob', 'LS'])).length > 0
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
export function guard(p: Policy, input: { tool_name?: unknown; tool_input?: unknown }): Verdict {
  const name = str(input.tool_name), ti = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>
  const path = str(ti.file_path) || str(ti.path)
  if (name.startsWith('MCP:') || name === 'ListMcpResources') return {}
  switch (name) {
    case 'Read': case 'ReadLints': return path && canRead(p, path) ? {} : no(p, `reading ${path || 'that'}`)
    case 'Grep': case 'List': return canSearch(p, name, path || p.cwd) ? {} : no(p, `searching ${path || p.cwd}`)
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
