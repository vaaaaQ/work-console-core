import type { Registered } from '../src/workspace.ts'
import home from './home/page.ts'

/* The page's registry: the workspaces this console shows, the first is the default. It is yours: add a workspace here. */
export const WORKSPACES: Registered[] = [{ page: home }]
