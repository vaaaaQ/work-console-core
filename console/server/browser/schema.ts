import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { coreDir } from '../config.ts'

/* The concept schemas' keyword subset, the one packs/example/test/validate.mjs checks: what a pack's read
   and get must look like before the console takes them. */

export const SCHEMAS_DIR = coreDir('schemas')

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; enum?: unknown[]; minimum?: number; maxItems?: number; format?: string }

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const is = (type: string, v: unknown) => ({
  string: typeof v === 'string', number: typeof v === 'number', integer: Number.isInteger(v), boolean: typeof v === 'boolean',
  array: Array.isArray(v), object: v !== null && typeof v === 'object' && !Array.isArray(v), null: v === null,
} as Record<string, boolean>)[type]
const formatOk = (f: string, s: string) => {
  if (f === 'date-time') return s.length >= 20 && (/Z$/.test(s) || /[+-]\d\d:\d\d$/.test(s)) && !isNaN(Date.parse(s))
  if (f === 'uri') { try { return ['https:', 'http:'].includes(new URL(s).protocol) } catch { return false } }
  return true
}

export function validate(s: Schema, value: unknown, path = '$', errors: string[] = []): string[] {
  if (s.type !== undefined && !(Array.isArray(s.type) ? s.type : [s.type]).some((t) => is(t, value))) {
    errors.push(`${path}: expected ${s.type}, got ${kind(value)}`)
    return errors
  }
  if (value === null) return errors
  if (s.enum && !s.enum.some((o) => JSON.stringify(o) === JSON.stringify(value))) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`)
  if (s.minimum !== undefined && typeof value === 'number' && value < s.minimum) errors.push(`${path}: below ${s.minimum}`)
  if (s.format && typeof value === 'string' && !formatOk(s.format, value)) errors.push(`${path}: not a ${s.format}`)
  if (is('object', value)) {
    const o = value as Record<string, unknown>
    for (const r of s.required || []) if (!(r in o)) errors.push(`${path}.${r}: missing`)
    for (const [k, v] of Object.entries(o)) {
      if (s.properties && k in s.properties) validate(s.properties[k], v, `${path}.${k}`, errors)
      else if (s.additionalProperties === false) errors.push(`${path}.${k}: not allowed`)
    }
  }
  if (Array.isArray(value)) {
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: ${value.length} items, over ${s.maxItems}`)
    if (s.items) value.forEach((x, i) => validate(s.items as Schema, x, `${path}[${i}]`, errors))
  }
  return errors
}

export interface Validator {
  has(key: string): boolean
  hasGet(concept: string): boolean
  item(concept: string, value: unknown): string[]
  get(concept: string, value: unknown): string[]
}

/** the schemas in dir, read once each; a concept with no schema of a kind is not checked */
export function validator(dir = SCHEMAS_DIR): Validator {
  const cache = new Map<string, Schema | null>()
  const load = (key: string) => {
    if (!/^[a-z][a-z0-9-]*\.(item|get)$/.test(key)) return null
    if (!cache.has(key)) {
      const f = join(dir, `${key}.schema.json`)
      cache.set(key, existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as Schema : null)
    }
    return cache.get(key) ?? null
  }
  const check = (key: string, v: unknown) => { const s = load(key); return s ? validate(s, v) : [] }
  return {
    has: (key) => load(key) !== null,
    hasGet: (c) => load(`${c}.get`) !== null,
    item: (c, v) => check(`${c}.item`, v),
    get: (c, v) => check(`${c}.get`, v),
  }
}
