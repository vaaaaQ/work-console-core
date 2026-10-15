import type { Grants } from '../grants.ts'
import type { Applied, Ops } from '../agent/ops.ts'
import type { Source, WsConfig } from '../workspace.ts'
import { packConfig, packKind, renderPack } from '../bridge/packs.ts'
import type { PackManifest } from '../bridge/packs.ts'
import { isLocal } from '../bridge/local.ts'
import type { PackState } from '../bridge/local.ts'
import { HttpError } from '../events.ts'
import { catalog, configGrants } from './packs.ts'
import type { CatalogEntry } from './packs.ts'
import type { PackChange, PackView } from '../../src/model/packs.ts'

/* What Settings, the run prompt and the agent see of a workspace's packs, and the one way Settings changes them. */

export type GrantsLike = { packs: readonly string[]; acts?: readonly string[]; llmActs?: readonly string[]; scopes?: Readonly<Record<string, readonly string[]>> }
export type StatusIn = { loaded: Record<string, string>; states: Record<string, PackState> } | null
const RANK = ['signin_required', 'source_unavailable', 'source_error', 'rate_limited', 'warming_up']

function stateOf(e: CatalogEntry, on: boolean, st: StatusIn): Pick<PackView, 'state' | 'message' | 'host'> {
  if (e.problem) return { state: 'error', message: e.problem }
  if (!on) return { state: 'off' }
  if (!st || packKind(e.manifest!) !== 'browser') return { state: 'on' }
  const loaded = st.loaded[e.name]
  if (loaded && loaded !== 'loaded') return { state: 'error', message: loaded }
  const cs = Object.values(st.states[e.name]?.concepts ?? {})
  if (!cs.length || cs.every((c) => c.status === 'ok')) return { state: cs.length ? 'ok' : 'warming_up' }
  // the worst concept speaks for the pack: a sign-in first, since only the person can fix it
  const bad = cs.filter((c) => c.status !== 'ok').sort((a, b) => (RANK.indexOf(a.status) + 99) % 99 - (RANK.indexOf(b.status) + 99) % 99)[0]
  return { state: bad.status, message: bad.message, ...(bad.host ? { host: bad.host } : {}) }
}

/** an mcp server as one line: its url, or its command with the args */
export function mcpLine(c: Record<string, unknown> | undefined): string {
  if (typeof c?.url === 'string') return c.url
  const args = Array.isArray(c?.args) ? c.args.map(String) : []
  return [typeof c?.command === 'string' ? c.command : '', ...args].filter(Boolean).join(' ')
}

export function packViews(cat: CatalogEntry[], g: GrantsLike, st: StatusIn): PackView[] {
  return cat.map((e, i) => {
    // a workspace copy of a core name is never the one that is on; a granted pack that fails to load is, with state error
    const dup = cat.findIndex((x) => x.name === e.name) !== i
    const m = e.manifest, actions = Object.keys(m?.actions ?? {}), on = !dup && g.packs.includes(e.name)
    const names = st?.states[e.name]?.names ?? {}
    return {
      name: e.name, title: m?.title ?? e.name, kind: m ? packKind(m) : 'browser', about: m?.about ?? '', ...(m?.scopeAbout ? { scopeAbout: m.scopeAbout } : {}),
      listed: e.listed, on, concepts: Object.keys(m?.concepts ?? {}), actions,
      scoped: Object.values(m?.concepts ?? {}).some((c) => !!(c as { scope?: string }).scope),
      scopes: (g.scopes?.[e.name] ?? []).map((id) => (names[id] ? { id, name: names[id] } : { id })),
      acts: actions.filter((a) => (g.acts ?? actions).includes(a)), llmActs: actions.filter((a) => (g.llmActs ?? []).includes(a)),
      ...stateOf(e, on, st), ...(e.problem ? { problem: e.problem } : {}), ...(m && packKind(m) === 'mcp' ? { mcp: mcpLine(m.mcp) } : {}), guide: e.guide,
    }
  })
}

/** a space's views: its grants.json, or its config while unmanaged; the source's state when it is local */
export function viewsFor(s: { packDirs: string[]; grants: Grants | null; cfg: WsConfig; source: Source }): PackView[] {
  const g = s.grants ?? configGrants(s.cfg)
  const st = isLocal(s.source) ? { loaded: s.source.status().packs, states: s.source.packStates() } : null
  return packViews(catalog(s.packDirs), g, st)
}

const uniq = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))]
const bad = (m: string) => new HttpError(400, 'bad_args', m)

/** the hosts a pack's tabs and hosts name, with its settings put in; throws when its settings do not render */
function hostsOrThrow(e: CatalogEntry, cfgs: Record<string, Record<string, unknown>>): string[] {
  if (!e.manifest) return []
  const { config, problems } = packConfig(e.manifest, cfgs[e.name])
  if (problems.length) throw new Error(problems.join('; '))
  const r = renderPack(e.manifest, config)
  return uniq([...Object.values(r.tabs).map((t) => new URL(t.open).hostname), ...r.hosts])
}
/** the same, none when it does not render: a pack off or already granted needs no host to be worked out */
export function packHosts(e: CatalogEntry, cfgs: Record<string, Record<string, unknown>> = {}): string[] {
  try { return hostsOrThrow(e, cfgs) } catch { return [] }
}

/** the grants after one Settings change, and its reason; null when they are already so;
    a workspace pack's hosts are granted with it (a core pack's come with itself) and leave with it unless another granted pack names them */
export function applyPackChange(g: Grants, e: CatalogEntry, ch: PackChange, cat: CatalogEntry[] = [e], cfgs: Record<string, Record<string, unknown>> = {}): { grants: Grants; reason: string } | null {
  // a pack that does not load can still be turned off; its name and scopes go, its acts stay: their names are unknown
  if (!e.manifest && !(ch.on === false && Object.keys(ch).length === 1)) throw bad(`${e.name} did not load: ${e.problem}`)
  const m = e.manifest ?? { actions: {} } as Partial<PackManifest>, name = e.name, mine = Object.keys(m.actions ?? {}), why: string[] = []
  let n: Grants = structuredClone(g)
  const strip = (x: Grants): Grants => {
    const acts = x.acts.filter((a) => !mine.includes(a)), llm = (x.llmActs ?? []).filter((a) => !mine.includes(a))
    const { [name]: _s, ...scopes } = x.scopes ?? {}, { [name]: _m, ...mcp } = x.mcp
    const out: Grants = { ...x, packs: x.packs.filter((p) => p !== name), acts, mcp }
    if (llm.length) out.llmActs = llm; else delete out.llmActs
    if (Object.keys(scopes).length) out.scopes = scopes; else delete out.scopes
    return out
  }
  if (ch.on === true && !n.packs.includes(name)) {
    n = { ...n, packs: [...n.packs, name], acts: uniq([...n.acts, ...mine]) }
    if (packKind(m) === 'mcp') n.mcp = { ...n.mcp, [name]: structuredClone(m.mcp!) }
    if (!e.core) {
      let hs: string[]
      try { hs = hostsOrThrow(e, cfgs) } catch (x) { throw bad(`${name}: fill its settings first (${(x as Error).message})`) }
      n.hosts = uniq([...n.hosts, ...hs])
    }
    why.push(`turn on ${name}`)
  }
  if (ch.on === false && n.packs.includes(name)) {
    n = strip(n)
    if (!e.core) {
      const kept = new Set(cat.filter((x) => x.name !== name && n.packs.includes(x.name)).flatMap((x) => packHosts(x, cfgs)))
      const own = new Set(packHosts(e, cfgs))
      n.hosts = n.hosts.filter((h) => !own.has(h) || kept.has(h))
    }
    why.push(`turn off ${name}`)
  }
  const isOn = n.packs.includes(name)
  if ((ch.scopes || ch.acts || ch.llmActs) && !isOn) throw bad(`turn ${name} on first`)
  if (ch.scopes) {
    const ids = uniq(ch.scopes), { [name]: _, ...rest } = n.scopes ?? {}
    n.scopes = ids.length ? { ...rest, [name]: ids } : rest
    if (!Object.keys(n.scopes).length) delete n.scopes
    why.push(`scopes of ${name}: ${ids.join(', ') || 'none'}`)
  }
  if (ch.acts) {
    for (const a of ch.acts) if (!mine.includes(a)) throw bad(`${a} is not an act of ${name}`)
    n.acts = uniq([...n.acts.filter((a) => !mine.includes(a)), ...ch.acts])
    const llm = (n.llmActs ?? []).filter((a) => n.acts.includes(a))
    if (llm.length) n.llmActs = llm; else delete n.llmActs
    why.push(`acts of ${name}: ${ch.acts.join(', ') || 'none'}`)
  }
  if (ch.llmActs) {
    for (const a of ch.llmActs) if (!mine.includes(a)) throw bad(`${a} is not an act of ${name}`)
    for (const a of ch.llmActs) if (!n.acts.includes(a)) throw bad(`${a}: tick "I can" first`)
    const llm = uniq([...(n.llmActs ?? []).filter((a) => !mine.includes(a)), ...ch.llmActs])
    if (llm.length) n.llmActs = llm; else delete n.llmActs
    why.push(`runs may call of ${name}: ${ch.llmActs.join(', ') || 'none'}`)
  }
  if (JSON.stringify(n) === JSON.stringify(g)) return null
  return { grants: n, reason: `${why.join('; ')} (Settings)` }
}

/** commits the grants the acceptGrants way; the console's restart waits until done() */
export async function settingsWrite(o: { ops: Pick<Ops, 'acceptGrants'>; hold(): () => void }, ws: string, g: Grants, reason: string): Promise<{ applied: Applied; done(): void }> {
  const release = o.hold()
  let released = false
  const done = () => { if (!released) { released = true; release() } }
  try { return { applied: await o.ops.acceptGrants(ws, g, reason), done } } catch (e) { done(); throw e }
}
