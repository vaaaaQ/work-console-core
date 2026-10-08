import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/* What a workspace's agent may change, in no provider's terms: globs relative to cwd with forward slashes.
   Write = its folder and tools/; deny wins over write. Reading is not limited here (the provider keeps its token denies). */

export interface Limits { cwd: string; write: string[]; deny: string[] }

/** core files as core.lock.json lists them; none outside a consumer */
export function lockedFiles(root: string): string[] {
  const f = resolve(root, 'core.lock.json')
  if (!existsSync(f)) return []
  return Object.keys((JSON.parse(readFileSync(f, 'utf8')) as { files?: Record<string, string> }).files ?? {})
}

export function agentLimits(root: string, ws: string, locked: string[] = lockedFiles(root)): Limits {
  const areas = [`workspaces/${ws}/`, 'tools/']
  return {
    cwd: root,
    write: areas.map((a) => `${a}**`),
    deny: [`workspaces/${ws}/grants.json`, 'workspaces/page.ts', 'workspaces/server.ts', 'core.lock.json', ...locked.filter((p) => areas.some((a) => p.startsWith(a)))],
  }
}

const win = process.platform === 'win32'
const fold = (s: string) => (win ? s.toLowerCase() : s)
/** a glob as a regex: ** any depth, * and ? within one segment */
export function globRe(g: string): RegExp {
  let r = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') { r += '.*'; i++ } else if (c === '*') r += '[^/]*'
    else if (c === '?') r += '[^/]'
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${fold(r)}$`)
}

/** path relative to cwd with forward slashes; null when it leaves cwd */
export function relPath(cwd: string, path: string): string | null {
  const rel = relative(cwd, resolve(cwd, path.replace(/[\\/]+/g, sep)))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

export function canWrite(l: Limits, path: string): boolean {
  const rel = relPath(l.cwd, path)
  if (rel === null) return false
  const p = fold(rel), hit = (g: string) => globRe(g).test(p)
  return l.write.some(hit) && !l.deny.some(hit)
}
