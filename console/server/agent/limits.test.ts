import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLimits, canWrite, lockedFiles } from './limits.ts'

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
  if (process.platform === 'win32') assert.ok(!canWrite(l, 'Workspaces/W1/Grants.json'), 'case does not slip past a deny on Windows')
})

test('lockedFiles reads core.lock.json; none without it', () => {
  const r = mkdtempSync(join(tmpdir(), 'wc-lock-'))
  assert.deepEqual(lockedFiles(r), [])
  writeFileSync(join(r, 'core.lock.json'), JSON.stringify({ core: 'abc', files: { 'server/main.ts': 'x', 'workspaces/acme/page.ts': 'y' } }))
  assert.deepEqual(lockedFiles(r), ['server/main.ts', 'workspaces/acme/page.ts'])
})
