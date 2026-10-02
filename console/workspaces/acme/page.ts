import { demoTime } from '../../src/data/time.ts'
import type { WorkspacePage } from '../../src/workspace.ts'
import { BOARD0 } from './data/board.ts'
import { chats, cdr, demoCal, jobs, jr, llms, log, mail, mdr, ovr, pri, ret, work } from './data/demo.ts'
import { pack } from './data/pack.ts'
import { playbooks, templates } from './data/playbooks.ts'

/* Acme, the fictional example workspace: the page half. It names no user, so prompts say "the user". */
const acme: WorkspacePage = {
  id: 'acme', pack, playbooks, templates,
  board: { start: 'dev-item', key: (id) => id, itemId: (k) => (/^[A-Z][A-Z0-9]*-\d+$/.test(k) ? k : null) },
  demo: { jobs, chats, log, ovr, jr, ret, pri, llms, cdr, mdr, mail, work, cal: demoCal(), board: BOARD0, time: demoTime },
}
export default acme
