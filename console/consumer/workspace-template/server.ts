import { localSource } from '../../server/bridge/local.ts'
import type { WorkspaceServer } from '../../server/workspace.ts'
import __VAR__ from './page.ts'

/* __TITLE__: the server half. Its jobs live in the console's own PostgreSQL, from pgUrl and pgPasswordPath under
   workspaces.__ID__ in config.json, and it is down until they are there. What it reads and does comes from the packs
   its grants.json names, run in the console's own Edge, which starts only once a pack is granted. */
const __VAR__Server: WorkspaceServer = {
  page: __VAR__, jobPrefix: '__PREFIX__',
  defaults: { pgSchema: 'work_console' },
  source: (cfg, o) => localSource(cfg, { ...o, needDb: 'Postgres not running — start Docker and run install again' }),
  llm: { bridge: false },
}
export default __VAR__Server
