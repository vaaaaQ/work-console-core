import { join } from 'node:path'
import { consoleHome } from '../../scripts/lib.mjs'
import { PG_DOWN } from '../../scripts/workspaces.mjs'
import { configGrants } from '../../server/browser/packs.ts'
import { localSource } from '../../server/bridge/local.ts'
import type { WorkspaceServer } from '../../server/workspace.ts'
import __VAR__ from './page.ts'

/* __TITLE__: the server half. Its jobs live in the console's own PostgreSQL, from pgUrl and pgPasswordPath under
   workspaces.__ID__ in config.json, and it is down until they are there. What it reads and does comes from the packs
   its grants.json names, run in the console's own Edge, which starts only once a pack is granted; runs then read them
   through the run MCP it serves on a free loopback port. */
const __VAR__Server: WorkspaceServer = {
  page: __VAR__, jobPrefix: '__PREFIX__',
  defaults: { pgSchema: 'work_console', gatewayUrl: 'http://127.0.0.1:0', llmTokenPath: join(consoleHome(), 'llm-__ID__.token') },
  source: (cfg, o) => localSource(cfg, { ...o, needDb: PG_DOWN, mcp: (o.grants ?? configGrants)(cfg).packs.length > 0 }),
}
export default __VAR__Server
