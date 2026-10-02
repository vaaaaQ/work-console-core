import type { CalEvent, Chat, JobSeed, JournalEntry, LogEntry, Mail, Pr, StepOverride, Tpl, Ws } from '../model/types.ts'

/* The demo data of the registered workspaces: jobs, chats, mail and meetings. Each workspace brings its
   own under workspaces/<id>/; install() (src/workspace.ts) fills these maps in place. at = current step, upd = minutes ago */
export const JOBS0: JobSeed[] = []

/** a past round per demo job: the job went back to `to` for `why`; that round had got as far as `upTo` */
export const RET0: Record<string, { to: string; upTo: string; at: string; why: string; by: string }> = {}

/* per-step overrides: s state, m meta, arts, b badges {k,t,r,o(open)}, rv review, dr pending LLM draft, out accepted output */
export const OVR: Record<string, Record<string, StepOverride>> = {}

/* journals: ## <ts> — <actor> / Observed / Changed / Next. Actors: you, LLM (a run you asked for) */
export const JR: Record<string, JournalEntry[]> = {}

/* message templates: [source, channel, text]; {var} fills from the job, the pack or an earlier step */
export const TPL0: Record<string, Tpl[]> = {}
export const PRI: Record<string, Pr> = {}
/* canned LLM answers for the demo; anything else gets a generic draft */
export const LLMS: Record<string, string> = {}

export const CHATS0: Record<Ws, Chat[]> = {}
/** a work item as the bridge's work get returns it */
export interface WorkDoc {
  type: string; title: string; state: string; assignedTo: string | null; description: string; reproSteps: string; acceptanceCriteria: string
  comments: { id: string; author: string; at: string; text: string }[]
}
/* work items by id; the fake gateway and the demo context preview read these */
export const WORK0: Record<string, WorkDoc> = {}
/* canned LLM reply drafts, per chat and author; the greeting goes in front */
export const CDR: Record<string, string> = {}

export const MAIL0: Partial<Record<Ws, Mail[]>> = {}

/* calendar: as the bridge returns it, and as the page shows it */
export const CAL_ITEMS: Partial<Record<Ws, ({ id: string } & Record<string, unknown>)[]>> = {}
export const CAL: Partial<Record<Ws, CalEvent[]>> = {}
/* today: activity = what you and your LLM runs did */
export const LOG0: Record<Ws, LogEntry[]> = {}
