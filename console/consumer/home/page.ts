import type { Pack } from '../../src/model/types.ts'
import type { WorkspacePage } from '../../src/workspace.ts'

/* Home, the workspace a new console starts with: no tools yet, so a job is the core Action playbook on your own words. */
const pack: Pack = {
  n: 'Home', d: 'Your own jobs', tz: null, tzl: '', keyPh: '', strip: null, prj: ['main'],
  src: {}, votes: {}, ok: 1, veto: -1, rule: '', people: {},
}

const home: WorkspacePage = {
  id: 'home', pack, playbooks: {},
  board: { start: 'action', key: (id) => id, itemId: () => null },
  demo: { jobs: [], chats: [], log: [] },
}
export default home
