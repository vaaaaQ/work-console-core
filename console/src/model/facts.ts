import { httpUrl } from './context.ts'
import type { Lamp } from './types.ts'

/* Typed step outputs: what a step leaves besides its prose. A fixed set of kinds, each a generic development concept;
   a run reports them with submit_draft(facts), the console writes review and round itself. Plain data over plain
   checks, so the page, the backend and the run tools share them. */

export const FACT_KINDS = ['branch', 'pr', 'review', 'deploy', 'check', 'round'] as const
export type FactKind = typeof FACT_KINDS[number]
export const PR_STATES = ['open', 'merged', 'closed'] as const
export const CHECK_STATES = ['pass', 'fail', 'pending'] as const
export const VERDICTS = ['accepted', 'sent_back'] as const
export interface PrCheck { name: string; state: typeof CHECK_STATES[number]; url?: string }

export type BranchFact = { kind: 'branch'; repo: string; name: string; sha: string; base?: string }
export type PrFact = { kind: 'pr'; url: string; n?: number; title?: string; state: typeof PR_STATES[number]; checks: PrCheck[] }
/** by = who reviewed, of = the sha reviewed */
export type ReviewFact = { kind: 'review'; by: string; verdict: typeof VERDICTS[number]; of?: string; note?: string }
export type DeployFact = { kind: 'deploy'; what: string; where: string; version: string; ok: boolean; url?: string }
/** against = the version it ran against; url or art (an artifact of the step) = its evidence */
export type CheckFact = { kind: 'check'; name: string; ok: boolean; against?: string; url?: string; art?: string; note?: string }
/** n = the round that went back, back_to = the step it went back to, failed = the names of the checks that failed */
export type RoundFact = { kind: 'round'; n: number; back_to: string; why: string; failed: string[] }
/** an honest empty result for a declared kind: why there is nothing to report */
export type NoneFact = { kind: FactKind; none: string }
/** a fact as a run or the page gives it */
export type FactIn = BranchFact | PrFact | ReviewFact | DeployFact | CheckFact | RoundFact | NoneFact
/** a fact as a job keeps it: at = when, step = the step that made it; the console adds both */
export type Fact = FactIn & { at: string; step: string }

export const FACTS_MAX = 20, CHECKS_MAX = 50, STR_MAX = 300, NOTE_MAX = 1000
export class FactError extends Error {}

/** the kinds a run or a session reports; review and round are the console's own, written as a person reviews or the job goes back */
export const RUN_KINDS = ['branch', 'pr', 'deploy', 'check'] as const satisfies readonly FactKind[]
export type RunKind = typeof RUN_KINDS[number]
/** the fields of each kind a run may report, for the run tools' help */
export const FACT_FIELDS: Record<RunKind, string> = {
  branch: 'repo, name, sha (the commit), base?',
  pr: 'url, n?, title?, state (open, merged or closed), checks: [{name, state (pass, fail or pending), url?}]',
  deploy: 'what, where, version, ok (true or false), url?',
  check: 'name, ok (true or false), against? (the version it ran against), url? or art? (an artifact of this step) as evidence, note?',
}
/** every field each kind has, besides kind; anything else is refused, never dropped, so a run that guesses a name learns the real ones */
export const KIND_FIELDS: Record<FactKind, readonly string[]> = {
  branch: ['repo', 'name', 'sha', 'base'],
  pr: ['url', 'n', 'title', 'state', 'checks'],
  review: ['by', 'verdict', 'of', 'note'],
  deploy: ['what', 'where', 'version', 'ok', 'url'],
  check: ['name', 'ok', 'against', 'url', 'art', 'note'],
  round: ['n', 'back_to', 'why', 'failed'],
}
const PR_CHECK_FIELDS = ['name', 'state', 'url'] as const
export const FACTS_HELP ='facts: what this step leaves besides its text, each {kind, ...fields}: '
  + (Object.entries(FACT_FIELDS) as [string, string][]).map(([k, f]) => `${k} {${f}}`).join('; ')
  + '. A kind the step must report but has nothing for goes as {kind, none: why}. URLs are http(s). Each text is one line.'

/** text in one line: every run of whitespace, a newline too, one space; so no fact can open a heading or a line of its own in a prompt */
export const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim()
/** text that goes before "; " in a line: a sentence's closing . , ; or : dropped, so no ".;" */
export const clause = (t: string) => t.replace(/[\s.,;:]+$/, '')

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null)

/** one object's fields, checked; at = how messages name it */
function reader(o: Rec, at: string) {
  const fail = (m: string): never => { throw new FactError(`${at}: ${m}`) }
  const str = (k: string, max = STR_MAX, opt = false): string | undefined => {
    const v = o[k]
    if (v === undefined || v === null || (opt && v === '')) { if (opt) return undefined; return fail(`${k} is missing`) }
    if (typeof v !== 'string' || !v.trim()) return fail(`${k} is text`)
    const t = oneLine(v)
    if (t.length > max) return fail(`${k} is longer than ${max} characters`)
    return t
  }
  const req = (k: string, max?: number) => str(k, max)!
  const url = (k: string, opt = true) => {
    const v = str(k, 2000, opt)
    if (v === undefined) return undefined
    return httpUrl(v) ?? fail(`${k} is an http(s) address`)
  }
  const one = <T extends string>(k: string, of: readonly T[]) => {
    const v = o[k]
    return (typeof v === 'string' && (of as readonly string[]).includes(v) ? v : fail(`${k} is one of ${of.join(', ')}`)) as T
  }
  const bool = (k: string) => (typeof o[k] === 'boolean' ? o[k] as boolean : fail(`${k} is true or false`))
  const sha = (k: string, opt = false) => {
    const v = str(k, 64, opt)
    if (v === undefined) return undefined
    return /^[0-9a-f]{7,64}$/i.test(v) ? v.toLowerCase() : fail(`${k} is a commit hash (7 to 64 hex digits)`)
  }
  const opt = <V>(k: string, v: V | undefined) => (v === undefined ? {} : { [k]: v })
  /** refuses the first field outside known; what = how the message names the object */
  const only = (known: readonly string[], what: string) => {
    const k = Object.keys(o).find((f) => !known.includes(f))
    if (k !== undefined) fail(`${what} has no field ${k}; its fields are ${known.filter((f) => f !== 'kind').join(', ')}`)
  }
  return { fail, str, req, url, one, bool, sha, opt, only }
}

/** one fact as a run reports it, checked; i = its place in the list */
function factIn(v: unknown, i: number, console: boolean): FactIn {
  const o = rec(v)
  if (!o) throw new FactError(`fact ${i + 1} is an object {kind, ...}`)
  const kind = o.kind as FactKind
  if (!FACT_KINDS.includes(kind)) throw new FactError(`fact ${i + 1}: kind is one of ${FACT_KINDS.join(', ')}`)
  const r = reader(o, `fact ${i + 1} (${kind})`)
  // the console's own kinds are refused before anything else, a none among them
  if (!console && !(RUN_KINDS as readonly string[]).includes(kind)) {
    return r.fail(`the console writes ${kind} facts itself; a run never reports one (report ${RUN_KINDS.join(', ')})`)
  }
  if (o.none !== undefined) {
    const extra = Object.keys(o).find((k) => k !== 'kind' && k !== 'none')
    if (extra !== undefined) return r.fail(`a none fact has only kind and none; drop ${extra}`)
    const none = typeof o.none === 'string' ? oneLine(o.none) : ''
    if (!none) return r.fail('none says why there is nothing to report')
    if (none.length > STR_MAX) return r.fail(`none is longer than ${STR_MAX} characters`)
    return { kind, none }
  }
  r.only(['kind', ...KIND_FIELDS[kind]], kind)
  switch (kind) {
    case 'branch': return { kind, repo: r.req('repo'), name: r.req('name'), sha: r.sha('sha')!, ...r.opt('base', r.str('base', STR_MAX, true)) }
    case 'pr': {
      const n = o.n
      if (n !== undefined && !(Number.isInteger(n) && (n as number) > 0)) r.fail('n is a whole number')
      const cs = o.checks ?? []
      if (!Array.isArray(cs) || cs.length > CHECKS_MAX) r.fail(`checks is a list of at most ${CHECKS_MAX}`)
      const checks = (cs as unknown[]).map((c, k): PrCheck => {
        const co = rec(c) ?? r.fail(`check ${k + 1} is an object {name, state, url?}`)
        const cr = reader(co, `fact ${i + 1} (pr), check ${k + 1}`)
        cr.only(PR_CHECK_FIELDS, 'a check')
        return { name: cr.req('name'), state: cr.one('state', CHECK_STATES), ...cr.opt('url', cr.url('url')) }
      })
      return { kind, url: r.url('url', false)!, ...r.opt('n', n as number | undefined), ...r.opt('title', r.str('title', STR_MAX, true)), state: r.one('state', PR_STATES), checks }
    }
    case 'review': return { kind, by: r.req('by'), verdict: r.one('verdict', VERDICTS), ...r.opt('of', r.str('of', 64, true)), ...r.opt('note', r.str('note', NOTE_MAX, true)) }
    case 'deploy': return { kind, what: r.req('what'), where: r.req('where'), version: r.req('version'), ok: r.bool('ok'), ...r.opt('url', r.url('url')) }
    case 'check': return {
      kind, name: r.req('name'), ok: r.bool('ok'), ...r.opt('against', r.str('against', STR_MAX, true)), ...r.opt('url', r.url('url')),
      ...r.opt('art', r.str('art', STR_MAX, true)), ...r.opt('note', r.str('note', NOTE_MAX, true)),
    }
    case 'round': {
      const failed = Array.isArray(o.failed) ? o.failed.filter((x): x is string => typeof x === 'string').map(oneLine) : []
      return { kind, n: Number(o.n), back_to: r.req('back_to'), why: r.req('why', NOTE_MAX), failed }
    }
  }
}

/** the facts a draft reports, checked: none when absent; throws FactError naming the first bad one */
export function factsIn(v: unknown, console = false): FactIn[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new FactError('facts is a list of {kind, ...}')
  if (v.length > FACTS_MAX) throw new FactError(`facts holds at most ${FACTS_MAX}`)
  return v.map((x, i) => factIn(x, i, console))
}

/** the declared kinds a list of facts has none of; a none fact counts */
export const missingKinds = (want: readonly FactKind[] | undefined, fx: readonly FactIn[] | undefined) =>
  (want ?? []).filter((k) => !(fx ?? []).some((f) => f.kind === k))

/** the kinds a step declares, checked: a list of known kinds, each once, round left to the console */
export function kindsIn(v: unknown): FactKind[] {
  if (!Array.isArray(v) || v.some((k) => !FACT_KINDS.includes(k) || k === 'round')) {
    throw new FactError(`facts is a list of kinds: ${FACT_KINDS.filter((k) => k !== 'round').join(', ')}`)
  }
  return [...new Set(v as FactKind[])]
}

/** the newest fact of each kind, in kind order; a none fact stands for its kind too */
export function latestFacts(fx: readonly Fact[]): Fact[] {
  const by = new Map<FactKind, Fact>()
  for (const f of [...fx].sort((a, b) => a.at.localeCompare(b.at))) by.set(f.kind, f)
  return FACT_KINDS.flatMap((k) => (by.has(k) ? [by.get(k)!] : []))
}

export const isNone = (f: FactIn): f is NoneFact => 'none' in f
const link = (name: string, url?: string) => (url ? `[${name}](${url})` : name)
/** the short form of a sha */
export const short = (sha: string) => sha.slice(0, 12)

/** a fact's own words, without the step it came from; title = a step's title by its id */
export function factText(f: FactIn, title: (id: string) => string = (id) => id): string {
  if (isNone(f)) return `${f.kind}: none, ${f.none}`
  switch (f.kind) {
    case 'branch': return `branch ${f.name} at ${short(f.sha)} (repo ${f.repo}${f.base ? `, from ${f.base}` : ''})`
    case 'pr': {
      const checks = f.checks.map((c) => `${c.name} ${c.state}${c.url && c.state !== 'pass' ? ` (${link(c.name, c.url)})` : ''}`)
      return `pr ${link(f.n ? `#${f.n}` : f.title || 'PR', f.url)} ${f.state}; ${checks.length ? `checks: ${checks.join(', ')}` : 'no checks'}`
    }
    case 'review': return `review ${f.verdict === 'accepted' ? 'accepted' : 'sent back'} by ${f.by}${f.of ? ` at ${short(f.of)}` : ''}${f.note ? `: ${f.note}` : ''}`
    case 'deploy': return `deploy ${f.what} at ${f.version} on ${f.where}: ${f.ok ? 'ok' : 'failed'}${f.url ? ` (${link('link', f.url)})` : ''}`
    case 'check': return `check "${f.name}" ${f.ok ? 'passed' : 'failed'}${f.against ? ` against ${f.against}` : ''}`
      + `${f.url ? ` (${link('evidence', f.url)})` : f.art ? ` (artifact ${f.art})` : ''}${f.note ? `: ${f.note}` : ''}`
    case 'round': return `round ${f.n} → back to "${title(f.back_to)}": ${f.failed.length ? `${clause(f.why)}; failed: ${f.failed.join(', ')}` : f.why}`
  }
}

/** a fact in one line, as a later prompt carries it: its words, then the step that made it. One line even for a fact
    kept before its texts were made one line */
export const factLine = (f: Fact, title: (id: string) => string = (id) => id) => {
  const t = oneLine(factText(f, title))
  return /\)$/.test(t) && f.kind === 'branch' ? t.replace(/\)$/, `; from "${title(f.step)}")`) : `${t} (from "${title(f.step)}")`
}

/** the names of the checks that failed among the facts */
export const failedChecks = (fx: readonly FactIn[] | undefined) =>
  (fx ?? []).filter((f): f is CheckFact => f.kind === 'check' && !isNone(f) && !(f as CheckFact).ok).map((f) => f.name)

/** a fact's colour: ok, failed (bad), still running (wait), a round going back (cur), nothing to report (off) */
export function factLamp(f: FactIn): Lamp {
  if (isNone(f)) return 'off'
  switch (f.kind) {
    case 'branch': return 'ok'
    case 'pr': return f.checks.some((c) => c.state === 'fail') || f.state === 'closed' ? 'bad' : f.checks.some((c) => c.state === 'pending') ? 'wait' : 'ok'
    case 'review': return f.verdict === 'accepted' ? 'ok' : 'bad'
    case 'deploy': case 'check': return f.ok ? 'ok' : 'bad'
    case 'round': return 'cur'
  }
}
/** one part of the job header's strip: kind, lamp, words, and the link its words go on */
export interface StripPart { kind: FactKind; l: Lamp; t: string; url?: string }
/** the job header's strip: the latest fact of each kind, a round left out, in a few words each */
export function stripParts(fx: readonly Fact[]): StripPart[] {
  return latestFacts(fx).filter((f) => f.kind !== 'round').map((f): StripPart => {
    const l = factLamp(f)
    if (isNone(f)) return { kind: f.kind, l, t: `${f.kind}: none` }
    switch (f.kind) {
      case 'branch': return { kind: f.kind, l, t: `${f.name} @ ${short(f.sha)}` }
      case 'pr': {
        const n = (s: string) => f.checks.filter((c) => c.state === s).length, [p, b, w] = [n('pass'), n('fail'), n('pending')]
        return { kind: f.kind, l, t: [`PR${f.n ? ` #${f.n}` : ''} ${f.state}`, p ? `✓${p}` : '', b ? `✗${b}` : '', w ? `…${w}` : ''].filter(Boolean).join(' '), url: f.url }
      }
      case 'review': return { kind: f.kind, l, t: `review: ${f.verdict === 'accepted' ? 'accepted' : 'sent back'}` }
      case 'deploy': return { kind: f.kind, l, t: f.ok ? `deployed ${f.version}` : `deploy of ${f.version} failed`, ...(f.url ? { url: f.url } : {}) }
      default: { const c = f as CheckFact; return { kind: c.kind, l, t: `${c.name} ${c.ok ? '✓' : '✗'}`, ...(c.url ? { url: c.url } : {}) } }
    }
  })
}
