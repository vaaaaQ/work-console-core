/** WORK_CONSOLE_HOME, else ~/.work-console */
export function consoleHome(env?: NodeJS.ProcessEnv): string
/** the parsed file, the fallback when it does not exist; throws naming the file when it is not JSON */
export function readJson<T>(file: string, fallback: T): T
/** writes through a temp file and a rename, creating the directory */
export function writeJson(file: string, value: unknown): void
export interface Ran { status: number | null; stdout: string; stderr: string; error?: Error }
export type Runner = (cmd: string, args: string[], o?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number }) => Ran
/** spawnSync with utf8 output; npm, npx, claude and agent go through cmd.exe on Windows */
export const run: Runner
/** nothing answers on host:port and it can be bound */
export function isFree(port: number, host?: string): Promise<boolean>
/** the first port from start that is not taken and is free */
export function firstFree(start: number, o?: { taken?: Set<number>; free?: (p: number) => Promise<boolean>; limit?: number }): Promise<number>
export function alive(pid: unknown): boolean
/** [] when git has an identity in cwd, else -c flags for a local one */
export function gitId(cwd: string, r?: Runner): string[]
/** the last n lines */
export function tail(text: string, n?: number): string
export interface Checked { ok: boolean; step?: string; output?: string }
/** npm ci, typecheck, tests (once more on a failure) and, when asked, the build; stops at the first failure */
export function npmChecks(folder: string, o?: { run?: Runner; log?: (line: string) => void; build?: boolean }): Checked
