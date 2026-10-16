import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Grants } from '../src/model/agent.ts'
import { CONSOLE } from './config.ts'
import { BROWSER, normRunBrowser } from './llm/runBrowser.ts'

/* A workspace with workspaces/<id>/grants.json is managed: its agent edits it, and its runs' tools and MCP servers
   come only from that file, which only an accepted Approvals item writes. Without the file a workspace is as before. */

export type { Grants }
/** browser is absent while off, so a grants.json without it reads and writes as before */
export const EMPTY_GRANTS: Grants = { packs: [], hosts: [], acts: [], runTools: [], mcp: {} }
const LISTS = ['packs', 'hosts', 'acts', 'runTools'] as const

export const grantsPath = (id: string, root = CONSOLE) => join(root, 'workspaces', id, 'grants.json')

/** a full Grants from what a file or a tool gave; throws on an unknown key or a wrong type */
export function normGrants(x: unknown): Grants {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('grants must be an object')
  const o = x as Record<string, unknown>
  for (const k of Object.keys(o)) if (![...LISTS, 'mcp', 'browser', 'scopes', 'llmActs'].includes(k)) throw new Error(`unknown key ${k}`)
  const out: Grants = structuredClone(EMPTY_GRANTS)
  for (const k of LISTS) {
    const v = o[k] ?? []
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s)) throw new Error(`${k} must be a list of names`)
    out[k] = [...new Set(v as string[])]
  }
  const mcp = o.mcp ?? {}
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) throw new Error('mcp must be an object of servers')
  for (const name of ['bridge', 'run', 'agent', BROWSER]) if (Object.hasOwn(mcp, name)) throw new Error(`mcp may not name ${name}`)
  out.mcp = structuredClone(mcp as Record<string, unknown>)
  const browser = normRunBrowser(o.browser)
  if (browser) out.browser = browser
  const scopes = o.scopes ?? {}
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) throw new Error('scopes must be an object of id lists per pack')
  for (const [p, ids] of Object.entries(scopes)) {
    if (!out.packs.includes(p)) throw new Error(`scopes.${p}: ${p} is not a granted pack`)
    if (!names(ids)) throw new Error(`scopes.${p} must be a list of ids`)
    if (ids.length) (out.scopes ??= {})[p] = [...new Set(ids)]
  }
  const llm = o.llmActs ?? []
  if (!names(llm)) throw new Error('llmActs must be a list of names')
  for (const a of llm) if (!out.acts.includes(a)) throw new Error(`llmActs: ${a} is not a granted act`)
  if (llm.length) out.llmActs = [...new Set(llm)]
  return out
}
const names = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && !!s)

/** the workspace's grants; null = unmanaged. A malformed file throws, naming it */
export function grantsOf(id: string, root = CONSOLE): Grants | null {
  const file = grantsPath(id, root)
  if (!existsSync(file)) return null
  try { return normGrants(JSON.parse(readFileSync(file, 'utf8'))) } catch (e) { throw new Error(`workspaces/${id}/grants.json: ${(e as Error).message}`) }
}

export function writeGrants(root: string, id: string, g: Grants) {
  writeFileSync(grantsPath(id, root), JSON.stringify(normGrants(g), null, 2) + '\n')
}

const ONE = { packs: 'pack', hosts: 'host', acts: 'act', runTools: 'runTool' } as const
/** what a change does, one line each: + added, - removed, ~ an MCP server changed; acting = the runTools that change things, marked so */
export function grantsDiff(a: Grants, b: Grants, acting: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  const mark = (k: string, x: string) => (k === 'runTools' && acting.has(x) ? ' (changes things)' : '')
  for (const k of LISTS) {
    for (const x of b[k]) if (!a[k].includes(x)) out.push(`+ ${ONE[k]} ${x}${mark(k, x)}`)
    for (const x of a[k]) if (!b[k].includes(x)) out.push(`- ${ONE[k]} ${x}${mark(k, x)}`)
  }
  for (const n of Object.keys(b.mcp)) {
    if (!Object.hasOwn(a.mcp, n)) out.push(`+ mcp ${n}`)
    else if (JSON.stringify(a.mcp[n]) !== JSON.stringify(b.mcp[n])) out.push(`~ mcp ${n}`)
  }
  for (const n of Object.keys(a.mcp)) if (!Object.hasOwn(b.mcp, n)) out.push(`- mcp ${n}`)
  const ba = a.browser ?? null, bb = b.browser ?? null
  const mode = (x: { allow: string[] | null }) => (x.allow ? `allowlist: ${x.allow.join(', ')}` : 'open: any site')
  if (!ba && bb) out.push(`+ browser ${mode(bb)}`)
  else if (ba && !bb) out.push('- browser')
  else if (ba && bb && mode(ba) !== mode(bb)) out.push(`~ browser ${mode(bb)}`)
  const sa = a.scopes ?? {}, sb = b.scopes ?? {}
  for (const p of [...new Set([...Object.keys(sa), ...Object.keys(sb)])]) {
    for (const x of sb[p] ?? []) if (!(sa[p] ?? []).includes(x)) out.push(`+ scope ${p} ${x}`)
    for (const x of sa[p] ?? []) if (!(sb[p] ?? []).includes(x)) out.push(`- scope ${p} ${x}`)
  }
  const la = a.llmActs ?? [], lb = b.llmActs ?? []
  for (const x of lb) if (!la.includes(x)) out.push(`+ llmAct ${x}`)
  for (const x of la) if (!lb.includes(x)) out.push(`- llmAct ${x}`)
  return out
}

/** a host granted as is, or under a granted *.domain */
export function hostAllowed(hosts: string[], host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return hosts.some((g) => {
    const x = g.toLowerCase()
    return x.startsWith('*.') ? h.endsWith(x.slice(1)) && h.length > x.length - 1 : h === x
  })
}

type Fetch = typeof fetch
/** a plugin's fetch: http(s) to granted hosts only, every redirect hop checked; hosts null = unmanaged, unrestricted */
export function guardedHttp(hosts: string[] | null, f: Fetch = fetch) {
  return async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    if (!hosts) return f(url, init)
    let u = new URL(String(url))
    for (let hop = 0; ; hop++) {
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`host_not_granted: ${u.protocol} is not http`)
      if (!hostAllowed(hosts, u.hostname)) throw new Error(`host_not_granted: ${u.hostname}`)
      const r = await f(u, { ...init, redirect: 'manual' })
      const to = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null
      if (!to || init.redirect === 'manual') return r
      if (hop >= 5) throw new Error('too many redirects')
      u = new URL(to, u)
      // a 303, or a 301/302 after a POST, follows as a GET without a body, as fetch does
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && init.method && init.method.toUpperCase() === 'POST')) init = { ...init, method: 'GET', body: undefined }
    }
  }
}
