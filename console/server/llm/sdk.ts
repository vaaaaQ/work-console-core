import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/* The only module that touches the Agent SDK. A session reads untrusted chat and mail text, so it
   runs in dontAsk mode with an explicit tool list: its own tools, A's read tools, the knowledge
   tools and config's runTools. The user's own user and local settings are not loaded, because their shell
   allow rules would let a session reach the console's API or A's tokens; only the repo's project
   settings are, for its CLAUDE.md and skills. It reads A through the gateway's MCP with the llm
   token and writes only through the run's own tools. */

export interface RunTools {
  submitDraft(t: string): Promise<void>
  addArtifact(n: string, content: string): Promise<void>
  journal(o: string, c: string, n: string): Promise<void>
}
export type SdkEvent = { k: 'session'; id: string } | { k: 'text'; t: string } | { k: 'tool'; name: string; input: string } | { k: 'result'; ok: boolean; error?: string }
export interface Sdk { start(o: { prompt: string; resume?: string; cwd: string; tools: RunTools; abort: AbortController }): AsyncIterable<SdkEvent> }

export const ALLOW = ['mcp__run__submit_draft', 'mcp__run__add_artifact', 'mcp__run__journal', 'mcp__bridge__bridge_snapshot', 'mcp__bridge__bridge_get', 'mcp__bridge__bridge_status',
  'mcp__bridge__knowledge_search', 'mcp__bridge__knowledge_read', 'mcp__bridge__knowledge_propose']
export const DENY = [
  'mcp__bridge__bridge_act', 'mcp__work-console',
  'Read(~/.bridge/**)', 'Read(~/.work-console/**)',
  'Bash(*.bridge*)', 'PowerShell(*.bridge*)', 'Bash(*console.token*)', 'PowerShell(*console.token*)',
  'Bash(*mcp.token*)', 'PowerShell(*mcp.token*)',
]

/** the permission half of a session's options: which settings load and which tools it may use.
    strictMcpConfig keeps the user's own user-scope MCP servers, the console's own job tools among them, out */
export function permissions(runTools: string[]) {
  return {
    settingSources: ['project'] as ('project')[],
    strictMcpConfig: true,
    permissionMode: 'dontAsk' as const,
    allowedTools: [...ALLOW, ...runTools],
    disallowedTools: DENY,
  }
}

/** the spec's reason for a session that cannot start because Claude Code is signed out */
export const signinReason = (e: string) => /\b(401|unauthori[sz]ed|not logged in|please (run )?\/?login|log ?in again|oauth token (has )?expired|invalid api key|authentication)\b/i.test(e) ? `signin_required: ${e}` : e

const done = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const failed = (e: unknown) => ({ content: [{ type: 'text' as const, text: `failed: ${(e as Error).message || e}` }], isError: true })
const wrap = (f: () => Promise<void>, ok: string) => async () => { try { await f(); return done(ok) } catch (e) { return failed(e) } }

export function agentSdk(o: { gatewayUrl: string; llmToken: () => string; runTools: string[] }): Sdk {
  return {
    async *start({ prompt, resume, cwd, tools, abort }) {
      const run = createSdkMcpServer({
        name: 'run', version: '1.0.0',
        tools: [
          tool('submit_draft', 'Submit the draft for this step for the user to review. Call exactly once, at the end.', { text: z.string().min(1) },
            (a) => wrap(() => tools.submitDraft(a.text), 'draft submitted')()),
          tool('add_artifact', 'Save a file this step produces (for example analysis.md). Same name replaces it.', { name: z.string().min(1), content: z.string() },
            (a) => wrap(() => tools.addArtifact(a.name, a.content), 'artifact saved')()),
          tool('journal', 'Add a line to the job journal: what you observed, what changed, what comes next.', { observed: z.string(), changed: z.string(), next: z.string() },
            (a) => wrap(() => tools.journal(a.observed, a.changed, a.next), 'journal updated')()),
        ],
      })
      const q = query({
        prompt,
        options: {
          cwd, resume, abortController: abort,
          ...permissions(o.runTools),
          mcpServers: {
            bridge: { type: 'http', url: o.gatewayUrl.replace(/\/$/, '') + '/mcp', headers: { Authorization: `Bearer ${o.llmToken()}` } },
            run,
          },
        },
      })
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') yield { k: 'session', id: m.session_id }
        else if (m.type === 'assistant') {
          for (const b of m.message.content) {
            if (b.type === 'text' && b.text.trim()) yield { k: 'text', t: b.text }
            else if (b.type === 'tool_use') yield { k: 'tool', name: b.name, input: JSON.stringify(b.input).slice(0, 300) }
          }
        } else if (m.type === 'result') {
          if (m.subtype === 'success' && !m.is_error) yield { k: 'result', ok: true }
          else {
            const errs = (m as { errors?: string[] }).errors
            const error = errs?.length ? errs.join('; ') : ('result' in m && typeof m.result === 'string' && m.result) || m.subtype
            yield { k: 'result', ok: false, error: signinReason(error) }
          }
        }
      }
    },
  }
}
