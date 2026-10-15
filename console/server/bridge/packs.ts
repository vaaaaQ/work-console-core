import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PackKind } from '../../src/model/packs.ts'
import { coreDir } from '../config.ts'

export type { PackKind }
export const PACKS_DIR = coreDir('packs')

/** one setting a pack takes from its workspace; the workspace's value reaches the script as call.config */
export type ConfigKey = { about: string; list?: boolean; required?: boolean; pattern?: string; enum?: string[]; default?: string | string[] }
export const GUIDE_MAX = 2000
const KINDS: readonly string[] = ['browser', 'remote-browser', 'mcp']
export interface PackManifest {
  name: string
  /** browser (default): a tab on this PC; remote-browser: a tab on a work machine; mcp: an MCP server */
  kind?: PackKind
  title?: string
  /** one line: what the pack gives */
  about?: string
  /** the LLM guide's file name next to pack.json */
  guide?: string
  /** what a scope id is and where to find it */
  scopeAbout?: string
  /** an mcp pack's server config, which turning it on puts into grants.mcp */
  mcp?: Record<string, unknown>
  /** false keeps the pack out of the Settings list; it still loads when granted */
  catalog?: boolean
  zone: string
  script: string
  config?: Record<string, ConfigKey>
  /** every host the script may call, `{key}` templates allowed */
  hosts?: string[]
  tabs: Record<string, { match: string; open: string }>
  /** scope: the item field a workspace's scopes list; a scoped concept serves only the listed ids */
  concepts: Record<string, { tab: string; interval: number; cap: number; scope?: string }>
  /** scope: the arg that names the target; a scoped action runs only on a listed id */
  actions?: Record<string, { tab: string; concept: string; scope?: string }>
}
export const packKind = (m: Pick<PackManifest, 'kind'>): PackKind => m.kind ?? 'browser'
export type PackConfig = Record<string, string | string[]>
export interface RenderedPack { tabs: Record<string, { match: RegExp; open: string }>; hosts: string[] }

const TEMPLATE = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const ACTION = /^[a-z]+\.[a-zA-Z]+$/, FIELD = /^[a-zA-Z][a-zA-Z0-9]*$/
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** what is wrong with a pack.json, one sentence per problem; empty when it is sound */
export function checkPack(p: unknown, hasSchema: (key: string) => boolean = () => true): string[] {
  const out: string[] = []
  if (!isObj(p)) return ['pack.json is not an object']
  if (typeof p.name !== 'string' || !p.name) out.push('name: missing')
  if (p.kind === 'token') out.push('kind: token packs come in stage 2')
  else if (p.kind !== undefined && !KINDS.includes(p.kind)) out.push('kind: not one of browser, remote-browser, mcp')
  for (const k of ['title', 'scopeAbout'] as const)
    if (p[k] !== undefined && (typeof p[k] !== 'string' || !p[k].trim())) out.push(`${k}: not a non-empty string`)
  if (p.about !== undefined && (typeof p.about !== 'string' || !p.about.trim() || /[\r\n]/.test(p.about) || p.about.length > 200)) out.push('about: one line of at most 200 characters')
  if (p.guide !== undefined && (typeof p.guide !== 'string' || !/^[\w.-]+\.md$/.test(p.guide))) out.push('guide: not a .md file name')
  if (p.catalog !== undefined && typeof p.catalog !== 'boolean') out.push('catalog: not true or false')
  const kind = typeof p.kind === 'string' && KINDS.includes(p.kind) ? p.kind as PackKind : p.kind === undefined ? 'browser' : null
  if (kind === 'mcp') {
    if (!isObj(p.mcp)) out.push('mcp: an mcp pack needs its server config')
    for (const k of ['script', 'tabs', 'concepts', 'actions', 'hosts', 'config'])
      if (p[k] !== undefined) out.push(`${k}: an mcp pack has none`)
    return out
  }
  if (kind === 'remote-browser') {
    for (const k of ['script', 'tabs', 'hosts', 'config'])
      if (p[k] !== undefined) out.push(`${k}: a remote-browser pack has none; it runs on the work machine`)
    const cs: Record<string, unknown> = isObj(p.concepts) ? p.concepts : {}
    if (!Object.keys(cs).length) out.push('concepts: none')
    for (const n of Object.keys(cs)) if (!hasSchema(`${n}.item`)) out.push(`concepts.${n}: no schema ${n}.item`)
    for (const n of Object.keys(isObj(p.actions) ? p.actions : {})) if (!ACTION.test(n)) out.push(`actions.${n}: not an action name`)
    return out
  }
  if (kind === null) return out
  if (typeof p.zone !== 'string' || !p.zone) out.push('zone: missing')
  if (typeof p.script !== 'string' || !/^[\w.-]+\.js$/.test(p.script)) out.push('script: not a .js file name')
  const config: Record<string, any> = isObj(p.config) ? p.config : {}
  if (p.config !== undefined && !isObj(p.config)) out.push('config: not an object')
  for (const [k, c] of Object.entries(config)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(k)) out.push(`config.${k}: not a key name`)
    if (!isObj(c) || typeof c.about !== 'string') { out.push(`config.${k}: needs about`); continue }
    if (c.pattern !== undefined) try { new RegExp(c.pattern) } catch { out.push(`config.${k}: pattern does not compile`) }
    if (c.enum !== undefined && (!Array.isArray(c.enum) || !c.enum.every((e: unknown) => typeof e === 'string'))) out.push(`config.${k}: enum is not a list of strings`)
    if (c.default !== undefined) out.push(...valueProblems(k, c as ConfigKey, c.default).map((m) => `${m} (default)`))
  }
  const templated = (at: string, s: string) => {
    for (const [, key] of s.matchAll(TEMPLATE)) {
      if (!(key in config)) out.push(`${at}: {${key}} is not a config key`)
      else if (config[key].list) out.push(`${at}: {${key}} is a list`)
    }
  }
  if (p.hosts !== undefined && (!Array.isArray(p.hosts) || !p.hosts.every((h: unknown) => typeof h === 'string'))) out.push('hosts: not a list of strings')
  else (p.hosts || []).forEach((h: string, i: number) => templated(`hosts[${i}]`, h))
  const tabs: Record<string, any> = isObj(p.tabs) ? p.tabs : {}
  if (!Object.keys(tabs).length) out.push('tabs: none')
  for (const [n, t] of Object.entries(tabs)) {
    if (!isObj(t) || typeof t.match !== 'string' || typeof t.open !== 'string') { out.push(`tabs.${n}: needs match and open`); continue }
    templated(`tabs.${n}.match`, t.match)
    templated(`tabs.${n}.open`, t.open)
    try { new RegExp(t.match.replace(TEMPLATE, 'x')) } catch { out.push(`tabs.${n}.match: does not compile`) }
  }
  const concepts: Record<string, any> = isObj(p.concepts) ? p.concepts : {}
  if (!Object.keys(concepts).length) out.push('concepts: none')
  for (const [n, c] of Object.entries(concepts)) {
    if (!isObj(c)) { out.push(`concepts.${n}: not an object`); continue }
    if (!(c.tab in tabs)) out.push(`concepts.${n}: no tab ${c.tab}`)
    if (!(typeof c.interval === 'number' && c.interval > 0)) out.push(`concepts.${n}: interval is not a positive number`)
    if (!(Number.isInteger(c.cap) && c.cap > 0)) out.push(`concepts.${n}: cap is not a positive integer`)
    if (!hasSchema(`${n}.item`)) out.push(`concepts.${n}: no schema ${n}.item`)
    if (c.scope !== undefined && (typeof c.scope !== 'string' || !FIELD.test(c.scope))) out.push(`concepts.${n}: scope is not a field name`)
  }
  for (const [n, a] of Object.entries(isObj(p.actions) ? p.actions : {})) {
    if (!ACTION.test(n)) out.push(`actions.${n}: not an action name`)
    if (!isObj(a)) { out.push(`actions.${n}: not an object`); continue }
    if (!(a.tab in tabs)) out.push(`actions.${n}: no tab ${a.tab}`)
    if (!(a.concept in concepts)) out.push(`actions.${n}: no concept ${a.concept}`)
    if (a.scope !== undefined && (typeof a.scope !== 'string' || !FIELD.test(a.scope))) out.push(`actions.${n}: scope is not an arg name`)
  }
  return out
}

function valueProblems(k: string, c: ConfigKey, v: unknown): string[] {
  if (c.list) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return [`config.${k}: a list of strings is needed`]
    return v.flatMap((x) => oneProblem(k, c, x))
  }
  if (typeof v !== 'string' || !v) return [`config.${k}: a non-empty string is needed`]
  return oneProblem(k, c, v)
}
function oneProblem(k: string, c: ConfigKey, v: string): string[] {
  if (c.enum && !c.enum.includes(v)) return [`config.${k}: ${JSON.stringify(v)} is not one of ${c.enum.join(', ')}`]
  if (c.pattern && !new RegExp(c.pattern).test(v)) return [`config.${k}: ${JSON.stringify(v)} does not match the pattern`]
  return []
}

/** a workspace's settings for a pack, defaults applied; problems name each missing or malformed value */
export function packConfig(p: PackManifest, given: Record<string, unknown> | undefined): { config: PackConfig; problems: string[] } {
  const config: PackConfig = {}, problems: string[] = []
  const decl = p.config || {}
  for (const k of Object.keys(given || {})) if (!(k in decl)) problems.push(`config.${k}: not a setting of ${p.name}`)
  for (const [k, c] of Object.entries(decl)) {
    const v = given?.[k] ?? c.default
    if (v === undefined || v === '') { if (c.required) problems.push(`config.${k}: required`); continue }
    const bad = valueProblems(k, c, v)
    if (bad.length) problems.push(...bad)
    else config[k] = Array.isArray(v) ? [...v] : (v as string)
  }
  return { config, problems }
}

/** a pack's tabs and hosts with the workspace's values put in: escaped in a match, encoded in a url */
export function renderPack(p: PackManifest, config: PackConfig): RenderedPack {
  const fill = (at: string, s: string, put: (v: string) => string) => s.replace(TEMPLATE, (_, key: string) => {
    const v = config[key]
    if (typeof v !== 'string') throw new Error(`${at}: config.${key} has no value`)
    return put(v)
  })
  const tabs: RenderedPack['tabs'] = {}
  for (const [n, t] of Object.entries(p.tabs)) tabs[n] = { match: new RegExp(fill(`tabs.${n}.match`, t.match, escapeRe)), open: fill(`tabs.${n}.open`, t.open, encodeURIComponent) }
  const hosts = (p.hosts || []).map((h, i) => {
    const host = fill(`hosts[${i}]`, h, (v) => v)
    if (!HOST.test(host)) throw new Error(`hosts[${i}]: ${host} is not a host`)
    return host
  })
  return { tabs, hosts }
}

export const schemasIn = (dir: string) => (key: string) => existsSync(join(dir, `${key}.schema.json`))
/** the fields a pack without a script or tabs still gives its readers; the manifest's own values win */
const MCP_EMPTY: Partial<PackManifest> = { zone: 'UTC', script: '', tabs: {}, concepts: {} }
const REMOTE_EMPTY: Partial<PackManifest> = { zone: 'UTC', script: '', tabs: {} }

/** reads and checks <dir>/pack.json; throws with every problem */
export function readPack(dir: string, hasSchema?: (key: string) => boolean): PackManifest {
  let p: unknown
  try { p = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')) } catch (e) { throw new Error(`pack ${dir}: ${(e as Error).message}`) }
  const problems = checkPack(p, hasSchema)
  const m = p as PackManifest, kind = problems.length ? null : packKind(m)
  if (kind === 'browser' && !existsSync(join(dir, m.script))) problems.push(`${m.script}: missing`)
  if (!problems.length && m.guide) {
    const f = join(dir, m.guide)
    if (!existsSync(f)) problems.push(`${m.guide}: missing`)
    else { const n = readFileSync(f, 'utf8').length; if (n > GUIDE_MAX) problems.push(`${m.guide}: ${n} characters, at most ${GUIDE_MAX}`) }
  }
  if (problems.length) throw new Error(`pack ${dir}: ${problems.join('; ')}`)
  if (kind === 'mcp') return { ...MCP_EMPTY, ...m }
  if (kind === 'remote-browser') return { ...REMOTE_EMPTY, ...m }
  return m
}

export const loadPacks = (packsDir: string, names: readonly string[], hasSchema?: (key: string) => boolean): PackManifest[] =>
  names.map((n) => readPack(join(packsDir, n), hasSchema))
