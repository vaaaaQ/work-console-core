import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONSOLE } from '../config.ts'
import type { WsConfig } from '../workspace.ts'
import { PACKS_DIR, packConfig, packKind, readPack, renderPack } from '../bridge/packs.ts'
import type { PackConfig, PackManifest } from '../bridge/packs.ts'
import { SCHEMAS_DIR, validator } from './schema.ts'

/* Which packs a workspace runs, with what settings, onto which hosts: the grants, and the packs loaded under them. */

export { PACKS_DIR }
const NAME = /^[a-z][a-z0-9-]{0,40}$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** hosts: a core pack's own come with it, so these are the hosts outside the core packs;
    acts: the actions a person may run here; absent = every action a granted pack declares;
    scopes: the ids each scoped pack serves; a scoped pack absent from it serves none */
export type PackGrants = { packs: string[]; hosts: string[]; config: Record<string, Record<string, unknown>>; acts?: string[]; scopes?: Record<string, string[]> }
export type GrantsFn = (cfg: WsConfig) => PackGrants

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** the grants from the workspace config: packs, hosts, packConfig.<pack>, acts and scopes */
export const configGrants: GrantsFn = (cfg) => {
  const pc = cfg.packConfig
  const g: PackGrants = { packs: strings(cfg.packs), hosts: strings(cfg.hosts), config: isObj(pc) ? pc as PackGrants['config'] : {} }
  if (Array.isArray(cfg.acts)) g.acts = strings(cfg.acts)
  if (isObj(cfg.scopes)) g.scopes = Object.fromEntries(Object.entries(cfg.scopes).map(([p, ids]) => [p, strings(ids)]))
  return g
}

/** a managed workspace's: packs, hosts, acts and scopes from its grants.json, each pack's settings from its config */
export const grantsFrom = (g: { packs: readonly string[]; hosts: readonly string[]; acts: readonly string[]; scopes?: Readonly<Record<string, readonly string[]>> }): GrantsFn =>
  (cfg) => ({
    packs: [...g.packs], hosts: [...g.hosts], acts: [...g.acts], config: configGrants(cfg).config,
    ...(g.scopes ? { scopes: Object.fromEntries(Object.entries(g.scopes).map(([p, ids]) => [p, [...ids]])) } : {}),
  })

export type LoadedPack = {
  name: string; zone: string; script: string; config: PackConfig
  /** from the core packs folder: its hosts come with it; a workspace pack's need grants.hosts */
  core: boolean
  tabs: Record<string, { match: RegExp; open: string; host: string }>
  hosts: string[]
  concepts: Record<string, { tab: string; interval: number; cap: number; scope?: string }>
  actions: Record<string, { tab: string; concept: string; scope?: string }>
}

export type CatalogEntry = { name: string; dir: string; manifest: PackManifest | null; guide: string; listed: boolean; core: boolean; problem?: string }
const dirList = (d: string | readonly string[]) => (typeof d === 'string' ? [d] : [...d])
/** the core packs, then a workspace's own: where the catalog is read */
export const wsPackDirs = (ws: string, root = CONSOLE): string[] => [PACKS_DIR, join(root, 'workspaces', ws, 'packs')]

/** every pack in dirs, in order (core = the first dir's); a name already taken by an earlier dir is a problem, never a shadow */
export function catalog(dirs: string | readonly string[], schemas = SCHEMAS_DIR): CatalogEntry[] {
  const out: CatalogEntry[] = [], seen = new Map<string, string>(), has = validator(schemas).has
  for (const [i, root] of dirList(dirs).entries()) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name), bad = (problem: string) => out.push({ name, dir, manifest: null, guide: '', listed: true, core: i === 0, problem })
      if (!existsSync(join(dir, 'pack.json'))) continue
      const first = seen.get(name)
      if (first !== undefined) { bad(`${name} is already a pack in ${first}; rename this one`); continue }
      seen.set(name, root)
      if (!NAME.test(name)) { bad('not a pack name'); continue }
      try {
        const m = readPack(dir, has)
        if (m.name !== name) throw new Error(`pack.json names ${m.name}, not ${name}`)
        out.push({ name, dir, manifest: m, guide: m.guide ? readFileSync(join(dir, m.guide), 'utf8') : '', listed: m.catalog !== false, core: i === 0 })
      } catch (e) { bad((e as Error).message) }
    }
  }
  return out
}

function loadOne(e: CatalogEntry & { manifest: PackManifest }, g: PackGrants): LoadedPack {
  const m = e.manifest, name = e.name
  const { config, problems } = packConfig(m, g.config[name])
  if (problems.length) throw new Error(problems.join('; '))
  const r = renderPack(m, config), tabs: LoadedPack['tabs'] = {}
  for (const [t, spec] of Object.entries(r.tabs)) {
    const u = new URL(spec.open)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw new Error(`tabs.${t}.open: https only, or http on 127.0.0.1`)
    tabs[t] = { ...spec, host: u.hostname }
  }
  if (!e.core) {
    const off = [...new Set([...Object.values(tabs).map((t) => t.host), ...r.hosts])].filter((h) => !g.hosts.includes(h))
    if (off.length) throw new Error(`${off.join(', ')} ${off.length > 1 ? 'are' : 'is'} not granted`)
  }
  return { name, core: e.core, zone: m.zone, script: readFileSync(join(e.dir, m.script), 'utf8'), config, tabs, hosts: r.hosts, concepts: { ...m.concepts }, actions: { ...(m.actions ?? {}) } }
}

/** the granted packs that load here; problems: why each other did not; elsewhere: granted packs that run off this PC */
export function grantedPacks(g: PackGrants, dirs: string | readonly string[] = PACKS_DIR, schemas = SCHEMAS_DIR): { packs: LoadedPack[]; problems: Record<string, string>; elsewhere: string[] } {
  const packs: LoadedPack[] = [], problems: Record<string, string> = {}, elsewhere: string[] = [], owner = new Map<string, string>()
  const cat = catalog(dirs, schemas)
  for (const name of g.packs) {
    if (!NAME.test(name)) { problems[name] = 'not a pack name'; continue }
    const e = cat.find((x) => x.name === name)
    if (!e) { problems[name] = `no pack ${name} in the catalog`; continue }
    if (!e.manifest) { problems[name] = e.problem ?? 'did not load'; continue }
    if (packKind(e.manifest) !== 'browser') { elsewhere.push(name); continue }
    let p: LoadedPack
    try { p = loadOne(e as CatalogEntry & { manifest: PackManifest }, g) } catch (x) { problems[name] = (x as Error).message; continue }
    const taken = Object.keys(p.actions).filter((k) => owner.has(k))
    if (taken.length) { problems[name] = taken.map((k) => `${k} is served by ${owner.get(k)}`).join('; '); continue }
    for (const k of Object.keys(p.actions)) owner.set(k, name)
    packs.push(p)
  }
  return { packs, problems, elsewhere }
}
