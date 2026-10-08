import type { WorkspaceServer } from '../server/workspace.ts'
import homeServer from './home/server.ts'

/* The server's registry: the workspaces this console serves, the first is the default. It is yours: add a workspace here. */
export const SERVERS: WorkspaceServer[] = [homeServer]
