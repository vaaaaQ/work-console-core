import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CORE_PB } from '../src/data/playbooks.ts'
import { Bus } from '../server/events.ts'
import { checkWorkspaces, type WsConfig } from '../server/workspace.ts'
import { WORKSPACES } from '../consumer/page.ts'
import { SERVERS } from '../consumer/server.ts'

/* consumer/ holds what install.mjs writes into a new console's workspaces/: the two registries and the home workspace. */

const cfg = (own: Record<string, unknown>) => ({ ...SERVERS[0].defaults, ...own }) as WsConfig

test('the consumer templates register one valid workspace, home', () => {
  checkWorkspaces(SERVERS)
  assert.deepEqual(SERVERS.map((s) => s.page.id), ['home'])
  assert.equal(WORKSPACES.length, 1)
  assert.equal(WORKSPACES[0].page, SERVERS[0].page)
  assert.ok(CORE_PB[SERVERS[0].page.board.start], 'its board starts a core playbook')
})

test('home keeps its jobs in Postgres, schema work_console, without a bridge', () => {
  const home = SERVERS[0]
  assert.equal(home.defaults?.pgSchema, 'work_console')
  assert.equal(home.llm?.bridge, false)
  assert.ok(home.source && home.store)
})

test('home names the config.json key it misses', () => {
  assert.throws(() => SERVERS[0].source!(cfg({ pgPasswordPath: 'x' }), { bus: new Bus() }), /workspaces\.home\.pgUrl/)
  assert.throws(() => SERVERS[0].source!(cfg({ pgUrl: 'postgres://u@127.0.0.1:1/db' }), { bus: new Bus() }), /workspaces\.home\.pgPasswordPath/)
})

test('home builds a Postgres source from config.json', () => {
  const src = SERVERS[0].source!(cfg({ pgUrl: 'postgres://work_console@127.0.0.1:55432/work_console', pgPasswordPath: 'nowhere' }), { bus: new Bus() })
  assert.equal(src.available(), false)
  assert.equal(typeof (src as unknown as { store: unknown }).store, 'function')
  src.stop()
})
