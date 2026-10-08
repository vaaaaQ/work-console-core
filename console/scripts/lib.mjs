// Helpers shared by install.mjs, run.mjs, update.mjs and postgres.mjs. Plain Node, no dependencies.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const consoleHome = (env = process.env) => env.WORK_CONSOLE_HOME || join(homedir(), '.work-console')

export function readJson(file, fallback) {
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return fallback; throw e }
  try { return JSON.parse(text) } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`) }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

// Windows ships these as .cmd shims, which Node starts only through cmd.exe
const SHIMS = new Set(['npm', 'npx', 'claude', 'agent'])
const quote = (a) => {
  if (/["%^&|<>!]/.test(a)) throw new Error(`run: refusing a shell argument with metacharacters: ${a}`)
  return /\s/.test(a) || a === '' ? `"${a}"` : a
}

export function run(cmd, args = [], o = {}) {
  const opts = { cwd: o.cwd, env: o.env, input: o.input, timeout: o.timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
  const r = process.platform === 'win32' && SHIMS.has(cmd)
    ? spawnSync([cmd, ...args].map(quote).join(' '), { ...opts, shell: true })
    : spawnSync(cmd, args, opts)
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) }
}

// Windows lets a second socket bind a port another process holds, so a connect probe decides too
const answers = (port, host) => new Promise((res) => {
  const s = connect({ port, host })
  const done = (v) => { s.destroy(); res(v) }
  s.setTimeout(500, () => done(false))
  s.once('connect', () => done(true))
  s.once('error', () => done(false))
})
const bindable = (port, host) => new Promise((res) => {
  const s = createServer()
  s.once('error', () => res(false))
  s.listen(port, host, () => s.close(() => res(true)))
})
export const isFree = async (port, host = '127.0.0.1') => !(await answers(port, host)) && (await bindable(port, host))

export async function firstFree(start, o = {}) {
  const { taken = new Set(), free = isFree, limit = 100 } = o
  for (let p = start; p < start + limit; p++) if (!taken.has(p) && (await free(p))) return p
  throw new Error(`no free port in ${start}-${start + limit - 1}`)
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

export function gitId(cwd, r = run) {
  const me = r('git', ['config', 'user.email'], { cwd })
  return me.status === 0 && me.stdout.trim() ? [] : ['-c', 'user.name=Work Console', '-c', 'user.email=work-console@localhost']
}

export const tail = (text, n = 200) => text.split(/\r?\n/).slice(-n).join('\n')

const STEPS = [['npm ci', ['ci']], ['typecheck', ['run', 'typecheck']], ['tests', ['test']], ['build', ['run', 'build']]]

export function npmChecks(folder, o = {}) {
  const { run: r = run, log = () => {}, build = false } = o
  for (const [step, args] of STEPS) {
    if (step === 'build' && !build) continue
    log(`${step}...`)
    let got = r('npm', args, { cwd: folder })
    // the suite has known load flakes; one more run tells a flake from a failure
    if (step === 'tests' && got.status !== 0) { log('tests failed once, running them again'); got = r('npm', args, { cwd: folder }) }
    if (got.status !== 0) return { ok: false, step, output: tail(`${got.stdout}\n${got.stderr}${got.error ? `\n${got.error.message}` : ''}`) }
  }
  return { ok: true }
}
