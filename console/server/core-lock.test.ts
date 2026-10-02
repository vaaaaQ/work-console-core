import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IGNORED, OWN, hash } from '../scripts/sync-core.mjs'
import type { CoreLock } from '../scripts/sync-core.mjs'

/* The drift guard of a repo that vendors the core: core.lock.json, written by scripts/sync-core.mjs, says which
   files came from the core and what they hashed to. A file edited here, or added outside workspaces/ and tools/,
   is a change that belongs in the core. In the core itself there is no lock and this skips. */

const root = fileURLToPath(new URL('../', import.meta.url)), lockFile = join(root, 'core.lock.json')
const lock: CoreLock | null = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : null
const skip = lock ? false : 'no core.lock.json: this is the core itself'

test('every locked file exists and hashes as the lock says', { skip }, () => {
  const bad = Object.entries(lock!.files).filter(([p, h]) => !existsSync(join(root, p)) || hash(readFileSync(join(root, p))) !== h).map(([p]) => p)
  assert.equal(bad.length, 0, `core-owned files are missing or differ from core.lock.json: ${bad.join(', ')}; change it in the core, then sync`)
})

test('every file outside workspaces/ and tools/ came from the core', { skip }, () => {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
  const stray = listed.filter((p) => existsSync(join(root, p)) && !IGNORED(p) && !OWN(p) && !p.startsWith('workspaces/') && !Object.hasOwn(lock!.files, p))
  assert.equal(stray.length, 0, `files not in core.lock.json: ${stray.join(', ')}; change it in the core, then sync`)
})
