#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Vendors the core into a consumer repo:
     node <core>/console/scripts/sync-core.mjs --to <consumer console dir> [--ref <rev>] [--force]
   It copies the core's console/ at a commit (HEAD unless --ref) except the consumer's own files, writes
   core.lock.json (the commit and a hash per file) and deletes core files the commit dropped. The lock is how
   the consumer's tests (server/core-lock.test.ts) and the next sync tell an edited core file from a clean one. */

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

function git(core, args, input) {
  const r = spawnSync('git', ['-C', core, ...args], { input, maxBuffer: 1 << 30 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`)
  return r.stdout
}

/** the core's console/ at rev, read with `git ls-tree -r -z` + one `git cat-file --batch` (no tar on Windows);
    the paths are relative to console/, and the consumer's own files (OWN) are left out */
export function readCore(coreRoot, rev) {
  const sha = String(git(coreRoot, ['rev-parse', '--verify', `${rev}^{commit}`])).trim()
  const entries = []
  // each record is "<mode> <type> <oid>\t<path>", NUL-terminated and unquoted
  for (const rec of String(git(coreRoot, ['ls-tree', '-r', '-z', `${sha}:console`])).split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t'), [, type, oid] = rec.slice(0, tab).split(' '), path = rec.slice(tab + 1)
    if (type === 'blob' && !OWN(path)) entries.push({ path, oid })
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
    A file already equal to what the sync writes loses nothing, so it is not listed. No lock, no check. */
export function conflicts(to, lock, files) {
  if (!lock) return []
  const locked = lock.files ?? {}, out = []
  for (const p of new Set([...Object.keys(locked), ...files.keys()])) {
    const file = join(to, p)
    if (!existsSync(file)) continue
    const disk = hash(readFileSync(file))
    if (disk === locked[p] || (files.has(p) && disk === hash(files.get(p)))) continue
    out.push(p)
  }
  return out.sort()
}

const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`

/** removes dir and its parents up to (not including) stop while they are empty */
function prune(dir, stop) {
  for (let d = dir; d !== stop && d.startsWith(stop) && !readdirSync(d).length; d = dirname(d)) rmdirSync(d)
}

/** to = the consumer's console dir; core = the core's repo root */
export function sync({ core, to, rev = 'HEAD', force = false, log = console.log }) {
  const dest = resolve(to)
  if (dest === resolve(core, 'console')) throw new Error('--to is the core itself; give the console dir of the repo that vendors it')
  const { sha, files } = readCore(core, rev)
  const lockFile = join(dest, 'core.lock.json')
  const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : null
  if (lock) {
    const bad = force ? [] : conflicts(dest, lock, files)
    if (bad.length) throw new Error(`core-owned files differ from core.lock.json; change them in the core (or pass --force): ${bad.join(', ')}`)
  } else {
    const n = [...files.keys()].filter((p) => existsSync(join(dest, p))).length
    log(`first sync, no core.lock.json: ${count(n, 'existing file')} will be replaced`)
  }
  for (const [p, buf] of files) {
    const file = join(dest, p)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, buf)
  }
  const deleted = []
  for (const p of Object.keys(lock?.files ?? {})) {
    const file = join(dest, p)
    if (files.has(p) || !existsSync(file)) continue
    rmSync(file)
    prune(dirname(file), dest)
    deleted.push(p)
  }
  const written = [...files.keys()].sort()
  writeFileSync(lockFile, JSON.stringify({ core: sha, files: Object.fromEntries(written.map((p) => [p, hash(files.get(p))])) }, null, 2) + '\n')
  log(`synced core ${sha.slice(0, 7)}: ${count(written.length, 'file')} written, ${deleted.length} deleted`)
  return { sha, written, deleted }
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
