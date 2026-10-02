import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drift, isCoreLayout } from '../scripts/sync-core.mjs'

/* The drift guard of a repo that vendors the core: core.lock.json, written by scripts/sync-core.mjs, says which
   files came from the core. A file edited here, or added outside workspaces/ and tools/, is a change that belongs
   in the core. The checks are drift() in sync-core.mjs, tested there. Only the core itself, which has no lock, skips;
   anywhere else a missing lock is a failure. */

const root = fileURLToPath(new URL('../', import.meta.url))
const skip = !existsSync(join(root, 'core.lock.json')) && isCoreLayout(root) ? 'no core.lock.json: this is the core itself' : false

test('the vendored core files are untouched and nothing else sits outside workspaces/ and tools/', { skip }, () => {
  const problems = drift(root)
  assert.equal(problems.length, 0, problems.join('\n'))
})
