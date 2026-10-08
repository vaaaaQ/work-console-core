import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_GRANTS, grantsDiff, grantsOf, guardedHttp, hostAllowed, normGrants, writeGrants } from './grants.ts'

const root = () => { const r = mkdtempSync(join(tmpdir(), 'wc-grants-')); mkdirSync(join(r, 'workspaces', 'w1'), { recursive: true }); return r }

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
