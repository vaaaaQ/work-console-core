import type { WorkspaceServer } from '../../server/workspace.ts'
import beta from './page.ts'

/* Beta, the second fictional example workspace: the server half. The default source and store, and a fake gateway derived from its demo. */
const betaServer: WorkspaceServer = { page: beta, jobPrefix: 'B' }
export default betaServer
