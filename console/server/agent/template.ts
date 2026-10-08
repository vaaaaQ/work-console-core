import { join } from 'node:path'
import { CONSOLE } from '../config.ts'
import { PREFIX, WS_ID } from '../workspace.ts'
import type { NewWorkspace } from '../../scripts/workspaces.mjs'

/* The new-workspace template (consumer/workspace-template); rendering it and the registry edits live in scripts/workspaces.mjs. */

export const TEMPLATE = join(CONSOLE, 'consumer', 'workspace-template')

export { addRegistry, render, TEMPLATE_FILES, varName } from '../../scripts/workspaces.mjs'
export type { NewWorkspace } from '../../scripts/workspaces.mjs'

/** why a workspace cannot be made so, or null */
export function newWorkspaceIssue(o: NewWorkspace, taken: { ids: string[]; prefixes: string[]; exists(id: string): boolean }): string | null {
  if (!WS_ID.test(o.id)) return `id ${o.id} must match ${WS_ID}`
  if (!PREFIX.test(o.prefix)) return `prefix ${o.prefix} must match ${PREFIX}`
  if (taken.ids.includes(o.id)) return `the id ${o.id} is taken`
  if (taken.prefixes.includes(o.prefix)) return `the prefix ${o.prefix} is taken by another workspace`
  if (taken.exists(o.id)) return `workspaces/${o.id} already exists`
  if (!/^[^\\'"`\r\n]{1,60}$/.test(o.title) || o.title.includes('*/') || !o.title.trim()) return 'the title is 1-60 characters on one line, without quotes or backslashes'
  return null
}
