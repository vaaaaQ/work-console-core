import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { catalog } from './packs.ts'
import { applyPackChange, packViews, settingsWrite } from './catalogView.ts'
import { EMPTY_GRANTS } from '../grants.ts'
import type { Grants } from '../grants.ts'

const FIXTURE_PACKS = join(import.meta.dirname, 'testdata', 'packs')
const cat = () => catalog(FIXTURE_PACKS)
const entry = (n: string) => cat().find((e) => e.name === n)!
const on: Grants = { ...EMPTY_GRANTS, packs: ['talk'], acts: ['talk.post'], llmActs: ['talk.post'], scopes: { talk: ['t1'] } }

test('views: every catalog pack, its state from the source, its scopes by name', () => {
  const v = packViews(cat(), on, {
    loaded: { talk: 'loaded' },
    states: { talk: { concepts: { chat: { status: 'signin_required', message: 'signed out', host: 'talk.example' } }, names: { t1: 'Brothers' } } },
  })
  const talk = v.find((x) => x.name === 'talk')!, fixture = v.find((x) => x.name === 'fixture')!
  assert.deepEqual([talk.on, talk.state, talk.host, talk.scoped, talk.scopes, talk.acts, talk.llmActs], [true, 'signin_required', 'talk.example', true, [{ id: 't1', name: 'Brothers' }], ['talk.post'], ['talk.post']])
  assert.deepEqual([talk.title, talk.kind, talk.concepts, talk.actions], ['Talk', 'browser', ['chat'], ['talk.post']])
  assert.deepEqual([fixture.on, fixture.state, fixture.title], [false, 'off', 'fixture'])
})

test('views: a granted pack that failed to load is an error with its reason; no source status is just on', () => {
  assert.deepEqual(packViews(cat(), on, { loaded: { talk: 'talk.post is served by x' }, states: {} }).find((x) => x.name === 'talk')!.state, 'error')
  assert.equal(packViews(cat(), on, null).find((x) => x.name === 'talk')!.state, 'on')
})

test('a granted pack that does not load is on with state error, and can only be turned off', () => {
  const broken = { name: 'talk', dir: '/x/talk', manifest: null, guide: '', listed: true, core: true, problem: 'pack /x/talk: zone: missing' }
  const [v] = packViews([broken], on, null)
  assert.deepEqual([v.on, v.state, v.message], [true, 'error', 'pack /x/talk: zone: missing'])
  assert.deepEqual(applyPackChange(on, broken, { on: false })!.grants.packs, [])
  assert.throws(() => applyPackChange(on, broken, { scopes: ['t1'] }), /did not load/)
})

test('turning a pack on adds it with all its actions as acts; turning it off strips its acts, llmActs and scopes', () => {
  const up = applyPackChange(EMPTY_GRANTS, entry('talk'), { on: true })!
  assert.deepEqual([up.grants.packs, up.grants.acts, up.reason], [['talk'], ['talk.post'], 'turn on talk (Settings)'])
  const down = applyPackChange(on, entry('talk'), { on: false })!
  assert.deepEqual([down.grants.packs, down.grants.acts, down.grants.llmActs, down.grants.scopes], [[], [], undefined, undefined])
  assert.equal(down.reason, 'turn off talk (Settings)')
  assert.equal(applyPackChange(on, entry('talk'), { on: true }), null)
})

test('scopes, acts and llmActs of an on pack; llmActs stay within acts; an off pack takes none', () => {
  const s = applyPackChange(on, entry('talk'), { scopes: ['t1', ' t2 ', 't2', ''] })!
  assert.deepEqual([s.grants.scopes, s.reason], [{ talk: ['t1', 't2'] }, 'scopes of talk: t1, t2 (Settings)'])
  const a = applyPackChange(on, entry('talk'), { acts: [] })!
  assert.deepEqual([a.grants.acts, a.grants.llmActs], [[], undefined])
  assert.throws(() => applyPackChange(on, entry('talk'), { llmActs: ['work.comment'] }), /work\.comment is not an act of talk/)
  assert.throws(() => applyPackChange(EMPTY_GRANTS, entry('talk'), { scopes: ['t1'] }), /turn talk on first/)
})

test('a settings write holds the restart until done, and a failed commit says why', async () => {
  const seen: string[] = []
  const hold = () => { seen.push('hold'); return () => seen.push('release') }
  const ok = await settingsWrite({ ops: { acceptGrants: async (_ws, _g, why) => { seen.push(`commit ${why}`); return { ok: true, sha: 'abc', files: [], summary: why } } }, hold }, 'w', on, 'turn on talk (Settings)')
  assert.deepEqual(seen, ['hold', 'commit turn on talk (Settings)'])
  ok.done(); ok.done()
  assert.deepEqual(seen, ['hold', 'commit turn on talk (Settings)', 'release'])
  const bad = await settingsWrite({ ops: { acceptGrants: async () => ({ ok: false, error: 'git refused' }) }, hold }, 'w', on, 'r')
  assert.deepEqual(bad.applied, { ok: false, error: 'git refused' })
})

const offTalk: Grants = { ...EMPTY_GRANTS, hosts: ['elsewhere.example'] }
const outside = () => ({ ...entry('talk'), core: false })

test('a core pack never touches grants.hosts', () => {
  assert.deepEqual(applyPackChange(offTalk, entry('talk'), { on: true })!.grants.hosts, ['elsewhere.example'])
  assert.deepEqual(applyPackChange({ ...on, hosts: ['talk.example'] }, entry('talk'), { on: false })!.grants.hosts, ['talk.example'])
})

test('a workspace pack: turning it on grants its hosts, turning it off takes them back', () => {
  const up = applyPackChange(offTalk, outside(), { on: true })!
  assert.deepEqual(up.grants.hosts, ['elsewhere.example', 'talk.example'])
  const down = applyPackChange(up.grants, outside(), { on: false })!
  assert.deepEqual(down.grants.hosts, ['elsewhere.example'])
})

test('a host another granted pack declares stays when a workspace pack goes off', () => {
  const twin = { ...entry('fixture'), name: 'twin', core: false, manifest: { ...entry('talk').manifest!, name: 'twin' } }
  const both: Grants = { ...EMPTY_GRANTS, packs: ['talk', 'twin'], hosts: ['talk.example'] }
  const down = applyPackChange(both, outside(), { on: false }, [outside(), twin])!
  assert.deepEqual([down.grants.packs, down.grants.hosts], [['twin'], ['talk.example']])
  const last = applyPackChange(down.grants, twin, { on: false }, [outside(), twin])!
  assert.deepEqual(last.grants.hosts, [])
})

test('a workspace pack whose settings leave its hosts unrendered cannot be turned on; a core pack can', () => {
  const m = { ...entry('talk').manifest!, config: { site: { about: 'the site', required: true } }, hosts: ['{site}.example'] }
  const ws = { ...entry('talk'), core: false, manifest: m }
  assert.throws(() => applyPackChange(EMPTY_GRANTS, ws, { on: true }), /talk: fill its settings first \(config\.site: required\)/)
  assert.deepEqual(applyPackChange(EMPTY_GRANTS, ws, { on: true }, [ws], { talk: { site: 'a' } })!.grants.hosts, ['talk.example', 'a.example'])
  assert.deepEqual(applyPackChange(EMPTY_GRANTS, { ...ws, core: true }, { on: true })!.grants.hosts, [])
})

test('an mcp pack shows its server as one line', () => {
  const base = entry('talk')
  const mk = (name: string, mcp: Record<string, unknown>) => ({ ...base, name, manifest: { ...base.manifest!, name, kind: 'mcp' as const, mcp } })
  const v = packViews([mk('stdio', { command: 'npx', args: ['-y', 'some-server'] }), mk('remote', { type: 'http', url: 'https://mcp.example/mcp' }), base], EMPTY_GRANTS, null)
  assert.deepEqual([v[0].mcp, v[1].mcp, v[2].mcp], ['npx -y some-server', 'https://mcp.example/mcp', undefined])
})
