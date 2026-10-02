import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import { createServer as createTls } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TPL0 } from '../src/data/demo.ts'
import { PB0 } from '../src/data/playbooks.ts'
import * as T from '../src/model/transitions.ts'
import type { Job, Playbook } from '../src/model/types.ts'
import { install } from '../src/workspace.ts'
import acme from '../workspaces/acme/page.ts'
import { BoardReturns } from './board/returns.ts'
import { startItem } from './board/start.ts'
import { BridgeClient } from './bridge/client.ts'
import { startFakeGateway } from './bridge/fake.ts'
import { READY } from './bridge/wire.ts'
import { loadConfig, readToken } from './config.ts'
import type { Config } from './config.ts'
import { Bus } from './events.ts'
import { createApp } from './http/app.ts'
import { Jobs } from './jobs/jobs.ts'
import { resolveContext } from './llm/context.ts'
import { Runner } from './llm/runner.ts'
import { agentSdk } from './llm/sdk.ts'
import type { Sdk } from './llm/sdk.ts'
import { ensureToken, jobTools, mcpHandler } from './mcp/mcp.ts'
import { Notify } from './notify/notify.ts'
import { Reminders } from './notify/reminders.ts'
import { Pairing } from './pairing/pairing.ts'
import { bridgeStore } from './store/bridge.ts'

/* Wiring. Loopback always; LAN only once install.ps1 has made tls/server.key and tls/server.crt.
   The console's state lives in B on the workplace. While it is away the console still starts and
   answers: no jobs, built-in playbooks, every write 503; runs in flight are interrupted, never queued
   for later. When the bridge comes back the state is loaded and stray runs are swept. */

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

/** load runs on the first ok and on each unavailable → ok, retried with backoff until it succeeds
    or the bridge goes away; a concept flip while up is not a comeback */
export function onBridgeBack(bus: Bus, load: () => Promise<void>, backoff = [2000, 5000, 10000, 30000]) {
  let up = false, gen = 0, timer: ReturnType<typeof setTimeout> | undefined
  const attempt = async (g: number, n: number) => {
    try { await load() } catch (e) {
      if (g !== gen) return
      console.error('loading the state from the bridge failed:', (e as Error).message)
      timer = setTimeout(() => void attempt(g, n + 1), backoff[Math.min(n, backoff.length - 1)])
    }
  }
  const off = bus.on((e) => {
    if (e.kind !== 'bridge') return
    const was = up; up = e.state === 'ok'
    if (up === was) return
    gen++; clearTimeout(timer)
    if (up) void attempt(gen, 0)
  })
  return () => { off(); gen++; clearTimeout(timer) }
}

async function listen(s: Server, port: number, host: string) {
  await new Promise<void>((ok, no) => { s.once('error', no); s.listen(port, host, () => { s.off('error', no); ok() }) })
  return (s.address() as AddressInfo).port
}

export async function main(o: { cfg?: Config; sdk?: Sdk } = {}) {
  // the packs, playbooks and demo data come from the registered workspaces
  install([{ page: acme }])
  const cfg = o.cfg ?? loadConfig()
  const bus = new Bus()
  const fake = cfg.fakeGateway ? await startFakeGateway() : null
  const gatewayUrl = fake?.url ?? cfg.gatewayUrl
  const bridge = new BridgeClient({ url: gatewayUrl, token: () => (fake ? fake.token : readToken(cfg.consoleTokenPath)), bus })
  const gate = () => bridge.available()
  const store = bridgeStore({ bridge, bus, playbooks: PB0 })
  // until B answers, the built-in playbooks stand in
  let PB: Record<string, Playbook> = structuredClone(PB0)
  const ctx = (): T.Ctx => ({ PB, TPL: TPL0 })

  const jobs = new Jobs({ store, bus, ctx, gate })
  const sdk = o.sdk ?? agentSdk({ gatewayUrl, llmToken: () => (fake ? fake.llmToken : readToken(cfg.llmTokenPath)), runTools: cfg.runTools })
  const artifactsDir = join(cfg.home, 'artifacts')
  const runner = new Runner({ store, jobs, bus, sdk, cwd: cfg.workDir, max: cfg.maxSessions, gate, artifactsDir, ctx, context: (j) => resolveContext(bridge, j) })
  bus.on((e) => {
    if (e.kind === 'bridge' && e.state === 'unavailable')
      void runner.interruptAll('the bridge went away').catch((err) => console.error('interrupting runs:', (err as Error).message))
  })

  const known = new Map<string, Job>()
  bus.on((e) => { if (e.kind === 'job') known.set(e.job.id, e.job) })
  const returns = new BoardReturns({
    bus, jobs, ctx, push: (t, b, u) => notify.push(t, b, u),
    read: async () => { const r = (await bridge.read(['board'])).board; return r && READY.has(r.status) && Array.isArray(r.items) ? (r.items as { id: string }[]) : null },
  })
  // a QA return pushes its own message; the reopen and note it makes would push a second one
  const quiet = { onNeedsYou: (f: (j: Job) => void) => jobs.onNeedsYou((j) => { if (!returns.handling(j.id)) f(j) }) }
  const notify = new Notify({ dir: cfg.home, bus, ctx, jobs: quiet, runs: runner, jobFor: (t) => jobByText(known.values(), t), job: (id) => known.get(id) })
  const reminders = new Reminders({ dir: cfg.home, jobs: () => known.values(), push: (t, b, u) => notify.push(t, b, u) }).start()
  // after the notifier, so the runs a restart interrupted are pushed too
  let recovered = false
  const onBridgeUp = async () => {
    PB = await store.playbooks()
    for (const j of await store.jobs()) known.set(j.id, j)
    await runner.recover(recovered ? 'the bridge went away' : 'the console restarted')
    recovered = true
  }
  const stopLoading = onBridgeBack(bus, onBridgeUp)
  const pairing = new Pairing(cfg.home)
  const mcpToken = ensureToken(join(cfg.home, 'mcp.token'))

  let app: ReturnType<typeof createApp> | null = null
  const late = (side: 'loopback' | 'lan'): RequestListener => (q, s) => app![side](q, s)
  const loop = createServer(late('loopback'))
  const loopbackPort = await listen(loop, cfg.loopbackPort, '127.0.0.1')
  const key = join(cfg.home, 'tls', 'server.key'), crt = join(cfg.home, 'tls', 'server.crt')
  const lan = existsSync(key) && existsSync(crt) ? createTls({ key: readFileSync(key), cert: readFileSync(crt) }, late('lan')) : null
  const lanPort = lan ? await listen(lan, cfg.lanPort, '0.0.0.0') : null

  app = createApp({
    loopbackPort, lanPort: lanPort ?? cfg.lanPort, pcName: cfg.pcName, bus, store, jobs, runner, bridge, pairing, notify, ctx,
    putPlaybook: async (id, pb) => { await store.putPlaybook(id, pb); PB = await store.playbooks() },
    staticDirs: [join(PKG, 'dist'), join(PKG, 'public')], artifactsDir, tz: cfg.teamTz,
    mcp: mcpHandler({ tools: jobTools({ jobs, ctx, start: startItem({ jobs, ctx, bridge }) }), token: () => readToken(mcpToken) }),
  })
  bridge.start()
  console.log(`work console on http://127.0.0.1:${loopbackPort}${lanPort ? ` and https://${cfg.pcName}:${lanPort}` : ' (no LAN: run scripts/install.ps1 for a certificate)'}${fake ? ', fake gateway' : ''}`)

  return {
    loopbackPort, lanPort, bus, jobs, runner, fake, mcpToken,
    async close() {
      stopLoading(); reminders.stop(); app!.close(); bridge.stop()
      for (const s of [loop, lan]) if (s) { s.closeAllConnections(); await new Promise((r) => s.close(r)) }
      await fake?.close()
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((m) => {
    const stop = () => { void m.close().finally(() => process.exit(0)) }
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
  }, (e) => { console.error('the console failed to start:', e); process.exit(1) })
}
