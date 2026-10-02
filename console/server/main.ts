import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import { createServer as createTls } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as T from '../src/model/transitions.ts'
import type { Job } from '../src/model/types.ts'
import { install } from '../src/workspace.ts'
import { SERVERS } from '../workspaces/server.ts'
import type { FakeGateway } from './bridge/fake.ts'
import { loadConfig, readRaw, readToken, wsConfigs } from './config.ts'
import type { Config } from './config.ts'
import { Bus } from './events.ts'
import { createApp } from './http/app.ts'
import type { Sdk } from './llm/sdk.ts'
import { ensureToken, jobTools, mcpHandler } from './mcp/mcp.ts'
import { Notify } from './notify/notify.ts'
import { Reminders } from './notify/reminders.ts'
import { Pairing } from './pairing/pairing.ts'
import { hub, makeSpace, Spaces } from './spaces.ts'
import type { Space } from './spaces.ts'
import { checkWorkspaces } from './workspace.ts'
import type { WorkspaceServer } from './workspace.ts'

/* Wiring. Loopback always; LAN only once install.ps1 has made tls/server.key and tls/server.crt.
   One space per registered workspace (spaces.ts), each with its own gateway, store, jobs and runner;
   push, reminders, pairing and the MCP token are shared. A workspace's state lives in B on its workplace.
   While it is away the console still starts and answers: no jobs, built-in playbooks, every write 503;
   its runs in flight are interrupted, never queued for later. When the bridge comes back the state is
   loaded and stray runs are swept. */

const PKG = fileURLToPath(new URL('../', import.meta.url))

/** a review or build names a job when the job key's number appears in it as a whole token */
export function jobByText(jobs: Iterable<Job>, text: string): Job | undefined {
  for (const j of jobs) {
    if (T.isClosed(j)) continue
    const n = j.key.replace(/^[A-Za-z]+-/, '')
    if (n.length >= 3 && new RegExp(`(^|[^0-9A-Za-z])${n.replace(/[^\w-]/g, '')}([^0-9A-Za-z]|$)`).test(text)) return j
  }
  return undefined
}

async function listen(s: Server, port: number, host: string) {
  await new Promise<void>((ok, no) => { s.once('error', no); s.listen(port, host, () => { s.off('error', no); ok() }) })
  return (s.address() as AddressInfo).port
}

export async function main(o: { cfg?: Config; sdk?: Sdk; workspaces?: WorkspaceServer[] } = {}) {
  const workspaces = o.workspaces ?? SERVERS
  checkWorkspaces(workspaces)
  // the packs, playbooks and demo data come from the registered workspaces
  install(workspaces.map((w) => ({ page: w.page })))
  const cfg = o.cfg ?? loadConfig()
  const cfgs = wsConfigs(cfg, workspaces, readRaw(cfg.home), (l) => console.log(l))
  const artifactsDir = join(cfg.home, 'artifacts')

  let notify: Notify | null = null
  const push = (t: string, b: string, u: string) => notify!.push(t, b, u)
  const list: Space[] = []
  try {
    for (const w of workspaces) list.push(await makeSpace(w, { cfg: cfgs[w.page.id], home: cfg.home, artifactsDir, sdk: o.sdk, fake: cfg.fakeGateway, push }))
  } catch (e) { for (const s of list) await s.close(); throw e }
  const spaces = new Spaces(list), bus = new Bus(), unhub = hub(list, bus)
  const allKnown = function* () { for (const s of list) yield* s.known.values() }

  // before any source starts, so the runs a restart interrupted are pushed too
  notify = new Notify({
    dir: cfg.home, bus, ctx: () => spaces.ctx(),
    jobs: { onNeedsYou: (f) => { for (const s of list) s.onNeedsYou(f) } },
    runs: { onSettled: (f) => { for (const s of list) s.runner.onSettled(f) } },
    jobFor: (t, ws) => jobByText(ws ? list.find((s) => s.id === ws)?.known.values() ?? [] : allKnown(), t),
    job: (id) => { for (const s of list) { const j = s.known.get(id); if (j) return j } return undefined },
  })
  const reminders = new Reminders({ dir: cfg.home, jobs: allKnown, push }).start()
  const pairing = new Pairing(cfg.home)
  const mcpToken = ensureToken(join(cfg.home, 'mcp.token'))

  let app: ReturnType<typeof createApp> | null = null
  const open: Server[] = []
  /** every space is closed even when one fails; the first failure is rethrown after the rest */
  async function close() {
    reminders.stop(); app?.close()
    const r = await Promise.allSettled(list.map((s) => s.close()))
    unhub()
    for (const s of open) { s.closeAllConnections(); await new Promise((ok) => s.close(ok)) }
    const bad = r.find((x) => x.status === 'rejected')
    if (bad) throw bad.reason
  }

  const late = (side: 'loopback' | 'lan'): RequestListener => (q, s) => app![side](q, s)
  const loop = createServer(late('loopback'))
  const key = join(cfg.home, 'tls', 'server.key'), crt = join(cfg.home, 'tls', 'server.crt')
  const lan = existsSync(key) && existsSync(crt) ? createTls({ key: readFileSync(key), cert: readFileSync(crt) }, late('lan')) : null
  let loopbackPort: number, lanPort: number | null = null
  try {
    loopbackPort = await listen(loop, cfg.loopbackPort, '127.0.0.1'); open.push(loop)
    if (lan) { lanPort = await listen(lan, cfg.lanPort, '0.0.0.0'); open.push(lan) }
  } catch (e) {
    // a taken port: what was made so far would otherwise keep the process alive
    await close().catch(() => {})
    throw e
  }

  const first = list[0]
  app = createApp({
    loopbackPort, lanPort: lanPort ?? cfg.lanPort, pcName: cfg.pcName, hub: bus, spaces, pairing, notify,
    staticDirs: [join(PKG, 'dist'), join(PKG, 'public')], artifactsDir, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // first space until Task 9: the job tools still serve one workspace
    mcp: mcpHandler({ tools: jobTools({ jobs: first.jobs, ctx: first.ctx, start: first.start }), token: () => readToken(mcpToken) }),
  })
  for (const s of list) s.source.start()
  const fakes: Record<string, FakeGateway> = Object.fromEntries(list.flatMap((s) => (s.fake ? [[s.id, s.fake]] : [])))
  console.log(`work console on http://127.0.0.1:${loopbackPort}${lanPort ? ` and https://${cfg.pcName}:${lanPort}` : ' (no LAN: run scripts/install.ps1 for a certificate)'}, workspaces ${list.map((s) => s.id).join(', ')}${cfg.fakeGateway ? ', fake gateways' : ''}`)

  return {
    loopbackPort, lanPort, hub: bus, spaces, fakes, mcpToken, close,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((m) => {
    const stop = () => { void m.close().finally(() => process.exit(0)) }
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
  }, (e) => { console.error('the console failed to start:', e); process.exit(1) })
}
