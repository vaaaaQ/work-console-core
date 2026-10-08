#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Vendors the core into a consumer repo:
     node <core>/console/scripts/sync-core.mjs --to <consumer console dir> [--ref <rev>] [--force]
   It copies the core's console/ at a commit (HEAD unless --ref) except the consumer's own files, and the core's packs/
   and schemas/ into the consumer's packs/ and schemas/; it writes
   core.lock.json (the commit and a hash per file) and deletes core files the commit dropped. The lock is how
   the consumer's tests (server/core-lock.test.ts) and the next sync tell an edited core file from a clean one.
   The consumer must already have its own workspaces/page.ts and workspaces/server.ts. */

/** the consumer's own files: the registries and shared tools; a sync neither writes nor deletes them */
export const OWN = (p) => p === 'workspaces/page.ts' || p === 'workspaces/server.ts' || p.startsWith('tools/')
/** build output and the lock itself: never listed in the lock */
export const IGNORED = (p) => /^(node_modules|dist)\//.test(p) || p === 'core.lock.json'

/** sha256 of the bytes with every CRLF turned into LF, so a CRLF checkout hashes like the core */
export function hash(buf) {
  const out = Buffer.allocUnsafe(buf.length)
  let n = 0
  for (let i = 0; i < buf.length; i++) if (!(buf[i] === 13 && buf[i + 1] === 10)) out[n++] = buf[i]
  return createHash('sha256').update(out.subarray(0, n)).digest('hex')
}

/** true when p is a plain relative path that stays under dest (an absolute, resolved dir): the one check
    in front of every write and every delete, so a hostile tree or a hand-edited lock cannot leave dest */
export function inside(dest, p) {
  if (typeof p !== 'string' || !p || isAbsolute(p) || /[\\:]/.test(p)) return false
  if (p.split('/').some((s) => !s || s === '.' || s === '..')) return false
  return resolve(dest, p).startsWith(dest.endsWith(sep) ? dest : dest + sep)
}

function git(cwd, args, input) {
  const r = spawnSync('git', ['-C', cwd, ...args], { input, maxBuffer: 1 << 30 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`)
  return r.stdout
}

/** the core's console/ at rev, plus its packs/ and schemas/, read with `git ls-tree -r -z` + one `git cat-file --batch`
    (no tar on Windows); console/ paths lose their console/ prefix, packs/ and schemas/ keep theirs, so the consumer holds
    them in its own folder. The consumer's own files (OWN) are left out */
export function readCore(coreRoot, rev) {
  const sha = String(git(coreRoot, ['rev-parse', '--verify', `${rev}^{commit}`])).trim()
  const entries = [], seen = new Set()
  // each record is "<mode> <type> <oid>\t<path>", NUL-terminated and unquoted
  for (const rec of String(git(coreRoot, ['ls-tree', '-r', '-z', '--full-tree', sha, '--', 'console', 'packs', 'schemas'])).split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t'), [, type, oid] = rec.slice(0, tab).split(' '), full = rec.slice(tab + 1)
    const path = full.startsWith('console/') ? full.slice('console/'.length) : /^(packs|schemas)\//.test(full) ? full : null
    if (type !== 'blob' || path === null || OWN(path)) continue
    if (seen.has(path)) throw new Error(`the core has both console/${path} and ${path}; one of them has to go`)
    seen.add(path)
    entries.push({ path, oid })
  }
  const files = new Map()
  if (!entries.length) return { sha, files }
  // the reply is "<oid> blob <size>\n<bytes>\n" per object, in request order
  const out = git(coreRoot, ['cat-file', '--batch'], entries.map((e) => e.oid).join('\n') + '\n')
  let at = 0
  for (const { path, oid } of entries) {
    const nl = out.indexOf(10, at), [got, type, size] = out.toString('latin1', at, nl).split(' ')
    if (got !== oid || type !== 'blob') throw new Error(`git cat-file returned "${out.toString('latin1', at, nl)}" for ${path} (${oid})`)
    files.set(path, out.subarray(nl + 1, nl + 1 + Number(size)))
    at = nl + 1 + Number(size) + 1
  }
  return { sha, files }
}

/** what a sync would refuse: locked files edited on disk, and unlocked consumer files it would overwrite.
    A file already equal to what the sync writes loses nothing, so it is not listed. No lock, no check.
    A path the lock lists under another case is the same file on a case-insensitive disk (a rename that
    only changes case), so it is compared with the locked hash. The consumer's own files are never judged. */
export function conflicts(to, lock, files) {
  if (!lock) return []
  const locked = lock.files ?? {}, out = []
  const folded = new Map(Object.entries(locked).map(([p, h]) => [p.toLowerCase(), h]))
  for (const p of new Set([...Object.keys(locked), ...files.keys()])) {
    if (OWN(p) || IGNORED(p)) continue
    const file = join(to, p)
    if (!existsSync(file)) continue
    const disk = hash(readFileSync(file)), want = Object.hasOwn(locked, p) ? locked[p] : folded.get(p.toLowerCase())
    if (disk === want || (files.has(p) && disk === hash(files.get(p)))) continue
    out.push(p)
  }
  return out.sort()
}

const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`

/** removes dir and its parents up to (not including) stop while they are empty */
export function prune(dir, stop) {
  const base = stop.endsWith(sep) ? stop : stop + sep
  for (let d = dir; d.startsWith(base) && !readdirSync(d).length; d = dirname(d)) rmdirSync(d)
}

/** a directory compares by its real path, lower-cased: a junction, a symlink or another spelling of the same
    folder is still that folder. A directory that does not exist yet falls back to its resolved path. */
const real = (p) => { try { return realpathSync(p).toLowerCase() } catch { return resolve(p).toLowerCase() } }

/** to = the consumer's console dir; core = the core's repo root */
export function sync({ core, to, rev = 'HEAD', force = false, log = console.log }) {
  const dest = resolve(to)
  if (real(dest) === real(resolve(core, 'console'))) throw new Error('--to is the core itself; give the console dir of the repo that vendors it')
  if (!['workspaces/page.ts', 'workspaces/server.ts'].every((r) => existsSync(join(dest, r)))) {
    throw new Error(`${to} is not a consumer console dir: write workspaces/page.ts and workspaces/server.ts first`)
  }
  const { sha, files } = readCore(core, rev)
  for (const p of files.keys()) if (!inside(dest, p)) throw new Error(`the core has a path that is not safe to write: ${p}`)
  const lockFile = join(dest, 'core.lock.json')
  const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : null
  for (const p of Object.keys(lock?.files ?? {})) if (!inside(dest, p)) throw new Error(`core.lock.json lists a path that is not safe to touch: ${p}`)
  if (lock) {
    const bad = force ? [] : conflicts(dest, lock, files)
    if (bad.length) throw new Error(`core-owned files differ from core.lock.json; change them in the core (or pass --force): ${bad.join(', ')}`)
  } else {
    const n = [...files].filter(([p, buf]) => existsSync(join(dest, p)) && hash(readFileSync(join(dest, p))) !== hash(buf)).length
    log(`first sync, no core.lock.json: replacing ${count(n, 'existing file')} that differ from the core`)
  }
  // delete first: on a case-insensitive disk a file the core renamed only in case (Foo.ts to foo.ts) is the file about to be written
  const deleted = []
  for (const p of Object.keys(lock?.files ?? {})) {
    const file = join(dest, p)
    if (files.has(p) || OWN(p) || IGNORED(p) || !existsSync(file)) continue
    rmSync(file)
    prune(dirname(file), dest)
    deleted.push(p)
  }
  for (const [p, buf] of files) {
    const file = join(dest, p)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, buf)
  }
  const written = [...files.keys()].sort()
  writeFileSync(lockFile, JSON.stringify({ core: sha, files: Object.fromEntries(written.map((p) => [p, hash(files.get(p))])) }, null, 2) + '\n')
  log(`synced core ${sha.slice(0, 7)}: ${count(written.length, 'file')} written, ${deleted.length} deleted`)
  return { sha, written, deleted }
}

const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

/** true when consoleDir sits in the core's own layout: schemas/ and packs/ beside it */
export const isCoreLayout = (consoleDir) => isDir(join(consoleDir, '..', 'schemas')) && isDir(join(consoleDir, '..', 'packs'))

/** what is wrong with a console dir that vendors the core, one sentence per problem; empty when it is clean.
    Locked files must exist and hash as locked; every other file (git's list) must be build output, the
    consumer's own (registries, tools/, workspaces/) or in the lock. */
export function drift(consoleDir) {
  const root = resolve(consoleDir), lockFile = join(root, 'core.lock.json')
  if (!existsSync(lockFile)) return ['no core.lock.json: run sync-core']
  const lock = JSON.parse(readFileSync(lockFile, 'utf8')), locked = lock.files ?? {}, out = []
  for (const [p, h] of Object.entries(locked)) {
    if (!inside(root, p)) out.push(`core.lock.json lists a path that is not safe to touch: ${p}`)
    else if (!existsSync(join(root, p))) out.push(`core file is missing: ${p}; run sync-core`)
    else if (hash(readFileSync(join(root, p))) !== h) out.push(`core file differs from core.lock.json: ${p}; change it in the core, then sync`)
  }
  const listed = String(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
  for (const p of listed) {
    if (!existsSync(join(root, p)) || IGNORED(p) || OWN(p) || p.startsWith('workspaces/') || Object.hasOwn(locked, p)) continue
    out.push(`file is not from the core: ${p}; own files go under workspaces/ or tools/, anything else belongs in the core`)
  }
  return out
}

const USAGE = 'usage: node sync-core.mjs --to <consumer console dir> [--ref <rev>] [--force]'

function cli(argv) {
  const o = { to: '', rev: 'HEAD', force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--to') o.to = argv[++i] ?? ''
    else if (argv[i] === '--ref') o.rev = argv[++i] ?? ''
    else if (argv[i] === '--force') o.force = true
    else throw new Error(`unknown argument ${argv[i]}\n${USAGE}`)
  }
  if (!o.to || !o.rev) throw new Error(USAGE)
  sync({ core: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), ...o })
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { cli(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exitCode = 1 }
}
