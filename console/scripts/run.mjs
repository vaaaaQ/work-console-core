#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeProfile, edgeProfile } from './edge.mjs'
import { alive, consoleHome, readJson, writeJson } from './lib.mjs'

/* Keeps the console's server running:
     node <dir>/scripts/run.mjs [--home <dir>]     in this window; Ctrl+C stops it
     node <dir>/scripts/run.mjs --detach           in the background, prints the URL
     node <dir>/scripts/run.mjs --stop | --restart
   Exit code 75 restarts the server at once and keeps the console's Edge; any other exit restarts it after a backoff.
   Stopping closes the Edge too.
   Output goes to <home>/logs/console.log; <home>/run.json names the supervisor and the server. */

export const RESTART = 75
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MB10 = 10 * 1024 * 1024
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 1 s after the first quick failure, doubling, at most 60 s */
export const backoff = (fails) => Math.min(60000, 1000 * 2 ** Math.max(0, fails - 1))

const serverCmd = (folder) => [process.execPath, '--experimental-strip-types', '--no-warnings=ExperimentalWarning', join(folder, 'server', 'main.ts')]
const portOf = (home) => readJson(join(home, 'config.json'), {}).loopbackPort ?? 7410
const rotate = (file) => { try { if (statSync(file).size > MB10) renameSync(file, `${file}.1`) } catch { /* no log yet */ } }

export function supervisorOf(home) {
  const s = readJson(join(home, 'run.json'), null)
  return s && alive(s.pid) ? s : null
}

export function supervise(o) {
  const { folder, home, cmd = serverCmd(folder), log = () => {}, quickMs = 60000, backoff: wait = backoff } = o
  const running = supervisorOf(home)
  if (running) throw new Error(`the console already runs for ${home} (pid ${running.pid}); run.mjs --stop ends it`)
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logFile = join(home, 'logs', 'console.log'), runFile = join(home, 'run.json'), flag = join(home, 'restart')
  rmSync(flag, { force: true })
  let stopping = false, child = null
  const note = (line) => { const l = `[${new Date().toISOString()}] ${line}`; appendFileSync(logFile, l + '\n'); log(l) }
  const record = (server) => writeJson(runFile, { pid: process.pid, server, folder, port: portOf(home) })
  const consume = () => { if (!existsSync(flag)) return false; rmSync(flag, { force: true }); return true }
  // a backoff ends early on stop or on a restart request
  const pause = (ms) => new Promise((res) => {
    const end = Date.now() + ms
    const t = setInterval(() => { if (stopping || Date.now() >= end || existsSync(flag)) { clearInterval(t); res() } }, Math.min(250, ms))
  })
  record(null)

  const done = (async () => {
    let fails = 0
    while (!stopping) {
      rotate(logFile)
      note('starting')
      const t0 = Date.now(), fd = openSync(logFile, 'a')
      let code
      try {
        child = spawn(cmd[0], cmd.slice(1), { cwd: folder, env: { ...process.env, WORK_CONSOLE_HOME: home }, stdio: ['ignore', fd, fd], windowsHide: true })
        if (child.pid) record(child.pid)
        code = await new Promise((res) => {
          child.once('error', (e) => { note(`could not start: ${e.message}`); res(1) })
          child.once('exit', (c) => res(c ?? 1))
        })
      } finally { closeSync(fd); child = null }
      if (stopping) break
      record(null)
      if (consume() || code === RESTART) { note(`exited with ${code}; restarting now`); fails = 0; continue }
      fails = Date.now() - t0 >= quickMs ? 1 : fails + 1
      const ms = wait(fails)
      note(`exited with ${code}; restarting in ${ms / 1000} s`)
      await pause(ms)
      consume()
    }
    note('stopped')
    rmSync(runFile, { force: true })
    rmSync(flag, { force: true })
  })()

  return { done, stop: async () => { stopping = true; child?.kill(); await done; await closeProfile(edgeProfile(home)) } }
}

/** asks a running supervisor to restart its server now; false when none runs */
export function requestRestart(home) {
  const s = supervisorOf(home)
  if (!s) return false
  writeFileSync(join(home, 'restart'), String(Date.now()))
  if (alive(s.server)) try { process.kill(s.server) } catch { /* already gone */ }
  return true
}

/** ends the supervisor first, so nothing restarts the server, then the server, then closes the console's Edge */
export async function stopConsole(home) {
  const s = readJson(join(home, 'run.json'), null)
  const pids = s ? [s.pid, s.server] : []
  for (const pid of pids) if (alive(pid)) try { process.kill(pid) } catch { /* already gone */ }
  for (const end = Date.now() + 5000; pids.some(alive) && Date.now() < end;) await sleep(50)
  rmSync(join(home, 'run.json'), { force: true })
  rmSync(join(home, 'restart'), { force: true })
  await closeProfile(edgeProfile(home))
  return !!s
}

export async function waitUp({ port, home, timeoutMs = 60000 }) {
  const url = `http://127.0.0.1:${port}/`
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(500)) {
    try { if ((await fetch(`${url}api/state`, { signal: AbortSignal.timeout(2000) })).ok) return url } catch { /* not up yet */ }
  }
  throw new Error(`the console did not answer on ${url} within ${Math.round(timeoutMs / 1000)} s; see ${join(home, 'logs', 'console.log')}`)
}

/** starts the folder's own run.mjs in the background and waits for the URL */
export function detach({ folder, home, port, timeoutMs }) {
  const child = spawn(process.execPath, [join(folder, 'scripts', 'run.mjs'), '--home', home], { cwd: folder, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return waitUp({ port, home, timeoutMs })
}

/** install's start step: restart a running console of this folder, else start one */
export async function startConsole({ folder, home, port }) {
  const s = supervisorOf(home)
  if (s && resolve(s.folder) === resolve(folder)) {
    const old = s.server
    requestRestart(home)
    for (const end = Date.now() + 30000; Date.now() < end; await sleep(250)) {
      const now = supervisorOf(home)
      if (now?.server && now.server !== old) break
    }
    return waitUp({ port, home })
  }
  if (s) await stopConsole(home)
  return detach({ folder, home, port })
}

async function cli(argv) {
  let home = consoleHome(), mode = 'run'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home') home = resolve(argv[++i] ?? '')
    else if (['--detach', '--stop', '--restart'].includes(argv[i])) mode = argv[i].slice(2)
    else throw new Error(`unknown argument ${argv[i]}\nusage: node scripts/run.mjs [--home <dir>] [--detach | --stop | --restart]`)
  }
  if (mode === 'stop') return console.log(await stopConsole(home) ? 'stopped' : 'not running')
  if (mode === 'restart') return console.log(requestRestart(home) ? 'restarting' : 'not running: run.mjs --detach starts it')
  if (mode === 'detach') {
    if (supervisorOf(home)) return console.log(`already running: http://127.0.0.1:${portOf(home)}/`)
    return console.log(await detach({ folder: HERE, home, port: portOf(home) }))
  }
  const sup = supervise({ folder: HERE, home, log: (l) => console.log(l) })
  const quit = () => { void sup.stop().then(() => process.exit(0)) }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
  await sup.done
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  cli(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1 })
}
