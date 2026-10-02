import type { WorkspaceServer } from '../server/workspace.ts'
import acmeServer from './acme/server.ts'
import betaServer from './beta/server.ts'

/* The server's registry: the workspaces this console serves, the first is the default. Each consumer writes its own. */
export const SERVERS: WorkspaceServer[] = [acmeServer, betaServer]
