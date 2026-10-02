import type { Pack, Playbook } from '../../src/model/types.ts'
import type { WorkspacePage } from '../../src/workspace.ts'
import { board, chats, demoCal, jobs, log } from './data/demo.ts'

/* Beta, the second fictional example workspace: a tracker, a chat and a calendar, and nothing else.
   It sets no `me` and no acts, which shows how little a workspace has to bring. */
const pack: Pack = {
  n: 'Beta', d: 'Tracker, Chat, Calendar', tz: null, tzl: '', keyPh: 'BETA-1', strip: null, prj: ['main'],
  src: { work: { n: 'Tracker', item: 'task' }, chat: { n: 'Chat' }, cal: { n: 'Calendar', item: 'meeting' } },
  votes: {}, ok: 1, veto: -1, rule: 'No review rule.', people: {},
}

const playbooks: Record<string, Playbook> = {
  'beta-task': { ws: 'beta', n: 'Beta task', d: 'Do a task, then check it', ph: [
    { c: 'BT', n: 'Task', s: [
      { id: 'bt1', t: 'Do it', m: 'llm', x: 'The task is done' },
      { id: 'bt2', t: 'Check it', m: 'you', x: 'The result is checked' }] }] },
}

const beta: WorkspacePage = {
  id: 'beta', pack, playbooks,
  board: { start: 'beta-task', key: (id) => id, itemId: (k) => (/^BETA-\d+$/.test(k) ? k : null) },
  demo: { jobs, chats, log, cal: demoCal(), board },
}
export default beta
