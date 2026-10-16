import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { accessAddIn, accessChangeIn, accessRequests, addLines, applyAccessChange, applyAdd } from './access.ts'
import { catalog } from './browser/packs.ts'
import { EMPTY_GRANTS } from './grants.ts'
import type { Grants } from './grants.ts'
import { tempDir } from './testdirs.ts'

const cat = () => catalog(join(import.meta.dirname, 'browser', 'testdata', 'packs'))
const g0: Grants = { ...EMPTY_GRANTS, hosts: ['api.example'], runTools: ['Read'] }

test('a Settings change replaces the fields it names and says what changed', () => {
  const r = applyAccessChange(g0, { hosts: ['api.example', '*.docs.example'], runTools: ['Read', 'WebFetch'] })!
  assert.deepEqual([r.grants.hosts, r.grants.runTools], [['api.example', '*.docs.example'], ['Read', 'WebFetch']])
  assert.match(r.reason, /\+ host \*\.docs\.example/); assert.match(r.reason, /\+ runTool WebFetch/); assert.match(r.reason, /\(Settings\)$/)
  assert.equal(applyAccessChange(g0, { hosts: ['api.example'] }), null, 'what the grants already hold is no change')
})

test('a Settings change adds, edits and removes an MCP server and sets the runs\' browser', () => {
  const add = applyAccessChange(g0, { mcp: { notes: { command: 'notes-mcp', args: [] } } })!
  assert.match(add.reason, /\+ mcp notes/)
  const off = applyAccessChange(add.grants, { mcp: {} })!
  assert.match(off.reason, /- mcp notes/)
  const open = applyAccessChange(g0, { browser: { allow: null } })!
  assert.deepEqual(open.grants.browser, { allow: null })
  const only = applyAccessChange(open.grants, { browser: { allow: ['portal.example'] } })!
  assert.match(only.reason, /~ browser allowlist: portal\.example/)
  const none = applyAccessChange(only.grants, { browser: null })!
  assert.equal(none.grants.browser, undefined); assert.match(none.reason, /- browser/)
})

test('a pack\'s own MCP server cannot be changed or removed from Access, and reserved names are refused', () => {
  const g: Grants = { ...g0, packs: ['talk'], mcp: { talk: { command: 'talk-mcp' } } }
  assert.throws(() => applyAccessChange(g, { mcp: {} }), /belongs to the pack talk/)
  assert.throws(() => applyAccessChange(g, { mcp: { talk: { command: 'other' } } }), /belongs to the pack talk/)
  assert.ok(applyAccessChange(g, { mcp: { talk: { command: 'talk-mcp' }, x: { url: 'https://x.example/mcp' } } }))
  assert.throws(() => applyAccessChange(g0, { mcp: { run: { command: 'x' } } }))
})

test('a Settings body of a wrong shape is a 400', () => {
  for (const b of [{}, { hosts: 'x' }, { runTools: [1] }, { mcp: [] }, { mcp: { a: 'cmd' } }, { browser: true }, { browser: { allow: 'x' } }]) {
    assert.throws(() => accessChangeIn(b as Record<string, unknown>), (e: { status?: number }) => e.status === 400, JSON.stringify(b))
  }
  assert.deepEqual(accessChangeIn({ browser: { allow: null } }), { browser: { allow: null } })
})

test('a run asks only to add packs, hosts, runTools or browser sites', () => {
  assert.deepEqual(accessAddIn({ hosts: ['b.example', 'a.example', 'a.example'] }), { hosts: ['a.example', 'b.example'] })
  assert.throws(() => accessAddIn({ mcp: { x: {} } }), /only for packs, hosts, runTools or browser/)
  assert.throws(() => accessAddIn({ hosts: [] }), /names nothing/)
  assert.throws(() => accessAddIn([]), /object/)
})

test('a request\'s add turns a pack on as Settings would, merges lists and grows the browser allowlist', () => {
  const n = applyAdd(g0, { packs: ['talk'], hosts: ['new.example'], runTools: ['Grep'], browser: ['portal.example'] }, cat())!
  assert.ok(n.packs.includes('talk')); assert.ok(n.acts.includes('talk.post'))
  assert.deepEqual([n.hosts.includes('new.example'), n.runTools], [true, ['Read', 'Grep']])
  assert.deepEqual(n.browser, { allow: ['portal.example'] })
  // an open browser already reaches every site
  assert.deepEqual(applyAdd({ ...g0, browser: { allow: null } }, { browser: ['x.example'] }, cat()), null)
  assert.equal(applyAdd(g0, { hosts: ['api.example'] }, cat()), null)
  assert.deepEqual(addLines(g0, { packs: ['nope'] }, cat()), ['! no pack nope in this workspace\'s catalog'])
})

test('requests: one file per workspace, the same add joins the waiting one, at most 20, removed when decided', () => {
  const f = join(tempDir('access'), 'access-requests', 'acme.json'), seen: string[] = []
  const rs = accessRequests(f, (u, r) => seen.push(`${u.map((x) => x.id).join(',')}|${r.join(',')}`))
  const id = rs.add({ hosts: ['a.example'] }, 'needs the API', 'ACME-1/s1', ['+ host a.example'])
  assert.equal(rs.add({ hosts: ['a.example'] }, 'also', 'ACME-2/s3', ['+ host a.example']), id)
  assert.deepEqual(rs.get(id)!.by, ['ACME-1/s1', 'ACME-2/s3'])
  assert.equal(rs.add({ hosts: ['a.example'] }, 'again', 'ACME-1/s1', []), id)
  assert.equal(seen.length, 2, 'asking again from the same step changes nothing')
  for (let i = 1; i < 20; i++) rs.add({ hosts: [`h${i}.example`] }, 'r', 'ACME-3/s1', [])
  assert.throws(() => rs.add({ hosts: ['more.example'] }, 'r', 'ACME-3/s1', []), /20 requests already wait/)
  rs.remove(id)
  assert.equal(rs.get(id), null); assert.equal(rs.list().length, 19)
  assert.equal(seen.at(-1), `|${id}`)
  assert.ok(existsSync(f)); assert.equal(JSON.parse(readFileSync(f, 'utf8')).length, 19)
})

const shell = () => {
  const base = cat().find((e) => e.name === 'talk')!
  return { ...base, name: 'shell', manifest: { ...base.manifest!, name: 'shell', kind: 'mcp' as const, tabs: {}, concepts: {}, actions: {}, mcp: { command: 'npx', args: ['shell-mcp@1'] }, tools: { read: ['list'], act: ['run'] } } }
}

test("a run's ask for an mcp pack gets its read tools only; its lines mark a tool that changes things", () => {
  const c = [...cat(), shell()]
  const n = applyAdd(g0, { packs: ['shell'] }, c)!
  assert.deepEqual([n.mcp, n.runTools], [{ shell: { command: 'npx', args: ['shell-mcp@1'] } }, ['Read', 'mcp__shell__list']])
  assert.deepEqual(addLines(g0, { runTools: ['mcp__shell__run'] }, c), ['+ runTool mcp__shell__run (changes things)'])
})

test('Access refuses a literal secret in a server\'s env or headers and says to write ${env:…}', () => {
  assert.throws(() => accessChangeIn({ mcp: { box: { command: 'x', env: { API_TOKEN: 'abc' } } } }), /mcp\.box\.env\.API_TOKEN: looks like a secret; write \$\{env:API_TOKEN\}/)
  assert.deepEqual(accessChangeIn({ mcp: { box: { command: 'x', env: { API_TOKEN: '${env:API_TOKEN}' } } } }).mcp, { box: { command: 'x', env: { API_TOKEN: '${env:API_TOKEN}' } } })
})
