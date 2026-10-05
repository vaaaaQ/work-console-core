import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig, SDKResultMessage, SDKUserMessage, SettingSource } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
import { sep } from 'node:path'
import { z } from 'zod'
import type { Hit, Note, ProposalIn } from '../knowledge/notes.ts'
import type { PromptImage } from './context.ts'
import type { Shot } from './shot.ts'

/* The only module that touches the Agent SDK. A session reads untrusted chat and mail text, so it
   runs in dontAsk mode with an explicit tool list: its own tools (the workspace's knowledge among them),
   A's read tools and config's runTools. The user's own user and local settings are not loaded, because their shell
   allow rules would let a session reach the console's API or A's tokens; only the repo's project
   settings are, for its CLAUDE.md and skills. The user's own CLAUDE.md stays out too, though a work
   dir under the home folder would reach it as a parent's. It reads A through the gateway's MCP with the llm
   token and writes only through the run's own tools. */

export interface RunTools {
  submitDraft(t: string): Promise<void>
  addArtifact(n: string, content: string): Promise<void>
  /** a file already under the run's dir (a screenshot, a build output), path relative to it */
  addArtifactFile(path: string, name?: string): Promise<void>
  journal(o: string, c: string, n: string): Promise<void>
  /** the prompt's sections but how to work, and its pictures, read anew */
  context?(): Promise<{ text: string; images: PromptImage[] }>
  /** a png of a page as an artifact; only where the workspace allows it */
  screenshot?(o: Shot & { name: string }): Promise<void>
  /** a new job in the run's own workspace, its id; only where the workspace allows it */
  createJob?(o: { title: string; playbook?: string; key?: string; project?: string; start?: boolean }): Promise<string>
  /** starts a ready job of the run's own workspace */
  startJob?(id: string): Promise<void>
  /** the workspace's knowledge notes; a proposal writes nothing until the user accepts it */
  knowledgeSearch?(q: string, tags?: string[]): Promise<Hit[]>
  knowledgeRead?(id: string): Promise<Note>
  /** the proposal's id */
  knowledgePropose?(p: KnowledgeIn): Promise<string>
}
export type KnowledgeIn = Omit<ProposalIn, 'by'>
/** a result's t = the session's final text */
export type SdkEvent = { k: 'session'; id: string } | { k: 'text'; t: string } | { k: 'tool'; name: string; input: string } | { k: 'result'; ok: boolean; error?: string; t?: string }
/** a tool of a one-shot answer, which only reads: its input as zod fields, its answer as text */
export interface AskTool { name: string; description: string; input: z.ZodRawShape; run(a: Record<string, unknown>): Promise<string> }
/** tool = a call of one of the ask's own tools, by its bare name; result = the answer in the schema's shape */
export type AskEvent = { k: 'tool'; name: string; input: Record<string, unknown> } | { k: 'result'; ok: true; out: unknown } | { k: 'result'; ok: false; error: string }
export interface Sdk {
  /** images = pictures the prompt's text names, sent before it */
  start(o: { prompt: string; images?: PromptImage[]; resume?: string; cwd: string; tools: RunTools; abort: AbortController }): AsyncIterable<SdkEvent>
  /** one answer in the schema's shape from a session that has only the given tools; none = this console cannot ask */
  ask?(o: { system: string; prompt: string; schema: Record<string, unknown>; tools: AskTool[]; cwd: string; abort: AbortController }): AsyncIterable<AskEvent>
}

const BRIDGE = ['mcp__bridge__bridge_snapshot', 'mcp__bridge__bridge_get', 'mcp__bridge__bridge_status']
export const ALLOW = ['mcp__run__submit_draft', 'mcp__run__add_artifact', 'mcp__run__add_artifact_file', 'mcp__run__journal', 'mcp__run__context', 'mcp__run__screenshot', 'mcp__run__create_job', 'mcp__run__start_job',
  'mcp__run__knowledge_search', 'mcp__run__knowledge_read', 'mcp__run__knowledge_propose', ...BRIDGE]
export const DENY = [
  'mcp__bridge__bridge_act', 'mcp__work-console',
  'Read(~/.bridge/**)', 'Read(~/.work-console/**)', 'Read(**/.work-console/**)',
  'Bash(*.bridge*)', 'PowerShell(*.bridge*)', 'Bash(*console.token*)', 'PowerShell(*console.token*)',
  'Bash(*mcp.token*)', 'PowerShell(*mcp.token*)', 'Bash(*.work-console*)', 'PowerShell(*.work-console*)',
]

const HOME = homedir().split(sep).join('/')
/** the user's own CLAUDE.md and rules, which Claude Code reads as any parent folder's */
const USER_MD = [`${HOME}/.claude/CLAUDE.md`, `${HOME}/.claude/rules/**`]

/** the permission half of a session's options: which settings load and which tools it may use.
    strictMcpConfig keeps the user's own user-scope MCP servers, the console's own job tools among them, out;
    bridge false: a workspace without a gateway, so no bridge tools */
export function permissions(runTools: string[], bridge = true) {
  return {
    settingSources: ['project'] as ('project')[],
    settings: { claudeMdExcludes: USER_MD },
    strictMcpConfig: true,
    permissionMode: 'dontAsk' as const,
    allowedTools: [...(bridge ? ALLOW : ALLOW.filter((t) => !BRIDGE.includes(t))), ...runTools],
    disallowedTools: DENY,
  }
}

/** a one-shot answer's options: no settings of any scope, no built-in tool, no MCP server but its own, whose tools only
    read, and no transcript kept. The answer comes back in the schema's shape */
const ASK = 'ask'
export function askOptions(o: { system: string; schema: Record<string, unknown>; tools: string[]; cwd: string; abort: AbortController }) {
  return {
    cwd: o.cwd, abortController: o.abort, systemPrompt: o.system,
    settingSources: [] as SettingSource[], strictMcpConfig: true, tools: [] as string[], persistSession: false,
    permissionMode: 'dontAsk' as const,
    allowedTools: o.tools.map((t) => `mcp__${ASK}__${t}`), disallowedTools: DENY,
    outputFormat: { type: 'json_schema' as const, schema: o.schema }, maxTurns: 30,
  }
}

/** the spec's reason for a session that cannot start because Claude Code is signed out */
export const signinReason = (e: string) => /\b(401|unauthori[sz]ed|not logged in|please (run )?\/?login|log ?in again|oauth token (has )?expired|invalid api key|authentication)\b/i.test(e) ? `signin_required: ${e}` : e

const done = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const failed = (e: unknown) => ({ content: [{ type: 'text' as const, text: `failed: ${(e as Error).message || e}` }], isError: true })
const wrap = (f: () => Promise<void>, ok: string) => async () => { try { await f(); return done(ok) } catch (e) { return failed(e) } }
const answer = (f: () => Promise<string>) => async () => { try { return done(await f()) } catch (e) { return failed(e) } }
const list = (xs: string[]) => xs.join(', ') || 'none'
/** each picture after the line that names it */
const picBlocks = (ims: PromptImage[]) => ims.flatMap((im) => [{ type: 'text' as const, text: im.label }, { type: 'image' as const, data: im.data, mimeType: im.mime }])
/** a search hit and a whole note as the knowledge tools answer them */
export const hitLine = (h: Hit) => `- ${h.id}: ${h.title} (tags ${list(h.tags)}) ${h.snippet}`
export const noteText = (n: Note) => `# ${n.title}\nid ${n.id} · v${n.v} · tags ${list(n.tags)} · playbooks ${list(n.playbooks)}\n\n${n.text}`
/** why a session ended without its answer */
function resultError(m: SDKResultMessage) {
  const errs = (m as { errors?: string[] }).errors
  return signinReason(errs?.length ? errs.join('; ') : ('result' in m && typeof m.result === 'string' && m.result) || m.subtype)
}

/** A's bridge with the LLM's read-only token (none when bridge is false), the run's own tools, then the
    workspace's own servers; checkWorkspaces keeps those from taking the name bridge or run */
export function mcpServers(o: { gatewayUrl: string; llmToken: () => string; mcp?: Record<string, unknown>; bridge?: boolean }, run: McpServerConfig): Record<string, McpServerConfig> {
  return {
    ...(o.bridge === false ? {} : { bridge: { type: 'http' as const, url: o.gatewayUrl.replace(/\/$/, '') + '/mcp', headers: { Authorization: `Bearer ${o.llmToken()}` } } }),
    run,
    ...(o.mcp as Record<string, McpServerConfig> | undefined),
  }
}

/** the run server's tools: always its own, then the ones this run's tools carry */
export function runToolDefs(tools: RunTools) {
  return [
    tool('submit_draft', 'Submit the draft for this step for the user to review. Call exactly once, at the end.', { text: z.string().min(1) },
      (a) => wrap(() => tools.submitDraft(a.text), 'draft submitted')()),
    tool('add_artifact', 'Save a file this step produces (for example analysis.md). Same name replaces it.', { name: z.string().min(1), content: z.string() },
      (a) => wrap(() => tools.addArtifact(a.name, a.content), 'artifact saved')()),
    tool('add_artifact_file', 'Save a file already under your working dir (an image, a log, a build output), at most 20 MB. name defaults to the file name.',
      { path: z.string().min(1), name: z.string().min(1).optional() },
      (a) => wrap(() => tools.addArtifactFile(a.path, a.name), 'artifact saved')()),
    tool('journal', 'Add a line to the job journal: what you observed, what changed, what comes next.', { observed: z.string(), changed: z.string(), next: z.string() },
      (a) => wrap(() => tools.journal(a.observed, a.changed, a.next), 'journal updated')()),
    ...(tools.context ? [tool('context', "This run's prompt again, read anew: the pictures its context names, then the job and its step, its context items, its knowledge notes, earlier outputs, the journal, the description and the instruction. One call gives all of it.", {},
      async () => { try { const c = await tools.context!(); return { content: [...picBlocks(c.images), { type: 'text' as const, text: c.text }] } } catch (e) { return failed(e) } })] : []),
    ...(tools.screenshot ? [tool('screenshot', 'Take a png of a page (http, https, or a file under your working dir) and save it as an artifact of this step: the proof of a UI change.',
      { url: z.string().min(1), name: z.string().min(1), width: z.number().int().optional(), height: z.number().int().optional(), fullPage: z.boolean().optional() },
      (a) => wrap(() => tools.screenshot!(a), 'screenshot saved')())] : []),
    ...(tools.createJob ? [tool('create_job', 'Create a job in this workspace for work found along the way that is not this job\'s. playbook and project default to the workspace\'s own; start true starts it at once. At most 5 per run. Returns the new id.',
      { title: z.string().min(1), playbook: z.string().min(1).optional(), key: z.string().min(1).optional(), project: z.string().min(1).optional(), start: z.boolean().optional() },
      async (a) => { try { return done(`created ${await tools.createJob!(a)}`) } catch (e) { return failed(e) } })] : []),
    ...(tools.startJob ? [tool('start_job', 'Start a ready job of this workspace by its id.', { id: z.string().min(1) },
      (a) => wrap(() => tools.startJob!(a.id), 'job started')())] : []),
    ...(tools.knowledgeSearch ? [tool('knowledge_search', "Search this workspace's knowledge notes: how its tools, systems and machines work. Up to 20 notes, best first, each with a snippet; an empty q lists them all. Read one in full with knowledge_read.",
      { q: z.string(), tags: z.array(z.string()).optional() },
      (a) => answer(async () => (await tools.knowledgeSearch!(a.q, a.tags)).map(hitLine).join('\n') || 'no note matches')())] : []),
    ...(tools.knowledgeRead ? [tool('knowledge_read', 'Read one knowledge note in full by its id.', { id: z.string().min(1) },
      (a) => answer(async () => noteText(await tools.knowledgeRead!(a.id)))())] : []),
    ...(tools.knowledgePropose ? [tool('knowledge_propose', 'Propose a new knowledge note, or a change to one: note = its id, text = the whole new text in Markdown. The user accepts, edits or rejects it; nothing is written before that. Propose what a later run would need and could not find. playbooks: ids of the playbooks whose every run should read it.',
      { note: z.string().min(1).optional(), title: z.string().min(1), text: z.string().min(1), reason: z.string().min(1), tags: z.array(z.string()).optional(), playbooks: z.array(z.string()).optional() },
      (a) => answer(async () => `proposed ${await tools.knowledgePropose!(a)}; it waits for the user in Approvals`)())] : []),
  ]
}

/** the prompt as one user message: each picture after the line that names it, then the text */
export function userMessage(prompt: string, images: PromptImage[]): SDKUserMessage {
  return {
    type: 'user', parent_tool_use_id: null,
    message: { role: 'user', content: [
      ...images.flatMap((im) => [
        { type: 'text' as const, text: im.label },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: im.mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: im.data } },
      ]),
      { type: 'text' as const, text: prompt },
    ] },
  }
}
async function* once<T>(x: T) { yield x }

export function agentSdk(o: { gatewayUrl: string; llmToken: () => string; runTools: string[]; mcp?: Record<string, unknown>; bridge?: boolean }): Sdk {
  return {
    async *start({ prompt, images, resume, cwd, tools, abort }) {
      const run = createSdkMcpServer({ name: 'run', version: '1.0.0', tools: runToolDefs(tools) })
      const q = query({
        // pictures need a streamed message; the SDK keeps its input open until the run ends
        prompt: images?.length ? once(userMessage(prompt, images)) : prompt,
        options: {
          cwd, resume, abortController: abort,
          ...permissions(o.runTools, o.bridge !== false),
          mcpServers: mcpServers(o, run),
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
          if (m.subtype === 'success' && !m.is_error) yield { k: 'result', ok: true, ...(typeof m.result === 'string' && m.result.trim() ? { t: m.result } : {}) }
          else yield { k: 'result', ok: false, error: resultError(m) }
        }
      }
    },
    async *ask({ system, prompt, schema, tools, cwd, abort }) {
      const own = createSdkMcpServer({ name: ASK, version: '1.0.0', tools: tools.map((t) => tool(t.name, t.description, t.input, (a) => answer(() => t.run(a))())) })
      const q = query({ prompt, options: { ...askOptions({ system, schema, tools: tools.map((t) => t.name), cwd, abort }), mcpServers: { [ASK]: own } } })
      const pre = `mcp__${ASK}__`
      for await (const m of q) {
        if (m.type === 'assistant') {
          for (const b of m.message.content) if (b.type === 'tool_use' && b.name.startsWith(pre)) yield { k: 'tool', name: b.name.slice(pre.length), input: (b.input || {}) as Record<string, unknown> }
        } else if (m.type === 'result') {
          if (m.subtype === 'success' && !m.is_error && m.structured_output !== undefined) yield { k: 'result', ok: true, out: m.structured_output }
          else yield { k: 'result', ok: false, error: m.subtype === 'success' && !m.is_error ? 'the session ended without its answer' : resultError(m) }
        }
      }
    },
  }
}
