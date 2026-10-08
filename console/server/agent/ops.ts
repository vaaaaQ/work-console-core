import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Grants } from '../../src/model/agent.ts'
import { CONSOLE } from '../config.ts'
import { EMPTY_GRANTS, grantsOf, grantsPath, normGrants, writeGrants } from '../grants.ts'
import { swapDist } from '../restart.ts'
import { importCheck } from './imports.ts'
import { agentLimits, canWrite, lockedFiles, linksUnder, relPath, writeAreas } from './limits.ts'
import { addRegistry, newWorkspaceIssue, render, TEMPLATE, TEMPLATE_FILES } from './template.ts'
import type { NewWorkspace } from './template.ts'

/* What the agent's console tools do, over git and an injectable exec: check, apply (check, build, commit, restart),
   undo one of its commits, write accepted grants and add a workspace. One at a time; a failed step leaves no commit and the served build. */

/** env = variables set over the server's own */
export type Exec = (cmd: string, args: string[], o: { cwd: string; timeoutMs?: number; env?: Record<string, string> }) => Promise<{ code: number; out: string }>
export type Applied = { ok: true; sha: string; files: string[]; summary: string } | { ok: false; error: string; failures?: string[] }
export interface Checked { ok: boolean; failures: string[] }

const CHECK_MS = 15 * 60_000, BUILD_MS = 10 * 60_000

/** runs a command and gives its exit code and output; npm through the shell on Windows, a hung one killed with its children */
export const realExec: Exec = (cmd, args, o) => new Promise((ok) => {
  const p = spawn(cmd, args, { cwd: o.cwd, shell: process.platform === 'win32' && cmd === 'npm', windowsHide: true, env: o.env ? { ...process.env, ...o.env } : process.env })
  let out = ''
  p.stdout.on('data', (b) => { out += b }); p.stderr.on('data', (b) => { out += b })
  const t = o.timeoutMs ? setTimeout(() => {
    out += `\n(stopped after ${o.timeoutMs! / 1000} s)`
    if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }); else p.kill('SIGKILL')
  }, o.timeoutMs) : null
  p.on('error', (e) => { if (t) clearTimeout(t); ok({ code: -1, out: `${out}${e.message}` }) })
  p.on('close', (code) => { if (t) clearTimeout(t); ok({ code: code ?? -1, out }) })
})

const tail = (out: string, n = 40) => out.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const DB_KEYS = ['pgUrl', 'pgPasswordPath', 'pgSchema']
const fail = (error: string, failures?: string[]): Applied => (failures ? { ok: false, error, failures } : { ok: false, error })

export class Ops {
  readonly root: string
  private exec: Exec
  private stage: string
  private dist: string
  private restart?: () => void
  private home: string
  private fake: boolean
  private template: string
  private queue: Promise<unknown> = Promise.resolve()

  /** home = where config.json is; fake = the workspaces run on fake gateways, so a new one needs no database */
  constructor(o: { root?: string; exec?: Exec; stage?: string; dist?: string; restart?: () => void; home?: string; fake?: boolean; template?: string } = {}) {
    this.root = o.root ?? CONSOLE
    this.exec = o.exec ?? realExec
    this.stage = o.stage ?? join(this.root, 'node_modules', '.cache', 'work-console', 'dist')
    this.dist = o.dist ?? join(this.root, 'dist')
    this.restart = o.restart
    this.home = o.home ?? (process.env.WORK_CONSOLE_HOME || join(homedir(), '.work-console'))
    this.fake = o.fake ?? false
    this.template = o.template ?? TEMPLATE
  }

  private lock<T>(f: () => Promise<T>): Promise<T> {
    const r = this.queue.then(f, f)
    this.queue = r.catch(() => {})
    return r
  }

  private async run(cmd: string, args: string[], timeoutMs?: number) {
    try { return await this.exec(cmd, args, { cwd: this.root, timeoutMs }) } catch (e) { return { code: -1, out: (e as Error).message } }
  }

  private async git(...args: string[]) {
    const r = await this.run('git', args)
    if (r.code !== 0) throw new Error(`git ${args[0]}: ${tail(r.out, 5).join(' ')}`)
    return r.out
  }

  private z = (out: string) => out.split('\0').filter(Boolean)

  /** changed files under the agent's areas, relative to root: tracked against HEAD and untracked, not ignored */
  private async changed(ws: string) {
    const areas = writeAreas(ws)
    const tracked = this.z(await this.git('diff', '--name-only', '-z', '--no-renames', '--relative', 'HEAD', '--', ...areas))
    const fresh = this.z(await this.git('ls-files', '-z', '--others', '--exclude-standard', '--', ...areas))
    return [...new Set([...tracked, ...fresh])].sort()
  }

  /** why a set of paths may not be committed by ws's agent: grants.json is the approvals' alone, the rest per the limits */
  private refused(ws: string, files: string[]): string | null {
    const l = agentLimits(this.root, ws), grants = relPath(this.root, `workspaces/${ws}/grants.json`, l.fold)
    for (const f of files) {
      if (relPath(this.root, f, l.fold) === grants) return `${f} changes only through propose_grants and an accepted approval`
      if (!canWrite(l, f)) return `the agent may not change ${f}`
    }
    return null
  }

  /** every changed or new file outside the given paths with a hash of its content */
  private async outside(own: string[]) {
    const not = own.map((a) => `:(exclude)${a}`)
    const tracked = this.z(await this.git('diff', '--name-only', '-z', '--no-renames', '--relative', 'HEAD', '--', '.', ...not))
    const fresh = this.z(await this.git('ls-files', '-z', '--others', '--exclude-standard', '--', '.', ...not))
    const m = new Map<string, string>()
    for (const f of [...tracked, ...fresh]) {
      const p = join(this.root, f)
      m.set(f, existsSync(p) ? createHash('sha1').update(readFileSync(p)).digest('hex') : 'gone')
    }
    return m
  }

  private moved(before: Map<string, string>, after: Map<string, string>) {
    return [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f)).sort()
  }

  private async checkIn(ws: string): Promise<Checked> {
    const areas = writeAreas(ws)
    const links = linksUnder(this.root, areas).map((p) => `${p}: a symlink or junction; the agent areas hold plain files only`)
    if (links.length) return { ok: false, failures: links }
    const locked = new Set(lockedFiles(this.root))
    const imports = importCheck(this.root, areas).filter((l) => !locked.has(l.slice(0, l.indexOf(':'))))
    if (imports.length) return { ok: false, failures: imports }
    for (const [args, name] of [[['run', 'typecheck'], 'npm run typecheck'], [['test'], 'npm test']] as const) {
      const r = await this.run('npm', [...args], CHECK_MS)
      if (r.code !== 0) return { ok: false, failures: [`${name} failed (exit ${r.code})`, ...tail(r.out)] }
    }
    return { ok: true, failures: [] }
  }

  /** the page built into the staging dir; served only once swapped in */
  private async build(): Promise<Applied | null> {
    rmSync(this.stage, { recursive: true, force: true })
    const vite = join(this.root, 'node_modules', 'vite', 'bin', 'vite.js')
    const r = await this.run(process.execPath, [vite, 'build', '--outDir', this.stage, '--emptyOutDir'], BUILD_MS)
    if (r.code === 0 && existsSync(join(this.stage, 'index.html'))) return null
    rmSync(this.stage, { recursive: true, force: true })
    return fail('the build failed', tail(r.out))
  }

  /** the changes under specs committed alone, with a one-line message; the rest of the index and tree untouched */
  private async commit(specs: string[], message: string) {
    await this.git('add', '-A', '--', ...specs)
    await this.git('commit', '-q', '--only', '-m', message, '--', ...specs)
    const sha = (await this.git('rev-parse', 'HEAD')).trim()
    return { sha, files: this.z(await this.git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--relative', sha)) }
  }

  check(ws: string): Promise<Checked> { return this.lock(() => this.checkIn(ws)) }

  apply(ws: string, summary: string): Promise<Applied> {
    return this.lock(async () => {
      const s = oneLine(summary)
      if (!s) return fail('a summary is needed')
      const files = await this.changed(ws)
      if (!files.length) return fail(`nothing to apply: no changes under workspaces/${ws} or tools`)
      const why = this.refused(ws, files)
      if (why) return fail(why)
      const before = await this.outside(writeAreas(ws))
      const c = await this.checkIn(ws)
      if (!c.ok) return fail('the check failed', c.failures)
      const b = await this.build()
      if (b) return b
      const moved = this.moved(before, await this.outside(writeAreas(ws)))
      const links = linksUnder(this.root, writeAreas(ws))
      const now = await this.changed(ws), why2 = moved.length
        ? `changed outside workspaces/${ws} and tools while it was checked: ${moved.join(', ')}`
        : links.length ? `a symlink or junction appeared while it was checked: ${links.join(', ')}` : this.refused(ws, now)
      if (why2) { rmSync(this.stage, { recursive: true, force: true }); return fail(why2) }
      const swap = await swapDist(this.stage, this.dist)
      let done
      const specs = writeAreas(ws).filter((a) => now.some((f) => f.startsWith(`${a}/`)))
      try { done = await this.commit(specs, `${ws}: ${s}`) } catch (e) { await swap.back(); return fail((e as Error).message) }
      swap.done(); this.restart?.()
      return { ok: true, sha: done.sha, files: done.files, summary: s }
    })
  }

  undo(ws: string, sha: string): Promise<Applied> {
    return this.lock(async () => {
      const v = await this.run('git', ['rev-parse', '--verify', '-q', `${sha}^{commit}`])
      if (v.code !== 0) return fail(`no such commit: ${sha}`)
      const full = v.out.trim(), subject = (await this.git('log', '-1', '--format=%s', full)).trim()
      if (!subject.startsWith(`${ws}: `) || subject.startsWith(`${ws}: grants — `)) return fail(`${sha} is not a commit of ${ws}'s agent`)
      const prefix = (await this.git('rev-parse', '--show-prefix')).trim(), top = (await this.git('rev-parse', '--show-toplevel')).trim()
      const all = this.z(await this.git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', full))
      if (all.some((f) => !f.startsWith(prefix))) return fail(`${sha} touches files outside this console`)
      const files = all.map((f) => f.slice(prefix.length))
      const why = this.refused(ws, files)
      if (why) return fail(why)
      const dirty = [...new Set([
        ...this.z(await this.git('diff', '--name-only', '-z', '--relative', 'HEAD', '--', ...files)),
        ...this.z(await this.git('ls-files', '-z', '--others', '--exclude-standard', '--', ...files)),
      ])]
      if (dirty.length) return fail(`uncommitted changes in ${dirty.join(', ')}: apply or discard them first`)

      const dir = mkdtempSync(join(tmpdir(), 'wc-undo-')), patch = join(dir, 'undo.patch')
      try {
        writeFileSync(patch, await this.git('diff', '--binary', '--no-renames', `${full}^`, full))
        const atTop = (...a: string[]) => this.exec('git', a, { cwd: top }).catch((e: Error) => ({ code: -1, out: e.message }))
        const ck = await atTop('apply', '-R', '--check', patch)
        if (ck.code !== 0) return fail(`${sha} does not revert cleanly: ${tail(ck.out, 5).join(' ')}`)
        const r = await atTop('apply', '-R', patch)
        if (r.code !== 0) return fail(`${sha} does not revert cleanly: ${tail(r.out, 5).join(' ')}`)
        const putBack = () => atTop('apply', patch)
        const b = await this.build()
        if (b) { await putBack(); return b }
        const swap = await swapDist(this.stage, this.dist)
        const summary = `undo — ${subject.slice(ws.length + 2)}`
        let done
        try { done = await this.commit(files.map((f) => `:(literal)${f}`), `${ws}: ${summary}`) } catch (e) { await swap.back(); await putBack(); return fail((e as Error).message) }
        swap.done(); this.restart?.()
        return { ok: true, sha: done.sha, files: done.files, summary }
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })
  }

  acceptGrants(ws: string, g: Grants, reason: string): Promise<Applied> {
    return this.lock(async () => {
      let n: Grants
      try { n = normGrants(g) } catch (e) { return fail(`the grants are malformed: ${(e as Error).message}`) }
      const why = oneLine(reason)
      if (!why) return fail('a reason is needed')
      if (linksUnder(this.root, [`workspaces/${ws}`]).length) return fail(`workspaces/${ws} holds a symlink or junction`)
      let cur: Grants | null = null
      try { cur = grantsOf(ws, this.root) } catch { /* a malformed file is replaced */ }
      if (cur && JSON.stringify(cur) === JSON.stringify(n)) return fail('the grants are already so')
      const file = grantsPath(ws, this.root), prev = existsSync(file) ? readFileSync(file) : null
      writeGrants(this.root, ws, n)
      const rel = `workspaces/${ws}/grants.json`
      let done
      try { done = await this.commit([rel], `${ws}: grants — ${why}`) } catch (e) {
        if (prev) writeFileSync(file, prev); else rmSync(file, { force: true })
        return fail((e as Error).message)
      }
      this.restart?.()
      return { ok: true, sha: done.sha, files: done.files, summary: `grants — ${why}` }
    })
  }

  /** a managed workspace from the template: its folder, empty grants, both registry lines and the database settings
      another workspace has, then checked, built and committed by the agent of ws; a failure takes it all back */
  createWorkspace(ws: string, n: NewWorkspace, taken: { ids: string[]; prefixes: string[] }): Promise<Applied> {
    return this.lock(async () => {
      const o = { ...n, title: oneLine(n.title) }
      const issue = newWorkspaceIssue(o, { ...taken, exists: (id) => existsSync(join(this.root, 'workspaces', id)) })
      if (issue) return fail(issue)
      const cfgFile = join(this.home, 'config.json'), cfgText = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null
      let raw: Record<string, unknown>
      try { raw = cfgText ? JSON.parse(cfgText) as Record<string, unknown> : {} } catch (e) { return fail(`config.json: ${(e as Error).message}`) }
      const sections = (raw.workspaces && typeof raw.workspaces === 'object' && !Array.isArray(raw.workspaces) ? raw.workspaces : {}) as Record<string, Record<string, unknown>>
      const from = Object.values(sections).find((x) => x && typeof x.pgUrl === 'string' && typeof x.pgPasswordPath === 'string')
      if (!from && !this.fake) return fail('no workspace in config.json has pgUrl and pgPasswordPath to share; a new workspace keeps its jobs in the console\'s PostgreSQL')

      const reg = { page: join(this.root, 'workspaces', 'page.ts'), server: join(this.root, 'workspaces', 'server.ts') }
      const old = { page: readFileSync(reg.page, 'utf8'), server: readFileSync(reg.server, 'utf8') }
      let next: typeof old
      try { next = { page: addRegistry(old.page, 'page', o.id), server: addRegistry(old.server, 'server', o.id) } } catch (e) { return fail((e as Error).message) }
      const dir = join(this.root, 'workspaces', o.id), own = [`workspaces/${o.id}`, 'workspaces/page.ts', 'workspaces/server.ts']
      const before = await this.outside(own)
      const back = () => {
        rmSync(dir, { recursive: true, force: true })
        writeFileSync(reg.page, old.page); writeFileSync(reg.server, old.server)
        if (cfgText === null) rmSync(cfgFile, { force: true }); else writeFileSync(cfgFile, cfgText)
      }
      try {
        mkdirSync(dir)
        for (const f of TEMPLATE_FILES) writeFileSync(join(dir, f), render(readFileSync(join(this.template, f), 'utf8'), o))
        writeGrants(this.root, o.id, EMPTY_GRANTS)
        writeFileSync(reg.page, next.page); writeFileSync(reg.server, next.server)
        if (from) {
          sections[o.id] = Object.fromEntries(DB_KEYS.filter((k) => from[k] !== undefined).map((k) => [k, from[k]]))
          writeFileSync(cfgFile, JSON.stringify({ ...raw, workspaces: sections }, null, 2) + '\n')
        }
      } catch (e) { back(); return fail((e as Error).message) }

      const c = await this.checkIn(o.id)
      if (!c.ok) { back(); return fail('the check failed', c.failures) }
      const b = await this.build()
      if (b) { back(); return b }
      const moved = this.moved(before, await this.outside(own))
      if (moved.length) { back(); rmSync(this.stage, { recursive: true, force: true }); return fail(`changed outside the new workspace while it was checked: ${moved.join(', ')}`) }
      const swap = await swapDist(this.stage, this.dist), summary = `create workspace ${o.id} — ${o.title}`
      let done
      try { done = await this.commit(own, `${ws}: ${summary}`) } catch (e) { await swap.back(); back(); return fail((e as Error).message) }
      swap.done(); this.restart?.()
      return { ok: true, sha: done.sha, files: done.files, summary }
    })
  }
}
