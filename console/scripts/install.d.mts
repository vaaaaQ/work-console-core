import type { Runner } from './lib.mjs'
import type { Docker, PgNames } from './postgres.mjs'

export interface InstallArgs { to: string; provider: 'claude' | 'cursor'; port: number | null; force: boolean; start: boolean; prompt: boolean; core: string | null }
export function parseArgs(argv: string[]): InstallArgs
/** Node 22.6 or later, git and npm */
export function tools(r?: Runner, version?: string): { ok: boolean; lines: string[] }
/** the consumer folder at the core's HEAD, or its locked commit on a repair; commits only what it wrote */
export function folder(o: { core: string; to: string; force?: boolean; run?: Runner; log?: (line: string) => void }): { sha: string; wrote: string[]; committed: boolean }
/** --port, else config.json, else install.json, else the first free from 7410 that is not the LAN port */
export function consolePort(o: { home: string; arg: number | null; free?: (port: number) => Promise<boolean> }): Promise<number>
export function writeConfig(home: string, o: { port: number; pgUrl?: string; passwordPath?: string }): void
/** whether the provider CLI is there and signed in; never prints an account */
export function provider(name: 'claude' | 'cursor', r?: Runner, env?: NodeJS.ProcessEnv): { ok: boolean; line: string }
/** 'on: ...' when a key is in place or typed, 'off: ...' otherwise */
export function voice(home: string, o: { prompt: boolean; ask?: (question: string) => Promise<string> }): Promise<string>
export type StepState = 'ok' | 'failed' | 'blocked' | 'skipped' | 'todo'
export interface Step { name: string; state: StepState; line: string }
export function install(o?: {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  run?: Runner
  docker?: Docker
  pg?: (o: { home: string; docker: Docker; names?: Partial<PgNames>; want?: number | null; free?: (port: number) => Promise<boolean>; log?: (line: string) => void }) => Promise<{ port: number; url: string; passwordPath: string }>
  free?: (port: number) => Promise<boolean>
  ask?: (question: string) => Promise<string>
  start?: (s: { folder: string; home: string; port: number }) => Promise<string>
  log?: (line: string) => void
}): Promise<{ code: number; steps: Step[] }>
