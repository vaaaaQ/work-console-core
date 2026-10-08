import { z } from 'zod'
import type { AgentCommit, Grants } from '../../src/model/agent.ts'
import { normGrants } from '../grants.ts'
import type { AskTool } from '../llm/sdk.ts'
import type { Applied, Ops } from './ops.ts'

/* The workspace agent's console tools, in no provider's terms: each runs one op and answers in plain text. */

export type AgentOps = Pick<Ops, 'check' | 'apply' | 'undo' | 'createWorkspace'>
/** what the tools need from the session: its grants and commits, the registered names, and where results go */
export interface AgentHooks {
  grants(): Grants
  commits(): AgentCommit[]
  taken(): { ids: string[]; prefixes: string[] }
  committed(c: AgentCommit, undoes?: string): void
  propose(change: Grants, reason: string): void
}

const short = (sha: string) => sha.slice(0, 8)
const failed = (a: Applied & { ok: false }) => [a.error, ...(a.failures ?? [])].join('\n')
const RESTART = 'The console restarts when this turn ends; the page then says Updated — press Ctrl+F5.'

const checkTool = (ws: string, ops: Pick<Ops, 'check'>): AskTool => ({
  name: 'check',
  description: 'Typecheck, run the tests under workspaces/<id>/ and tools/, the registry and core-drift tests and the static import check of the console as it is now. Answers the failures, if any.',
  input: {},
  run: async () => {
    const c = await ops.check(ws)
    return c.ok ? 'The check passed.' : `The check failed:\n${c.failures.join('\n')}`
  },
})

export function agentTools(o: { ws: string; ops: AgentOps; hooks: AgentHooks }): AskTool[] {
  const { ws, ops, hooks } = o
  const record = (a: Applied & { ok: true }, kind: AgentCommit['kind'], undoes?: string) =>
    hooks.committed({ sha: a.sha, summary: a.summary, files: a.files, at: new Date().toISOString(), kind }, undoes)
  return [
    checkTool(ws, ops),
    {
      name: 'apply',
      description: `Check, build and commit your changes under workspaces/${ws}/ and tools/ as "${ws}: <summary>", then restart the console. A failed check or build commits nothing.`,
      input: { summary: z.string().min(1).max(120).describe('one line: what changed, for the person') },
      run: async (a) => {
        const r = await ops.apply(ws, String(a.summary))
        if (!r.ok) return `Not applied: ${failed(r)}`
        record(r, 'apply')
        return `Applied ${short(r.sha)}: ${r.summary}. ${r.files.length} file(s): ${r.files.join(', ')}. ${RESTART}`
      },
    },
    {
      name: 'undo',
      description: 'Revert one of your own commits by its sha (at least 7 characters), build and restart the console.',
      input: { sha: z.string().min(1) },
      run: async (a) => {
        const sha = String(a.sha).trim().toLowerCase()
        if (!/^[0-9a-f]{7,40}$/.test(sha)) return 'Not undone: give at least 7 characters of the sha'
        const c = hooks.commits().find((x) => x.sha.startsWith(sha))
        if (!c) return `Not undone: ${sha} is not one of your commits`
        if (c.undoneBy) return `Not undone: ${short(c.sha)} is already undone by ${short(c.undoneBy)}`
        const r = await ops.undo(ws, c.sha)
        if (!r.ok) return `Not undone: ${failed(r)}`
        record(r, 'undo', c.sha)
        return `Undone ${short(c.sha)} with ${short(r.sha)}. ${RESTART}`
      },
    },
    {
      name: 'propose_grants',
      description: 'Ask the person, through Approvals, for what this workspace may reach. change is the whole grants you want: '
        + 'packs, hosts (exact or *.domain), acts, runTools (the tools its runs may use) and mcp (MCP servers by name). '
        + 'Their answer comes back as a message; do not wait for it.',
      input: {
        change: z.object({
          packs: z.array(z.string()).optional(), hosts: z.array(z.string()).optional(), acts: z.array(z.string()).optional(),
          runTools: z.array(z.string()).optional(), mcp: z.record(z.string(), z.unknown()).optional(),
        }).passthrough(),
        reason: z.string().describe('why, in one line for the person'),
      },
      run: async (a) => {
        let g: Grants
        try { g = normGrants(a.change) } catch (e) { return `Not proposed: ${(e as Error).message}` }
        const reason = String(a.reason ?? '').replace(/\s+/g, ' ').trim()
        if (!reason) return 'Not proposed: a reason is needed'
        if (JSON.stringify(g) === JSON.stringify(hooks.grants())) return 'Not proposed: the grants are already so'
        hooks.propose(g, reason)
        return 'Proposed: it waits in Approvals for the person. Carry on; the answer comes back as a message.'
      },
    },
    {
      name: 'create_workspace',
      description: 'Make a new managed workspace from the template, with empty grants, registered and committed; the console restarts. '
        + 'id: lower case, digits and dashes; prefix: the job key prefix, upper case; title: its name.',
      input: { id: z.string(), prefix: z.string(), title: z.string() },
      run: async (a) => {
        const n = { id: String(a.id), prefix: String(a.prefix), title: String(a.title) }
        const r = await ops.createWorkspace(ws, n, hooks.taken())
        if (!r.ok) return `Not created: ${failed(r)}`
        record(r, 'create')
        return `Created workspace ${n.id} (${short(r.sha)}). Its own agent interviews the person there. ${RESTART}`
      },
    },
  ]
}

/** a reintegration's tools, over ops rooted at the update's worktree: check, apply on its branch, give_up;
    end notes how the agent closed it, and the update runs once the turn ends */
export function reintegrateTools(o: { ws: string; branch: string; ops: Pick<Ops, 'check' | 'apply'>; committed(c: AgentCommit): void; end(kind: 'apply' | 'give-up', reason?: string): void }): AskTool[] {
  const { ws, branch, ops } = o
  return [
    checkTool(ws, ops),
    {
      name: 'apply',
      description: `Check, build and commit your changes under workspaces/${ws}/ and tools/ on ${branch} as "${ws}: <summary>". When the turn ends the console runs the update again. A failed check or build commits nothing.`,
      input: { summary: z.string().min(1).max(120).describe('one line: what changed, for the person') },
      run: async (a) => {
        const r = await ops.apply(ws, String(a.summary))
        if (!r.ok) return `Not applied: ${failed(r)}`
        o.committed({ sha: r.sha, summary: r.summary, files: r.files, at: new Date().toISOString(), kind: 'reintegrate' })
        o.end('apply')
        return `Committed ${short(r.sha)} on ${branch}: ${r.summary}. When this turn ends the console runs the update again; once it passes, it merges, builds and restarts.`
      },
    },
    {
      name: 'give_up',
      description: 'Drop the update when the fix needs more than you may change. When the turn ends its branch and worktree go, and the console stays on its core.',
      input: { reason: z.string().min(1).describe('why, in one line for the person') },
      run: async (a) => {
        o.end('give-up', String(a.reason ?? '').replace(/\s+/g, ' ').trim())
        return 'When this turn ends the update is dropped: its branch and worktree go, and the console stays on its core.'
      },
    },
  ]
}
