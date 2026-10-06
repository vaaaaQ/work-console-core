import { agentSdk } from './sdk.ts'
import type { Sdk } from './sdk.ts'

/* The tools a step's LLM work can run in. auto = the console runs a session itself (runs, auto-ask,
   draft replies, the builder); open = what the step's Open button gives to take the step up by hand.
   The console never branches on a provider's id: it asks the registry. Cursor has no auto until a
   spike shows cursor-agent keeps a run to its tools as the Agent SDK does. */

export type ProviderId = 'claude' | 'cursor'
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'cursor']
export const isProvider = (x: unknown): x is ProviderId => typeof x === 'string' && (PROVIDER_IDS as readonly string[]).includes(x)

/** run = the step's newest run that has a session, if any */
export interface OpenIn { dir: string; job: string; title: string; step: string; stepTitle: string; run?: { provider: ProviderId; session?: string } }
/** link = the page follows it; command = the page copies it for a terminal */
export type Open = { kind: 'link' | 'command'; value: string }
export type AgentOpts = Parameters<typeof agentSdk>[0]
export interface Provider { id: ProviderId; label: string; auto?: (o: AgentOpts) => Sdk; open(s: OpenIn): Open }
export interface ProviderSettings { auto: ProviderId; manual: ProviderId; claudePath?: string; cursorPath?: string }

/** Claude Code's q and the whole Cursor URL, as their docs set them */
const CLAUDE_Q = 5000, CURSOR_URL = 8000

/** one text for every provider; the dir is in it because Cursor's link has none */
export function manualPrompt(s: OpenIn) {
  return `Work Console job ${s.job} "${s.title}", step ${s.step} "${s.stepTitle}". Work dir: ${s.dir}.\n`
    + `Call step_context {id: "${s.job}", step: "${s.step}"} on the work-console MCP server for the step's context and instruction, do the step, `
    + 'then hand the result in with submit_draft {id, step, output}. The user reviews it in the console.'
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  claude: {
    id: 'claude', label: 'Claude Code',
    auto: (o) => agentSdk(o),
    open(s) {
      if (s.run?.provider === 'claude' && s.run.session) return { kind: 'command', value: `cd "${s.dir}"; claude --resume ${s.run.session}` }
      const q = manualPrompt(s)
      if (q.length > CLAUDE_Q) throw new Error(`the prompt is over ${CLAUDE_Q} characters`)
      return { kind: 'link', value: `claude-cli://open?cwd=${encodeURIComponent(s.dir)}&q=${encodeURIComponent(q)}` }
    },
  },
  cursor: {
    id: 'cursor', label: 'Cursor',
    open(s) {
      const u = `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(manualPrompt(s))}`
      if (u.length > CURSOR_URL) throw new Error(`the link is over ${CURSOR_URL} characters`)
      return { kind: 'link', value: u }
    },
  },
}

/** which provider a new run takes, and a provider's Sdk; get throws provider_unavailable for one that cannot run by itself */
export interface SdkPick { auto(): ProviderId; get(id: ProviderId): Sdk }
export const pickOf = (s: Sdk | SdkPick): SdkPick => ('start' in s ? { auto: () => 'claude', get: () => s } : s)

/** settings are read on every new run; each provider's Sdk is made once */
export function providerPick(settings: () => ProviderSettings, make: (p: Provider) => Sdk): SdkPick {
  const made = new Map<ProviderId, Sdk>()
  return {
    auto: () => settings().auto,
    get(id) {
      const p = PROVIDERS[id]
      if (!p?.auto) throw new Error(`provider_unavailable: ${p?.label ?? id} cannot run by itself`)
      let s = made.get(id)
      if (!s) { s = make(p); made.set(id, s) }
      return s
    },
  }
}
