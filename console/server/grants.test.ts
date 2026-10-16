import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_GRANTS, grantsDiff, grantsOf, guardedHttp, hostAllowed, normGrants, writeGrants } from './grants.ts'
import { tempDir } from './testdirs.ts'

const root = () => { const r = tempDir('grants'); mkdirSync(join(r, 'workspaces', 'w1'), { recursive: true }); return r }

test('normGrants fills what is missing and refuses unknown keys and wrong types', () => {
  assert.deepEqual(normGrants({}), EMPTY_GRANTS)
  assert.deepEqual(normGrants({ hosts: ['a.example', 'a.example'], mcp: { t: { type: 'http', url: 'http://x' } } }),
    { ...EMPTY_GRANTS, hosts: ['a.example'], mcp: { t: { type: 'http', url: 'http://x' } } })
  assert.throws(() => normGrants({ shell: true }), /unknown key shell/)
  assert.throws(() => normGrants({ runTools: 'Bash' }), /runTools must be a list/)
  assert.throws(() => normGrants({ packs: [1] }), /packs must be a list/)
  assert.throws(() => normGrants({ mcp: [] }), /mcp must be an object/)
  assert.throws(() => normGrants({ mcp: { run: {} } }), /mcp may not name run/)
  assert.throws(() => normGrants(null), /grants must be an object/)
})

test("normGrants: browser is off by default, true is open mode, allow lists the hosts; mcp may not take the browser's name", () => {
  assert.ok(!('browser' in EMPTY_GRANTS) && !('browser' in normGrants({})), 'off is absent, so an old grants.json reads as before')
  assert.deepEqual(normGrants({ browser: true }).browser, { allow: null })
  assert.deepEqual(normGrants({ browser: { allow: ['web.telegram.example'] } }).browser, { allow: ['web.telegram.example'] })
  assert.ok(!('browser' in normGrants({ browser: false })))
  assert.throws(() => normGrants({ browser: { allow: [] } }), /allow must list at least one host/)
  assert.throws(() => normGrants({ mcp: { browser: {} } }), /mcp may not name browser/)
})

test('grantsDiff says when the browser turns on, off, or changes mode', () => {
  const off = EMPTY_GRANTS, open = { ...EMPTY_GRANTS, browser: { allow: null } as { allow: string[] | null } }, only = { ...EMPTY_GRANTS, browser: { allow: ['a.example', 'b.example'] } }
  assert.deepEqual(grantsDiff(off, open), ['+ browser open: any site'])
  assert.deepEqual(grantsDiff(open, only), ['~ browser allowlist: a.example, b.example'])
  assert.deepEqual(grantsDiff(only, off), ['- browser'])
  assert.deepEqual(grantsDiff(only, only), [])
})

test('normGrants: scopes list ids per granted pack, llmActs are granted acts; both are absent while empty', () => {
  const g = normGrants({ packs: ['chat-web'], acts: ['chat.post'], scopes: { 'chat-web': ['-100', '-100'] }, llmActs: ['chat.post'] })
  assert.deepEqual(g.scopes, { 'chat-web': ['-100'] })
  assert.deepEqual(g.llmActs, ['chat.post'])
  assert.ok(!('scopes' in normGrants({})) && !('llmActs' in normGrants({})), 'an old grants.json reads and writes as before')
  assert.ok(!('scopes' in normGrants({ scopes: {} })) && !('llmActs' in normGrants({ llmActs: [] })))
  assert.throws(() => normGrants({ scopes: [] }), /scopes must be an object of id lists per pack/)
  assert.throws(() => normGrants({ packs: ['p'], scopes: { p: '-1' } }), /scopes\.p must be a list of ids/)
  assert.throws(() => normGrants({ packs: ['p'], scopes: { p: [''] } }), /scopes\.p must be a list of ids/)
  assert.throws(() => normGrants({ scopes: { p: ['-1'] } }), /scopes\.p: p is not a granted pack/)
  assert.throws(() => normGrants({ llmActs: 'chat.post' }), /llmActs must be a list of names/)
  assert.throws(() => normGrants({ acts: [], llmActs: ['chat.post'] }), /llmActs: chat.post is not a granted act/)
})

test('grantsDiff says which scope ids and run acts a change adds and removes', () => {
  const a = normGrants({ packs: ['t'], acts: ['chat.post'], scopes: { t: ['-1', '-2'] } })
  const b = normGrants({ packs: ['t'], acts: ['chat.post'], scopes: { t: ['-2', '-3'] }, llmActs: ['chat.post'] })
  assert.deepEqual(grantsDiff(a, b), ['+ scope t -3', '- scope t -1', '+ llmAct chat.post'])
  assert.deepEqual(grantsDiff(b, a), ['+ scope t -1', '- scope t -3', '- llmAct chat.post'])
  assert.deepEqual(grantsDiff(b, b), [])
})

test('grantsOf: no file = unmanaged, a file = its grants, a bad file throws naming it', () => {
  const r = root()
  assert.equal(grantsOf('w1', r), null)
  writeGrants(r, 'w1', { ...EMPTY_GRANTS, runTools: ['Read'] })
  assert.deepEqual(grantsOf('w1', r), { ...EMPTY_GRANTS, runTools: ['Read'] })
  assert.match(readFileSync(join(r, 'workspaces', 'w1', 'grants.json'), 'utf8'), /\n {2}"runTools": \[\n/)
  writeFileSync(join(r, 'workspaces', 'w1', 'grants.json'), '{ nope')
  assert.throws(() => grantsOf('w1', r), /^Error: workspaces\/w1\/grants.json: /)
  writeFileSync(join(r, 'workspaces', 'w1', 'grants.json'), '{"hosts": "x"}')
  assert.throws(() => grantsOf('w1', r), { message: 'workspaces/w1/grants.json: hosts must be a list of names' })
})

test('grantsDiff says what a change adds, removes and alters', () => {
  const a = { ...EMPTY_GRANTS, hosts: ['a.example'], runTools: ['Read'], mcp: { t: { url: 'x' }, gone: {} } }
  const b = { ...EMPTY_GRANTS, hosts: ['b.example'], runTools: ['Read', 'Grep'], packs: ['m365'], mcp: { t: { url: 'y' }, n: {} } }
  assert.deepEqual(grantsDiff(a, b), ['+ pack m365', '+ host b.example', '- host a.example', '+ runTool Grep', '~ mcp t', '+ mcp n', '- mcp gone'])
  assert.deepEqual(grantsDiff(a, a), [])
})

test('hostAllowed: exact hosts and *.domain, nothing that only looks alike', () => {
  const hosts = ['api.example.com', '*.corp.example']
  assert.ok(hostAllowed(hosts, 'api.example.com'))
  assert.ok(hostAllowed(hosts, 'API.Example.com.'))
  assert.ok(hostAllowed(hosts, 'x.corp.example'))
  assert.ok(hostAllowed(hosts, 'a.b.corp.example'))
  assert.ok(!hostAllowed(hosts, 'corp.example'))
  assert.ok(!hostAllowed(hosts, 'evilcorp.example'))
  assert.ok(!hostAllowed(hosts, 'api.example.com.evil'))
  assert.ok(!hostAllowed(hosts, 'example.com'))
})

test('guardedHttp reaches granted hosts only, every redirect hop included; null = unrestricted', async () => {
  const seen: string[] = []
  const f = (async (u: string | URL) => {
    seen.push(String(u))
    const s = String(u)
    if (s.endsWith('/hop')) return new Response(null, { status: 302, headers: { location: 'https://b.example/ok' } })
    if (s.endsWith('/out')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })
    return new Response('ok')
  }) as typeof fetch
  const http = guardedHttp(['a.example', 'b.example'], f)
  assert.equal(await (await http('https://a.example/x')).text(), 'ok')
  assert.equal(await (await http('https://a.example/hop')).text(), 'ok')
  await assert.rejects(http('https://evil.example/'), /host_not_granted: evil.example/)
  await assert.rejects(http('https://a.example/out'), /host_not_granted: evil.example/)
  await assert.rejects(http('file:///etc/passwd'), /host_not_granted: file: is not http/)
  assert.ok(!seen.some((s) => s.includes('evil')))
  assert.equal(await (await guardedHttp(null, f)('https://evil.example/')).text(), 'ok')
})

test('grantsDiff marks a runTool that changes things when told which do', () => {
  const a = { ...EMPTY_GRANTS }, b = { ...EMPTY_GRANTS, runTools: ['mcp__s__list', 'mcp__s__run'] }
  assert.deepEqual(grantsDiff(a, b, new Set(['mcp__s__run'])), ['+ runTool mcp__s__list', '+ runTool mcp__s__run (changes things)'])
  assert.deepEqual(grantsDiff(b, a, new Set(['mcp__s__run'])), ['- runTool mcp__s__list', '- runTool mcp__s__run (changes things)'])
})
