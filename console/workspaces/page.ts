import type { Registered } from '../src/workspace.ts'
import acme from './acme/page.ts'

/* The page's registry: the workspaces this console shows, the first is the default. Each consumer writes its own. */
export const WORKSPACES: Registered[] = [{ page: acme }]
