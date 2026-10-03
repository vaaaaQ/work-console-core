import { CORE_PB, CORE_TPL } from '../src/data/playbooks.ts'
import * as T from '../src/model/transitions.ts'
import type { Job, Playbook } from '../src/model/types.ts'
import type { WorkspacePage } from '../src/workspace.ts'
import { BoardReturns } from './board/returns.ts'
import { startItem } from './board/start.ts'
import { startFakeGateway } from './bridge/fake.ts'
import type { FakeGateway } from './bridge/fake.ts'
import { READY } from './bridge/wire.ts'
import { readToken } from './config.ts'
import { Bus, HttpError } from './events.ts'
import { Jobs } from './jobs/jobs.ts'
import { resolveContext } from './llm/context.ts'
import { Runner } from './llm/runner.ts'
import { agentSdk } from './llm/sdk.ts'
import type { Sdk } from './llm/sdk.ts'
import { withWs } from './notify/notify.ts'
import { bridgeStore } from './store/bridge.ts'
import type { Store } from './store/port.ts'
import { fakeSeed, gatewaySource } from './workspace.ts'
import type { Plugin, Source, WorkspaceServer, WsConfig } from './workspace.ts'

/* One instance per workspace: its own gateway source, store, jobs and runner on its own bus. The hub
   re-emits every space's events on one shared bus tagged with the workspace id, for the services all
   spaces share (push, the page's event stream). A space's gateway going away interrupts only its runs. */

export type Push = (title: string, body: string, url: string) => Promise<void>

export interface Space {
  id: string; page: WorkspacePage; prefix: string; cfg: WsConfig
  bus: Bus; source: Source; store: Store; jobs: Jobs; runner: Runner
  ctx(): T.Ctx; putPlaybook(id: string, pb: Playbook | null): Promise<void>
  start: ReturnType<typeof startItem>; plugins: Plugin[]; known: Map<string, Job>; fake: FakeGateway | null
  /** needs-you, less the jobs a QA return pushes about itself */
  onNeedsYou(f: (j: Job) => void): void
  /** stops loading, the source and the fake gateway */
  close(): Promise<void>
}

export class Spaces {
  readonly list: Space[]
  constructor(list: Space[]) { this.list = list }

  get(id: string): Space {
    const s = this.list.find((x) => x.id === id)
    if (!s) throw new HttpError(404, 'no_workspace', `no workspace ${id}`)
    return s
  }

  /** the space whose prefix the job id carries before its first dash */
  byJob(jobId: string): Space {
    const i = jobId.indexOf('-'), s = i > 0 ? this.list.find((x) => x.prefix === jobId.slice(0, i)) : undefined
    if (!s) throw new HttpError(404, 'not_found', `no job ${jobId}`)
    return s
  }

  /** the named space; none named, the only one, else a 400 naming them all. Only a string names one */
  pick(ws: unknown): Space {
    if (typeof ws === 'string' && ws !== '') return this.get(ws)
    if (ws !== undefined && ws !== null && ws !== '') throw new HttpError(404, 'no_workspace', `no workspace ${JSON.stringify(ws)}`)
    if (this.list.length === 1) return this.list[0]
    throw new HttpError(400, 'bad_args', `say which workspace: ${this.list.map((s) => s.id).join(', ')}`)
  }

  /** every space's playbooks and templates in one, for the services all spaces share */
  ctx(): T.Ctx {
    const xs = this.list.map((s) => s.ctx())
    return { PB: Object.assign({}, ...xs.map((x) => x.PB)), TPL: Object.assign({}, ...xs.map((x) => x.TPL)) }
  }
}

/** re-emits every space's events on the shared bus as {...e, ws: id}; returns an unsubscribe */
export function hub(list: Space[], to: Bus): () => void {
  const offs = list.map((s) => s.bus.on((e) => to.emit({ ...e, ws: s.id })))
  return () => { for (const off of offs) off() }
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

/** a workspace's instance; its source is not started, so the caller can wire what listens first */
type SpaceOpts = { cfg: WsConfig; home: string; artifactsDir: string; sdk?: Sdk; fake: boolean; push: Push }

export async function makeSpace(w: WorkspaceServer, o: SpaceOpts): Promise<Space> {
  const fake = o.fake ? await startFakeGateway({ seed: fakeSeed(w), me: w.page.me, board: w.page.board }) : null
  // a workspace hook that throws would leave the fake holding its port
  try { return assemble(w, o, fake) } catch (e) { await fake?.close(); throw e }
}

function assemble(w: WorkspaceServer, o: SpaceOpts, fake: FakeGateway | null): Space {
  const id = w.page.id, bus = new Bus()
  const cfg: WsConfig = fake ? { ...o.cfg, gatewayUrl: fake.url } : o.cfg
  // the fake stands in for whatever source the workspace brings
  const source = fake ? gatewaySource(cfg, { bus, token: () => fake.token }) : w.source?.(cfg, { bus }) ?? gatewaySource(cfg, { bus })
  const builtins = { ...CORE_PB, ...w.page.playbooks }
  const store = w.store?.(source, cfg, { bus, home: o.home }) ?? bridgeStore({ bridge: source, bus, playbooks: builtins, prefix: w.jobPrefix })
  // until B answers, the built-in playbooks stand in
  let PB: Record<string, Playbook> = structuredClone(builtins)
  const TPL = { ...CORE_TPL, ...w.page.templates }
  const ctx = (): T.Ctx => ({ PB, TPL })
  const gate = () => source.available()

  const jobs = new Jobs({ store, bus, ctx, gate })
  const sdk = o.sdk ?? agentSdk({ gatewayUrl: cfg.gatewayUrl, llmToken: () => (fake ? fake.llmToken : readToken(cfg.llmTokenPath)), runTools: cfg.runTools, mcp: w.llm?.mcp })
  const runner = new Runner({
    store, jobs, bus, sdk, cwd: cfg.workDir, max: cfg.maxSessions, gate, artifactsDir: o.artifactsDir, ctx,
    context: (j) => resolveContext(source, j, w.page.me), me: w.page.me,
  })
  const offInterrupt = bus.on((e) => {
    if (e.kind === 'bridge' && e.state === 'unavailable')
      void runner.interruptAll('the bridge went away').catch((err) => console.error(`interrupting the runs of ${id}:`, (err as Error).message))
  })

  const known = new Map<string, Job>()
  bus.on((e) => { if (e.kind === 'job') known.set(e.job.id, e.job) })
  const push: Push = (t, b, u) => o.push(t, b, withWs(u, id))
  const returns = new BoardReturns({
    bus, jobs, ctx, push, key: (i) => w.page.board.key(i),
    read: async () => { const r = (await source.read(['board'])).board; return r && READY.has(r.status) && Array.isArray(r.items) ? (r.items as { id: string }[]) : null },
  })

  let recovered = false
  const stopLoading = onBridgeBack(bus, async () => {
    PB = await store.playbooks()
    for (const j of await store.jobs()) known.set(j.id, j)
    await runner.recover(recovered ? 'the bridge went away' : 'the console restarted')
    recovered = true
  })

  return {
    id, page: w.page, prefix: w.jobPrefix, cfg, bus, source, store, jobs, runner, ctx, known, fake,
    putPlaybook: async (pid, pb) => { await store.putPlaybook(pid, pb); PB = await store.playbooks() },
    start: startItem({ jobs, ctx, bridge: source, page: w.page }),
    plugins: w.plugins?.({ id, cfg, home: o.home, jobs, source, artifactsDir: o.artifactsDir }) ?? [],
    // a QA return pushes its own message; the reopen and note it makes would push a second one
    onNeedsYou: (f) => jobs.onNeedsYou((j) => { if (!returns.handling(j.id)) f(j) }),
    // the source going away on close is no reason to interrupt the runs
    async close() { stopLoading(); offInterrupt(); source.stop(); await fake?.close() },
  }
}
