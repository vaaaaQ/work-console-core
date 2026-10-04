import { MODES } from '../data/core.ts'
import { store } from '../lib/util.ts'
import { FMT, checkPb, toInternal } from './pbFormat.ts'
import type { PbFile, PbStepFile } from './pbFormat.ts'
import { PB, S, TPL, steps } from './world.ts'
import type { Mode, Tpl } from './types.ts'

/* the file's format and checks live in pbFormat.ts, which the backend imports too */
export { FMT, checkPb, toInternal }
export type { PbFile, PbMsgFile, PbStepFile } from './pbFormat.ts'

export function pbToFile(k: string): PbFile {
  const p = PB[k]
  return {
    format: FMT, key: k, name: p.n, description: p.d || '', ...(p.needs ? { needs: p.needs } : {}), workspace: p.ws || null,
    phases: p.ph.map((ph) => ({
      code: ph.c, name: ph.n, steps: ph.s.map((s) => {
        const o: PbStepFile = { id: s.fid || s.id, title: s.t, who: s.m, doneWhen: s.x }
        if (s.a) o.produces = s.a.slice()
        if (TPL[s.id]) o.messages = TPL[s.id].map(([via, to, text]) => ({ via, to, text }))
        if (s.rv) o.review = true
        if (s.out) o.output = s.out
        if (s.act) o.act = s.act
        return o
      }),
    })),
  }
}
export function addPb(o: PbFile & { key: string }) { const { pb, tpl } = toInternal(o, o.key); PB[o.key] = pb; Object.assign(TPL, tpl) }
/** a playbook's planned messages by step id, as the backend keeps them with it */
export const pbMsgs = (k: string): Record<string, Tpl[]> => Object.fromEntries(steps(k).filter((s) => TPL[s.id]).map((s) => [s.id, TPL[s.id]]))

/** added playbooks and changed "who does it" live in this browser only */
export function loadCustomPbs() {
  const x = store.get<Record<string, PbFile>>('pbx', {})
  Object.keys(x).forEach((k) => { const o = x[k]; if (!PB[k] && o && !checkPb(o).length) { o.key = k; addPb(o as PbFile & { key: string }) } })
  const m = store.get<Record<string, string>>('pbm', {})
  Object.keys(PB).forEach((k) => steps(k).forEach((s) => { if (MODES[m[s.id] as Mode]) s.m = m[s.id] as Mode }))
}

export const blankFile = (): PbFile => ({
  format: FMT, name: 'My playbook', description: 'What this flow is for', workspace: S.ws, phases: [
    { code: 'DO', name: 'Do', steps: [
      { id: 'read', title: 'Read the request', who: 'llm', doneWhen: 'Clear what is asked', produces: ['notes.md'] },
      { id: 'do', title: 'Do the work', who: 'you', doneWhen: 'Done and checked' }] },
    { code: 'TL', name: 'Tell', steps: [
      { id: 'tell', title: 'Tell the team', who: 'you', doneWhen: 'Posted', messages: [{ via: 'chat', to: 'team chat', text: 'hi all,\n{key} is done.' }] }] }],
})
