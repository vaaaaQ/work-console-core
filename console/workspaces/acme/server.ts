import type { WorkspaceServer } from '../../server/workspace.ts'
import { acmeFake } from './fake.ts'
import acme from './page.ts'

/* Acme, the fictional example workspace: the server half. It reads its gateway like any other and has no plugins. */
const acmeServer: WorkspaceServer = { page: acme, jobPrefix: 'A', fake: acmeFake }
export default acmeServer
