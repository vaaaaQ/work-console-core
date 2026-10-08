import { readFileSync } from 'node:fs'
import { pgSource } from '../../server/store/pg.ts'
import type { PgSource } from '../../server/store/pg.ts'
import type { WorkspaceServer, WsConfig } from '../../server/workspace.ts'
import __VAR__ from './page.ts'

/* __TITLE__: the server half. Its jobs live in the console's own PostgreSQL, from pgUrl and pgPasswordPath under
   workspaces.__ID__ in config.json. Its runs' tools and MCP servers come from grants.json, never from here. */
const need = (cfg: WsConfig, key: string) => {
  const v = cfg[key]
  if (typeof v !== 'string' || !v) throw new Error(`workspaces.${__VAR__.id}.${key} is missing in config.json`)
  return v
}

const __VAR__Server: WorkspaceServer = {
  page: __VAR__, jobPrefix: '__PREFIX__',
  defaults: { pgSchema: 'work_console' },
  source: (cfg, { bus }) => {
    const passwordPath = need(cfg, 'pgPasswordPath')
    return pgSource({ url: need(cfg, 'pgUrl'), password: () => readFileSync(passwordPath, 'utf8').trim(), schema: cfg.pgSchema as string, ws: __VAR__.id, bus })
  },
  store: (src, _cfg, o) => (src as PgSource).store(o),
  llm: { bridge: false },
}
export default __VAR__Server
