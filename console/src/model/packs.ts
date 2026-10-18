/* What the page and the server share about the packs a workspace can turn on. */

export type PackKind = 'browser' | 'remote-browser' | 'mcp'
export const KIND_LABEL: Record<PackKind, string> = { browser: 'browser tab', 'remote-browser': 'work machine', mcp: 'MCP server' }
export interface PackView {
  name: string; title: string; kind: PackKind; about: string; scopeAbout?: string; listed: boolean; on: boolean
  concepts: string[]; actions: string[]; scoped: boolean; scopes: { id: string; name?: string }[]; acts: string[]; llmActs: string[]
  /** off · on · ok · warming_up · signin_required · error · another source state */
  state: string; message?: string; host?: string; problem?: string
  /** an mcp pack: the server a click puts into the grants, as one line */
  mcp?: string
  /** a workspace pack: the hosts turning it on grants, with its settings put in; absent when none or its settings do not render */
  hosts?: string[]
  guide: string
  /** an mcp pack's tools: read ones only read, act ones change things; on = the grants let runs call it */
  tools?: { name: string; act: boolean; on: boolean }[]
  /** the settings the pack takes from the workspace's config (packConfig.<pack>), with the value given there */
  config?: { key: string; about: string; required?: boolean; value?: string | string[] }[]
}
/** tools = an mcp pack's tools runs may call, by bare name: the whole ticked set */
export interface PackChange { on?: boolean; scopes?: string[]; acts?: string[]; llmActs?: string[]; tools?: string[] }
