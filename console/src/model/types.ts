/** a workspace id: the key of a pack in PACKS */
export type Ws = string
export type Mode = 'you' | 'llm'
export type JobStatus =
  | 'draft' | 'ready' | 'active' | 'waiting-user' | 'waiting-external'
  | 'review' | 'recurring' | 'done' | 'cancelled'
/** step state on the flow board */
export type NodeState = 'done' | 'cur' | 'wait' | 'bad' | 'fut' | 'tpl' | 'skip'
/** colour class: the only place colour carries meaning */
export type Lamp = 'ok' | 'cur' | 'wait' | 'bad' | 'off' | 'tpl'
export type BadgeKind = 'q' | 'c' | 'd' | 'p'
/** core concepts a pack maps its tools onto */
export type SrcKey = 'work' | 'review' | 'chat' | 'mail' | 'cal' | 'ci' | 'tickets' | 'docs' | 'time'
/** nw marks what the last change added; the next change clears it */
type New = { nw?: 0 | 1 }

/** m = who does it by default, x = exit criterion, a = artifacts, msg = messages,
 *  rv = review, out = variable its accepted draft fills; fid = id inside an added playbook's file;
 *  act = the console action its inspector offers: 'time' opens the Time view, a workspace adds its own */
export interface Step { id: string; fid?: string; t: string; m: Mode; x: string; a?: string[]; msg?: number; rv?: 1; out?: string; act?: string }
export interface Phase { c: string; n: string; s: Step[] }
/** ws = owning pack; none = core, offered in every workspace; needs = in plain words, the context its jobs need;
 *  once = one job's own steps, which no playbook list, catalog or list_playbooks shows */
export interface Playbook { ws?: Ws; ks?: SrcKey; n: string; d?: string; ph: Phase[]; custom?: 1; needs?: string; once?: 1 }

export interface Src { n: string; item?: string }
export interface Pack {
  n: string; d: string; tz: string | null; tzl: string; keyPh: string; strip: RegExp | null; prj: string[]
  src: Partial<Record<SrcKey, Src>>; votes: Record<string, string>; ok: number; veto: number; rule: string
  people: { po?: string }
}

/** [source, channel, text, head]; {var} fills from the job, the pack or an earlier step. A mail with a channel is a
    new mail: the channel is its To addresses, head its CC and subject; a mail without one replies to the job's mail */
export type Tpl = [string, string, string, MsgHead?]
export interface MsgHead { cc?: string; subject?: string }

/** link = where the artifact lives, when an LLM run wrote it to disk */
export interface Art extends New { n: string; ok: boolean; link?: string }
/** o = open */
export interface Badge extends New { k: BadgeKind; t: string; r?: string; o?: 1 | 0 }
export interface Vote extends New { n: string; v: number }
export interface Review { v: Vote[]; need: number }
export interface Draft extends New { t: string; at: string; q?: string }
/** id = the backend's run record; absent in the demo; reply = it continues the draft's session, so the draft stays */
export interface Run { q: string; at: number; id?: string; reply?: 1 }
export interface Sent { at: string; t: string }
/** a step's blocker: j = the job it waits for, t = its title when linked, st = its state as last seen,
    plan = what to do with its outcome, out = its outcome, copied in when it closed, at = when it closed */
export interface WaitLink { j: string; t?: string; st: 'open' | 'done' | 'cancelled'; plan?: string; out?: string; at?: string }
/** w = the jobs this step waits for; bb = a blocker the user asked for in a reply, waiting for the builder */
export interface Flow extends New {
  s: NodeState; m: string; arts: Art[]; b: Badge[]; rv: Review | null; dr: Draft | null
  out: string | null; run: Run | null; sent: Record<number, Sent>
  w?: WaitLink[]; bb?: { say: string; at: string }
}
export type StepOverride = Partial<Pick<Flow, 's' | 'm' | 'arts' | 'b' | 'rv' | 'dr' | 'out'>>

/** l = outcome colour for the Today feed */
export interface JournalEntry extends New { ts: string; a: string; o: string; c: string; n: string; l?: Lamp }
/** a kind of context a job gives its LLM runs; each kind's reading lives in model/context.ts */
export type CtxKind = 'work' | 'chat' | 'mail' | 'note'
/** one context item: n = how many of its newest comments or messages a run gets (1 for a mail or a note, which go in whole), name = its label on the page */
export interface CtxItem { k: CtxKind; id: string; n: number; name?: string }
/** at = current step, upd = minutes ago; ev = the calendar event it came from;
 *  due = when it is due (ISO); it needs you from midnight `lead` days before due (default 0), and
 *  pushes `remind` minutes before due (default 60); every = a recurring job's due moves on by this per period;
 *  ctx = what every LLM run is given (absent = the defaults its key and chat imply);
 *  d = the description, Markdown: the user's part of every LLM run's prompt */
export interface JobSeed {
  id: string; ws: Ws; key: string; pb: string; prj: string; t: string; st: JobStatus
  at: string | null; upd: number; slug: string; chat?: string; mail?: string; vars?: Record<string, string>
  ev?: string; due?: string; lead?: number; remind?: number; every?: 'month'; ctx?: CtxItem[]; d?: string
}
/** a finished pass through the flow, kept read-only: n = its number (1 = the first pass), from = the step it began at,
 *  at = when it ended, by + why = who returned the job and why, st = the job's status then, flow = its steps from `from` on */
export interface Round { n: number; from: string; at: string; by: string; why: string; st: JobStatus; flow: Record<string, Flow> }
/** v = the store's version; a write names the version it replaces; rounds = past passes, oldest first;
 *  rf = the step the current pass began at (absent = the first step) */
export interface Job extends JobSeed { flow: Record<string, Flow>; ts: number; jr: JournalEntry[]; v?: number; rounds?: Round[]; rf?: string }

/** a job change; the backend-only ops come from the LLM runner */
export type Cmd =
  | { op: 'start' } | { op: 'close'; st: 'done' | 'cancelled'; note?: string } | { op: 'reopen' }
  /** force = done although blockers are open; they are removed */
  | { op: 'stepDone'; step: string; force?: boolean }
  | { op: 'stepSkip' | 'stepResume' | 'stepReopen'; step: string }
  /** why = the reason; with one the backend redoes the step in a fresh session */
  | { op: 'rejectDraft'; step: string; why?: string }
  | { op: 'stepWait'; step: string; m: string }
  /** said = accepted on the replier's word, by an accept reply; force as for stepDone */
  | { op: 'acceptDraft'; step: string; text?: string; said?: boolean; force?: boolean }
  | { op: 'noteAdd'; step: string; k: BadgeKind; t: string }
  | { op: 'noteAnswer'; step: string; i: number; r: string } | { op: 'noteReopen'; step: string; i: number }
  | { op: 'sent'; step: string; i: number; t: string; to: string }
  | { op: 'vote'; step: string; n: string; v: number } | { op: 'nudged'; to: string } | { op: 'replied'; subj: string }
  /** auto = the console started it by itself */
  | { op: 'runStart'; step: string; q: string; id: string; resumed?: boolean; auto?: boolean }
  /** a reply to the draft in its own session; the draft stays until it is revised */
  | { op: 'runReply'; step: string; q: string; id: string; intent: RunIntent; resumed?: boolean }
  | { op: 'runDraft'; step: string; t: string }
  /** a draft a session made by hand hands in through the console's MCP; it waits for review as a run's does */
  | { op: 'draftIn'; step: string; t: string }
  /** an ask reply's answer: the run ends, the draft stays */
  | { op: 'runAnswer'; step: string; a: string }
  /** due = an interrupted run that resumes by itself */
  | { op: 'runEnd'; step: string; why: 'cancelled' | 'failed' | 'interrupted'; detail?: string; due?: boolean }
  | { op: 'artifact'; step: string; n: string; link?: string; ok?: false }
  | { op: 'journal'; o: string; c: string; n: string; a?: string }
  | { op: 'returnTo'; step: string; why: string }
  | { op: 'schedule'; due: string | null; lead?: number; remind?: number; every?: 'month' | null }
  | { op: 'ctxAdd'; k: CtxKind; id: string; n?: number; name?: string }
  | { op: 'ctxSet'; k: CtxKind; id: string; n: number } | { op: 'ctxDel'; k: CtxKind; id: string }
  | { op: 'describe'; d: string }
  /** j = the job of this workspace the step waits for; plan = what to do with its outcome */
  | { op: 'waitAdd'; step: string; j: string; plan?: string } | { op: 'waitDel'; step: string; j: string }
  /** the console, when a blocker closed: out = its outcome */
  | { op: 'blockerClosed'; step: string; j: string; st: 'done' | 'cancelled'; out?: string }
  /** a reply run asked for a blocker: the run ends, the draft stays, say waits for the builder */
  | { op: 'runBlocker'; step: string; say: string } | { op: 'blockerDrop'; step: string }
/** ops the page may send; the rest belong to the LLM runner */
export const PAGE_OPS = ['start', 'close', 'reopen', 'stepDone', 'stepSkip', 'stepResume', 'stepReopen', 'rejectDraft', 'stepWait',
  'acceptDraft', 'noteAdd', 'noteAnswer', 'noteReopen', 'sent', 'vote', 'nudged', 'replied', 'schedule', 'ctxAdd', 'ctxSet', 'ctxDel', 'describe',
  'waitAdd', 'waitDel', 'blockerDrop'] as const
/** ops a Claude Code session may send through the console's MCP: the page's, plus returning to a passed step */
export const SESSION_OPS = [...PAGE_OPS, 'returnTo'] as const

/** what a reply to a draft asks for: change it, change it and accept it, or only answer */
export type RunIntent = 'revise' | 'accept' | 'ask'
export const INTENTS: readonly RunIntent[] = ['revise', 'accept', 'ask']
export type RunState = 'queued' | 'running' | 'draft' | 'answered' | 'failed' | 'cancelled' | 'interrupted'
/** one LLM ask; session = the Claude Code session id, for Resume and hand-over;
    ar = auto-resume: due = it resumes by itself after the next comeback, used = it did once or no longer can;
    parent = the run this replies to, intent = what the reply asks for, a = an ask reply's answer,
    via = who replied when it was not the user: a Claude Code session, or the console itself,
    provider = the tool that runs its session (none: claude) */
export interface RunRec {
  id: string; job: string; step: string; q: string; state: RunState; session?: string; reason?: string; at: string; ended?: string
  ar?: 'due' | 'used'; parent?: string; intent?: RunIntent; a?: string; via?: 'session' | 'console'; provider?: 'claude' | 'cursor'
}

/** at = time of day; ts = the journal entry's ISO time, which Home orders logs that span days by (the demo's seeded rows have none) */
export interface LogEntry extends New { at: string; job: string; a: string; l: Lamp; t: string; ts?: string }
export interface Msg extends New { who: string; me?: 1; bot?: 1; at: string; t: string }
/** hidden + mentioned: a thread the console hides, listed while an unread message mentions me */
export interface Chat { id: string; name: string; kind: string; unread: number; sum: string; msgs: Msg[]; at?: string; link?: string; hidden?: 1; mentioned?: 1 }
export type MailCat = 'reply' | 'wait' | 'fyi' | 'auto'
export interface Mail {
  id: string; cat: MailCat; from: string; subj: string; at: string; sum: string; body: string
  job?: string; done?: boolean; sent?: Sent
}
/** b/v = start in the home zone / the team zone, d = duration, n = organizer or 'cancelled'; day = home date, start/end ISO, x = cancelled */
export interface CalEvent { b: string; v: string; t: string; d: string; n: string; id?: string; day?: string; start?: string; end?: string; org?: string; x?: 1; join?: string }
export interface Pr { id: string; br: string; to: string; ch: string }

export type View = 'jobs' | 'job' | 'approvals' | 'knowledge' | 'today' | 'chats' | 'mail' | 'calendar' | 'board' | 'time'
  | 'playbooks' | 'workspaces' | 'devices' | 'settings'
/** what New job had typed while a dialog opened over it */
export interface NjDraft { t?: string; key?: string; prj?: string; pb?: string; src?: string; chat?: string; mail?: string; ev?: string; due?: string }
/** UI state: f/prj/q = jobs filter, sel = selected step, flash = row just created, sum = LLM summaries,
 *  cd = unsent chat replies, pbRet = a dialog opened over New job returns to it */
export interface Ui {
  ws: Ws; view: View; job: string | null; sel: string | null; f: string; prj: string; q: string; flash: string | null
  chat: Record<Ws, string>; mail: string | null; mcat: MailCat; pbv: string | null; sum: Record<string, 'run' | 'ok'>
  focusB: number | null; cd: Record<string, string>
  /** the step whose inspector is widened (actions/wide.ts) */
  wide: string | null
  /** a dialog opened over New job: Cancel there goes back to it */
  pbRet: 'newjob' | null
}
