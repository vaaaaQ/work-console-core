/* What the page and the server share about the packs a workspace can turn on. */

export type PackKind = 'browser' | 'remote-browser' | 'mcp'
export const KIND_LABEL: Record<PackKind, string> = { browser: 'browser', 'remote-browser': 'work machine', mcp: 'MCP server' }
export interface PackView {
  name: string; title: string; kind: PackKind; about: string; scopeAbout?: string; listed: boolean; on: boolean
  concepts: string[]; actions: string[]; scoped: boolean; scopes: { id: string; name?: string }[]; acts: string[]; llmActs: string[]
  /** off · on · ok · warming_up · signin_required · error · another source state */
  state: string; message?: string; host?: string; problem?: string
  guide: string
}
export interface PackChange { on?: boolean; scopes?: string[]; acts?: string[]; llmActs?: string[] }
