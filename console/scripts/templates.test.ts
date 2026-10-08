import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { consoleHome } from './lib.mjs'
import { EMPTY_GRANTS_JSON, HOME, PG_DOWN, render } from './workspaces.mjs'
import { tempDir } from '../server/testdirs.ts'

/* consumer/ holds what install.mjs and create_workspace write into a console's workspaces/: two empty registries and
   the one workspace template, here rendered for home into a temp dir whose imports point back at this console. */

async function renderHome(): Promise<{ page: WorkspacePage; server: WorkspaceServer }> {
  const dir = tempDir('template'), ws = join(dir, 'home')
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

test('the template rendered for home is one valid workspace that starts a core playbook, its run MCP on a loopback port of its own', async () => {
  const { page, server } = await renderHome()
  checkWorkspaces([server])
  assert.equal(page.id, 'home')
  assert.equal(server.jobPrefix, 'H')
  assert.equal(server.page, page)
  assert.ok(CORE_PB[page.board.start], 'its board starts a core playbook')
  assert.equal(server.defaults?.pgSchema, 'work_console')
  assert.equal(server.llm, undefined, 'its source says whether runs get the bridge tools')
  assert.equal(server.defaults?.gatewayUrl, 'http://127.0.0.1:0', 'a free port, never the gateway on 47821')
  assert.equal(server.defaults?.llmTokenPath, join(consoleHome(), 'llm-home.token'), "its own token, not the gateway's in ~/.bridge")
  assert.equal(server.store, undefined, 'its jobs are B, kept by the local source')
})

test('home is a local source; without a database address it is down, as its store, saying what install says', async () => {
  const { server } = await renderHome()
  const home = tempDir('template-home')
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

test("with a pack granted, home serves the run MCP's read tools on a free port and its own token; with none it serves nothing", async () => {
  const { server } = await renderHome()
  const home = tempDir('template-home'), token = join(home, 'llm.token')
  const granted = () => ({ packs: ['not-installed'], hosts: [], config: {} })
  const none = server.source!(cfg(server, { llmTokenPath: token }), { bus: new Bus(), ws: 'home', home, grants: () => ({ packs: [], hosts: [], config: {} }) })
  assert.ok(isLocal(none) && none.mcp === false)
  const src = server.source!(cfg(server, { llmTokenPath: token }), { bus: new Bus(), ws: 'home', home, grants: granted })
  assert.ok(isLocal(src) && src.mcp === true)
  src.start()
  try {
    await until(() => !!src.status().mcp || !!src.status().mcpError)
    const url = new URL(src.status().mcp!)
    assert.equal(url.hostname, '127.0.0.1')
    assert.ok(Number(url.port) > 0 && Number(url.port) !== 47821, url.href)
    assert.equal(url.pathname, '/mcp')
    assert.ok(existsSync(token), 'the token is made where its config says')
    assert.equal(src.status().browser.state, 'off', 'a pack that did not load starts no Edge')
  } finally { src.stop() }
})

test("an empty grants.json from install is the one the console writes for a new workspace", () => {
  const root = tempDir('template-grants')
  mkdirSync(join(root, 'workspaces', 'x'), { recursive: true })
  writeGrants(root, 'x', EMPTY_GRANTS)
  assert.equal(readFileSync(join(root, 'workspaces', 'x', 'grants.json'), 'utf8'), EMPTY_GRANTS_JSON)
})
