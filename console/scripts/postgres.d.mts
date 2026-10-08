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
/** the host ports a docker ps Ports column publishes */
export function published(col: string): number[]
/** every container: running with the ports it publishes, stopped with those it declares */
export function containers(docker: Docker): { name: string; running: boolean; ports: number[] }[]
/** PG with the overrides; throws unless container and volume are renamed together; a renamed container is its own project */
export function pgNames(over?: Partial<PgNames>): PgNames
/** the container and volume from WORK_CONSOLE_PG_CONTAINER and WORK_CONSOLE_PG_VOLUME */
export function envNames(env?: NodeJS.ProcessEnv): Partial<PgNames>
/** starts the container on the port it publishes, else a recorded or the next free one no other container has, and waits for select 1 */
export function postgres(o: {
  home: string
  docker: Docker
  names?: Partial<PgNames>
  want?: number | null
  free?: (port: number) => Promise<boolean>
  wait?: { tries: number; ms: number }
  log?: (line: string) => void
}): Promise<{ port: number; url: string; passwordPath: string }>
/** docker compose down -v for a renamed project; the default names throw */
export function pgDown(o: { docker: Docker; names?: Partial<PgNames>; passwordPath?: string }): Ran
