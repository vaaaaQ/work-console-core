import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AccessAdd, AccessChange, AccessRequest } from '../src/model/access.ts'
import { grantsDiff, normGrants } from './grants.ts'
import type { Grants } from './grants.ts'
import { HttpError } from './events.ts'
import { applyPackChange } from './browser/catalogView.ts'
import type { CatalogEntry } from './browser/packs.ts'

/* Settings → Access: hosts, runTools, MCP servers and the runs' browser, each change one grants.json commit as in Packs.
   A run that misses one of these asks with request_access; its request waits in a file until the person decides. */

export type { AccessAdd, AccessChange, AccessRequest }
const bad = (m: string) => new HttpError(400, 'bad_args', m)
const uniq = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))]
const names = (v: unknown, k: string): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw bad(`${k} is a list of names`)
  return uniq(v)
}

/** a Settings body as an AccessChange; throws a 400 on a wrong shape */
export function accessChangeIn(b: Record<string, unknown>): AccessChange {
  const ch: AccessChange = {}
  if (b.hosts !== undefined) ch.hosts = names(b.hosts, 'hosts')
  if (b.runTools !== undefined) ch.runTools = names(b.runTools, 'runTools')
  if (b.mcp !== undefined) {
    if (!b.mcp || typeof b.mcp !== 'object' || Array.isArray(b.mcp)) throw bad('mcp is an object of servers by name')
    for (const [n, c] of Object.entries(b.mcp)) if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad(`mcp ${n} must be an object (command and args, or url)`)
    ch.mcp = b.mcp as Record<string, unknown>
  }
  if (b.browser !== undefined) {
    const x = b.browser as { allow?: unknown } | null
    if (x === null) ch.browser = null
    else if (typeof x === 'object' && !Array.isArray(x) && (x.allow === null || Array.isArray(x.allow))) ch.browser = { allow: x.allow === null ? null : names(x.allow, 'browser.allow') }
    else throw bad('browser is null, {allow: null} or {allow: hosts}')
  }
  if (!Object.keys(ch).length) throw bad('send hosts, runTools, mcp or browser')
  return ch
}

/** the grants after a Settings change, and its reason; null when they are already so. A pack's MCP server stays as the pack set it */
export function applyAccessChange(g: Grants, ch: AccessChange): { grants: Grants; reason: string } | null {
  const n: Grants = structuredClone(g)
  if (ch.hosts) n.hosts = ch.hosts
  if (ch.runTools) n.runTools = ch.runTools
  if (ch.mcp) {
    for (const p of g.packs) {
      const had = Object.hasOwn(g.mcp, p), has = Object.hasOwn(ch.mcp, p)
      if ((had || has) && (had !== has || JSON.stringify(g.mcp[p]) !== JSON.stringify(ch.mcp[p]))) throw bad(`mcp ${p} belongs to the pack ${p}: turn it off in Packs instead`)
    }
    n.mcp = structuredClone(ch.mcp)
  }
  if (ch.browser !== undefined) { if (ch.browser) n.browser = ch.browser; else delete n.browser }
  let out: Grants
  try { out = normGrants(n) } catch (e) { throw bad((e as Error).message) }
  const lines = grantsDiff(g, out)
  return lines.length ? { grants: out, reason: `${lines.join('; ')} (Settings)` } : null
}

/** a run's ask as an AccessAdd; throws on a wrong shape or an empty one */
export function accessAddIn(x: unknown): AccessAdd {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('add must be an object')
  const o = x as Record<string, unknown>, out: AccessAdd = {}
  for (const k of Object.keys(o)) if (!['packs', 'hosts', 'runTools', 'browser'].includes(k)) throw new Error(`add.${k}: a run may ask only for packs, hosts, runTools or browser`)
  for (const k of ['packs', 'hosts', 'runTools', 'browser'] as const) {
    if (o[k] === undefined) continue
    const v = o[k]
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new Error(`add.${k} must be a list of names`)
    const u = uniq(v as string[]).sort()
    if (u.length) out[k] = u
  }
  if (!Object.keys(out).length) throw new Error('add names nothing')
  return out
}

/** the grants with a request's additions: each pack turned on as Settings would; null when they already hold it all */
export function applyAdd(g: Grants, add: AccessAdd, cat: CatalogEntry[], cfgs: Record<string, Record<string, unknown>> = {}): Grants | null {
  let n: Grants = structuredClone(g)
  for (const p of add.packs ?? []) {
    const e = cat.find((x) => x.name === p)
    if (!e) throw bad(`no pack ${p} in this workspace's catalog`)
    n = applyPackChange(n, e, { on: true }, cat, cfgs)?.grants ?? n
  }
  n.hosts = uniq([...n.hosts, ...(add.hosts ?? [])])
  n.runTools = uniq([...n.runTools, ...(add.runTools ?? [])])
  // an open browser already reaches every site; an allowlist grows; an off one starts as just these
  if (add.browser?.length && (!n.browser || n.browser.allow)) n.browser = { allow: uniq([...(n.browser?.allow ?? []), ...add.browser]) }
  let out: Grants
  try { out = normGrants(n) } catch (e) { throw bad((e as Error).message) }
  return JSON.stringify(out) === JSON.stringify(normGrants(g)) ? null : out
}

/** what a request adds, one line each, as the grants' own diff says it */
export function addLines(g: Grants, add: AccessAdd, cat: CatalogEntry[], cfgs?: Record<string, Record<string, unknown>>): string[] {
  try { const n = applyAdd(g, add, cat, cfgs); return n ? grantsDiff(g, n) : [] } catch (e) { return [`! ${(e as Error).message}`] }
}

const MAX = 20
/** a workspace's waiting requests, in one JSON file; the same add from another step joins the one already waiting */
export function accessRequests(file: string, onChange: (upserts: AccessRequest[], removes: string[]) => void = () => {}) {
  const read = (): AccessRequest[] => {
    if (!existsSync(file)) return []
    try { const v = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(v) ? v : [] } catch { return [] }
  }
  const write = (xs: AccessRequest[], upserts: AccessRequest[], removes: string[]) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(xs, null, 2) + '\n')
    renameSync(tmp, file)
    onChange(upserts, removes)
  }
  return {
    list: read,
    get: (id: string) => read().find((x) => x.id === id) ?? null,
    /** the request's id: a new one, or the waiting one with the same add */
    add(add: AccessAdd, reason: string, by: string, lines: string[]): string {
      const xs = read(), key = JSON.stringify(add), same = xs.find((x) => JSON.stringify(x.add) === key)
      if (same) {
        if (!same.by.includes(by)) { same.by.push(by); write(xs, [same], []) }
        return same.id
      }
      if (xs.length >= MAX) throw new Error(`${MAX} requests already wait for the person; ask in the draft instead`)
      const r: AccessRequest = { id: randomUUID(), add, reason, by: [by], at: new Date().toISOString(), lines }
      write([...xs, r], [r], [])
      return r.id
    },
    remove(id: string) {
      const xs = read(), left = xs.filter((x) => x.id !== id)
      if (left.length !== xs.length) write(left, [], [id])
    },
  }
}
export type AccessRequests = ReturnType<typeof accessRequests>
