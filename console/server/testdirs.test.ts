import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { removeDir, tempDir } from './testdirs.ts'

const lib = pathToFileURL(join(import.meta.dirname, 'testdirs.ts')).href
// a child that makes folders with tempDir, runs body, prints the folders and exits
const child = (body: string) => {
  const code = `import { tempDir } from '${lib}'; import { writeFileSync } from 'node:fs'
    const a = tempDir('testdirs'), b = tempDir('testdirs'); writeFileSync(a + '/f', 'x'); ${body}; console.log(JSON.stringify([a, b]))`
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8' })
  return { status: r.status, dirs: JSON.parse(r.stdout.trim().split('\n')[0] || '[]') as string[], stderr: r.stderr }
}

test('the folders a process made with tempDir go when it exits', () => {
  const r = child('')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.dirs.length, 2)
  for (const d of r.dirs) assert.equal(existsSync(d), false, d)
})

test('a folder that will not go fails the process and is named', { skip: process.platform !== 'win32' && 'only Windows refuses to remove a cwd' }, (t) => {
  const r = child('process.chdir(a)')
  t.after(() => { for (const d of r.dirs) removeDir(d) })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /test folders left behind/)
  assert.ok(r.stderr.includes(r.dirs[0]), r.stderr)
  assert.equal(existsSync(r.dirs[1]), false)
})

test('removeDir waits out a folder another process still holds for a moment', { skip: process.platform !== 'win32' && 'only Windows refuses to remove a cwd' }, async () => {
  const d = tempDir('testdirs')
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { cwd: d })
  await new Promise((r) => holder.once('spawn', r))
  removeDir(d)
  assert.equal(existsSync(d), false)
})
