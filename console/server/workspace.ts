import { CORE_PB } from '../src/data/playbooks.ts'
import type { Playbook } from '../src/model/types.ts'
import { wallIso } from '../src/lib/zone.ts'
import type { GatewayItem, WorkspacePage } from '../src/workspace.ts'
import { BridgeClient } from './bridge/client.ts'
import { readToken } from './config.ts'
import type { Bus } from './events.ts'
import type { Bridge } from './http/app.ts'
import type { Jobs } from './jobs/jobs.ts'
import type { Store } from './store/port.ts'

/* The server half of a workspace: how its gateway is reached, what job ids it mints, what its plugins add.
   workspaces/server.ts lists the registered ones; the page half is src/workspace.ts. Nothing here names a workplace. */

/** the channel to a workspace's gateway: reads, acts, state ops and the event stream */
export type Source = Bridge & { start(): void; stop(): void }
export interface WsConfig {
  gatewayUrl: string; consoleTokenPath: string; llmTokenPath: string; workDir: string
  runTools: string[]; teamTz: string | null; maxSessions: number; [own: string]: unknown
}
export type PluginReq = { q: URLSearchParams; p: string[]; body(): Promise<Record<string, unknown>> }
export interface Plugin {
  name: string
  /** matched against the path after /api/ws/<id> */
  routes: [method: string, path: RegExp, run: (r: PluginReq) => Promise<unknown>][]
  /** its block in /api/state: ws.<id>.plugins.<name> */
  state?(): unknown
}
export interface PluginCtx { id: string; cfg: WsConfig; home: string; jobs: Jobs; source: Source; artifactsDir: string }
/** what the fake gateway starts with: items per concept, and the messages of each chat thread;
    get = what a get of a concept's item answers, instead of the item itself */
export type FakeSeed = {
  concepts: Record<string, GatewayItem[]>; threads: Record<string, GatewayItem[]>
  get?: Record<string, (id: string, item: GatewayItem) => unknown>
}
export interface WorkspaceServer {
  page: WorkspacePage; jobPrefix: string; defaults?: Partial<WsConfig>
  source?(cfg: WsConfig, o: { bus: Bus }): Source          // default: gatewaySource
  /** default: bridgeStore over the source; playbooks = the built-in ones, the core's and the page's */
  store?(source: Source, cfg: WsConfig, o: { bus: Bus; home: string; ws: string; prefix: string; playbooks: Record<string, Playbook> }): Store
  llm?: { runTools?: string[]; mcp?: Record<string, unknown> }
  plugins?(x: PluginCtx): Plugin[]
  fake?(): FakeSeed                                          // default: derived from page.demo
}

const WS_ID = /^[a-z][a-z0-9-]{0,31}$/, PREFIX = /^[A-Z][A-Z0-9]{0,7}$/

/** ids well-formed and unique, prefixes well-formed and unique, built-in playbook ids unique across workspaces and apart from the core's,
    no own MCP server named bridge or run */
export function checkWorkspaces(list: WorkspaceServer[]): void {
  const ids = new Set<string>(), prefixes = new Map<string, string>()
  // the core's playbooks belong to every workspace, so none may define one of its own
  const owners = new Map<string, string>(Object.keys(CORE_PB).map((pb) => [pb, 'core']))
  for (const { page, jobPrefix, llm } of list) {
    const id = page.id
    if (typeof id !== 'string' || !WS_ID.test(id)) throw new Error(`workspace id ${id} must match ${WS_ID}`)
    if (ids.has(id)) throw new Error(`workspace ${id} is registered twice`)
    ids.add(id)
    if (typeof jobPrefix !== 'string' || !PREFIX.test(jobPrefix)) throw new Error(`job prefix ${jobPrefix} of ${id} must match ${PREFIX}`)
    const other = prefixes.get(jobPrefix)
    if (other) throw new Error(`workspaces ${other} and ${id} both use job prefix ${jobPrefix}`)
    prefixes.set(jobPrefix, id)
    // a session's servers are bridge and run, then the workspace's own: an own one by those names would replace them
    for (const name of ['bridge', 'run']) if (llm?.mcp && Object.hasOwn(llm.mcp, name)) throw new Error(`workspace ${id}: llm.mcp may not name ${name}`)
    for (const pb of Object.keys(page.playbooks)) {
      const first = owners.get(pb)
      if (first) throw new Error(`playbook ${pb} is built into both ${first} and ${id}`)
      owners.set(pb, id)
    }
  }
}

/** the bridge client over the workspace's gateway; the console token is read from its file on every call unless one is given */
export function gatewaySource(cfg: WsConfig, o: { bus: Bus; token?: () => string }): Source {
  return new BridgeClient({ url: cfg.gatewayUrl, token: o.token ?? (() => readToken(cfg.consoleTokenPath)), bus: o.bus })
}

/** what a page's demo gives a fake gateway: its chats with their threads, mail, calendar, board and timesheet */
export function seedFromDemo(page: WorkspacePage): FakeSeed {
  const { demo } = page, me = page.me ?? 'You', threads: FakeSeed['threads'] = {}
  for (const c of demo.chats) threads[c.id] = c.msgs.map((m, i) => ({
    id: `${c.id}-${i}`, author: m.me ? me : m.who, authorKind: m.me ? 'me' : m.bot ? 'bot' : 'person', at: wallIso(m.at), text: m.t,
  }))
  return {
    threads,
    concepts: {
      chat: demo.chats.map((c) => {
        const last = c.msgs[c.msgs.length - 1]
        return { id: c.id, name: c.name, kind: c.kind, unread: c.unread, lastAt: wallIso(last.at), lastFrom: last.me ? me : last.who, lastPreview: last.t, link: `https://slack.example/archives/${c.id}`, mentioned: false }
      }),
      mail: (demo.mail ?? []).map((m) => ({
        id: m.id, folder: m.cat === 'wait' ? 'Sent' : 'Inbox', from: m.from.replace(/^You → .*/, me), to: m.cat === 'wait' ? [m.from.replace(/^You → /, '')] : [me], cc: [],
        subject: m.subj, at: wallIso(m.at), unread: m.cat === 'reply', preview: m.sum, category: m.cat, myReply: false, conversationId: `conv-${m.id}`, link: `https://mail.example/${m.id}`,
      })),
      cal: (demo.cal ?? []).map((e) => ({ ...e })),
      board: (demo.board?.() ?? []).map((b): GatewayItem => ({ ...b })),
      time: demo.time?.(wallIso('12:00').slice(0, 10)) ?? [],
    },
  }
}
/** the workspace's own fake() when it has one, else what its demo gives */
export const fakeSeed = (w: WorkspaceServer): FakeSeed => (w.fake ? w.fake() : seedFromDemo(w.page))
