import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildId } from './build.ts'
import { tempDir } from './testdirs.ts'

test('buildId hashes the file, follows a rewrite, and is null without one', () => {
  const dir = tempDir('build'), f = join(dir, 'index.html')
  try {
    assert.equal(buildId(f), null)
    writeFileSync(f, '<p>one</p>')
    const a = buildId(f)
    assert.match(a ?? '', /^[0-9a-f]{12}$/)
    assert.equal(buildId(f), a, 'the same file, the same id')
    writeFileSync(f, '<p>two</p>')
    // a rewrite within the clock's resolution still counts: the mtime is set apart on purpose
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    const b = buildId(f)
    assert.notEqual(b, a)
    rmSync(f)
    assert.equal(buildId(f), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
