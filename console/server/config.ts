import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Where the console keeps its files and which ports it takes. config.json in the home directory
   overrides any field; WORK_CONSOLE_HOME moves the whole directory (tests use a temp one). */

export interface Config {
  home: string
  loopbackPort: number
  lanPort: number
  pcName: string
  gatewayUrl: string
  /** the console's own bearer for A; LLM sessions never see it */
  consoleTokenPath: string
  /** the bearer LLM sessions use for A's /mcp: read tools only */
  llmTokenPath: string
  /** where LLM sessions run: the repo, so they get its CLAUDE.md, skills and tests */
  workDir: string
  maxSessions: number
  /** tools an LLM run may use beyond its own and A's read tools, e.g. "mcp__my-tools" or
      "Bash(npm test)". The user's own Claude Code settings are not inherited, so this is the whole list */
  runTools: string[]
  /** the pack's team time zone for calendar times, e.g. Europe/Berlin; null = none */
  teamTz: string | null
  /** dev only: serve a fake gateway seeded with demo data instead of talking to A */
  fakeGateway: boolean
}

/** console/server → the repo root */
export const REPO = fileURLToPath(new URL('../../', import.meta.url))

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.WORK_CONSOLE_HOME || join(homedir(), '.work-console')
  mkdirSync(home, { recursive: true })
  const bridge = join(homedir(), '.bridge')
  const base: Config = {
    home,
    loopbackPort: 7410,
    lanPort: 7411,
    pcName: hostname().toLowerCase(),
    gatewayUrl: env.GATEWAY_URL || 'http://127.0.0.1:47821',
    consoleTokenPath: join(bridge, 'console.token'),
    llmTokenPath: join(bridge, 'llm.token'),
    workDir: env.WORK_CONSOLE_CWD || REPO,
    maxSessions: 3,
    runTools: ['Read', 'Glob', 'Grep'],
    teamTz: null,
    fakeGateway: env.WORK_CONSOLE_FAKE_GATEWAY === '1',
  }
  const file = join(home, 'config.json')
  const over = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<Config> : {}
  return { ...base, ...over, home }
}

/** a token file read on every use, so a rotated token needs no restart; missing = empty */
export const readToken = (path: string) => { try { return readFileSync(path, 'utf8').trim() } catch { return '' } }
