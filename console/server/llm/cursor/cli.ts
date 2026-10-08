import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/* Where the Cursor agent CLI is, and how a session's process starts and ends. The CLI is started as its own launcher
   does, its bundled node on its index.js, with a preload that gives it the session's own home folder. */

const VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/
export interface Install { node: string; index: string }
export const PRELOAD = join(import.meta.dirname, 'home.cjs')
export const GUARD = join(import.meta.dirname, 'guard.cjs')

/** the installer's own folder */
export const defaultRoot = (platform = process.platform, env = process.env) =>
  (platform === 'win32' ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'cursor-agent') : join(homedir(), '.local', 'share', 'cursor-agent'))

const order = (v: string) => VERSION.exec(v)!.slice(1).map((x) => (x ?? '0').padStart(4, '0')).join('')
function inVersion(dir: string, platform: string): Install | null {
  const index = join(dir, 'index.js'), node = join(dir, platform === 'win32' ? 'node.exe' : 'node')
  return existsSync(index) && existsSync(node) ? { node, index } : null
}
function newest(root: string, platform: string): Install | null {
  let vs: string[] = []
  try { vs = readdirSync(join(root, 'versions')).filter((v) => VERSION.test(v)) } catch { return null }
  for (const v of vs.sort((a, b) => order(b).localeCompare(order(a)))) { const i = inVersion(join(root, 'versions', v), platform); if (i) return i }
  return null
}

/** setting = the cursorPath setting: the CLI's launcher, or any file of a version folder; none = the installer's folder */
export function findInstall(setting?: string, root = defaultRoot(), platform: string = process.platform): Install {
  if (setting) {
    let real = setting
    try { real = realpathSync(setting) } catch { /* the setting as it is */ }
    const i = inVersion(dirname(real), platform) ?? newest(dirname(real), platform)
    if (i) return i
    throw new Error(`cursor_missing: ${setting} is not the Cursor agent CLI: no index.js and node beside it or in its versions folder`)
  }
  const i = newest(root, platform)
  if (!i) throw new Error(`cursor_missing: no Cursor agent CLI in ${root}; install it, or name its launcher in Settings`)
  return i
}

/** the ripgrep the CLI searches with: its own beside its index.js, else the one on PATH */
export function ripgrep(i: Install, platform: string = process.platform): string {
  const own = join(dirname(i.index), platform === 'win32' ? 'rg.exe' : 'rg')
  return existsSync(own) ? own : 'rg'
}

/** what a Windows session keeps of the console's environment: hooks and shell commands start several times faster on a short one */
const WIN_KEEP = ['SystemRoot', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'SystemDrive', 'PSModulePath', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles', 'USERNAME', 'USERDOMAIN', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
export interface RunDirs { config: string; data: string; home: string; tmp: string }

/** the session's environment: its own config, data, home and temp folders, and no browser for a sign-in */
export function sessionEnv(d: RunDirs, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Record<string, string> {
  const own = { CURSOR_CONFIG_DIR: d.config, CURSOR_DATA_DIR: d.data, WC_CURSOR_HOME: d.home, NO_OPEN_BROWSER: '1', CURSOR_INVOKED_AS: 'agent', TEMP: d.tmp, TMP: d.tmp }
  if (platform !== 'win32') return { ...Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string')), ...own, TMPDIR: d.tmp }
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]))
  const kept = WIN_KEEP.flatMap((k) => { const v = lower.get(k.toLowerCase()); return typeof v === 'string' ? [[k, v] as const] : [] })
  return { ...Object.fromEntries(kept), ...own }
}

export function spawnAgent(i: Install, cwd: string, env: Record<string, string>): ChildProcessWithoutNullStreams {
  return spawn(i.node, ['-r', PRELOAD, i.index, 'acp'], { cwd, env, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' })
}

/** the process and every one it started: shell commands, MCP servers, hooks */
export function killTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  else try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
}

/** the hook's command line: the CLI runs it in PowerShell on Windows, in sh elsewhere */
export function hookCommand(args: string[], platform: string = process.platform): string {
  if (platform === 'win32') return `& ${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(' ')}`
  return args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
}
