import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, type Ran, type Runner } from './lib.mjs'
import { AUTO_PROVIDERS, chooseProvider, consolePort, folder, install, parseArgs, provider, PROVIDER_IDS as IDS, tools, voice, writeConfig } from './install.mjs'
import { PROVIDER_IDS, PROVIDERS } from '../server/llm/providers.ts'
import { addRegistry, EMPTY_GRANTS_JSON, HOME, render, TEMPLATE_FILES } from './workspaces.mjs'
import { tempDir } from '../server/testdirs.ts'

/* install.mjs against throwaway git repos: a "core" whose console/ carries the real consumer/ templates and a few
   stub files, and a consumer folder. Git runs for real; npm, docker and the provider CLIs are fakes. */

process.env.GIT_CONFIG_COUNT = '2'
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
process.env.GIT_CONFIG_VALUE_0 = 'false'
process.env.GIT_CONFIG_KEY_1 = 'core.autocrlf'
process.env.GIT_CONFIG_VALUE_1 = 'false'

const tmp = (what: string) => tempDir(`install-${what}`)
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Install Test', '-c', 'user.email=install@example.test', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const put = (dir: string, p: string, body: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body) }
const read = (dir: string, p: string) => readFileSync(join(dir, p), 'utf8')
const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' })
const quiet = () => {}
const CONSUMER = fileURLToPath(new URL('../consumer/', import.meta.url))
const TEMPLATES = ['page.ts', 'server.ts', ...TEMPLATE_FILES.map((f) => `workspace-template/${f}`)]

function makeCore() {
  const core = tmp('core')
  git(core, 'init', '-q', '-b', 'main')
  put(core, 'console/package.json', '{ "name": "stub" }\n')
  put(core, 'console/.gitignore', 'node_modules/\ndist/\n')
  put(core, 'console/server/a.ts', 'export const a = 1\n')
  put(core, 'console/workspaces/page.ts', '// the core\'s own registry\n')
  put(core, 'console/workspaces/server.ts', '// the core\'s own registry\n')
  for (const t of TEMPLATES) put(core, `console/consumer/${t}`, readFileSync(join(CONSUMER, t), 'utf8'))
  git(core, 'add', '-A')
  git(core, 'commit', '-q', '-m', 'core')
  return core
}
const log = (dir: string) => git(dir, 'log', '--format=%s').split('\n')

/** git for real, npm and claude answered */
const fakeRun = (calls: string[] = []): Runner => (cmd, args, o) => {
  calls.push(`${cmd} ${args.join(' ')}`)
  if (cmd === 'git') return run(cmd, args, o)
  if (cmd === 'claude') return ok('{"loggedIn": true, "authMethod": "claude.ai", "email": "someone@example.test"}')
  return ok('10.9.0\n')
}
const dockerDown = () => ({ status: 1, stdout: '', stderr: 'error during connect' })
const dockerUp = (args: string[]) => (args[0] === 'version' ? ok('27.3.1\n') : ok())

test('parseArgs reads the flags and rejects the unknown', () => {
  const a = parseArgs(['--to', 'X', '--provider', 'cursor', '--port', '7500', '--force', '--no-start', '--no-prompt', '--core', 'C'])
  assert.equal(a.provider, 'cursor')
  assert.equal(a.port, 7500)
  assert.equal(a.force && !a.start && !a.prompt, true)
  assert.equal(a.core, 'C')
  assert.equal(parseArgs(['--to', 'X']).provider, null, 'no flag, no choice: the settings stay as they are')
  assert.throws(() => parseArgs(['--to', 'X', '--provider', 'other']), /claude\|cursor/)
  assert.throws(() => parseArgs(['--to', 'X', '--port', 'x']), /port/)
  assert.throws(() => parseArgs(['--bogus']), /unknown argument --bogus/)
})

test("the provider ids and those that run by themselves are the console's", () => {
  assert.deepEqual(IDS, PROVIDER_IDS)
  assert.deepEqual(AUTO_PROVIDERS, PROVIDER_IDS.filter((id) => PROVIDERS[id].auto))
})

test('chooseProvider writes --provider into providers.json, auto only where it can run by itself, and keeps the rest', () => {
  const home = tmp('home'), f = join(home, 'providers.json')
  assert.deepEqual(chooseProvider(home, null), { auto: 'claude', manual: 'claude' })
  assert.equal(existsSync(f), false, 'no flag writes nothing')
  assert.deepEqual(chooseProvider(home, 'cursor'), { auto: 'claude', manual: 'cursor' })
  assert.deepEqual(JSON.parse(read(home, 'providers.json')), { manual: 'cursor' })
  writeFileSync(f, JSON.stringify({ auto: 'claude', manual: 'cursor', claudePath: 'C:/x/claude.exe' }, null, 2))
  const before = read(home, 'providers.json')
  assert.deepEqual(chooseProvider(home, null), { auto: 'claude', manual: 'cursor' })
  assert.equal(read(home, 'providers.json'), before, "the user's choice stays byte for byte")
  assert.deepEqual(chooseProvider(home, 'claude'), { auto: 'claude', manual: 'claude' })
  assert.deepEqual(JSON.parse(read(home, 'providers.json')), { auto: 'claude', manual: 'claude', claudePath: 'C:/x/claude.exe' })
})

test('tools needs Node 22.6 or later, git and npm', () => {
  assert.equal(tools(fakeRun(), '23.3.0').ok, true)
  const old = tools(fakeRun(), '22.5.1')
  assert.equal(old.ok, false)
  assert.match(old.lines.join('\n'), /22\.6/)
  const noGit = tools((c) => (c === 'git' ? { status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ENOENT' }) } : ok('1\n')), '23.3.0')
  assert.equal(noGit.ok, false)
  assert.match(noGit.lines.join('\n'), /git/)
})

test('folder: an empty dir becomes a synced consumer repo with home and one commit', () => {
  const core = makeCore(), to = join(tmp('to'), 'console')
  const r = folder({ core, to, log: quiet })
  const tpl = (t: string) => readFileSync(join(CONSUMER, t), 'utf8')
  assert.equal(read(to, 'workspaces/page.ts'), addRegistry(tpl('page.ts'), 'page', 'home'))
  assert.equal(read(to, 'workspaces/server.ts'), addRegistry(tpl('server.ts'), 'server', 'home'))
  for (const f of TEMPLATE_FILES) assert.equal(read(to, `workspaces/home/${f}`), render(tpl(`workspace-template/${f}`), HOME), f)
  assert.equal(read(to, 'workspaces/home/grants.json'), EMPTY_GRANTS_JSON, 'home is managed from the start, granted nothing')
  assert.equal(read(to, 'server/a.ts'), 'export const a = 1\n')
  assert.equal(JSON.parse(read(to, 'core.lock.json')).core, git(core, 'rev-parse', 'HEAD'))
  assert.deepEqual(log(to), [`Work Console at core ${r.sha.slice(0, 7)}`])
  assert.equal(git(to, 'status', '--porcelain'), '')
  assert.equal(r.committed, true)
})

test('folder: repair keeps own files and restores a core file the person deleted', () => {
  const core = makeCore(), to = tmp('to')
  folder({ core, to, log: quiet })
  git(to, 'rm', '-q', 'server/a.ts')
  git(to, 'commit', '-q', '-m', 'oops')
  put(to, 'workspaces/home/page.ts', read(to, 'workspaces/home/page.ts') + '// mine\n')
  put(to, 'workspaces/page.ts', read(to, 'workspaces/page.ts') + '// mine too\n')
  const r = folder({ core, to, log: quiet })
  assert.equal(read(to, 'server/a.ts'), 'export const a = 1\n')
  assert.match(read(to, 'workspaces/home/page.ts'), /\/\/ mine\n$/)
  assert.match(read(to, 'workspaces/page.ts'), /\/\/ mine too\n$/)
  assert.equal(r.committed, true)
  assert.equal(git(to, 'show', '--name-only', '--format=', 'HEAD'), 'server/a.ts')
  // left unstaged: the helper trims, so the porcelain line starts with M
  assert.match(git(to, 'status', '--porcelain'), /^M workspaces\/home\/page\.ts$/m)
  assert.equal(git(to, 'diff', '--cached', '--name-only'), '')
})

test('folder: a repair with nothing to restore makes no commit', () => {
  const core = makeCore(), to = tmp('to')
  folder({ core, to, log: quiet })
  rmSync(join(to, 'server/a.ts'))
  const r = folder({ core, to, log: quiet })
  assert.equal(r.committed, false)
  assert.equal(log(to).length, 1)
  assert.equal(git(to, 'status', '--porcelain'), '')
})

test('folder: repair stays on the locked core even when the core moved on', () => {
  const core = makeCore(), to = tmp('to')
  const first = folder({ core, to, log: quiet })
  put(core, 'console/server/a.ts', 'export const a = 2\n')
  git(core, 'commit', '-q', '-am', 'next')
  assert.equal(folder({ core, to, log: quiet }).sha, first.sha)
  assert.equal(read(to, 'server/a.ts'), 'export const a = 1\n')
})

test('folder: refuses a non-empty folder that is not a console', () => {
  const core = makeCore(), to = tmp('to')
  put(to, 'notes.txt', 'mine')
  assert.throws(() => folder({ core, to, log: quiet }), /not empty/)
  assert.equal(existsSync(join(to, 'core.lock.json')), false)
})

test('writeConfig merges the port and the home database, keeping other keys', () => {
  const home = tmp('home')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ pcName: 'pc', loopbackPort: 1, workspaces: { other: { a: 1 }, home: { keep: 1 } } }))
  writeConfig(home, { port: 7412, pgUrl: 'postgres://work_console@127.0.0.1:55433/work_console', passwordPath: 'P' })
  assert.deepEqual(JSON.parse(read(home, 'config.json')), {
    pcName: 'pc', loopbackPort: 7412,
    workspaces: { other: { a: 1 }, home: { keep: 1, pgUrl: 'postgres://work_console@127.0.0.1:55433/work_console', pgPasswordPath: 'P' } },
  })
})

test('consolePort: --port, then config.json, then install.json, then the first free from 7410 past the LAN port', async () => {
  const home = tmp('home')
  const free = async (p: number) => p !== 7410
  assert.equal(await consolePort({ home, arg: null, free }), 7412)
  writeFileSync(join(home, 'install.json'), JSON.stringify({ port: 7600 }))
  assert.equal(await consolePort({ home, arg: null, free }), 7600)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ loopbackPort: 7500 }))
  assert.equal(await consolePort({ home, arg: null, free }), 7500)
  assert.equal(await consolePort({ home, arg: 8000, free }), 8000)
})

test('provider claude: signed in from claude auth status, without printing the email', () => {
  const r = provider('claude', fakeRun(), {})
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.line, /@/)
})

test('provider claude: an API key counts; signed out and missing say what to do', () => {
  assert.equal(provider('claude', () => { throw new Error('not called') }, { ANTHROPIC_API_KEY: 'k' }).ok, true)
  const out = provider('claude', () => ok('{"loggedIn": false}'), {})
  assert.equal(out.ok, false)
  assert.match(out.line, /claude auth login/)
  const missing = provider('claude', () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ENOENT' }) }), {})
  assert.equal(missing.ok, false)
  assert.match(missing.line, /not found/)
})

test('provider cursor: agent missing, signed out, signed in', () => {
  const enoent = { status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ENOENT' }) }
  assert.match(provider('cursor', () => enoent, {}).line, /not found/)
  const out = provider('cursor', () => ok('Not logged in\n'), {})
  assert.equal(out.ok, false)
  assert.match(out.line, /agent login/)
  const signed = provider('cursor', () => ok('Logged in as someone@example.test\n'), {})
  assert.equal(signed.ok, true)
  assert.doesNotMatch(signed.line, /@/)
})

test('voice: off without a prompt, a typed key is saved, an existing key is kept', async () => {
  const home = tmp('home')
  assert.match(await voice(home, { prompt: false }), /off/)
  assert.equal(existsSync(join(home, 'openai.key')), false)
  assert.match(await voice(home, { prompt: true, ask: async () => '' }), /off/)
  assert.match(await voice(home, { prompt: true, ask: async () => 'sk-test' }), /saved/)
  assert.equal(read(home, 'openai.key').trim(), 'sk-test')
  assert.match(await voice(home, { prompt: true, ask: async () => { throw new Error('asked again') } }), /on/)
})

test('voice: the key goes where config.json says the console reads it', async () => {
  const home = tmp('home'), keyPath = join(tmp('keys'), 'k.txt')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ openaiKeyPath: keyPath }))
  await voice(home, { prompt: true, ask: async () => 'sk-test' })
  assert.equal(readFileSync(keyPath, 'utf8').trim(), 'sk-test')
})

test('install: Docker down blocks the postgres step only and records no database address, exit 1', async () => {
  const core = makeCore(), to = tmp('to'), home = tmp('home'), calls: string[] = []
  const lines: string[] = []
  const r = await install({
    argv: ['--to', to, '--core', core, '--no-prompt'], env: { WORK_CONSOLE_HOME: home }, run: fakeRun(calls), docker: dockerDown,
    free: async (p) => p !== 7410, start: async (s) => `http://127.0.0.1:${s.port}`, log: (l) => lines.push(l),
  })
  const state = Object.fromEntries(r.steps.map((s) => [s.name, s.state]))
  assert.deepEqual(state, { checks: 'ok', folder: 'ok', postgres: 'blocked', provider: 'ok', voice: 'skipped', build: 'ok', start: 'ok' })
  assert.equal(r.code, 1)
  assert.match(r.steps.find((s) => s.name === 'postgres')!.line, /Postgres not running — start Docker and run install again/)
  const cfg = JSON.parse(read(home, 'config.json'))
  assert.equal(cfg.loopbackPort, 7412)
  assert.equal(cfg.workspaces, undefined, 'home stays unconfigured')
  const rec = JSON.parse(read(home, 'install.json'))
  assert.deepEqual(Object.keys(rec).sort(), ['core', 'folder', 'port', 'provider'])
  assert.equal(rec.provider, 'claude')
  assert.equal(existsSync(join(home, 'providers.json')), false, 'no --provider, so the settings file is not written')
  assert.ok(calls.includes('npm ci') && calls.includes('npm run build'))
})

test('install --provider cursor: the settings name it for open-in, auto stays claude, and both are checked', async () => {
  const core = makeCore(), to = tmp('to'), home = tmp('home'), calls: string[] = []
  const r = await install({
    argv: ['--to', to, '--core', core, '--no-prompt', '--no-start', '--provider', 'cursor'], env: { WORK_CONSOLE_HOME: home },
    run: (c, a, o) => (c === 'agent' ? (calls.push('agent'), ok('Logged in')) : fakeRun(calls)(c, a, o)), docker: dockerDown, free: async () => true, log: quiet,
  })
  assert.deepEqual(JSON.parse(read(home, 'providers.json')), { manual: 'cursor' })
  assert.equal(JSON.parse(read(home, 'install.json')).provider, 'cursor')
  const step = r.steps.find((s) => s.name === 'provider')!
  assert.equal(step.state, 'ok', step.line)
  assert.ok(calls.includes('agent') && calls.some((c) => c.startsWith('claude auth status')), step.line)
})

test('install: a postgres step that fails records no address either', async () => {
  const core = makeCore(), to = tmp('to'), home = tmp('home')
  const r = await install({
    argv: ['--to', to, '--core', core, '--no-prompt', '--no-start'], env: { WORK_CONSOLE_HOME: home }, run: fakeRun(), docker: dockerUp,
    pg: async () => { throw new Error('docker compose up failed: pull access denied') }, free: async () => true, log: quiet,
  })
  const step = r.steps.find((s) => s.name === 'postgres')!
  assert.equal(step.state, 'failed')
  assert.match(step.line, /pull access denied/)
  assert.equal(JSON.parse(read(home, 'config.json')).workspaces, undefined)
  assert.equal(JSON.parse(read(home, 'install.json')).pgPort, undefined)
})

test('install: with Docker down the address an earlier run recorded stays, since it is our own container', async () => {
  const core = makeCore(), to = tmp('to'), home = tmp('home')
  const pg = async (o: { home: string }) => ({ port: 55433, url: 'postgres://work_console@127.0.0.1:55433/work_console', passwordPath: join(o.home, 'postgres.password') })
  const go = (docker: typeof dockerUp) => install({
    argv: ['--to', to, '--core', core, '--no-prompt', '--no-start'], env: { WORK_CONSOLE_HOME: home }, run: fakeRun(), docker, pg, free: async () => true, log: quiet,
  })
  await go(dockerUp)
  const cfg = read(home, 'config.json')
  await go(dockerDown)
  assert.equal(read(home, 'config.json'), cfg)
  assert.equal(JSON.parse(read(home, 'install.json')).pgPort, 55433)
})

test('install: WORK_CONSOLE_PG_CONTAINER and WORK_CONSOLE_PG_VOLUME name the container, and the address is the one postgres gives', async () => {
  const core = makeCore(), to = tmp('to'), home = tmp('home')
  const seen: unknown[] = []
  const pg = async (o: { home: string; names?: unknown }) => { seen.push(o.names); return { port: 55434, url: 'postgres://work_console@127.0.0.1:55434/work_console', passwordPath: join(o.home, 'postgres.password') } }
  await install({
    argv: ['--to', to, '--core', core, '--no-prompt', '--no-start'], run: fakeRun(), docker: dockerUp, pg, free: async () => true, log: quiet,
    env: { WORK_CONSOLE_HOME: home, WORK_CONSOLE_PG_CONTAINER: 'work-console-postgres-test', WORK_CONSOLE_PG_VOLUME: 'work-console-pg-test' },
  })
  assert.deepEqual(seen, [{ container: 'work-console-postgres-test', volume: 'work-console-pg-test' }])
  assert.equal(JSON.parse(read(home, 'config.json')).workspaces.home.pgUrl, 'postgres://work_console@127.0.0.1:55434/work_console')
})

test('install: a second run on the same folder repairs and keeps the ports', async () => {
  const core = makeCore(), to = tmp('to'), home = tmp('home')
  const wants: (number | null | undefined)[] = []
  const pg = async (o: { home: string; want?: number | null }) => { wants.push(o.want); return { port: o.want ?? 55433, url: `postgres://work_console@127.0.0.1:${o.want ?? 55433}/work_console`, passwordPath: join(o.home, 'postgres.password') } }
  const go = () => install({
    argv: ['--to', to, '--core', core, '--no-prompt'], env: { WORK_CONSOLE_HOME: home }, run: fakeRun(), docker: dockerUp, pg,
    free: async () => true, start: async (s) => `http://127.0.0.1:${s.port}`, log: quiet,
  })
  const first = await go()
  assert.equal(first.code, 0)
  const rec = JSON.parse(read(home, 'install.json'))
  const second = await go()
  assert.equal(second.code, 0)
  assert.deepEqual(JSON.parse(read(home, 'install.json')), rec)
  assert.deepEqual(wants, [null, 55433])
  assert.equal(log(to).length, 1)
})

test('install: a failing build skips the start and exits 1', async () => {
  const core = makeCore(), to = tmp('to'), home = tmp('home')
  let started = false
  const r = await install({
    argv: ['--to', to, '--core', core, '--no-prompt'], env: { WORK_CONSOLE_HOME: home }, docker: dockerDown, free: async () => true,
    run: (c, a, o) => (c === 'npm' && a[1] === 'typecheck' ? { status: 2, stdout: '', stderr: 'TS2322' } : fakeRun()(c, a, o)),
    start: async () => { started = true; return 'x' }, log: quiet,
  })
  assert.equal(r.code, 1)
  assert.equal(r.steps.find((s) => s.name === 'build')?.state, 'failed')
  assert.equal(r.steps.find((s) => s.name === 'start')?.state, 'skipped')
  assert.equal(started, false)
})
