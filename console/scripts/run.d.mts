/** the exit code that asks for a restart now */
export const RESTART: 75
/** milliseconds before the next start after this many quick failures in a row */
export function backoff(fails: number): number
export interface RunState { pid: number; server: number | null; folder: string; port: number }
/** <home>/run.json while its supervisor lives, else null */
export function supervisorOf(home: string): RunState | null
export function supervise(o: {
  folder: string
  home: string
  cmd?: string[]
  log?: (line: string) => void
  /** a run at least this long resets the backoff */
  quickMs?: number
  backoff?: (fails: number) => number
}): { done: Promise<void>; stop(): Promise<void> }
export function requestRestart(home: string): boolean
export function stopConsole(home: string): boolean
/** the URL once /api/state answers on loopback */
export function waitUp(o: { port: number; home: string; timeoutMs?: number }): Promise<string>
export function detach(o: { folder: string; home: string; port: number; timeoutMs?: number }): Promise<string>
export function startConsole(o: { folder: string; home: string; port: number }): Promise<string>
