import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRegistry, newWorkspaceIssue, render, TEMPLATE, varName } from './template.ts'

test('the template renders with no placeholder left; the variable is a safe identifier', () => {
  for (const f of ['page.ts', 'server.ts']) {
    const t = render(readFileSync(join(TEMPLATE, f), 'utf8'), { id: 'my-crm', prefix: 'CRM', title: 'My CRM' })
    assert.doesNotMatch(t, /__[A-Z]+__/, f)
    assert.match(t, /myCrm/)
  }
  assert.match(render(readFileSync(join(TEMPLATE, 'page.ts'), 'utf8'), { id: 'my-crm', prefix: 'CRM', title: 'My CRM' }), /id: 'my-crm'/)
  assert.match(render(readFileSync(join(TEMPLATE, 'server.ts'), 'utf8'), { id: 'my-crm', prefix: 'CRM', title: 'My CRM' }), /jobPrefix: 'CRM'/)
  assert.equal(varName('a-b-2c'), 'aB2c')
  assert.equal(varName('new'), 'wsNew')
  assert.equal(varName('class-x'), 'classX')
})

test('addRegistry adds an import and an entry to either registry, one line or many', () => {
  const page = "import type { Registered } from '../src/workspace.ts'\nimport acme from './acme/page.ts'\n\n/* x */\nexport const WORKSPACES: Registered[] = [{ page: acme }]\n"
  assert.equal(addRegistry(page, 'page', 'my-crm'),
    "import type { Registered } from '../src/workspace.ts'\nimport acme from './acme/page.ts'\nimport myCrm from './my-crm/page.ts'\n\n/* x */\nexport const WORKSPACES: Registered[] = [{ page: acme }, { page: myCrm }]\n")
  const server = "import type { WorkspaceServer } from '../server/workspace.ts'\r\nimport homeServer from './home/server.ts'\r\n\r\nexport const SERVERS: WorkspaceServer[] = [\r\n  homeServer,\r\n]\r\n"
  assert.equal(addRegistry(server, 'server', 'my-crm'),
    "import type { WorkspaceServer } from '../server/workspace.ts'\r\nimport homeServer from './home/server.ts'\r\nimport myCrmServer from './my-crm/server.ts'\r\n\r\nexport const SERVERS: WorkspaceServer[] = [\r\n  homeServer,\r\n  myCrmServer,\r\n]\r\n")
  const empty = "import type { WorkspaceServer } from '../server/workspace.ts'\nexport const SERVERS: WorkspaceServer[] = []\n"
  assert.equal(addRegistry(empty, 'server', 'x'), "import type { WorkspaceServer } from '../server/workspace.ts'\nimport xServer from './x/server.ts'\nexport const SERVERS: WorkspaceServer[] = [xServer]\n")
  assert.throws(() => addRegistry(page, 'page', 'acme'), /already registers acme/)
  assert.throws(() => addRegistry('export const OTHER = []\n', 'page', 'x'), /no WORKSPACES array/)
})

test('a new workspace needs a free id, prefix and folder and a plain title', () => {
  const taken = { ids: ['home'], prefixes: ['H'], exists: (id: string) => id === 'old' }
  assert.equal(newWorkspaceIssue({ id: 'crm', prefix: 'CRM', title: 'My CRM' }, taken), null)
  for (const [o, why] of [
    [{ id: 'Crm', prefix: 'CRM', title: 't' }, /id Crm must match/],
    [{ id: 'crm', prefix: 'crm', title: 't' }, /prefix crm must match/],
    [{ id: 'home', prefix: 'X', title: 't' }, /home is taken/],
    [{ id: 'crm', prefix: 'H', title: 't' }, /prefix H is taken by another workspace/],
    [{ id: 'old', prefix: 'X', title: 't' }, /workspaces\/old already exists/],
    [{ id: 'crm', prefix: 'X', title: "it's" }, /title/],
    [{ id: 'crm', prefix: 'X', title: 'a */ b' }, /title/],
    [{ id: 'crm', prefix: 'X', title: '' }, /title/],
  ] as const) assert.match(newWorkspaceIssue(o, taken) ?? '', why, JSON.stringify(o))
})
