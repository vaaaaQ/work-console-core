import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLimits, canWrite, caseInsensitive, linksUnder, lockedFiles } from './limits.ts'
import { tempDir } from '../testdirs.ts'

const root = join(tmpdir(), 'consumer')

test('limits: its folder and tools/, less its grants.json, the registries, core.lock.json and core files there', () => {
  const l = agentLimits(root, 'w1', ['server/main.ts', 'tools/core-helper.ts', 'workspaces/acme/page.ts'])
  assert.deepEqual(l.write, ['workspaces/w1/**', 'tools/**'])
  assert.deepEqual(l.deny, ['workspaces/w1/grants.json', 'workspaces/page.ts', 'workspaces/server.ts', 'core.lock.json', 'tools/core-helper.ts'])
  for (const p of ['workspaces/w1/page.ts', 'workspaces/w1/sub/x.ts', 'tools/t.ts', join(root, 'workspaces', 'w1', 'server.ts'), 'workspaces\\w1\\a.ts', './tools/a/b.ts'])
    assert.ok(canWrite(l, p), `${p} may be written`)
  for (const p of ['workspaces/w1/grants.json', 'workspaces/page.ts', 'workspaces/server.ts', 'core.lock.json', 'tools/core-helper.ts',
    'workspaces/w2/page.ts', 'server/main.ts', '../outside.txt', 'workspaces/w1/../../server/main.ts', join(tmpdir(), 'elsewhere.ts'),
    'workspaces/w1', 'workspaces/w1x/a.ts', 'toolsx/a.ts', '.claude/settings.json', 'package.json'])
    assert.ok(!canWrite(l, p), `${p} may not be written`)
})

test('lockedFiles reads core.lock.json; none without it', () => {
  const r = tempDir('lock')
  assert.deepEqual(lockedFiles(r), [])
  writeFileSync(join(r, 'core.lock.json'), JSON.stringify({ core: 'abc', files: { 'server/main.ts': 'x', 'workspaces/acme/page.ts': 'y' } }))
  assert.deepEqual(lockedFiles(r), ['server/main.ts', 'workspaces/acme/page.ts'])
})

/** a real consumer folder: w1 with its grants.json, the registries, a core dir */
function consumer() {
  const r = tempDir('limits')
  mkdirSync(join(r, 'workspaces', 'w1'), { recursive: true }); mkdirSync(join(r, 'server')); mkdirSync(join(r, 'tools'))
  writeFileSync(join(r, 'workspaces', 'w1', 'grants.json'), '{}'); writeFileSync(join(r, 'workspaces', 'server.ts'), '')
  writeFileSync(join(r, 'server', 'main.ts'), '')
  return r
}

test('a case variant does not slip past a deny where the file system ignores case', () => {
  const r = consumer(), l = agentLimits(r, 'w1', [])
  assert.equal(l.fold, caseInsensitive(r))
  for (const p of ['Workspaces/W1/GRANTS.json', 'workspaces/w1/Grants.JSON', 'WORKSPACES/server.ts', 'Core.Lock.json'])
    assert.equal(canWrite(l, p), false, `${p} may not be written`)
  assert.equal(canWrite(l, 'workspaces/W1/new.ts'), l.fold, 'another case of its own folder is its folder only where case is ignored')
  // a case-insensitive file system that keeps the given case for a file not there yet (macOS): the fold still applies
  const mac = { ...agentLimits(join(tmpdir(), 'wc-nowhere'), 'w1', []), fold: true }
  for (const p of ['Workspaces/w1/GRANTS.json', 'workspaces/W1/grants.json', 'TOOLS/../core.lock.json']) assert.equal(canWrite(mac, p), false, `${p} folded`)
  assert.ok(canWrite(mac, 'Workspaces/W1/x.ts'))
})

test('a new file under its folder may be written; a symlink or junction out of it may not', (t) => {
  const r = consumer(), l = agentLimits(r, 'w1', [])
  assert.ok(canWrite(l, 'workspaces/w1/new/deep/file.ts'))
  assert.ok(canWrite(l, join(r, 'tools', 'a', 'b.ts')))
  try {
    symlinkSync(join(r, 'server'), join(r, 'workspaces', 'w1', 'esc'), 'junction')
    symlinkSync(join(r, 'workspaces'), join(r, 'tools', 'up'), 'junction')
  } catch (e) { t.skip(`no junctions here: ${(e as Error).message}`); return }
  assert.equal(canWrite(l, 'workspaces/w1/esc/main.ts'), false, 'a junction into the core')
  assert.equal(canWrite(l, 'workspaces/w1/esc/new.ts'), false, 'a new file through a junction into the core')
  assert.equal(canWrite(l, 'tools/up/server.ts'), false, 'a junction onto the registry')
  assert.equal(canWrite(l, 'tools/up/w1/grants.json'), false, 'a junction onto its grants')
  assert.ok(canWrite(l, 'tools/up/w1/page.ts'), 'a junction that lands in its own folder lands in its own folder')
  assert.deepEqual(linksUnder(r, ['workspaces/w1', 'tools']).sort(), ['tools/up', 'workspaces/w1/esc'])
})

test('a dangling link is refused: writing it would create its target wherever that is', (t) => {
  const r = consumer(), l = agentLimits(r, 'w1', [])
  try { symlinkSync(join(r, 'server', 'gone'), join(r, 'workspaces', 'w1', 'dangle'), 'junction') } catch (e) { t.skip(`no junctions here: ${(e as Error).message}`); return }
  assert.equal(canWrite(l, 'workspaces/w1/dangle/x.ts'), false)
  assert.equal(canWrite(l, 'workspaces/w1/dangle'), false)
})
