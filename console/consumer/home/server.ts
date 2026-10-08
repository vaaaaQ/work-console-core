import { readFileSync } from 'node:fs'
import { pgSource } from '../../server/store/pg.ts'
import type { PgSource } from '../../server/store/pg.ts'
import type { WorkspaceServer, WsConfig } from '../../server/workspace.ts'
import home from './page.ts'

/* Home: the server half. Its jobs live in the console's own PostgreSQL; install.mjs writes pgUrl and
   pgPasswordPath under workspaces.home in config.json. */
const need = (cfg: WsConfig, key: string) => {
  const v = cfg[key]
  if (typeof v !== 'string' || !v) throw new Error(`workspaces.${home.id}.${key} is missing in config.json: run scripts/install.mjs again`)
  return v
}

const homeServer: WorkspaceServer = {
  page: home, jobPrefix: 'H',
  defaults: { pgSchema: 'work_console' },
  // the password is read on every connect, so a new one needs no restart
  source: (cfg, { bus }) => {
    const passwordPath = need(cfg, 'pgPasswordPath')
    return pgSource({ url: need(cfg, 'pgUrl'), password: () => readFileSync(passwordPath, 'utf8').trim(), schema: cfg.pgSchema as string, ws: home.id, bus })
  },
  store: (src, _cfg, o) => (src as PgSource).store(o),
  llm: { bridge: false },
}
export default homeServer
