import { join } from 'node:path'
import { CORE_PB, CORE_TPL } from '../src/data/playbooks.ts'
import * as T from '../src/model/transitions.ts'
import type { Job, Playbook, Tpl } from '../src/model/types.ts'
import type { WorkspacePage } from '../src/workspace.ts'
import { agentRecords } from './agent/records.ts'
import { AgentSession } from './agent/session.ts'
import type { Reintegration, SessionOps } from './agent/session.ts'
import { BoardReturns } from './board/returns.ts'
import { startItem } from './board/start.ts'
import { GATEWAY_ACTIONS, grantedActs } from './bridge/actions.ts'
import { isLocal } from './bridge/local.ts'
import { browserPlugin } from './browser/plugin.ts'
import { grantsFrom } from './browser/packs.ts'
import { startFakeGateway } from './bridge/fake.ts'
import type { FakeGateway } from './bridge/fake.ts'
import { READY } from './bridge/wire.ts'
import { readToken } from './config.ts'
import { shoot } from './llm/shot.ts'
import { builder } from './llm/builder.ts'
import type { Build } from './llm/builder.ts'
import { Bus, HttpError, downName } from './events.ts'
import { grantsOf, guardedHttp } from './grants.ts'
import type { Grants } from './grants.ts'
import { Blockers } from './jobs/blockers.ts'
import { Jobs } from './jobs/jobs.ts'
import { notesStore } from './knowledge/notes.ts'
import type { Notes } from './knowledge/notes.ts'
import { autoAsk } from './llm/autoAsk.ts'
import { resolveContext } from './llm/context.ts'
import { Runner } from './llm/runner.ts'
import { providerPick } from './llm/providers.ts'
import { Settings } from './settings.ts'
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
  /** grants.json's; null = an unmanaged workspace */
  grants: Grants | null
  /** a managed workspace's agent; none unmanaged */
  agent: AgentSession | null
  /** the actions the page may send: a gateway's eight, or what a managed workspace's grants allow */
  acts: ReadonlySet<string>
  bus: Bus; source: Source; store: Store; jobs: Jobs; runner: Runner
  /** the workspace's knowledge folder */
  notes: Notes
  ctx(): T.Ctx; putPlaybook(id: string, pb: Playbook | null, tpl?: Record<string, Tpl[]>): Promise<void>
  start: ReturnType<typeof startItem>; plugins: Plugin[]; known: Map<string, Job>; fake: FakeGateway | null
  /** fills the New job form from what the user said; it only reads */
  build: Build
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

/** a workspace's instance; its source is not started, so the caller can wire what listens first;
    askDelay = how long auto-ask waits before it asks, tests shorten it; root = the console's folder, where grants.json is read;
    agent = what a managed workspace's agent shares with the others: the ops, the restart hold, the registered names,
    the failed core update it may reintegrate;
    packsDir = where a managed workspace's granted packs are read */
export type SpaceOpts = {
  cfg: WsConfig; home: string; artifactsDir: string; sdk?: Sdk; fake: boolean; push: Push; askDelay?: number; root?: string; packsDir?: string
  agent?: { ops: SessionOps; hold(): () => void; taken(): { ids: string[]; prefixes: string[] }; reintegration?: Reintegration }
}

/** whether a run gets the bridge tools: the workspace's own say, else a local source's run MCP; url = where they are
    served when a run starts, since a local source's port is known only once it serves */
export function runBridge(w: WorkspaceServer, source: Source, cfg: WsConfig): { bridge?: boolean; url(): string } {
  const local = isLocal(source) ? source : null
  return {
    bridge: w.llm?.bridge ?? (local ? local.mcp : undefined),
    url: () => local?.status().mcp?.replace(/\/mcp$/, '') ?? cfg.gatewayUrl,
  }
}

export async function makeSpace(w: WorkspaceServer, o: SpaceOpts): Promise<Space> {
  const fake = o.fake ? await startFakeGateway({ seed: fakeSeed(w), me: w.page.me, board: w.page.board }) : null
  // a workspace hook that throws would leave the fake holding its port
  try { return assemble(w, o, fake) } catch (e) { await fake?.close(); throw e }
}

function assemble(w: WorkspaceServer, o: SpaceOpts, fake: FakeGateway | null): Space {
  const id = w.page.id, bus = new Bus(), grants = grantsOf(id, o.root)
  // a managed workspace's runs get exactly what its grants name
  const cfg: WsConfig = { ...o.cfg, ...(fake ? { gatewayUrl: fake.url } : {}), ...(grants ? { runTools: grants.runTools } : {}) }
  const mcp = grants ? grants.mcp : w.llm?.mcp
  const packGrants = grants ? grantsFrom(grants) : undefined
  // the fake stands in for whatever source and store the workspace brings
  const source = fake ? gatewaySource(cfg, { bus, token: () => fake.token })
    : w.source?.(cfg, { bus, ws: id, home: o.home, grants: packGrants, packsDir: o.packsDir }) ?? gatewaySource(cfg, { bus })
  // a local source acts through the packs it loaded; a managed one on a gateway through what its grants would load
  const acts = isLocal(source) ? source.actions() : packGrants ? grantedActs(packGrants(cfg), o.packsDir) : GATEWAY_ACTIONS
  const builtins = { ...CORE_PB, ...w.page.playbooks }
  const store = (fake ? undefined : w.store?.(source, cfg, { bus, home: o.home, ws: id, prefix: w.jobPrefix, playbooks: builtins }))
    ?? bridgeStore({ bridge: source, bus, playbooks: builtins, prefix: w.jobPrefix })
  // until B answers, the built-in playbooks stand in
  let PB: Record<string, Playbook> = structuredClone(builtins)
  const builtinTpl = { ...CORE_TPL, ...w.page.templates }
  let TPL = builtinTpl
  const ctx = (): T.Ctx => ({ PB, TPL })
  /** the stored playbooks over the built-in ones, their planned messages likewise */
  const loadPbs = async () => {
    const [pb, tpl] = await Promise.all([store.playbooks(), store.templates()])
    PB = pb; TPL = { ...builtinTpl, ...tpl }
  }
  const gate = () => source.available()
  // the page re-reads knowledge on these, and Web Push announces a new proposal; the fake never touches a real folder
  const notes = notesStore(!fake && cfg.knowledgeDir ? cfg.knowledgeDir : join(o.home, 'knowledge', id), {
    onChange: (concept, upserts, removes) => bus.emit({ kind: 'source', concept, upserts, removes }),
  })

  const jobs = new Jobs({ store, bus, ctx, gate, via: source.via })
  // a new run takes the auto provider the settings name now; a resume or a reply the one its run recorded
  const settings = new Settings(o.home), rb = runBridge(w, source, cfg)
  const sdk = o.sdk ?? providerPick(() => settings.read(), (p) => p.auto!({
    // a getter: a provider reads it as each session starts
    get gatewayUrl() { return rb.url() },
    llmToken: () => (fake ? fake.llmToken : readToken(cfg.llmTokenPath)), runTools: cfg.runTools, mcp, bridge: rb.bridge,
    claudePath: () => settings.read().claudePath, cursorPath: () => settings.read().cursorPath, home: o.home,
  }))
  // fake mode touches no real repo
  const workDir = fake ? undefined : w.workDir?.(cfg)
  const runner = new Runner({
    store, jobs, bus, sdk, cwd: cfg.workDir, max: cfg.maxSessions, gate, via: source.via, artifactsDir: o.artifactsDir, ctx,
    context: (j) => resolveContext(source, j, w.page.me, notes), me: w.page.me, bridge: rb.bridge, workDir,
    screenshot: w.llm?.screenshot ? (s) => shoot({ ...s, browserPath: cfg.browserPath }) : undefined,
    jobTools: w.llm?.jobTools ? { ws: id, pb: w.page.board.start, prj: w.page.pack.prj, prefix: w.jobPrefix } : undefined, notes,
    autoResume: cfg.autoAsk === true,
  })
  const offAuto = autoAsk({ jobs, runner, ctx, on: cfg.autoAsk === true, delay: o.askDelay })
  // a workspace without a gateway gives the builder no sources to read
  const build = builder({ ws: id, page: w.page, sdk, notes, source: rb.bridge === false ? null : source, ctx, bus, jobs: () => jobs.all() })
  const offInterrupt = bus.on((e) => {
    if (e.kind === 'bridge' && e.state === 'unavailable')
      void runner.interruptAll(`${downName(source.via)} went away`).catch((err) => console.error(`interrupting the runs of ${id}:`, (err as Error).message))
  })

  /** a closed job's work dir goes; what was kept and why is journaled, unless the journal already says it */
  const cleanUp = async (j: Job) => {
    const line = await workDir!.closed!(j)
    if (line && j.jr[0]?.c !== line) await jobs.cmd(j.id, { op: 'journal', o: 'Cleaned up after the job.', c: line, n: '-', a: 'console' }, undefined, 'console')
  }
  // one at a time: a load can find many closed jobs, and each is a few git calls
  let cleaning = Promise.resolve()
  const clean = (j: Job) => {
    if (workDir?.closed) cleaning = cleaning.then(() => cleanUp(j)).catch((e) => console.error(`cleaning up after ${j.id}:`, (e as Error).message))
  }

  const known = new Map<string, Job>()
  bus.on((e) => {
    if (e.kind !== 'job') return
    const was = known.get(e.job.id)
    known.set(e.job.id, e.job)
    if (was && !T.isClosed(was) && T.isClosed(e.job)) clean(e.job)
  })
  const push: Push = (t, b, u) => o.push(t, b, withWs(u, id))
  const returns = new BoardReturns({
    bus, jobs, ctx, push, key: (i) => w.page.board.key(i),
    read: async () => { const r = (await source.read(['board'])).board; return r && READY.has(r.status) && Array.isArray(r.items) ? (r.items as { id: string }[]) : null },
  })
  const blockers = new Blockers({ jobs, ctx, push })
  const agent = grants && o.agent ? new AgentSession({
    ws: id, title: w.page.pack.n || id, records: agentRecords(store, join(o.home, 'agent', `${id}.json`)), sdk, bus, root: o.root, ...o.agent,
  }) : null

  let recovered = false
  const stopLoading = onBridgeBack(bus, async () => {
    await loadPbs()
    const all = await store.jobs()
    for (const j of all) known.set(j.id, j)
    for (const j of all) if (T.isClosed(j)) clean(j)
    await runner.recover(recovered ? `${downName(source.via)} went away` : 'the console restarted')
    recovered = true
    await runner.resumeDue()
    // a blocker closed while the console was off is seen here
    await blockers.reconcile()
  })

  return {
    id, page: w.page, prefix: w.jobPrefix, cfg, grants, agent, acts, bus, source, store, jobs, runner, notes, ctx, known, fake, build,
    putPlaybook: async (pid, pb, tpl) => { await store.putPlaybook(pid, pb, tpl); await loadPbs() },
    start: startItem({ jobs, ctx, bridge: source, page: w.page }),
    plugins: [...browserPlugin(source), ...w.plugins?.({ id, cfg, home: o.home, jobs, source, artifactsDir: o.artifactsDir, http: guardedHttp(grants?.hosts ?? null) }) ?? []],
    // a QA return or a woken blocker pushes its own message; the generic one would say it again
    onNeedsYou: (f) => jobs.onNeedsYou((j) => { if (!returns.handling(j.id) && !blockers.handling(j.id)) f(j) }),
    // the source going away on close is no reason to interrupt the runs
    async close() { stopLoading(); offInterrupt(); offAuto(); blockers.stop(); agent?.close(); source.stop(); await fake?.close() },
  }
}
