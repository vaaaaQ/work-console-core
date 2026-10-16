import { existsSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import type { HookCallback, OnElicitation } from '@anthropic-ai/claude-agent-sdk'
import { resolveEnv } from '../mcp/env.ts'

/* A workspace's own MCP servers in a run: started with their ${env:…} put in and a command that starts on Windows, a
   server that did not start said in the feed, its tools kept to what the person ticked, at most ACT_CALLS_MAX calls of
   tools that change things a run, each refusal or failure of one a problem on the step, and a server's question
   (MCP elicitation) put to the person. Claude's and Cursor's sessions both use it. */

export const ACT_CALLS_MAX = 30
/** how long a server's question waits for the person: the catalog's ssh server gives up after 10 minutes, so an answer
    later than that would reach nobody */
export const ELICIT_WAIT = 10 * 60_000

type Env = Record<string, string | undefined>
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** where PATH finds a bare command, with PATHEXT tried as Windows does; null = not found */
function onPath(cmd: string, env: Env): string | null {
  const exts = extname(cmd) ? [''] : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const dirs = isAbsolute(cmd) || /[\\/]/.test(cmd) ? [''] : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  for (const d of dirs) for (const e of exts) {
    const f = d ? join(d, cmd + e) : cmd + e
    if (existsSync(f)) return f
  }
  return null
}

/** a stdio server's config as it starts on this platform: on win32 a .cmd or .bat (npx, for one) cannot be spawned
    without a shell, so it goes through cmd.exe; anything else is as it was */
export function stdioCommand<T extends Record<string, unknown>>(c: T, platform: NodeJS.Platform = process.platform, env: Env = process.env): T {
  if (platform !== 'win32' || typeof c.command !== 'string' || (c.type !== undefined && c.type !== 'stdio')) return c
  const found = onPath(c.command, env)
  if (!found || !/\.(cmd|bat)$/i.test(found)) return c
  const args = Array.isArray(c.args) ? c.args.map(String) : []
  return { ...c, command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', c.command, ...args] }
}

/** a workspace's servers as a run starts them; a server whose values are missing stays out, with a line that names them */
export function startServers(mcp: Record<string, unknown> | undefined, vars: Record<string, string>, platform: NodeJS.Platform = process.platform, env: Env = process.env) {
  const servers: Record<string, Record<string, unknown>> = {}, lines: string[] = [], secrets: string[] = []
  for (const [name, c] of Object.entries(mcp ?? {})) {
    if (!isObj(c)) continue
    try {
      const r = resolveEnv(c, vars)
      servers[name] = stdioCommand(r.config, platform, env)
      secrets.push(...r.secrets)
    } catch (e) { lines.push(`The MCP server ${name} is not started for this run: ${(e as Error).message}`) }
  }
  return { servers, lines, secrets: [...new Set(secrets)] }
}

/** the session's first message names its servers with their state: one line for those that did not connect, null when all did */
export function serverStatusLine(xs: readonly { name: string; status: string }[] | undefined): string | null {
  const bad = (xs ?? []).filter((x) => x.status !== 'connected' && x.status !== 'pending')
  return bad.length ? `MCP servers that did not start: ${bad.map((x) => `${x.name} (${x.status})`).join(', ')}. Their tools are not there for this run.` : null
}

const textOf = (r: unknown): string => {
  if (typeof r === 'string') return r
  const c = isObj(r) && Array.isArray(r.content) ? r.content : Array.isArray(r) ? r : []
  return c.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join(' ') || JSON.stringify(r)
}
const brief = (x: unknown) => JSON.stringify(x ?? {}).slice(0, 300)
const deny = (why: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } })

/** the hooks that keep a run to the workspace servers' ticked tools: servers = the workspace's own, runTools = what grants allow
    (a tool by name, or mcp__<server> for all of it), acting = the tools that change things; problem = a note on the step */
export function mcpGuard(o: { servers: readonly string[]; runTools: readonly string[]; acting: ReadonlySet<string>; max?: number; problem(t: string): Promise<void>; scrub?: (t: string) => string }) {
  const max = o.max ?? ACT_CALLS_MAX, calls: string[] = [], scrub = o.scrub ?? ((t: string) => t)
  const serverOf = (tool: string) => o.servers.find((s) => tool.startsWith(`mcp__${s}__`))
  const say = async (t: string) => { try { await o.problem(scrub(t)) } catch { /* the step is gone; the refusal still holds */ } }
  /** null = the call may go; else why not, already said on the step. A call that goes and changes things is counted */
  const check = async (name: string, input: unknown): Promise<string | null> => {
    const srv = serverOf(name)
    if (!srv) return null
    if (!o.runTools.includes(name) && !o.runTools.includes(`mcp__${srv}`)) {
      const why = 'it is not ticked for this workspace in Packs or Access'
      await say(`Refused ${name} ${brief(input)}: ${why}. Not retried.`)
      return `${why}; do not retry, say in the draft what you needed`
    }
    if (!o.acting.has(name)) return null
    if (calls.length >= max) {
      const why = `this run already called ${max} tools that change things`
      await say(`Refused ${name} ${brief(input)}: ${why}. Not retried.`)
      return `${why}; do not retry`
    }
    calls.push(name)
    return null
  }
  const pre: HookCallback = async (input) => {
    const i = input as { tool_name?: string; tool_input?: unknown }
    const no = await check(i.tool_name ?? '', i.tool_input)
    return no ? deny(no) : {}
  }
  const failed = async (name: string, input: unknown, text: string) => { if (o.acting.has(name)) await say(`Failed ${name} ${brief(input)}: ${text}. Not retried.`) }
  const post: HookCallback = async (input) => {
    const i = input as { tool_name?: string; tool_input?: unknown; tool_response?: unknown }
    if (isObj(i.tool_response) && i.tool_response.isError === true) await failed(i.tool_name ?? '', i.tool_input, textOf(i.tool_response))
    return {}
  }
  const failure: HookCallback = async (input) => {
    const i = input as { tool_name?: string; tool_input?: unknown; error?: string }
    await failed(i.tool_name ?? '', i.tool_input, i.error ?? 'failed')
    return {}
  }
  return {
    hooks: { PreToolUse: [{ hooks: [pre] }], PostToolUse: [{ hooks: [post] }], PostToolUseFailure: [{ hooks: [failure] }] },
    check,
    /** the calls of tools that change things this run made, in order */
    calls: () => [...calls],
  }
}

/** a server's question as the person sees it */
export type ElicitIn = { srv: string; msg: string; schema?: Record<string, unknown>; title?: string; description?: string }
export type ElicitOut = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }

/** answers a server's elicitation: a form goes to the person through ask (none = this run cannot ask), a link is declined;
    no answer in waitMs is a decline, an aborted run a cancel. Every decline the person did not give is a problem */
export function elicitHandler(o: { ask?: (q: ElicitIn, signal: AbortSignal) => Promise<ElicitOut>; problem(t: string): Promise<void>; waitMs?: number }): OnElicitation {
  return async (r, { signal }) => {
    const say = async (t: string) => { try { await o.problem(t) } catch { /* the step is gone */ } }
    if (r.mode === 'url') { await say(`The MCP server ${r.serverName} asks to open a link (${r.url ?? 'no url'}); that is not supported yet. Declined.`); return { action: 'decline' } }
    if (!o.ask) { await say(`The MCP server ${r.serverName} asked for a confirmation this run cannot ask the person for: ${r.message} Declined.`); return { action: 'decline' } }
    const q: ElicitIn = {
      srv: r.serverName, msg: r.message,
      ...(r.requestedSchema ? { schema: r.requestedSchema } : {}), ...(r.title ? { title: r.title } : {}), ...(r.description ? { description: r.description } : {}),
    }
    const ac = new AbortController(), stop = () => ac.abort()
    signal.addEventListener('abort', stop)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((res) => { timer = setTimeout(() => { res('late'); ac.abort() }, o.waitMs ?? ELICIT_WAIT) })
    try {
      const a = await Promise.race([o.ask(q, ac.signal), late])
      if (a === 'late') { await say(`No answer in time to the MCP server ${r.serverName}: ${r.message} Declined.`); return { action: 'decline' } }
      return a
    } catch {
      if (signal.aborted) return { action: 'cancel' }
      return { action: 'decline' }
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop) }
  }
}

/** what is wrong with an answer to a server's form: MCP keeps its schema flat (string, number, integer, boolean, an enum,
    a list of strings), so each field is checked on its own; empty when it fits */
export function elicitProblems(schema: Record<string, unknown> | undefined, content: Record<string, unknown>): string[] {
  const props = isObj(schema?.properties) ? schema!.properties as Record<string, Record<string, unknown>> : {}
  const req = Array.isArray(schema?.required) ? schema!.required as string[] : []
  const out: string[] = []
  for (const k of req) if (content[k] === undefined) out.push(`${k} is required`)
  for (const [k, v] of Object.entries(content)) {
    const p = props[k]
    if (!p) { out.push(`${k} is not asked for`); continue }
    const en = Array.isArray(p.enum) ? p.enum : null
    if (p.type === 'boolean' && typeof v !== 'boolean') out.push(`${k} is not true or false`)
    else if (p.type === 'integer' && !Number.isInteger(v)) out.push(`${k} is not an integer`)
    else if (p.type === 'number' && typeof v !== 'number') out.push(`${k} is not a number`)
    else if (p.type === 'string' && typeof v !== 'string') out.push(`${k} is not text`)
    else if (p.type === 'array' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) out.push(`${k} is not a list of strings`)
    else if (en && p.type !== 'array' && !en.includes(v)) out.push(`${k} is not one of ${en.join(', ')}`)
  }
  return out
}
