import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPack, loadPacks, packConfig, readPack, renderPack, schemasIn } from './packs.ts'
import type { PackManifest } from './packs.ts'

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
  const root = mkdtempSync(join(tmpdir(), 'wc-packs-'))
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
