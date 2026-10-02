import { acme, acmeServer } from './testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeGateway } from './bridge/fake.ts'
import { GatewayError } from './bridge/wire.ts'
import { Bus } from './events.ts'
import { checkWorkspaces, fakeSeed, gatewaySource } from './workspace.ts'
import type { WorkspaceServer, WsConfig } from './workspace.ts'

/** acme under another id; its prefix is A, so give it its own unless a test wants the clash */
const copy = (id: string, o: Partial<WorkspaceServer> = {}): WorkspaceServer => ({ ...acmeServer, jobPrefix: 'B', page: { ...acme, id, playbooks: {} }, ...o })
const bad = (list: WorkspaceServer[], message: string) => assert.throws(() => checkWorkspaces(list), { message })

test('registered workspaces with their own ids, prefixes and playbooks pass', () => {
  checkWorkspaces([acmeServer])
  checkWorkspaces([acmeServer, copy('beta')])
})

test('ids: well-formed and unique', () => {
  bad([{ ...acmeServer, page: { ...acme, id: 'Acme' } }], 'workspace id Acme must match /^[a-z][a-z0-9-]{0,31}$/')
  bad([acmeServer, acmeServer], 'workspace acme is registered twice')
})

test('prefixes: well-formed and unique', () => {
  for (const p of ['a', '1A', 'ABCDEFGHI', 'A-B', '']) bad([{ ...acmeServer, jobPrefix: p }], `job prefix ${p} of acme must match /^[A-Z][A-Z0-9]{0,7}$/`)
  checkWorkspaces([{ ...acmeServer, jobPrefix: 'A1' }, copy('beta', { jobPrefix: 'ABCDEFG1' })])
  // the clash is named before the shared playbooks, which this copy also has
  bad([acmeServer, { ...acmeServer, page: { ...acme, id: 'beta' } }], 'workspaces acme and beta both use job prefix A')
})

test('built-in playbook ids are unique across workspaces and not a core id', () => {
  const id = Object.keys(acme.playbooks)[0]
  bad([acmeServer, copy('beta', { page: { ...acme, id: 'beta' } })], `playbook ${id} is built into both acme and beta`)
  bad([{ ...acmeServer, page: { ...acme, playbooks: { action: acme.playbooks[id] } } }], 'playbook action is built into both core and acme')
})

test('without fake() the seed is derived from the demo; an own fake() wins', () => {
  const s = fakeSeed({ ...acmeServer, fake: undefined })
  assert.deepEqual(s.concepts.chat.map((c) => c.id), acme.demo.chats.map((c) => c.id))
  assert.deepEqual(Object.keys(s.threads), acme.demo.chats.map((c) => c.id))
  assert.deepEqual(s.concepts.mail.map((m) => m.id), acme.demo.mail!.map((m) => m.id))
  assert.deepEqual(s.concepts.cal.map((e) => e.id), acme.demo.cal!.map((e) => e.id))
  assert.deepEqual(s.concepts.board.map((b) => b.id), acme.demo.board!().map((b) => b.id))
  assert.ok(s.concepts.time.length > 0)
  assert.equal(s.concepts.review, undefined, 'only an own fake() knows its reviews, work items and builds')
  const bare = fakeSeed({ ...acmeServer, fake: undefined, page: { ...acme, demo: { jobs: [], chats: [], log: [] } } })
  assert.deepEqual(bare, { concepts: { chat: [], mail: [], cal: [], board: [], time: [] }, threads: {} })
  const own = fakeSeed(acmeServer)
  assert.ok(own.concepts.review.length > 0 && own.concepts.work.length > 0 && own.concepts.ci.length > 0)
})

test('gatewaySource reads through the token it is given, else through the token file', async () => {
  const fake = await startFakeGateway({ seed: fakeSeed(acmeServer) })
  const dir = mkdtempSync(join(tmpdir(), 'wc-src-')), tok = join(dir, 'console.token')
  writeFileSync(tok, fake.token + '\n')
  const cfg: WsConfig = { gatewayUrl: fake.url, consoleTokenPath: tok, llmTokenPath: tok, workDir: dir, runTools: [], teamTz: null, maxSessions: 1 }
  const a = gatewaySource(cfg, { bus: new Bus(), token: () => fake.token }), b = gatewaySource(cfg, { bus: new Bus() })
  try {
    for (const src of [a, b]) assert.equal((await src.read(['chat'])).chat.status, 'ok')
    await assert.rejects(gatewaySource({ ...cfg, consoleTokenPath: join(dir, 'none') }, { bus: new Bus() }).read(['chat']), (e: unknown) => e instanceof GatewayError && e.code === 'unauthorized')
  } finally { a.stop(); b.stop(); await fake.close() }
})
