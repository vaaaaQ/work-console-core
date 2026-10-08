/* The workspace agent as the page and the server both see it: what a workspace is granted, and one
   conversation with its record of turns and commits. */

/** a managed workspace's grants.json: the packs and hosts it may reach, the acts it may run, its runs' tools and MCP servers */
export interface Grants { packs: string[]; hosts: string[]; acts: string[]; runTools: string[]; mcp: Record<string, unknown> }

export type AgentWho = 'you' | 'agent' | 'tool' | 'note'
export interface AgentTurn { at: string; who: AgentWho; t: string }
/** a commit the agent made; undoneBy = the sha of the commit that took it back */
export interface AgentCommit { sha: string; summary: string; files: string[]; at: string; kind: 'apply' | 'undo' | 'grants' | 'create'; undoneBy?: string }
/** a grants change waiting in Approvals; diff = its lines against the grants when it was proposed */
export interface AgentPending { id: string; change: Grants; reason: string; at: string; diff: string[] }
/** one conversation; session = the provider's own id, to resume by */
export interface AgentRec {
  id: string; ws: string; provider: string; session?: string
  turns: AgentTurn[]; commits: AgentCommit[]
  status: 'idle' | 'running' | 'failed'; error?: string
  /** the first conversation of a new workspace: the agent interviews the person */
  interview?: boolean
  pending?: AgentPending
  /** what the agent hears before the person's next message: decisions and undos made while it was not asked */
  inbox?: string[]
  created: string; updated: string
}
