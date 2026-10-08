import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runToolDefs, signinReason } from '../sdk.ts'
import type { AskEvent, AskTool, Sdk, SdkEvent } from '../sdk.ts'
import type { PromptImage } from '../context.ts'
import { Rpc, RpcError } from './acp.ts'
import { GUARD, findInstall, hookCommand, killTree, sessionEnv, spawnAgent } from './cli.ts'
import { Feed } from './feed.ts'
import type { FeedEvent } from './feed.ts'
import { OWN, cliConfig, guard, permit } from './policy.ts'
import type { Asked, Mode, Policy } from './policy.ts'
import { ANSWER, answerTool, askTool, sdkTool, serveSession } from './serve.ts'
import type { Served, ServedTool } from './serve.ts'

/* The Cursor provider: each session is the Cursor agent CLI over ACP in a folder of its own under the console's home,
   holding its config, data, home and temp. It gets its tools from its own MCP server, a hook guards its file, shell
   and fetch tools, and the console answers each permission request it sends, all from policy.ts. The account's own
   default model runs. A session is kept between turns under cursor/sessions for a resume. */

export interface CursorOpts {
  gatewayUrl: string; llmToken: () => string; runTools: string[]; mcp?: Record<string, unknown>; bridge?: boolean
  /** the console's home: sessions run and are kept under it; none = the temp dir */
  home?: string
  /** the cursorPath setting, read at each session's start */
  cursorPath?: () => string | undefined
  /** tests: the agent process in place of the CLI */
  launch?: (cwd: string, env: Record<string, string>) => ChildProcessWithoutNullStreams
}
type AcpServer = { type: 'http' | 'sse'; name: string; url: string; headers: { name: string; value: string }[] } | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
type Block = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
interface Turn { cwd: string; mode: Mode; tools: ServedTool[]; servers?: () => AcpServer[]; prompt: Block[]; resume?: string; keep: boolean; hide?: string[]; abort: AbortController }
type Out = FeedEvent | { k: 'session'; id: string } | { k: 'result'; ok: boolean; error?: string; t?: string }

const pairs = (o: unknown) => Object.entries((o && typeof o === 'object' ? o : {}) as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) }))
/** the workspace's own MCP servers as ACP takes them; one of another kind is left out */
export function acpServers(mcp: Record<string, unknown> = {}): AcpServer[] {
  return Object.entries(mcp).flatMap(([name, c]): AcpServer[] => {
    const x = (c ?? {}) as { type?: string; url?: string; headers?: unknown; command?: string; args?: unknown; env?: unknown }
    if ((x.type === 'http' || x.type === 'sse') && x.url) return [{ type: x.type, name, url: x.url, headers: pairs(x.headers) }]
    if ((x.type === undefined || x.type === 'stdio') && x.command) return [{ name, command: x.command, args: Array.isArray(x.args) ? x.args.map(String) : [], env: pairs(x.env) }]
    return []
  })
}
const blocks = (prompt: string, images: PromptImage[] = []): Block[] =>
  [...images.flatMap((im): Block[] => [{ type: 'text', text: im.label }, { type: 'image', mimeType: im.mime, data: im.data }]), { type: 'text', text: prompt }]
const withSystem = (system: string, prompt: string) => `<instructions>\n${system}\n</instructions>\n\n${prompt}`
const SID = /^[\w-]{1,100}$/
const DAY = 86400e3
const noEmail = (t: string) => t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
const PLAN = /^\s*Upgrade your plan/i
/** SQLite opens no database on Windows whose path leaves no room under MAX_PATH for its "-journal" name */
const STORE_MAX = 251

function removeSoon(dir: string) {
  void (async () => {
    for (let i = 1; i <= 10; i++) {
      try { rmSync(dir, { recursive: true, force: true }); return } catch { await new Promise((r) => setTimeout(r, 100 * i)) }
    }
  })()
}
/** a short name, so the CLI's session store fits STORE_MAX */
function runDir(runs: string): string {
  for (;;) { const d = join(runs, randomBytes(4).toString('hex')); if (!existsSync(d)) return d }
}
/** run folders a crashed console left behind */
function sweep(runs: string) {
  try { for (const d of readdirSync(runs)) { const p = join(runs, d); if (Date.now() - statSync(p).mtimeMs > DAY) removeSoon(p) } } catch { /* none yet */ }
}

/** why a session ended before its turn did */
function failure(e: unknown, stderr: string): string {
  if (e instanceof RpcError) {
    const more = (e.data as { message?: unknown } | undefined)?.message
    if (/authentication required/i.test(e.message)) return signinReason('Authentication required: Cursor is signed out; sign in with agent login in a terminal')
    return signinReason(`${e.message}${typeof more === 'string' ? `: ${more}` : ''}`)
  }
  const tail = noEmail(stderr.trim().split('\n').slice(-5).join('\n')).slice(-800)
  return `${(e as Error)?.message || e}${tail ? `\n${tail}` : ''}`
}

export function cursorSdk(o: CursorOpts): Sdk {
  const base = join(o.home ?? join(tmpdir(), 'work-console'), 'cursor'), runs = join(base, 'runs'), kept = join(base, 'sessions')
  const launch = o.launch ?? ((cwd: string, env: Record<string, string>) => spawnAgent(findInstall(o.cursorPath?.()), cwd, env))

  async function* turn(t: Turn): AsyncGenerator<Out> {
    if (t.abort.signal.aborted) { yield { k: 'result', ok: false, error: 'the session was stopped' }; return }
    sweep(runs)
    const dir = runDir(runs), d = { config: join(dir, 'config'), data: join(dir, 'data'), home: join(dir, 'home'), tmp: join(dir, 'tmp') }
    const store = join(d.config, 'acp-sessions', '0'.repeat(36), 'store.db').length
    if (process.platform === 'win32' && store > STORE_MAX) {
      yield { k: 'result', ok: false, error: `cursor_path: the Cursor CLI cannot open its session store under ${base}: its path would take ${store} characters, and Windows opens one of ${STORE_MAX}; give the console a shorter home` }
      return
    }
    for (const x of [d.config, d.data, join(d.home, '.cursor'), d.tmp]) mkdirSync(x, { recursive: true })
    const policy: Policy = { cwd: t.cwd, mode: t.mode, hidden: [o.home ?? base, dir] }
    const own = OWN[t.mode.kind], feed = new Feed(t.mode.kind === 'start' ? undefined : own, t.hide)
    let child: ChildProcessWithoutNullStreams | undefined, served: Served | undefined, sid: string | undefined, stderr = ''
    const queue: Out[] = []
    let wake: (() => void) | null = null, live = false
    const push = (xs: Out[]) => { if (xs.length) { queue.push(...xs); wake?.() } }
    // before the session is open there is nothing to cancel: the process goes
    const cancel = () => {
      if (!live || !sid || !rpc) return killTree(child?.pid)
      rpc.notify('session/cancel', { sessionId: sid })
      setTimeout(() => killTree(child?.pid), 5000).unref()
    }
    let rpc: Rpc | undefined
    try {
      served = await serveSession({ name: own, tools: t.tools, guard: (x) => guard(policy, x as never) })
      writeFileSync(join(d.config, 'cli-config.json'), JSON.stringify(cliConfig(policy), null, 2))
      writeFileSync(join(d.home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: hookCommand([process.execPath, GUARD, new URL(served.guard).port, served.token]), failClosed: true }] } }, null, 2))
      if (t.resume) {
        if (!SID.test(t.resume) || !existsSync(join(kept, t.resume))) throw new Error(`the Cursor session ${t.resume} is not kept in this console`)
        cpSync(join(kept, t.resume), join(d.config, 'acp-sessions', t.resume), { recursive: true })
      }
      child = launch(t.cwd, sessionEnv(d))
      child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b).slice(-4000) })
      const r = rpc = new Rpc(child.stdout, child.stdin, {
        notify: (m, p) => { if (m === 'session/update' && live) push(feed.update((p as { update?: unknown } | undefined)?.update)) },
        request: (m, p) => {
          if (m !== 'session/request_permission') throw new RpcError(-32601, `no method ${m}`)
          const q = (p ?? {}) as { toolCall?: Asked & { toolCallId?: string }; options?: { optionId: string; kind: string }[] }
          const tc = q.toolCall ?? {}, raw = tc.rawInput && Object.keys(tc.rawInput).length ? tc.rawInput : feed.raw(String(tc.toolCallId ?? ''))
          const pick = q.options?.find((x) => x.kind === (permit(policy, { ...tc, rawInput: raw }) ? 'allow_once' : 'reject_once'))
          return { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } }
        },
      })
      child.on('error', (e) => r.close(e))
      child.on('close', (code) => { r.close(new Error(`the Cursor agent exited${code == null ? '' : ` with code ${code}`}`)); wake?.() })
      if (t.abort.signal.aborted) cancel()
      else t.abort.signal.addEventListener('abort', cancel, { once: true })
      await r.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'work-console', version: '1.0.0' } })
      // the bridge's address and token as they are now
      const mcpServers = [{ type: 'http', name: own, url: served.mcp, headers: [{ name: 'Authorization', value: `Bearer ${served.token}` }] }, ...(t.servers?.() ?? [])]
      if (t.resume) {
        // the history the CLI replays before its answer is not this turn's
        await r.call('session/load', { sessionId: t.resume, cwd: t.cwd, mcpServers }, () => { live = true })
        sid = t.resume
      } else {
        sid = String((await r.call('session/new', { cwd: t.cwd, mcpServers }) as { sessionId?: unknown })?.sessionId ?? '')
        if (!SID.test(sid)) throw new Error(`the Cursor agent gave the session id ${sid.slice(0, 100)}`)
        live = true
      }
      yield { k: 'session', id: sid }
      if (t.abort.signal.aborted) throw new Error('the session was stopped')
      let end: { r?: { stopReason?: string }; e?: unknown } | null = null
      const done = r.call('session/prompt', { sessionId: sid, prompt: t.prompt }).then((r) => { end = { r: r as { stopReason?: string } } }, (e) => { end = { e } })
      void done.then(() => wake?.())
      for (;;) {
        while (queue.length) yield queue.shift()!
        if (end) break
        await new Promise<void>((ok) => { wake = ok })
        wake = null
      }
      yield* feed.flush()
      const x = end as { r?: { stopReason?: string }; e?: unknown }
      if (x.r?.stopReason === 'cancelled' || (x.e && t.abort.signal.aborted)) yield { k: 'result', ok: false, error: 'the session was stopped' }
      else if (x.e) yield { k: 'result', ok: false, error: failure(x.e, stderr) }
      else if (x.r?.stopReason !== 'end_turn') yield { k: 'result', ok: false, error: `the Cursor agent stopped: ${x.r?.stopReason ?? 'no reason'}` }
      else if (PLAN.test(feed.last)) yield { k: 'result', ok: false, error: `cursor_plan: the Cursor account's plan refused the turn: ${feed.last.trim().slice(0, 200)}` }
      else yield { k: 'result', ok: true, ...(feed.last.trim() ? { t: feed.last } : {}) }
    } catch (e) {
      yield { k: 'result', ok: false, error: t.abort.signal.aborted ? 'the session was stopped' : failure(e, stderr) }
    } finally {
      t.abort.signal.removeEventListener('abort', cancel)
      if (child) {
        const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((ok) => child!.once('close', ok))
        killTree(child.pid)
        await Promise.race([closed, new Promise((ok) => setTimeout(ok, 5000))])
      }
      await served?.close()
      const from = sid ? join(d.config, 'acp-sessions', sid) : ''
      if (t.keep && sid && existsSync(from)) {
        try { rmSync(join(kept, sid), { recursive: true, force: true }); cpSync(from, join(kept, sid), { recursive: true }) } catch { /* a later resume says it is gone */ }
      }
      removeSoon(dir)
    }
  }

  const str = (i: Record<string, unknown>) => JSON.stringify(i).slice(0, 300)
  async function* events(t: Turn): AsyncIterable<SdkEvent> {
    for await (const e of turn(t)) yield e.k === 'tool' ? { k: 'tool', name: e.name, input: str(e.input) } : e
  }

  return {
    start({ prompt, images, resume, cwd, tools, abort }) {
      const bridge = o.bridge !== false
      return events({
        cwd, resume, abort, keep: true, prompt: blocks(prompt, images), tools: runToolDefs(tools).map(sdkTool),
        mode: { kind: 'start', runTools: o.runTools, bridge },
        servers: () => [
          ...(bridge ? [{ type: 'http' as const, name: 'bridge', url: o.gatewayUrl.replace(/\/$/, '') + '/mcp', headers: [{ name: 'Authorization', value: `Bearer ${o.llmToken()}` }] }] : []),
          ...acpServers(o.mcp),
        ],
      })
    },
    async *ask({ system, prompt, schema, tools, cwd, abort }) {
      let out: { v: unknown } | null = null
      const names = tools.map((t) => t.name)
      const text = `${withSystem(system, prompt)}\n\nGive your answer by calling the ${ANSWER} tool with it as the input, once, at the end. Your text is not read; only that call counts.`
      let error = ''
      for await (const e of turn({
        cwd, abort, keep: false, prompt: blocks(text), hide: [ANSWER],
        tools: [...tools.map(askTool), answerTool(schema, (v) => { out = { v } })], mode: { kind: 'ask', own: [...names, ANSWER] },
      })) {
        if (e.k === 'tool' && names.includes(e.name)) yield { k: 'tool', name: e.name, input: e.input } satisfies AskEvent
        else if (e.k === 'result' && !e.ok) error = e.error ?? ''
      }
      const got = out as { v: unknown } | null
      if (got) yield { k: 'result', ok: true, out: got.v }
      else yield { k: 'result', ok: false, error: error || 'the session ended without its answer' }
    },
    agent({ prompt, resume, limits, tools, system, abort }) {
      return events({
        cwd: limits.cwd, resume, abort, keep: true, prompt: blocks(withSystem(system, prompt)),
        tools: tools.map((t: AskTool) => askTool(t)), mode: { kind: 'agent', limits, own: tools.map((t) => t.name) },
      })
    },
  }
}
