import type { Pack } from '../../src/model/types.ts'
import type { WorkspacePage } from '../../src/workspace.ts'

/* __TITLE__: the page half. Its agent fills in the pack, the board and the playbooks; until then a job is the core
   Action playbook on your own words. */
const pack: Pack = {
  n: '__TITLE__', d: '', tz: null, tzl: '', keyPh: '', strip: null, prj: ['main'],
  src: {}, votes: {}, ok: 1, veto: -1, rule: '', people: {},
}

const __VAR__: WorkspacePage = {
  id: '__ID__', pack, playbooks: {},
  board: { start: 'action', key: (id) => id, itemId: () => null },
  demo: { jobs: [], chats: [], log: [] },
}
export default __VAR__
