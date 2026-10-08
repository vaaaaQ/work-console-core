import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/* What a workspace's agent may change, in no provider's terms: globs relative to cwd with forward slashes.
   Write = its folder and tools/; deny wins over write. A path is matched after its links are resolved, and folded to
   lower case where the file system ignores case. Reading is not limited here (the provider keeps its token denies). */

/** fold = the file system at cwd ignores case, probed once when the limits are made */
export interface Limits { cwd: string; write: string[]; deny: string[]; fold?: boolean }

/** core files as core.lock.json lists them; none outside a consumer */
export function lockedFiles(root: string): string[] {
  const f = resolve(root, 'core.lock.json')
  if (!existsSync(f)) return []
  return Object.keys((JSON.parse(readFileSync(f, 'utf8')) as { files?: Record<string, string> }).files ?? {})
}

export const writeAreas = (ws: string) => [`workspaces/${ws}`, 'tools']

export function agentLimits(root: string, ws: string, locked: string[] = lockedFiles(root)): Limits {
  const areas = writeAreas(ws).map((a) => `${a}/`)
  return {
    cwd: root,
    write: areas.map((a) => `${a}**`),
    deny: [`workspaces/${ws}/grants.json`, 'workspaces/page.ts', 'workspaces/server.ts', 'core.lock.json', ...locked.filter((p) => areas.some((a) => p.startsWith(a)))],
    fold: caseInsensitive(root),
  }
}

const probed = new Map<string, boolean>()
/** whether the file system at dir ignores case: a probe file made and looked up in another case; unwritable = the platform's default */
export function caseInsensitive(dir: string): boolean {
  let v = probed.get(dir)
  if (v !== undefined) return v
  const name = `.wc-case-${randomBytes(4).toString('hex')}`, f = join(dir, `${name}A`)
  try { writeFileSync(f, ''); v = existsSync(join(dir, `${name}a`)) } catch { v = process.platform === 'win32' || process.platform === 'darwin' } finally { rmSync(f, { force: true }) }
  probed.set(dir, v)
  return v
}

/** the path with every link and junction resolved: the nearest existing ancestor's real path plus the rest;
    null when a link on the way leads nowhere, since writing through it would create its target wherever that is */
export function canonical(p: string): string | null {
  let head = resolve(p)
  const tail: string[] = []
  for (;;) {
    try { return join(realpathSync.native(head), ...tail) } catch {
      if (isLink(head)) return null
    }
    const up = dirname(head)
    if (up === head) return resolve(p)
    tail.unshift(basename(head)); head = up
  }
}
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }

/** a glob as a regex: ** any depth, * and ? within one segment */
export function globRe(g: string, fold = false): RegExp {
  let r = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') { r += '.*'; i++ } else if (c === '*') r += '[^/]*'
    else if (c === '?') r += '[^/]'
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${r}$`, fold ? 'i' : '')
}

/** path relative to cwd with forward slashes, links resolved on both; null when it leaves cwd */
export function relPath(cwd: string, path: string, fold = false): string | null {
  const root = canonical(cwd), abs = canonical(resolve(cwd, path.replace(/[\\/]+/g, sep)))
  if (!root || !abs) return null
  const rel = fold ? relative(root.toLowerCase(), abs.toLowerCase()) : relative(root, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

export function canWrite(l: Limits, path: string): boolean {
  const fold = l.fold ?? caseInsensitive(l.cwd), rel = relPath(l.cwd, path, fold)
  if (rel === null) return false
  const hit = (g: string) => globRe(g, fold).test(rel)
  return l.write.some(hit) && !l.deny.some(hit)
}

/** every symlink or junction under dirs (relative to root), not followed */
export function linksUnder(root: string, dirs: string[]): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    let es
    try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) out.push(relative(root, p).split(sep).join('/'))
      else if (e.isDirectory() && e.name !== '.git') walk(p)
    }
  }
  for (const d of dirs) if (!isLink(join(root, d))) walk(join(root, d)); else out.push(d)
  return out
}
