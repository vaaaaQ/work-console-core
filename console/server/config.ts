import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkspaceServer, WsConfig } from './workspace.ts'

/* Where the console keeps its files and which ports it takes. config.json in the home directory
   overrides any field; WORK_CONSOLE_HOME moves the whole directory (tests use a temp one).
   PC-wide keys sit at its top; everything a workspace runs with sits under workspaces.<id>. */

export interface Config {
  home: string
  loopbackPort: number
  lanPort: number
  pcName: string
  /** dev only: serve a fake gateway per workspace, seeded with its demo data, instead of talking to A */
  fakeGateway: boolean
  /** the OpenAI key the mic's speech-to-text uses, read on every call; no file = no mic */
  openaiKeyPath: string
  /** the model that cleans up dictated text */
  formatModel: string
  /** config.json's workspaces.<id> sections, as written */
  workspaces: Record<string, Partial<WsConfig>>
  /** what every workspace starts from, with the env loadConfig was given (GATEWAY_URL, WORK_CONSOLE_CWD) */
  core: WsConfig
}

const PC_KEYS = new Set(['home', 'loopbackPort', 'lanPort', 'pcName', 'fakeGateway', 'openaiKeyPath', 'formatModel', 'workspaces'])

/** the console's own folder: console/server → console */
const CONSOLE = dirname(dirname(fileURLToPath(import.meta.url)))

/** the repo the console sits in: the console's folder or the nearest one above it with a .git (a file in a worktree),
    else the folder above the console */
export function repoRoot(dir = CONSOLE, has: (path: string) => boolean = existsSync): string {
  for (let d = dir; ; d = dirname(d)) {
    if (has(join(d, '.git'))) return d
    if (dirname(d) === d) return dirname(dir)
  }
}

/** config.json as written; none = {} */
export function readRaw(home: string): Record<string, unknown> {
  const file = join(home, 'config.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {}
}

/** workspace keys still at the top of config.json, from before it had sections */
export const legacyKeys = (raw: Record<string, unknown>) => Object.keys(raw).filter((k) => !PC_KEYS.has(k))

/** what every workspace runs with unless it or config.json says otherwise */
export function coreDefaults(env: NodeJS.ProcessEnv = process.env): WsConfig {
  const bridge = join(homedir(), '.bridge')
  return {
    gatewayUrl: env.GATEWAY_URL || 'http://127.0.0.1:47821',
    /** the console's own bearer for A; LLM sessions never see it */
    consoleTokenPath: join(bridge, 'console.token'),
    /** the bearer LLM sessions use for A's /mcp: read tools only */
    llmTokenPath: join(bridge, 'llm.token'),
    /** where LLM sessions run: the repo, so they get its CLAUDE.md, skills and tests */
    workDir: env.WORK_CONSOLE_CWD || repoRoot(),
    maxSessions: 3,
    /** tools an LLM run may use beyond its own and A's read tools, e.g. "mcp__my-tools" or
        "Bash(npm test)". The user's own Claude Code settings are not inherited, so this is the whole list */
    runTools: ['Read', 'Glob', 'Grep'],
    /** the team time zone for calendar times, e.g. Europe/Berlin; null = none */
    teamTz: null,
    /** the browser LLM screenshots run in; null = an installed Edge or Chrome */
    browserPath: null,
    /** the workspace's knowledge notes, Markdown files; null = <home>/knowledge/<id> */
    knowledgeDir: null,
    /** true = an llm step starts its run when the job moves onto it, and an interrupted run resumes
        once by itself; only true turns it on */
    autoAsk: false,
  }
}

/** one workspace's config, later winning: core defaults, its llm runTools, its defaults,
    legacy top-level keys (one workspace only, with a line saying where they belong), its config.json section */
export function wsConfig(cfg: Config, w: WorkspaceServer, raw: Record<string, unknown>, log: (line: string) => void = console.log): WsConfig {
  const id = w.page.id, legacy: Record<string, unknown> = {}
  for (const k of legacyKeys(raw)) { legacy[k] = raw[k]; log(`move ${k} to workspaces.${id}.${k} in config.json`) }
  return {
    ...cfg.core,
    ...(w.llm?.runTools ? { runTools: w.llm.runTools } : {}),
    ...w.defaults,
    ...legacy,
    ...cfg.workspaces[id],
  } as WsConfig
}

/** every workspace's config by id; a legacy top-level key with two or more workspaces is ambiguous, so startup refuses */
export function wsConfigs(cfg: Config, list: WorkspaceServer[], raw: Record<string, unknown>, log?: (line: string) => void): Record<string, WsConfig> {
  const legacy = legacyKeys(raw)
  if (legacy.length && list.length > 1)
    throw new Error(`${legacy.join(', ')} at the top of config.json belong to a workspace: move each to workspaces.<id>.<key> (<id>: ${list.map((w) => w.page.id).join(', ')})`)
  return Object.fromEntries(list.map((w) => [w.page.id, wsConfig(cfg, w, raw, log)]))
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.WORK_CONSOLE_HOME || join(homedir(), '.work-console')
  mkdirSync(home, { recursive: true })
  const raw = readRaw(home)
  const pc = Object.fromEntries(Object.entries(raw).filter(([k]) => PC_KEYS.has(k) && k !== 'home' && k !== 'workspaces'))
  const ws = raw.workspaces
  return {
    home,
    loopbackPort: 7410,
    lanPort: 7411,
    pcName: hostname().toLowerCase(),
    fakeGateway: env.WORK_CONSOLE_FAKE_GATEWAY === '1',
    openaiKeyPath: join(home, 'openai.key'),
    formatModel: 'gpt-6-luna',
    ...pc,
    workspaces: ws && typeof ws === 'object' && !Array.isArray(ws) ? ws as Config['workspaces'] : {},
    core: coreDefaults(env),
  }
}

/** a token file read on every use, so a rotated token needs no restart; missing = empty */
export const readToken = (path: string) => { try { return readFileSync(path, 'utf8').trim() } catch { return '' } }
