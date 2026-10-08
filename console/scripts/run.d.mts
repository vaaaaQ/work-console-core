/** the exit code that asks for a restart now */
export const RESTART: 75
/** milliseconds before the next start after this many quick failures in a row */
export function backoff(fails: number): number
/** finish: this supervisor runs update.mjs --finish before a start */
export interface RunState { pid: number; server: number | null; folder: string; port: number; finish?: boolean }
/** <home>/update-finish.json: a merged core update whose npm ci and build wait for the server to be down */
export function finishFile(home: string): string
/** <home>/run.json while its supervisor lives, else null */
export function supervisorOf(home: string): RunState | null
export function supervise(o: {
  folder: string
  home: string
  cmd?: string[]
  /** run before a start while finishFile(home) exists; default the folder's update.mjs --finish */
  finish?: string[]
  log?: (line: string) => void
  /** a run at least this long resets the backoff */
  quickMs?: number
  backoff?: (fails: number) => number
}): { done: Promise<void>; stop(): Promise<void> }
/** through the console's route, which waits for its agents' turns; else ends the server for its supervisor to start */
export function requestRestart(home: string): Promise<boolean>
/** ends the supervisor and its server, then closes the console's Edge; false when none ran */
export function stopConsole(home: string): Promise<boolean>
/** the URL once /api/state answers on loopback */
export function waitUp(o: { port: number; home: string; timeoutMs?: number }): Promise<string>
export function detach(o: { folder: string; home: string; port: number; timeoutMs?: number }): Promise<string>
export function startConsole(o: { folder: string; home: string; port: number }): Promise<string>
