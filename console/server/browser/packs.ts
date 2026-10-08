import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WsConfig } from '../workspace.ts'
import { packConfig, readPack, renderPack } from './manifest.ts'
import type { PackConfig } from './manifest.ts'
import { SCHEMAS_DIR, validator } from './schema.ts'

/* Which packs a workspace runs, with what settings, onto which hosts: the grants, and the packs loaded under them. */

export const PACKS_DIR = fileURLToPath(new URL('../../../packs/', import.meta.url))
const NAME = /^[a-z][a-z0-9-]{0,40}$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** acts: the actions a person may run here; absent = every action a granted pack declares */
export type PackGrants = { packs: string[]; hosts: string[]; config: Record<string, Record<string, unknown>>; acts?: string[] }
export type GrantsFn = (cfg: WsConfig) => PackGrants

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
/** the grants from the workspace config: packs, hosts, packConfig.<pack> and acts */
export const configGrants: GrantsFn = (cfg) => {
  const pc = cfg.packConfig
  const g: PackGrants = { packs: strings(cfg.packs), hosts: strings(cfg.hosts), config: pc && typeof pc === 'object' && !Array.isArray(pc) ? pc as PackGrants['config'] : {} }
  if (Array.isArray(cfg.acts)) g.acts = strings(cfg.acts)
  return g
}

export type LoadedPack = {
  name: string; zone: string; script: string; config: PackConfig
  tabs: Record<string, { match: RegExp; open: string; host: string }>
  hosts: string[]
  concepts: Record<string, { tab: string; interval: number; cap: number }>
  actions: Record<string, { tab: string; concept: string }>
}

function loadOne(name: string, g: PackGrants, dir: string, schemas: string): LoadedPack {
  const pdir = join(dir, name), m = readPack(pdir, validator(schemas).has)
  if (m.name !== name) throw new Error(`pack.json names ${m.name}, not ${name}`)
  const { config, problems } = packConfig(m, g.config[name])
  if (problems.length) throw new Error(problems.join('; '))
  const r = renderPack(m, config), tabs: LoadedPack['tabs'] = {}
  for (const [t, spec] of Object.entries(r.tabs)) {
    const u = new URL(spec.open)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw new Error(`tabs.${t}.open: https only, or http on 127.0.0.1`)
    tabs[t] = { ...spec, host: u.hostname }
  }
  const hosts = [...new Set([...Object.values(tabs).map((t) => t.host), ...r.hosts])]
  const off = hosts.filter((h) => !g.hosts.includes(h))
  if (off.length) throw new Error(`${off.join(', ')} ${off.length > 1 ? 'are' : 'is'} not granted`)
  return { name, zone: m.zone, script: readFileSync(join(pdir, m.script), 'utf8'), config, tabs, hosts: r.hosts, concepts: { ...m.concepts }, actions: { ...(m.actions ?? {}) } }
}

/** the granted packs that load; problems: why each other granted pack did not */
export function grantedPacks(g: PackGrants, dir = PACKS_DIR, schemas = SCHEMAS_DIR): { packs: LoadedPack[]; problems: Record<string, string> } {
  const packs: LoadedPack[] = [], problems: Record<string, string> = {}, owner = new Map<string, string>()
  for (const name of g.packs) {
    if (!NAME.test(name)) { problems[name] = 'not a pack name'; continue }
    let p: LoadedPack
    try { p = loadOne(name, g, dir, schemas) } catch (e) { problems[name] = (e as Error).message; continue }
    const taken = [...Object.keys(p.concepts), ...Object.keys(p.actions)].filter((k) => owner.has(k))
    if (taken.length) { problems[name] = taken.map((k) => `${k} is served by ${owner.get(k)}`).join('; '); continue }
    for (const k of [...Object.keys(p.concepts), ...Object.keys(p.actions)]) owner.set(k, name)
    packs.push(p)
  }
  return { packs, problems }
}
