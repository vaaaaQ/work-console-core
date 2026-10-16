import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/* A connected MCP server's secrets: grants.json, which lives in git, names them as ${env:NAME}, and the value is put in
   only as the server starts (a run's session, a Check). It comes from the console's own environment, then from
   <home>/mcp.env over it, read anew at each start; runs never read that file (DENY closes ~/.work-console). */

const REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
const SECRETISH = /token|passw|secret|key|credential|^authorization$|^cookie$/i
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const FIELDS = ['env', 'headers'] as const

/** where a server's values come from: mcp.env under the console's home */
export const mcpEnvPath = (home: string) => join(home, 'mcp.env')

/** NAME=value lines; # comments and blank lines skipped; a value in matching quotes loses them */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/** the values a server may name: the process's environment, then mcp.env over it; none when the file is absent */
export function mcpVars(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v
  const f = mcpEnvPath(home)
  if (existsSync(f)) Object.assign(out, parseEnvFile(readFileSync(f, 'utf8')))
  return out
}

/** every ${env:NAME} a server config names, in order, once each */
export function envRefs(c: unknown): string[] {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string') for (const [, n] of v.matchAll(REF)) out.add(n)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (isObj(v)) Object.values(v).forEach(walk)
  }
  walk(c)
  return [...out]
}

/** a server config with each ${env:NAME} put in, and the values put in (for scrub); throws naming the first missing one */
export function resolveEnv<T>(c: T, vars: Record<string, string>): { config: T; secrets: string[] } {
  const missing = envRefs(c).filter((n) => !vars[n])
  if (missing.length) throw new Error(`no variable ${missing.join(', ')} (set it in the console's environment or in mcp.env)`)
  const secrets = new Set<string>()
  const put = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(REF, (_, n: string) => { secrets.add(vars[n]); return vars[n] })
    if (Array.isArray(v)) return v.map(put)
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, put(x)]))
    return v
  }
  return { config: put(c) as T, secrets: [...secrets].filter((s) => s.length >= 4) }
}

/** each env or header value whose name says secret but that names no ${env:…}: one sentence per value */
export function literalSecrets(c: unknown, at = 'mcp'): string[] {
  if (!isObj(c)) return []
  const out: string[] = []
  for (const f of FIELDS) {
    const o = c[f]
    if (!isObj(o)) continue
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== 'string' || !v || !SECRETISH.test(k) || envRefs(v).length) continue
      out.push(`${at}.${f}.${k}: looks like a secret; write \${env:${f === 'env' ? k : 'NAME'}} and put the value in mcp.env`)
    }
  }
  return out
}

/** a text with every value in secrets masked */
export function scrubSecrets(t: string, secrets: readonly string[]): string {
  let out = t
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) if (s) out = out.split(s).join('***')
  return out
}
