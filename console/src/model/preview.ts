import * as T from './transitions.ts'
import type { Cmd, Flow, Job, Mode, Phase, Start, Step } from './types.ts'

/* A proposal on the board before the person accepts it: the job's own transitions run on a copy, never stored. */

export type Mark = 'add' | 'del' | 'edit' | 'reopen'
/** the board while a proposal is open: phases with removed steps kept in place, a mark per touched step, the flows
    as they would be, the round banner a returnTo would start; err = why the proposal no longer applies */
export interface Preview { ph: Phase[]; mk: Record<string, Mark>; flow: Record<string, Flow>; banner?: string; err?: string }

const same = (a: Step, b: Step, x: T.Ctx, j: Job, k: Job) =>
  a.t === b.t && a.x === b.x && a.m === b.m && a.start === b.start && a.ask === b.ask
  && JSON.stringify(T.tplOf(x, j, a.id)) === JSON.stringify(T.tplOf(x, k, b.id))

/** null = no open proposal */
export function preview(x: T.Ctx, j: Job): Preview | null {
  const p = j.pp
  if (!p) return null
  let after: Job
  try {
    // as ppAccept runs them: an added step's reason defaults to what the proposal says
    after = T.runAll(x, { ...j, pp: undefined }, p.cmds.map((c) => (c.op === 'stepAdd' && !c.why ? { ...c, why: p.say } : c))).job
  } catch (e) {
    if (!(e instanceof T.CmdError)) throw e
    return { ph: T.phasesOf(x, j), mk: {}, flow: j.flow, err: e.message }
  }
  const was = T.stepsOf(x, j), now = new Map(T.stepsOf(x, after).map((s) => [s.id, s]))
  const ph = T.phasesOf(x, after).map((q) => ({ ...q, s: [...q.s] })), mk: Record<string, Mark> = {}
  const flow = { ...after.flow }
  const moved = new Set(p.cmds.flatMap((c) => (c.op === 'stepMove' ? [c.step] : [])))
  for (const [id] of now) if (!was.some((s) => s.id === id)) mk[id] = 'add'
  // a removed step stays after its old predecessor, which is on the board by now
  const jph = T.phasesOf(x, j)
  was.forEach((s, i) => {
    const n = now.get(s.id)
    if (n) {
      if (moved.has(s.id) || !same(s, n, x, j, after)) mk[s.id] = 'edit'
      else if (j.flow[s.id]?.s === 'done' && after.flow[s.id]?.s !== 'done') mk[s.id] = 'reopen'
      return
    }
    mk[s.id] = 'del'; flow[s.id] = j.flow[s.id]
    const prev = was[i - 1], at = prev && ph.find((q) => q.s.some((t) => t.id === prev.id))
    if (at) { at.s.splice(at.s.findIndex((t) => t.id === prev.id) + 1, 0, s); return }
    const c = jph.find((q) => q.s.some((t) => t.id === s.id))?.c, home = ph.find((q) => q.c === c) ?? ph[0]
    home?.s.unshift(s)
  })
  const n = after.rounds?.length ?? 0
  const back = n > (j.rounds?.length ?? 0) && after.rf ? T.stepOf(x, after, after.rf) : undefined
  return { ph, mk, flow, ...(back ? { banner: `Round ${n + 1} starts at “${back.t}”` } : {}) }
}

/** one card line per cmd: a sign and plain text; an added step carries its mode and start */
export function ppLine(x: T.Ctx, j: Job, c: Cmd): { sign: string; t: string; mode?: Mode; start?: Start } {
  const t = (id: string) => { const s = T.stepOf(x, j, id); return s ? `“${s.t}”` : id }
  const job = (id: string) => { const b = x.jobOf?.(id); return b ? `${id} “${b.t}”` : id }
  const where = (o: { before?: string; after?: string }) => (o.before ? `before ${t(o.before)}` : o.after ? `after ${t(o.after)}` : '')
  switch (c.op) {
    case 'stepAdd': return { sign: '+', t: `${c.step.t}${where(c) ? `, ${where(c)}` : ''}`, mode: c.step.m, ...(c.step.m === 'llm' ? { start: c.step.start } : {}) }
    case 'stepDel': return { sign: '–', t: t(c.step) }
    case 'stepEdit': {
      const what = [
        c.t != null && `title “${c.t}”`, c.x != null && 'what done means', c.m && (c.m === 'llm' ? 'the LLM does it' : 'you do it'),
        c.start !== undefined && (c.start ? `starts ${c.start}` : 'default start'), c.tpl && 'its message',
        c.ask !== undefined && (c.ask ? 'waits for a reply' : 'no reply wait'),
      ].filter(Boolean)
      return { sign: '~', t: `${t(c.step)}: ${what.join(', ') || 'no change'}` }
    }
    case 'stepMove': return { sign: '↕', t: `${t(c.step)} ${where(c)}` }
    case 'returnTo': return { sign: '↺', t: `Return to ${t(c.step)}: ${c.why}` }
    case 'waitAdd': return { sign: '⏳', t: `${t(c.step)} waits for ${job(c.j)}${c.plan ? `; plan: ${c.plan}` : ''}` }
    case 'waitDel': return { sign: '⏳', t: `${t(c.step)} no longer waits for ${job(c.j)}` }
    case 'stepDone': return { sign: '✓', t: `${t(c.step)} done${c.force ? ', its blockers dropped' : ''}` }
    case 'describe': return { sign: '✎', t: 'Description' }
    case 'ctxAdd': return { sign: '·', t: `Context + ${c.k} ${c.name ? `“${c.name}”` : c.id}` }
    case 'ctxDel': return { sign: '·', t: `Context – ${c.k} ${c.id}` }
    case 'noteAdd': return { sign: '·', t: `Note on ${t(c.step)}: ${c.t}` }
    default: return { sign: '·', t: c.op }
  }
}
