import { readFileSync } from 'node:fs'
import { pgSource } from '../../server/store/pg.ts'
import type { PgSource } from '../../server/store/pg.ts'
import type { WorkspaceServer, WsConfig } from '../../server/workspace.ts'
import home from './page.ts'

/* Home: the server half. Its jobs live in the console's own PostgreSQL; install.mjs writes pgUrl and
   pgPasswordPath under workspaces.home in config.json once the container is up, and until then home is down. */
const str = (cfg: WsConfig, key: string) => (typeof cfg[key] === 'string' && cfg[key] ? cfg[key] as string : null)

const homeServer: WorkspaceServer = {
  page: home, jobPrefix: 'H',
  defaults: { pgSchema: 'work_console' },
  // the password is read on every connect, so a new one needs no restart
  source: (cfg, { bus }) => {
    const url = str(cfg, 'pgUrl'), passwordPath = str(cfg, 'pgPasswordPath')
    return pgSource({
      url: url && passwordPath ? url : null, unset: 'Postgres not running — start Docker and run install again',
      password: passwordPath ? () => readFileSync(passwordPath, 'utf8').trim() : undefined, schema: cfg.pgSchema as string, ws: home.id, bus,
    })
  },
  store: (src, _cfg, o) => (src as PgSource).store(o),
  llm: { bridge: false },
}
export default homeServer
