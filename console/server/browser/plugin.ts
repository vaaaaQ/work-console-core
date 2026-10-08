import { HttpError } from '../events.ts'
import { isLocal } from '../bridge/local.ts'
import type { Plugin, Source } from '../workspace.ts'

/* The console's routes for a local source: the browser's status, and a sign-in tab brought to the front so the
   person can finish signing in there. A workspace on a gateway gets none. */

export function browserPlugin(source: Source): Plugin[] {
  if (!isLocal(source)) return []
  return [{
    name: 'browser',
    routes: [
      ['GET', /^\/browser\/status$/, async () => source.status()],
      ['POST', /^\/browser\/front$/, async (r) => {
        const { host } = await r.body()
        if (typeof host !== 'string' || !host) throw new HttpError(400, 'bad_request', 'front needs the host of a tab')
        await source.front(host)
        return { ok: true }
      }],
    ],
    state: () => source.status(),
  }]
}
