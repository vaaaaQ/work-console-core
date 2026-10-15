import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKS_DIR, catalog, configGrants, grantedPacks, grantsFrom } from './packs.ts'
import type { PackGrants } from './packs.ts'
import { validator } from './schema.ts'
import type { WsConfig } from '../workspace.ts'
import { tempDir } from '../testdirs.ts'

const FIXTURE_PACKS = join(import.meta.dirname, 'testdata', 'packs')
const grants = (o: Partial<PackGrants> = {}): PackGrants => ({ packs: ['fixture'], hosts: ['board.example', 'mail.example'], config: { fixture: { org: 'acme' } }, ...o })
/** a packs dir holding the fixture pack, its pack.json changed by edit */
const dirWith = (edit: (p: any) => void = () => {}, name = 'fixture') => {
  const d = tempDir('packs')
  cpSync(join(FIXTURE_PACKS, 'fixture'), join(d, name), { recursive: true })
  const f = join(d, name, 'pack.json'), p = JSON.parse(readFileSync(f, 'utf8'))
  p.name = name; edit(p); writeFileSync(f, JSON.stringify(p))
  return d
}
/** copies the fixture pack into d as name, its pack.json changed by edit */
const addPack = (d: string, name: string, edit: (p: any) => void = () => {}) => {
  cpSync(join(FIXTURE_PACKS, 'fixture'), join(d, name), { recursive: true })
  const f = join(d, name, 'pack.json'), p = JSON.parse(readFileSync(f, 'utf8'))
  p.name = name; edit(p); writeFileSync(f, JSON.stringify(p))
  return d
}
const problem = (edit: (p: any) => void, g = grants()) => {
  const d = dirWith(edit)
  try { const r = grantedPacks(g, d); assert.equal(r.packs.length, 0); return r.problems.fixture } finally { rmSync(d, { recursive: true }) }
}

test('the fixture pack loads with its config, defaults applied, tabs and hosts rendered', () => {
  const { packs, problems } = grantedPacks(grants(), FIXTURE_PACKS)
  assert.deepEqual(problems, {})
  const [p] = packs
  assert.equal(p.name, 'fixture')
  assert.deepEqual(p.config, { org: 'acme', team: 'core' })
  assert.equal(p.tabs.board.open, 'https://board.example/acme/core')
  assert.equal(p.tabs.board.host, 'board.example')
  assert.ok(p.tabs.board.match.test('https://board.example/acme/x'))
  assert.deepEqual(p.concepts.work, { tab: 'board', interval: 1, cap: 10 })
  assert.deepEqual(p.actions['work.comment'], { tab: 'board', concept: 'work' })
  assert.deepEqual(p.hosts, ['board.example', 'mail.example'])
  assert.match(p.script, /^\/\/ A test pack/)
})

test('a config value is escaped in a match and encoded in an open url', () => {
  const [p] = grantedPacks(grants({ config: { fixture: { org: 'a.b', team: 'R&D (Ops)' } } }), FIXTURE_PACKS).packs
  assert.equal(p.tabs.board.match.test('https://board.example/aXb/'), false)
  assert.equal(p.tabs.board.match.test('https://board.example/a.b/'), true)
  assert.equal(p.tabs.board.open, 'https://board.example/a.b/R%26D%20(Ops)')
})

test('a pack the grants do not list is not loaded at all', () => {
  assert.deepEqual(grantedPacks(grants({ packs: [] }), FIXTURE_PACKS), { packs: [], problems: {}, elsewhere: [] })
})

test('a missing required config value is a problem', () => {
  const { problems } = grantedPacks(grants({ config: {} }), FIXTURE_PACKS)
  assert.match(problems.fixture, /config\.org: required/)
})

test('a pack name that is not a plain name is a problem and no file is read', () => {
  const { packs, problems } = grantedPacks(grants({ packs: ['../x'] }), FIXTURE_PACKS)
  assert.equal(packs.length, 0)
  assert.match(problems['../x'], /not a pack name/)
})

test('an absent pack is a problem', () => {
  assert.match(grantedPacks(grants({ packs: ['nope'] }), FIXTURE_PACKS).problems.nope, /no pack nope in the catalog/)
})

test('an unknown tab, a zero interval and a missing script are problems', () => {
  assert.match(problem((p) => { p.concepts.work.tab = 'none' }), /concepts\.work: no tab none/)
  assert.match(problem((p) => { p.concepts.work.interval = 0 }), /concepts\.work: interval/)
  assert.match(problem((p) => { p.script = 'gone.js' }), /gone\.js: missing/)
})

test('an open url that is plain http off loopback is a problem; http on 127.0.0.1 is fine', () => {
  assert.match(problem((p) => { p.tabs.mail.open = 'http://mail.example/' }), /tabs\.mail\.open: https only/)
  const d = dirWith((p) => { p.tabs.mail = { match: '^http://127\\.0\\.0\\.1:8/', open: 'http://127.0.0.1:8/' }; p.hosts = ['board.example'] })
  try { assert.deepEqual(grantedPacks(grants({ hosts: ['board.example', '127.0.0.1'] }), d).problems, {}) } finally { rmSync(d, { recursive: true }) }
})

test('hosts follow from the pack: a granted pack loads with no hosts granted', () => {
  const { packs, problems } = grantedPacks(grants({ hosts: [] }), FIXTURE_PACKS)
  assert.deepEqual(problems, {})
  assert.deepEqual(packs.map((p) => p.name), ['fixture'])
})

test('two packs on one concept both load; an action two packs both run is a problem for the later one', () => {
  const d = addPack(dirWith(), 'talk', (p) => { p.concepts = { chat: p.concepts.chat }; p.actions = { 'talk.post': { tab: 'mail', concept: 'chat' } } })
  addPack(d, 'twin')
  const cfg = { fixture: { org: 'acme' }, talk: { org: 'acme' }, twin: { org: 'acme' } }
  const r = grantedPacks(grants({ packs: ['fixture', 'talk', 'twin'], config: cfg }), d)
  assert.deepEqual(r.packs.map((p) => p.name), ['fixture', 'talk'])
  assert.deepEqual(r.problems, { twin: 'work.comment is served by fixture' })
})

test('a catalog reads core packs first, then the workspace ones; a workspace pack with a core name is a problem and the core pack still loads', () => {
  const core = dirWith(), ws = addPack(dirWith(() => {}, 'mine'), 'fixture', (p) => { p.about = 'the workspace copy' })
  const cat = catalog([core, ws])
  assert.deepEqual(cat.map((e) => [e.name, e.dir, e.problem ?? null]), [
    ['fixture', join(core, 'fixture'), null],
    ['fixture', join(ws, 'fixture'), `fixture is already a pack in ${core}; rename this one`],
    ['mine', join(ws, 'mine'), null],
  ])
  const r = grantedPacks(grants({ packs: ['fixture'] }), [core, ws])
  assert.equal(r.packs[0].script.startsWith('// A test pack'), true)
  assert.deepEqual(r.problems, {})
})

test('a pack with catalog false is not listed but loads when granted; its guide is read', () => {
  const d = dirWith((p) => { p.catalog = false; p.guide = 'guide.md' })
  writeFileSync(join(d, 'fixture', 'guide.md'), 'Use bridge_get on work items.')
  const [e] = catalog(d)
  assert.deepEqual([e.listed, e.guide], [false, 'Use bridge_get on work items.'])
  assert.deepEqual(grantedPacks(grants(), d).packs.map((p) => p.name), ['fixture'])
})

test('a granted mcp pack goes to elsewhere; an ungranted catalog pack is not loaded; a missing one is a problem', () => {
  const d = addPack(dirWith(), 'srv', (p) => {
    for (const k of ['script', 'tabs', 'concepts', 'actions', 'hosts', 'config', 'zone']) delete p[k]
    Object.assign(p, { kind: 'mcp', title: 'Srv', about: 'a server', mcp: { type: 'http', url: 'http://127.0.0.1:1/mcp' } })
  })
  assert.deepEqual(grantedPacks(grants({ packs: ['srv', 'gone'] }), d), { packs: [], problems: { gone: 'no pack gone in the catalog' }, elsewhere: ['srv'] })
})

test('configGrants reads packs, hosts, packConfig and acts from the workspace config, empty when absent', () => {
  const cfg = { packs: ['fixture'], hosts: ['board.example'], packConfig: { fixture: { org: 'acme' } }, acts: ['work.comment'] } as unknown as WsConfig
  assert.deepEqual(configGrants(cfg), { packs: ['fixture'], hosts: ['board.example'], config: { fixture: { org: 'acme' } }, acts: ['work.comment'] })
  assert.deepEqual(configGrants({} as WsConfig), { packs: [], hosts: [], config: {} })
})

test("a managed workspace's grants name its packs, hosts and acts; its pack settings stay in its config", () => {
  const cfg = { packs: ['other'], hosts: ['evil.example'], acts: ['mail.send'], packConfig: { fixture: { org: 'acme' } } } as unknown as WsConfig
  const g = grantsFrom({ packs: ['fixture'], hosts: ['board.example'], acts: ['work.comment'] })
  assert.deepEqual(g(cfg), { packs: ['fixture'], hosts: ['board.example'], acts: ['work.comment'], config: { fixture: { org: 'acme' } } })
})

test("scopes come from a managed workspace's grants only; its config cannot widen them", () => {
  const cfg = { scopes: { fixture: ['-1', '-2'] }, packConfig: {} } as unknown as WsConfig
  assert.deepEqual(configGrants(cfg).scopes, { fixture: ['-1', '-2'] })
  assert.deepEqual(grantsFrom({ packs: ['fixture'], hosts: [], acts: [], scopes: { fixture: ['-1'] } })(cfg).scopes, { fixture: ['-1'] })
  assert.ok(!('scopes' in grantsFrom({ packs: ['fixture'], hosts: [], acts: [] })(cfg)), 'none granted = none, whatever the config says')
})

test("the core's packs dir holds the example pack", () => {
  assert.match(readFileSync(join(PACKS_DIR, 'example', 'pack.json'), 'utf8'), /"name": "example"/)
})

test('the validator flags a mail item without its id and accepts a whole one', () => {
  const v = validator(), mail = {
    id: 'm1', folder: 'Inbox', from: 'Robin', to: ['You'], cc: [], subject: 's', at: '2026-10-08T09:00:00Z', unread: true,
    preview: 'p', category: 'reply', myReply: false, conversationId: 'c1', link: 'https://mail.example/m1',
  }
  assert.deepEqual(v.item('mail', mail), [])
  const { id: _, ...noId } = mail
  assert.deepEqual(v.item('mail', noId), ['$.id: missing'])
  assert.deepEqual(v.item('mail', { ...mail, at: 'yesterday' }), ['$.at: not a date-time'])
  assert.equal(v.hasGet('mail'), true)
  assert.equal(v.hasGet('cal'), false)
})
