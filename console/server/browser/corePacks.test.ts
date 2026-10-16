import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalog, PACKS_DIR } from './packs.ts'

test('every core pack loads into the catalog; each listed one has a title, an about and a guide', () => {
  const cat = catalog(PACKS_DIR)
  assert.deepEqual(cat.filter((e) => e.problem).map((e) => `${e.name}: ${e.problem}`), [])
  for (const e of cat.filter((x) => x.listed)) {
    assert.ok(e.manifest!.title && e.manifest!.about, `${e.name} has a title and an about`)
    assert.ok(e.guide.trim().length > 0, `${e.name} has a guide`)
  }
  assert.equal(cat.find((e) => e.name === 'example')!.listed, false)
  assert.equal(cat.find((e) => e.name === 'telegram-web')!.manifest!.scopeAbout !== undefined, true)
})

test('the ssh pack turns on with its six read tools and its config path put in; empty, ssh-mcp reads its default', async () => {
  const { applyPackChange } = await import('./catalogView.ts')
  const { EMPTY_GRANTS } = await import('../grants.ts')
  const cat = catalog(PACKS_DIR), ssh = cat.find((e) => e.name === 'ssh')!
  const on = applyPackChange(EMPTY_GRANTS, ssh, { on: true }, cat, { ssh: { file: 'C:/keys/config.toml' } })!.grants
  assert.deepEqual(on.mcp.ssh, { command: 'npx', args: ['-y', 'ssh-mcp@2.19.1', '--config=C:/keys/config.toml'] })
  assert.deepEqual(on.runTools, ['list-connections', 'list-sessions', 'read-command', 'read-session-output', 'sftp-list', 'sftp-download'].map((t) => `mcp__ssh__${t}`))
  assert.deepEqual((applyPackChange(EMPTY_GRANTS, ssh, { on: true }, cat)!.grants.mcp.ssh as { args: string[] }).args, ['-y', 'ssh-mcp@2.19.1'])
  const fsPack = cat.find((e) => e.name === 'filesystem')!
  assert.throws(() => applyPackChange(EMPTY_GRANTS, fsPack, { on: true }, cat), /config\.roots: required/)
})
