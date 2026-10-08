#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { consoleHome, firstFree, gitId, isFree, npmChecks, readJson, run, writeJson } from './lib.mjs'
import { dockerRunner, engine, envNames, postgres } from './postgres.mjs'
import { startConsole } from './run.mjs'
import { isCoreLayout, readCore, sync } from './sync-core.mjs'

/* One command from an empty folder to a running console:
     node <core>/console/scripts/install.mjs --to <dir> [--provider claude|cursor] [--port n] [--force] [--no-start] [--no-prompt]
   checks, folder, postgres, provider, voice, build, start. Every step can run again: a second run on the same
   folder repairs it, and `node <dir>/scripts/install.mjs` does the same from the folder itself. */

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = 'usage: node <core>/console/scripts/install.mjs --to <dir> [--provider claude|cursor] [--port n] [--force] [--no-start] [--no-prompt] [--core <core repo>]'
const TEMPLATES = [['consumer/page.ts', 'workspaces/page.ts'], ['consumer/server.ts', 'workspaces/server.ts'],
  ['consumer/home/page.ts', 'workspaces/home/page.ts'], ['consumer/home/server.ts', 'workspaces/home/server.ts']]

export function parseArgs(argv) {
  const o = { to: '', provider: 'claude', port: null, force: false, start: true, prompt: true, core: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--to') o.to = argv[++i] ?? ''
    else if (a === '--provider') o.provider = argv[++i] ?? ''
    else if (a === '--port') o.port = Number(argv[++i])
    else if (a === '--core') o.core = argv[++i] ?? null
    else if (a === '--force') o.force = true
    else if (a === '--no-start') o.start = false
    else if (a === '--no-prompt') o.prompt = false
    else throw new Error(`unknown argument ${a}\n${USAGE}`)
  }
  if (!['claude', 'cursor'].includes(o.provider)) throw new Error(`--provider takes claude|cursor\n${USAGE}`)
  if (o.port !== null && !(Number.isInteger(o.port) && o.port > 0 && o.port < 65536)) throw new Error(`--port takes a port number\n${USAGE}`)
  return o
}

const missing = (r) => r.error?.code === 'ENOENT' || (!r.stdout.trim() && /is not recognized|command not found|No such file/i.test(r.stderr))

export function tools(r = run, version = process.versions.node) {
  const [maj, min] = version.split('.').map(Number)
  let ok = maj > 22 || (maj === 22 && min >= 6)
  const lines = [ok ? `node ${version}` : `node ${version} is too old: install Node 22.6 or later`]
  for (const [cmd, fix] of [['git', 'install Git'], ['npm', 'it comes with Node: reinstall Node']]) {
    const v = r(cmd, ['--version'], { timeout: 30000 })
    if (v.status === 0) lines.push(`${cmd} ${v.stdout.trim().replace(/^git version /, '')}`)
    else { ok = false; lines.push(`${cmd} not found: ${fix}`) }
  }
  return { ok, lines }
}

function git(r, cwd, args, input) {
  const g = r('git', ['-C', cwd, ...args], { input })
  if (g.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(g.stderr || g.error?.message || '').trim()}`)
  return g.stdout
}

/** the consumer folder: the home workspace when there are no registries, the core at its locked commit, one commit */
export function folder(o) {
  const { core, force = false, run: r = run, log = console.log } = o
  const to = resolve(o.to)
  mkdirSync(to, { recursive: true })
  const lock = readJson(join(to, 'core.lock.json'), null)
  const regs = TEMPLATES.slice(0, 2).every(([, p]) => existsSync(join(to, p)))
  if (!lock && !regs && readdirSync(to).some((n) => n !== '.git')) throw new Error(`${to} is not empty and is not a Work Console folder: give an empty or a new folder`)
  // a repair stays on the locked core; moving on is update.mjs's job
  const rev = lock?.core ?? 'HEAD'
  const wrote = []
  if (!regs) {
    const { files } = readCore(core, rev)
    for (const [from, p] of TEMPLATES) {
      if (existsSync(join(to, p))) continue
      const buf = files.get(from)
      if (!buf) throw new Error(`the core at ${rev} has no console/${from}`)
      mkdirSync(dirname(join(to, p)), { recursive: true })
      writeFileSync(join(to, p), buf)
      wrote.push(p)
    }
  }
  const s = sync({ core, to, rev, force, log })
  if (!existsSync(join(to, '.git'))) git(r, to, ['init', '-q', '-b', 'main'])
  const born = r('git', ['-C', to, 'rev-parse', '-q', '--verify', 'HEAD']).status === 0
  const ours = [...new Set([...s.written, ...wrote, 'core.lock.json'])]
  git(r, to, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], ours.join('\0'))
  if (s.deleted.length) git(r, to, ['rm', '-q', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], s.deleted.join('\0'))
  // only the paths this run wrote or deleted are committed; whatever else the person staged stays staged
  const mine = new Set([...ours, ...s.deleted])
  const changed = git(r, to, ['diff', '--cached', '--name-only', '--no-renames', '-z']).split('\0').filter((p) => p && mine.has(p))
  if (!changed.length) return { sha: s.sha, wrote, committed: false }
  const msg = born ? `Repair at core ${s.sha.slice(0, 7)}` : `Work Console at core ${s.sha.slice(0, 7)}`
  git(r, to, [...gitId(to, r), 'commit', '-q', '-m', msg, '--pathspec-from-file=-', '--pathspec-file-nul'], changed.join('\0'))
  return { sha: s.sha, wrote, committed: true }
}

export async function consolePort({ home, arg, free = isFree }) {
  if (arg) return arg
  const cfg = readJson(join(home, 'config.json'), {})
  if (cfg.loopbackPort) return cfg.loopbackPort
  const rec = readJson(join(home, 'install.json'), {})
  if (rec.port) return rec.port
  return firstFree(7410, { taken: new Set([cfg.lanPort ?? 7411]), free })
}

/** merges the port and the home workspace's database into <home>/config.json, the file the server reads */
export function writeConfig(home, { port, pgUrl, passwordPath }) {
  const f = join(home, 'config.json')
  const cfg = readJson(f, {})
  cfg.loopbackPort = port
  if (pgUrl) cfg.workspaces = { ...cfg.workspaces, home: { ...cfg.workspaces?.home, pgUrl, pgPasswordPath: passwordPath } }
  writeJson(f, cfg)
}

/** reports whether the LLM provider is ready; never signs in and never installs */
export function provider(name, r = run, env = process.env) {
  if (name === 'claude') {
    if (env.ANTHROPIC_API_KEY) return { ok: true, line: 'Claude: ANTHROPIC_API_KEY is set' }
    const s = r('claude', ['auth', 'status'], { timeout: 30000 })
    if (missing(s)) return { ok: false, line: 'Claude Code not found: install it, then run claude auth login' }
    let st = null
    try { st = JSON.parse(s.stdout) } catch { /* an older CLI prints text */ }
    // the status carries the account's email; only the method is shown
    if (st?.loggedIn) return { ok: true, line: `Claude Code signed in${typeof st.authMethod === 'string' ? ` (${st.authMethod})` : ''}` }
    return { ok: false, line: 'Claude Code is not signed in: run claude auth login' }
  }
  if (env.CURSOR_API_KEY) return { ok: true, line: 'Cursor: CURSOR_API_KEY is set' }
  const s = r('agent', ['status'], { timeout: 30000 })
  if (missing(s)) return { ok: false, line: 'Cursor agent CLI not found: install it, then run agent login' }
  const text = `${s.stdout}\n${s.stderr}`
  if (s.status === 0 && !/not (logged|signed) in|unauthenticated/i.test(text) && /logged in|signed in|authenticated/i.test(text)) return { ok: true, line: 'Cursor agent signed in' }
  return { ok: false, line: 'Cursor agent is not signed in: run agent login' }
}

function askHidden(q) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    // echo the question but not the key
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(q) }
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); res(a) })
  })
}

/** the OpenAI key for voice, asked once and written where the console reads it */
export async function voice(home, { prompt, ask = askHidden }) {
  const keyPath = readJson(join(home, 'config.json'), {}).openaiKeyPath || join(home, 'openai.key')
  if (existsSync(keyPath) && readFileSync(keyPath, 'utf8').trim()) return 'on: the OpenAI key is in place'
  const off = `off: put an OpenAI key in ${keyPath} to show the mic`
  if (!prompt) return off
  const key = (await ask('OpenAI key for voice (Enter skips): ')).trim()
  if (!key) return off
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, key + '\n', { mode: 0o600 })
  return 'on: the key is saved'
}

export const PG_DOWN = 'Postgres not running — start Docker and run install again'

export async function install(o = {}) {
  const { env = process.env, run: r = run, docker = dockerRunner(r), pg = postgres, free = isFree, log = console.log, ask, start = startConsole } = o
  const a = parseArgs(o.argv ?? process.argv.slice(2))
  const home = consoleHome(env)
  const recorded = readJson(join(home, 'install.json'), {})
  const steps = []
  const step = (name, state, line) => { steps.push({ name, state, line }); log(`[${state}] ${name}: ${line}`) }
  const sub = (l) => log(`  ${l}`)
  const inCore = isCoreLayout(HERE)
  const finish = (to) => {
    const code = steps.some((s) => s.state === 'failed' || s.state === 'blocked') ? 1 : 0
    if (code) log(`\nSome steps need you (above). When they are done, run the install again${to ? `: node ${join(to, 'scripts', 'install.mjs')}` : ''}`)
    else log(`\nInstalled. Update with node ${join(to, 'scripts', 'update.mjs')}. To start the console at logon, add\n  node ${join(to, 'scripts', 'run.mjs')} --detach\nto your startup apps; the install does not change your system.`)
    return { code, steps }
  }

  const t = tools(r)
  const eng = engine(docker)
  if (!t.ok) { step('checks', 'failed', t.lines.join(', ')); return finish(null) }
  step('checks', 'ok', [...t.lines, eng.ok ? `docker ${eng.version}` : 'docker does not answer'].join(', '))

  const core = resolve(a.core ?? (inCore ? resolve(HERE, '..') : recorded.core ?? ''))
  if (!a.core && !inCore && !recorded.core) { step('folder', 'failed', `no core recorded in ${join(home, 'install.json')}: pass --core <core repo>`); return finish(null) }
  if (!a.to && inCore) throw new Error(USAGE)
  const to = resolve(a.to || HERE)
  try {
    const f = folder({ core, to, force: a.force, run: r, log: sub })
    step('folder', 'ok', `${to} at core ${f.sha.slice(0, 7)}${f.committed ? ', committed' : ''}`)
  } catch (e) { step('folder', 'failed', e.message); return finish(to) }

  const port = await consolePort({ home, arg: a.port, free })
  // only a container that came up gives home an address; without one home stays unconfigured and says why
  let db = null
  if (!eng.ok) step('postgres', 'blocked', `Docker does not answer (${eng.why}). ${PG_DOWN}`)
  else {
    try {
      db = await pg({ home, docker, names: envNames(env), want: recorded.pgPort ?? null, free, log: sub })
      step('postgres', 'ok', `127.0.0.1:${db.port}`)
    } catch (e) { step('postgres', 'failed', `${e.message}. Home stays without a database: run install again once this is fixed`) }
  }
  writeConfig(home, { port, pgUrl: db?.url, passwordPath: db?.passwordPath })
  // a port an earlier run recorded is our own container's, so it stays when this run could not reach Docker
  const pgPort = db?.port ?? recorded.pgPort
  writeJson(join(home, 'install.json'), { core, folder: to, port, ...(pgPort ? { pgPort } : {}), provider: a.provider })

  const p = provider(a.provider, r, env)
  step('provider', p.ok ? 'ok' : 'todo', p.line)

  const v = await voice(home, { prompt: a.prompt && (!!ask || !!process.stdin.isTTY), ask })
  step('voice', v.startsWith('on') ? 'ok' : 'skipped', v)

  const b = npmChecks(to, { run: r, build: true, log: sub })
  step('build', b.ok ? 'ok' : 'failed', b.ok ? 'npm ci, typecheck, tests, vite build' : `${b.step} failed:\n${b.output}`)

  if (!b.ok) step('start', 'skipped', 'the build failed')
  else if (!a.start) step('start', 'skipped', `--no-start: node ${join(to, 'scripts', 'run.mjs')} starts it`)
  else {
    try { step('start', 'ok', await start({ folder: to, home, port })) } catch (e) { step('start', 'failed', e.message) }
  }
  return finish(to)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  install().then((r) => { process.exitCode = r.code }, (e) => { console.error(e.message); process.exitCode = 1 })
}
