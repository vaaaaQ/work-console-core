import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { coreDefaults, coreDir, loadConfig, repoRoot } from './config.ts'

test('LLM sessions run in the repo around the console: the nearest folder with a .git, a file or a folder', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-repo-'))
  // a worktree: .git is a file, two levels above the console
  const wt = join(tmp, 'wt'), con = join(wt, 'services', 'console')
  mkdirSync(con, { recursive: true })
  writeFileSync(join(wt, '.git'), 'gitdir: elsewhere\n')
  assert.equal(repoRoot(con), wt)
  // a clone: .git is a folder, the nearest one wins
  const inner = join(wt, 'services')
  mkdirSync(join(inner, '.git'))
  assert.equal(repoRoot(con), inner)
  // no repo anywhere above (only this temp tree is looked at): the console's parent
  const bare = join(tmp, 'bare', 'console')
  mkdirSync(bare, { recursive: true })
  assert.equal(repoRoot(bare, (p) => resolve(p).startsWith(resolve(tmp)) && existsSync(p)), join(tmp, 'bare'))
})

test('the default work dir is that repo unless WORK_CONSOLE_CWD says otherwise', () => {
  assert.equal(coreDefaults({}).workDir, repoRoot())
  assert.equal(coreDefaults({ WORK_CONSOLE_CWD: 'C:/work' }).workDir, 'C:/work')
})

test('dictated text is tidied by gpt-6-luna unless config.json names another model', () => {
  const home = mkdtempSync(join(tmpdir(), 'wc-cfg-'))
  assert.equal(loadConfig({ WORK_CONSOLE_HOME: home }).formatModel, 'gpt-6-luna')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ formatModel: 'gpt-6' }))
  assert.equal(loadConfig({ WORK_CONSOLE_HOME: home }).formatModel, 'gpt-6')
})

test("packs/ and schemas/ are the consumer's own synced copies when it has them, else the core's beside console/", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-coredir-')), con = join(tmp, 'console')
  mkdirSync(join(con, 'packs'), { recursive: true })
  assert.equal(coreDir('packs', con), join(con, 'packs'))
  assert.equal(coreDir('schemas', con), join(tmp, 'schemas'))
})
