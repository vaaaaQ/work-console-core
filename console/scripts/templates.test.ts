import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CORE_PB } from '../src/data/playbooks.ts'
import type { WorkspacePage } from '../src/workspace.ts'
import { isLocal } from '../server/bridge/local.ts'
import { CONSOLE } from '../server/config.ts'
import { Bus } from '../server/events.ts'
import { EMPTY_GRANTS, writeGrants } from '../server/grants.ts'
import { checkWorkspaces, type WorkspaceServer, type WsConfig } from '../server/workspace.ts'
import { WORKSPACES } from '../consumer/page.ts'
import { SERVERS } from '../consumer/server.ts'
import { PG_DOWN } from './install.mjs'
import { EMPTY_GRANTS_JSON, HOME, render } from './workspaces.mjs'

/* consumer/ holds what install.mjs and create_workspace write into a console's workspaces/: two empty registries and
   the one workspace template, here rendered for home into a temp dir whose imports point back at this console. */

const made: string[] = []
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

async function renderHome(): Promise<{ page: WorkspacePage; server: WorkspaceServer }> {
  const dir = mkdtempSync(join(tmpdir(), 'wc-template-')), ws = join(dir, 'home')
  made.push(dir)
  mkdirSync(ws)
  const root = pathToFileURL(CONSOLE).href + '/'
  for (const f of ['page.ts', 'server.ts']) {
    const text = render(readFileSync(join(CONSOLE, 'consumer', 'workspace-template', f), 'utf8'), HOME)
    writeFileSync(join(ws, f), text.replaceAll("from '../../", `from '${root}`))
  }
  const [page, server] = await Promise.all(['page.ts', 'server.ts'].map((f) => import(pathToFileURL(join(ws, f)).href)))
  return { page: page.default, server: server.default }
}
const cfg = (s: WorkspaceServer, own: Record<string, unknown>) => ({ ...s.defaults, ...own }) as WsConfig
const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end && !f()) await new Promise((ok) => setTimeout(ok, 10))
  assert.ok(f(), 'timed out')
}

test('the registries start empty; install and create_workspace add each workspace to them', () => {
  assert.deepEqual(WORKSPACES, [])
  assert.deepEqual(SERVERS, [])
})

test('the template rendered for home is one valid workspace that starts a core playbook, without a bridge', async () => {
  const { page, server } = await renderHome()
  checkWorkspaces([server])
  assert.equal(page.id, 'home')
  assert.equal(server.jobPrefix, 'H')
  assert.equal(server.page, page)
  assert.ok(CORE_PB[page.board.start], 'its board starts a core playbook')
  assert.equal(server.defaults?.pgSchema, 'work_console')
  assert.equal(server.llm?.bridge, false)
  assert.equal(server.store, undefined, 'its jobs are B, kept by the local source')
})

test('home is a local source; without a database address it is down, as its store, saying what install says', async () => {
  const { server } = await renderHome()
  const home = mkdtempSync(join(tmpdir(), 'wc-template-home-'))
  made.push(home)
  for (const own of [{}, { pgUrl: 'postgres://u@127.0.0.1:1/x' }, { pgPasswordPath: 'x' }]) {
    const src = server.source!(cfg(server, own), { bus: new Bus(), ws: 'home', home })
    assert.ok(isLocal(src))
    assert.equal(src.via, 'store')
    src.start()
    try {
      await until(() => src.why!() !== '')
      assert.equal(src.available(), false)
      assert.equal(src.why!(), PG_DOWN)
      assert.equal(src.status().browser.state, 'off', 'no pack granted, no Edge')
    } finally { src.stop() }
  }
})

test("an empty grants.json from install is the one the console writes for a new workspace", () => {
  const root = mkdtempSync(join(tmpdir(), 'wc-template-grants-'))
  made.push(root)
  mkdirSync(join(root, 'workspaces', 'x'), { recursive: true })
  writeGrants(root, 'x', EMPTY_GRANTS)
  assert.equal(readFileSync(join(root, 'workspaces', 'x', 'grants.json'), 'utf8'), EMPTY_GRANTS_JSON)
})
