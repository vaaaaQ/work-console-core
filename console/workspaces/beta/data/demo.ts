import type { BoardItem } from '../../../src/data/board.ts'
import type { Chat, JobSeed, LogEntry } from '../../../src/model/types.ts'
import type { GatewayItem } from '../../../src/workspace.ts'
import { dayOf, fromWall } from '../../../src/lib/zone.ts'

/* Beta's demo, fictional and small: two jobs, one chat, two meetings today, two log lines and two board items.
   Its ids are its own (B-, bc, bev, BETA-): the page merges the job, step and reply-draft maps of every workspace flat, by id. */
export const jobs: JobSeed[] = [
  { id: 'B-0001', ws: 'beta', key: 'BETA-1', pb: 'beta-task', prj: 'main', t: 'Write the release notes', st: 'ready', at: 'bt1', upd: 20, slug: '20261001-beta-1-release-notes' },
  { id: 'B-0002', ws: 'beta', key: 'BETA-2', pb: 'beta-task', prj: 'main', t: 'Tidy the project board', st: 'active', at: 'bt2', upd: 90, slug: '20261001-beta-2-tidy-board' },
]

export const chats: Chat[] = [
  { id: 'bc1', name: '#general', kind: 'channel', unread: 1, sum: 'Robin asks whether the release notes are ready.', msgs: [
    { who: 'Robin Lee', at: '09:40', t: 'Are the release notes ready? The release is tomorrow.' }] },
]

export const log: LogEntry[] = [
  { at: '10:15', job: 'B-0001', a: 'you', l: 'cur', t: 'Asked the LLM to draft the release notes' },
  { at: '09:05', job: 'B-0002', a: 'you', l: 'ok', t: 'Started tidying the project board' },
]

/* two meetings today, placed in home-zone wall time, so Today lists them whatever the day */
export function demoCal(now = Date.now()): GatewayItem[] {
  const today = dayOf(now)
  const ev = (id: string, at: string, min: number, subject: string, organizer: string) => {
    const start = new Date(fromWall(Date.parse(`${today}T${at}:00Z`))).toISOString()
    return { id, subject, start, end: new Date(Date.parse(start) + min * 60e3).toISOString(), organizer, joinUrl: `https://meet.example/j/${id}`,
      response: 'accepted', cancelled: false, link: `https://meet.example/meeting/${id}` }
  }
  return [ev('bev1', '11:00', 30, 'Beta planning', 'Robin Lee'), ev('bev2', '15:30', 45, 'Beta review', 'Robin Lee')]
}

/* the board the fake gateway starts from too; Beta names no user, so "on me" is 'You' */
const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString()
export const board = (): BoardItem[] => [
  { id: 'BETA-1', type: 'Task', title: 'Write the release notes', state: 'In Progress', column: 'Doing', lane: 'mine', assignedTo: 'You', changedAt: ago(1), link: 'https://tracker.example/BETA-1' },
  { id: 'BETA-2', type: 'Task', title: 'Tidy the project board', state: 'To Do', column: 'Ready', lane: 'free', assignedTo: null, changedAt: ago(5), link: 'https://tracker.example/BETA-2' },
]
