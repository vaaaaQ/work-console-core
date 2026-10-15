import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPack, loadPacks, packConfig, packKind, readPack, renderPack, schemasIn } from './packs.ts'
import type { PackManifest } from './packs.ts'
import { tempDir } from '../testdirs.ts'

const sound = (): PackManifest => ({
  name: 'tracker', zone: 'UTC', script: 'tracker.js',
  config: {
    org: { about: 'the organisation', required: true, pattern: '^[A-Za-z0-9-]+$' },
    project: { about: 'the project', required: true },
    flavour: { about: 'which site', enum: ['one.example', 'two.example'], default: 'one.example' },
    done: { about: 'closed states', list: true, default: ['Done'] },
  },
  hosts: ['{flavour}', 'api.example'],
  tabs: { site: { match: '^https://tracker\\.example/{org}(/|$)', open: 'https://tracker.example/{org}/{project}' } },
  concepts: { work: { tab: 'site', interval: 30, cap: 100 } },
  actions: { 'work.comment': { tab: 'site', concept: 'work' } },
})
const all = () => true

function packDir(p: unknown, script = true): string {
  const root = tempDir('packs')
  const dir = join(root, 'tracker')
  mkdirSync(dir)
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(p))
  if (script) writeFileSync(join(dir, 'tracker.js'), 'async function (call, env) { return { ok: true, data: [] } }')
  return dir
}

test('a sound pack has no problems and loads', () => {
  assert.deepEqual(checkPack(sound(), all), [])
  const dir = packDir(sound())
  assert.equal(readPack(dir, all).name, 'tracker')
  assert.deepEqual(loadPacks(join(dir, '..'), ['tracker'], all).map((p) => p.name), ['tracker'])
})

test('a pack names each broken part', () => {
  const p = sound() as any
  p.concepts.work.tab = 'nowhere'
  p.concepts.ci = { tab: 'site', interval: 0, cap: 10 }
  p.actions['review.vote'] = { tab: 'site', concept: 'review' }
  p.tabs.site.open = 'https://tracker.example/{team}'
  p.hosts.push('{done}.example')
  const problems = checkPack(p, (k) => k !== 'ci.item')
  for (const want of [/concepts\.work: no tab nowhere/, /concepts\.ci: interval/, /concepts\.ci: no schema ci\.item/,
    /actions\.review\.vote: no concept review/, /tabs\.site\.open: \{team\} is not a config key/, /hosts\[2\]: \{done\} is a list/])
    assert.ok(problems.some((m) => want.test(m)), `${want} in ${problems.join('; ')}`)
})

test('a scope names an item field on a concept and an arg on an action; anything else is a problem', () => {
  const p = sound() as any
  p.concepts.work.scope = 'id'
  p.actions['work.comment'].scope = 'id'
  assert.deepEqual(checkPack(p, all), [])
  p.concepts.work.scope = ''
  p.actions['work.comment'].scope = 7
  const problems = checkPack(p, all)
  for (const want of [/concepts\.work: scope is not a field name/, /actions\.work\.comment: scope is not an arg name/])
    assert.ok(problems.some((m) => want.test(m)), `${want} in ${problems.join('; ')}`)
})

test('a pack without its script does not load', () => {
  assert.throws(() => readPack(packDir(sound(), false), all), /tracker\.js: missing/)
})

test('a pack config gets its defaults', () => {
  assert.deepEqual(packConfig(sound(), { org: 'acme', project: 'Road Map' }), {
    config: { org: 'acme', project: 'Road Map', flavour: 'one.example', done: ['Done'] }, problems: [],
  })
})

test('a pack config names a missing, unknown or malformed value', () => {
  const { problems } = packConfig(sound(), { org: 'ac me', flavour: 'three.example', done: 'Done', extra: 'x' })
  for (const want of [/config\.org: .*pattern/, /config\.project: required/, /config\.flavour: .*is not one of/,
    /config\.done: a list/, /config\.extra: not a setting/])
    assert.ok(problems.some((m) => want.test(m)), `${want} in ${problems.join('; ')}`)
  assert.deepEqual(packConfig(sound(), undefined).problems, ['config.org: required', 'config.project: required'])
})

test('rendering escapes a value in the tab match and encodes it in the tab url', () => {
  const r = renderPack(sound(), { org: 'acme', project: 'R&D (Ops)', flavour: 'two.example', done: ['Done'] })
  assert.equal(r.tabs.site.open, 'https://tracker.example/acme/R%26D%20(Ops)')
  assert.ok(r.tabs.site.match.test('https://tracker.example/acme/R%26D%20(Ops)'))
  assert.ok(r.tabs.site.match.test('https://tracker.example/acme'))
  assert.ok(!r.tabs.site.match.test('https://tracker.example/acmeX/'))
  assert.ok(!r.tabs.site.match.test('https://tracker.example/acme-evil/'))
  assert.deepEqual(r.hosts, ['two.example', 'api.example'])
  const dotted = renderPack({ ...sound(), config: { ...sound().config, org: { about: 'o' } } }, { org: 'a.b', project: 'p', flavour: 'one.example' })
  assert.ok(dotted.tabs.site.match.test('https://tracker.example/a.b/'))
  assert.ok(!dotted.tabs.site.match.test('https://tracker.example/aXb/'))
})

test('a host that renders to more than a host name is refused', () => {
  const p = { ...sound(), config: { ...sound().config, flavour: { about: 'f' } } }
  assert.throws(() => renderPack(p, { org: 'acme', project: 'p', flavour: 'evil.example/x' }), /hosts\[0\]: evil\.example\/x is not a host/)
})

test('every pack beside the console is sound', (t) => {
  const consoleDir = fileURLToPath(new URL('../../', import.meta.url))
  const packsDir = join(consoleDir, '..', 'packs'), schemasDir = join(consoleDir, '..', 'schemas')
  if (!existsSync(packsDir) || !existsSync(schemasDir)) return t.skip('no packs beside this console')
  const names = readdirSync(packsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  assert.ok(names.length > 0)
  assert.equal(loadPacks(packsDir, names, schemasIn(schemasDir)).length, names.length)
})

test('the catalog fields are checked: kind, one-line about, guide file name, catalog flag', () => {
  const p = { ...sound(), kind: 'browser', title: 'Tracker', about: 'work items of a tracker', guide: 'guide.md', scopeAbout: 'a project key', catalog: false }
  assert.deepEqual(checkPack(p, all), [])
  assert.deepEqual(checkPack({ ...sound(), kind: 'token' }, all), ['kind: token packs come in stage 2'])
  assert.deepEqual(checkPack({ ...sound(), kind: 'ftp' }, all), ['kind: not one of browser, remote-browser, mcp'])
  assert.deepEqual(checkPack({ ...sound(), about: 'two\nlines' }, all), ['about: one line of at most 200 characters'])
  assert.deepEqual(checkPack({ ...sound(), title: '' }, all), ['title: not a non-empty string'])
  assert.deepEqual(checkPack({ ...sound(), guide: '../x.md' }, all), ['guide: not a .md file name'])
  assert.deepEqual(checkPack({ ...sound(), catalog: 'no' }, all), ['catalog: not true or false'])
})

test('an mcp pack carries its server config and no tabs; a remote-browser pack names concepts without tabs', () => {
  const mcp = { name: 'remote', kind: 'mcp', title: 'Remote', about: 'a work machine', mcp: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }
  assert.deepEqual(checkPack(mcp, all), [])
  assert.deepEqual(checkPack({ ...mcp, mcp: undefined }, all), ['mcp: an mcp pack needs its server config'])
  assert.deepEqual(checkPack({ ...mcp, tabs: {} }, all), ['tabs: an mcp pack has none'])
  const rb = { name: 'far', kind: 'remote-browser', title: 'Far', about: 'a far tab', concepts: { chat: {} }, actions: { 'chat.post': {} } }
  assert.deepEqual(checkPack(rb, all), [])
  assert.deepEqual(checkPack({ ...rb, concepts: { chat: {} } }, () => false), ['concepts.chat: no schema chat.item'])
  assert.deepEqual(checkPack({ ...rb, actions: { post: {} } }, all), ['actions.post: not an action name'])
})

test('readPack checks the guide file and its length, and fills an mcp pack with empty tabs', () => {
  const dir = packDir({ ...sound(), guide: 'guide.md' })
  assert.throws(() => readPack(dir, all), /guide\.md: missing/)
  writeFileSync(join(dir, 'guide.md'), 'x'.repeat(2001))
  assert.throws(() => readPack(dir, all), /guide\.md: 2001 characters, at most 2000/)
  writeFileSync(join(dir, 'guide.md'), 'Read work items with bridge_get.')
  assert.equal(readPack(dir, all).guide, 'guide.md')
  const m = packDir({ name: 'tracker', kind: 'mcp', title: 'T', about: 'a', mcp: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }, false)
  const r = readPack(m, all)
  assert.deepEqual([r.script, r.tabs, r.concepts, packKind(r)], ['', {}, {}, 'mcp'])
})

test('files on a concept is true or false; anything else is a problem', () => {
  const p = sound() as any
  p.concepts.work.files = true
  assert.deepEqual(checkPack(p, all), [])
  p.concepts.work.files = 'yes'
  assert.ok(checkPack(p, all).some((m) => /concepts\.work: files is not true or false/.test(m)), checkPack(p, all).join('; '))
})
