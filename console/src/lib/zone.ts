/* The home zone: "today", midnight and every HH:MM the console shows are in it. It is the
   runtime's own zone unless WORK_CONSOLE_TZ names another (the server, and the tests, which pin a
   fixed UTC−3 zone so their expectations hold on any machine). */

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.WORK_CONSOLE_TZ
let tz = env || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const DAY = 864e5

export const zone = () => tz
/** throws on a zone Intl does not know */
export function setZone(z: string) { new Intl.DateTimeFormat('en-US', { timeZone: z }); tz = z }
/** "Sao Paulo" from America/Sao_Paulo */
export const zoneName = (z = tz) => z.split('/').pop()!.replace(/_/g, ' ')

/** the zone's wall time minus UTC at an instant, in ms */
export function offsetAt(ms: number, z = tz): number {
  const p: Record<string, number> = {}
  const f = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = +x.value
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}
/** the instant a wall time names; wall = that time written as if it were UTC */
export const fromWall = (wall: number, z = tz) => wall - offsetAt(wall - offsetAt(wall, z), z)
/** midnight of the day that holds an instant, `back` days earlier */
export const midnight = (ms: number, back = 0, z = tz) => fromWall((Math.floor((ms + offsetAt(ms, z)) / DAY) - back) * DAY, z)
/** the date (YYYY-MM-DD) of an instant */
export const dayOf = (t: number | Date = Date.now(), z = tz) => new Date(t).toLocaleDateString('en-CA', { timeZone: z })
