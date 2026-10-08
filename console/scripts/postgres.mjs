// The console's own PostgreSQL in Docker: one container, one named volume, a generated password in <home>.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { firstFree, isFree, run } from './lib.mjs'

export const PG = { project: 'work-console', container: 'work-console-postgres', volume: 'work-console-pg', port: 55432, user: 'work_console', db: 'work_console' }
export const COMPOSE = fileURLToPath(new URL('../postgres/compose.yaml', import.meta.url))

export const dockerRunner = (r = run) => (args, o = {}) => r('docker', args, { ...o, env: { ...process.env, ...o.env } })

const first = (r) => (r.stderr || r.stdout || r.error?.message || '').trim().split(/\r?\n/)[0]

export function engine(docker) {
  const v = docker(['version', '--format', '{{.Server.Version}}'], { timeout: 30000 })
  if (v.error?.code === 'ENOENT') return { ok: false, why: 'docker is not installed (install Docker Desktop)' }
  // docker can exit 0 while the engine is down, so only a printed server version counts
  const version = v.stdout.trim()
  if (!version) return { ok: false, why: first(v) || 'the Docker engine does not answer' }
  const ps = docker(['ps', '-q'], { timeout: 30000 })
  if (ps.status !== 0) return { ok: false, why: first(ps) || 'the Docker engine does not list containers' }
  if (docker(['compose', 'version'], { timeout: 30000 }).status !== 0) return { ok: false, why: 'docker compose is missing' }
  return { ok: true, version }
}

export function ensurePassword(home) {
  const f = join(home, 'postgres.password')
  if (existsSync(f) && readFileSync(f, 'utf8').trim()) return f
  mkdirSync(home, { recursive: true })
  writeFileSync(f, randomBytes(24).toString('base64url') + '\n', { mode: 0o600 })
  return f
}

/** the host ports a docker ps Ports column publishes: 127.0.0.1:55432->5432/tcp, [::]:80->80/tcp, ranges */
export function published(col) {
  const out = []
  for (const m of col.matchAll(/:(\d+)(?:-(\d+))?->/g)) for (let p = Number(m[1]); p <= Number(m[2] ?? m[1]); p++) out.push(p)
  return [...new Set(out)]
}

/** every container: a running one with the host ports it publishes, a stopped one with those it would */
export function containers(docker) {
  const r = docker(['ps', '-a', '--format', '{{.Names}}|{{.State}}|{{.Ports}}'])
  if (r.status !== 0) throw new Error(`docker ps failed: ${first(r)}`)
  const list = r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [names, state, ports = ''] = line.split('|')
    return { name: names.split(',')[0], running: state === 'running', ports: published(ports) }
  })
  const stopped = list.filter((c) => !c.running)
  if (stopped.length) {
    const d = docker(['inspect', '--format', '{{.Name}}|{{json .HostConfig.PortBindings}}', ...stopped.map((c) => c.name)])
    for (const line of d.stdout.split(/\r?\n/).filter(Boolean)) {
      const [name, ...rest] = line.split('|')
      const c = stopped.find((x) => x.name === name.replace(/^\//, ''))
      const bound = JSON.parse(rest.join('|') || 'null') ?? {}
      if (c) c.ports = Object.values(bound).flat().map((b) => Number(b?.HostPort)).filter((p) => p > 0)
    }
  }
  return list
}

/** PG with the overrides; a renamed container gets its own compose project, so compose never touches the default one */
export function pgNames(over = {}) {
  const n = { ...PG, ...over }
  // renamed apart, a test container would share the real volume, and its down -v would remove it
  if ((n.container === PG.container) !== (n.volume === PG.volume)) throw new Error('rename the Postgres container and volume together')
  if (!over.project && n.container !== PG.container) n.project = n.container
  return n
}

/** WORK_CONSOLE_PG_CONTAINER and WORK_CONSOLE_PG_VOLUME: a test install's own container beside the real one */
export function envNames(env = process.env) {
  const o = {}
  if (env.WORK_CONSOLE_PG_CONTAINER) o.container = env.WORK_CONSOLE_PG_CONTAINER
  if (env.WORK_CONSOLE_PG_VOLUME) o.volume = env.WORK_CONSOLE_PG_VOLUME
  return o
}

const composeEnv = (n, port, passwordPath) => ({
  WORK_CONSOLE_PG_PORT: String(port), WORK_CONSOLE_PG_PASSWORD_FILE: passwordPath,
  WORK_CONSOLE_PG_CONTAINER: n.container, WORK_CONSOLE_PG_VOLUME: n.volume,
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function postgres(o) {
  const { home, docker, want = null, free = isFree, wait = { tries: 120, ms: 1000 }, log = () => {} } = o
  const n = pgNames(o.names)
  const e = engine(docker)
  if (!e.ok) throw new Error(`Docker: ${e.why}`)
  const passwordPath = ensurePassword(home)
  const password = readFileSync(passwordPath, 'utf8').trim()

  // ours is only what our own container publishes; any other container's port is skipped, and the probe catches the rest
  const all = containers(docker)
  const own = all.find((c) => c.name === n.container)
  const owner = new Map(all.filter((c) => c !== own).flatMap((c) => c.ports.map((p) => [p, c.name])))
  let port
  if (own?.running && own.ports.length) port = own.ports[0]
  else {
    const prefer = own?.ports[0] ?? want ?? n.port
    if (!owner.has(prefer) && (await free(prefer))) port = prefer
    else {
      port = await firstFree(n.port, { taken: new Set(owner.keys()), free })
      log(`postgres: ${prefer} is held by ${owner.get(prefer) ?? 'another process'}, taking ${port}`)
    }
  }

  log(`postgres: ${n.container} on 127.0.0.1:${port}`)
  const up = docker(['compose', '-p', n.project, '-f', COMPOSE, 'up', '-d'], { env: composeEnv(n, port, passwordPath), timeout: 600000 })
  if (up.status !== 0) throw new Error(`docker compose up failed: ${(up.stderr || up.stdout).trim()}`)

  let last = ''
  let reset = false
  for (let i = 0; i < wait.tries; i++) {
    // -h 127.0.0.1 skips the socket-only server the image runs while it initializes
    const p = docker(['exec', '-e', 'PGPASSWORD', n.container, 'psql', '-h', '127.0.0.1', '-U', n.user, '-d', n.db, '-tAc', 'select 1'], { env: { PGPASSWORD: password }, timeout: 30000 })
    if (p.status === 0 && p.stdout.trim() === '1') return { port, url: `postgres://${n.user}@127.0.0.1:${port}/${n.db}`, passwordPath }
    last = first(p)
    if (/password authentication failed/.test(p.stderr) && !reset) {
      // the volume outlived its password file: the image trusts the local socket, so set the role's password again
      log('postgres: the password changed, setting it on the role')
      const a = docker(['exec', '-i', n.container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', n.user, '-d', n.db], { input: `ALTER ROLE "${n.user}" WITH PASSWORD '${password}';\n`, timeout: 30000 })
      if (a.status !== 0) throw new Error(`postgres: could not reset the password: ${first(a)}`)
      reset = true
      continue
    }
    await sleep(wait.ms)
  }
  throw new Error(`postgres: ${n.container} did not answer: ${last}`)
}

/** removes the project's container and volume; for tests and a deliberate uninstall */
export function pgDown(o) {
  const n = pgNames(o.names)
  if (n.container === PG.container) throw new Error('pgDown removes a renamed container only, never the default one')
  return o.docker(['compose', '-p', n.project, '-f', COMPOSE, 'down', '-v'], { env: composeEnv(n, n.port, o.passwordPath ?? COMPOSE), timeout: 120000 })
}
