import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { failedUpdate } from '../scripts/update.mjs'
import type { FailedUpdate } from '../scripts/update.mjs'
import { REINTEGRABLE } from '../src/model/update.ts'
import type { UpdateKind, UpdateView } from '../src/model/update.ts'
import { Ops, realExec } from './agent/ops.ts'
import type { Exec } from './agent/ops.ts'
import type { Reintegration, UpdateEnd } from './agent/session.ts'
import { HttpError } from './events.ts'

/* The console's failed core update: the record update.mjs left, the core's diff as it lands in the folder, ops rooted
   at its worktree, and update.mjs run again or given up. A run waits for the agents' turns, takes no new ones,
   and an update that applied restarts the console through its restarter. */

const RUN_MS = 45 * 60_000, DIFF_MAX = 60_000
const EXCLUDE = [':(exclude)core.lock.json', ':(exclude)package-lock.json']
const tail = (out: string, n = 60) => out.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n).join('\n')

export interface UpdatesOpts {
  /** the console's home, where update-failed.json is; root = its folder */
  home: string; root: string
  /** the page hears each change */
  emit(v: UpdateView | null): void
  /** settles once no agent's turn runs */
  idle(): Promise<void>
  restart(): void
  exec?: Exec
  runMs?: number
}

export class Updates implements Reintegration {
  private o: UpdatesOpts
  private exec: Exec
  private running: UpdateKind | null = null
  /** the record a run started on: update.mjs drops the file before the run ends */
  private held: FailedUpdate | null = null
  private last: UpdateView['last']
  private ops = new Map<string, Ops>()

  constructor(o: UpdatesOpts) { this.o = o; this.exec = o.exec ?? realExec }

  failed(): FailedUpdate | null {
    try { return failedUpdate(this.o.home) } catch (e) { console.error('update-failed.json:', (e as Error).message); return null }
  }

  view(): UpdateView | null {
    const f = this.failed() ?? (this.running ? this.held : null)
    if (!f) return null
    return {
      core: f.core, from: f.from, branch: f.branch, step: f.step, output: f.output, at: f.at, ...(f.log ? { log: f.log } : {}),
      reintegrable: REINTEGRABLE.includes(f.step), running: this.running, ...(this.last ? { last: this.last } : {}),
    }
  }

  updating() { return this.running !== null }

  /** the core's changes as they land in the folder: the update's own commit against the folder's, the locks left out */
  async diff(f: FailedUpdate): Promise<string> {
    const git = async (...a: string[]) => {
      const r = await this.exec('git', ['-C', f.dir, ...a], { cwd: f.dir })
      if (r.code !== 0) throw new Error(`git ${a[0]}: ${tail(r.out, 3)}`)
      return r.stdout
    }
    const sync = (await git('rev-list', '--reverse', `${f.pre}..HEAD`)).split(/\s+/).filter(Boolean)[0]
    if (!sync) return '(the update made no commit)'
    const stat = (await git('diff', '--stat=120', '--relative', f.pre, sync, '--', '.', ...EXCLUDE)).trimEnd()
    const full = (await git('diff', '--relative', f.pre, sync, '--', '.', ...EXCLUDE)).trimEnd()
    if (full.length <= DIFF_MAX) return `${stat}\n\n${full}`
    return `${stat}\n\n${full.slice(0, DIFF_MAX)}\n… cut at ${DIFF_MAX} characters: read the files themselves for the rest`
  }

  /** ops in the update's worktree: they check and commit there and restart nothing */
  opsAt(dir: string): Ops {
    let x = this.ops.get(dir)
    if (!x) { x = new Ops({ root: dir, home: this.o.home, exec: this.exec }); this.ops.set(dir, x) }
    return x
  }

  /** the page's Apply or Give up; a turn that runs ends first, and no new one starts meanwhile */
  start(kind: UpdateKind): UpdateView | null {
    if (!this.failed()) throw new HttpError(409, 'no_update', 'no failed core update waits')
    if (this.running) throw new HttpError(409, 'updating', 'the update runs already')
    void this.run(kind).catch((e) => console.error(`update ${kind}:`, (e as Error).message))
    return this.view()
  }

  async run(kind: UpdateKind, report?: (r: UpdateEnd) => Promise<void>): Promise<UpdateEnd> {
    if (this.running) throw new HttpError(409, 'updating', 'the update runs already')
    this.held = this.failed()
    this.running = kind
    this.o.emit(this.view())
    let end: UpdateEnd
    try {
      await this.o.idle()
      const before = this.lockCore()
      const args = [join(this.o.root, 'scripts', 'update.mjs'), kind === 'give-up' ? '--give-up' : '--no-pull', '--no-restart']
      const r = await this.exec(process.execPath, args, { cwd: this.o.root, timeoutMs: this.o.runMs ?? RUN_MS, env: { WORK_CONSOLE_HOME: this.o.home } })
      const output = tail(r.out)
      end = { code: r.code, output, updated: kind === 'apply' && r.code === 0 && this.lockCore() !== before, failed: this.failed() }
      this.last = { kind, code: r.code, output, at: new Date().toISOString() }
    } finally { this.running = null; this.held = null }
    await report?.(end).catch((e) => console.error('update report:', (e as Error).message))
    this.o.emit(this.view())
    if (end.updated) this.o.restart()
    return end
  }

  private lockCore(): string | null {
    const f = join(this.o.root, 'core.lock.json')
    try { return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { core?: string }).core ?? null : null } catch { return null }
  }
}
