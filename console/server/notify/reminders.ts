import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hm } from '../../src/lib/util.ts'
import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import { withWs } from './notify.ts'

/* Due-date reminders: one push per job and due date, `remind` minutes before it (60 by default).
   A late tick (the console was off) still sends until both the due time and an hour past the
   reminder have gone by. Sent keys live in reminded.json, so a restart does not send them again. */

const MIN = 60e3, KEEP = 40 * 86400e3

export interface ReminderDeps {
  dir: string
  jobs: () => Iterable<Job> | Promise<Iterable<Job>>
  push: (title: string, body: string, url: string) => Promise<void>
  now?: () => number
  every?: number
}

export class Reminders {
  private o: ReminderDeps; private f: string; private sent: Record<string, number> = {}; private timer: ReturnType<typeof setInterval> | undefined

  constructor(o: ReminderDeps) {
    this.o = o
    mkdirSync(o.dir, { recursive: true })
    this.f = join(o.dir, 'reminded.json')
    try { if (existsSync(this.f)) this.sent = JSON.parse(readFileSync(this.f, 'utf8')) } catch (e) { console.error('reminded.json unreadable, starting empty:', (e as Error).message) }
  }

  start() {
    this.timer = setInterval(() => void this.tick().catch((e) => console.error('reminders:', (e as Error).message)), this.o.every ?? MIN)
    return this
  }
  stop() { clearInterval(this.timer) }

  /** sends what is due now and returns its keys; marked and saved before sending, so at most once */
  async tick(): Promise<string[]> {
    const jobs = [...await this.o.jobs()], now = (this.o.now ?? Date.now)(), fire: Job[] = []
    for (const j of jobs) {
      if (!j.due || T.isClosed(j)) continue
      const due = Date.parse(j.due), at = due - (j.remind ?? 60) * MIN, key = `${j.id}@${j.due}`
      if (!Number.isFinite(due) || now < at || now > Math.max(due, at + 60 * MIN) || key in this.sent) continue
      this.sent[key] = now; fire.push(j)
    }
    const n = Object.keys(this.sent).length
    for (const [k, t] of Object.entries(this.sent)) if (now - t > KEEP) delete this.sent[k]
    if (fire.length || Object.keys(this.sent).length !== n) this.save()
    for (const j of fire)
      await this.o.push(`${j.t}: due ${hm(new Date(j.due!))}`, j.key && j.key !== 'NEW' ? `${j.id} · ${j.key}` : j.id, withWs(`/?job=${encodeURIComponent(j.id)}`, j.ws))
    return fire.map((j) => `${j.id}@${j.due}`)
  }

  private save() { const tmp = this.f + '.tmp'; writeFileSync(tmp, JSON.stringify(this.sent, null, 1)); renameSync(tmp, this.f) }
}
