import type { Ran, Runner } from './lib.mjs'

export interface PgNames { project: string; container: string; volume: string; port: number; user: string; db: string }
export const PG: PgNames
/** console/postgres/compose.yaml */
export const COMPOSE: string
export type Docker = (args: string[], o?: { env?: NodeJS.ProcessEnv; input?: string; timeout?: number }) => Ran
/** runs docker with the process env plus o.env */
export function dockerRunner(r?: Runner): Docker
/** ok only when the engine prints its version, lists containers and has compose */
export function engine(docker: Docker): { ok: boolean; version?: string; why?: string }
/** <home>/postgres.password, generated when missing and never rewritten */
export function ensurePassword(home: string): string
/** starts the container on its port, a recorded free one or the next free from 55432, and waits for select 1 */
export function postgres(o: {
  home: string
  docker: Docker
  names?: Partial<PgNames>
  want?: number | null
  free?: (port: number) => Promise<boolean>
  wait?: { tries: number; ms: number }
  log?: (line: string) => void
}): Promise<{ port: number; url: string; passwordPath: string }>
/** docker compose down -v for that project */
export function pgDown(o: { docker: Docker; names?: Partial<PgNames>; passwordPath?: string }): Ran
