/* What Settings → Access edits of grants.json besides the packs, and what a run may ask to be added. */

/** the runs' browser: off, any site (allow null) or only the hosts allowed */
export type BrowserGrant = { allow: string[] | null } | null

/** a Settings change: each field given replaces the grants' own; browser null turns it off */
export interface AccessChange { hosts?: string[]; runTools?: string[]; mcp?: Record<string, unknown>; browser?: BrowserGrant }

/** what a run asks to be added; it never removes. browser = hosts the runs' browser must open */
export interface AccessAdd { packs?: string[]; hosts?: string[]; runTools?: string[]; browser?: string[] }

/** a run's request waiting for the person; by = each job/step that asked for the same */
export interface AccessRequest { id: string; add: AccessAdd; reason: string; by: string[]; at: string; lines: string[] }

/** the tools Settings offers as ticks; any other name is typed */
export const KNOWN_RUN_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch']

/** grants.json as the page sees it */
export interface GrantsView { packs: string[]; hosts: string[]; runTools: string[]; mcp: Record<string, unknown>; browser?: { allow: string[] | null } }

/** Settings → Access: managed = it has a grants.json; packMcp = the MCP servers a granted pack owns, changed only in Packs */
export interface AccessView { managed: boolean; grants: GrantsView | null; packMcp: string[]; requests: AccessRequest[] }
