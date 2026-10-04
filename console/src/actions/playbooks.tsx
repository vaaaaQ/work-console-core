import * as React from 'react'
import { flushSync } from 'react-dom'
import { MODES } from '../data/core.ts'
import { PACKS } from '../data/packs.ts'
import { plural, slugify, store } from '../lib/util.ts'
import { FMT, addPb, blankFile, checkPb, pbMsgs, pbToFile, toInternal } from '../model/playbookFile.ts'
import { stepProblems } from '../model/pbFormat.ts'
import type { PbFile } from '../model/playbookFile.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { pbWs } from '../live/boot.ts'
import { JOBS, PB, S, TPL, W, steps } from '../model/world.ts'
import type { Mode, Pack, Playbook, Tpl } from '../model/types.ts'
import { commit, repaint } from '../store.ts'
import { Ic } from '../ui/Icon.tsx'
import { CancelBtn, FlowMap } from '../ui/bits.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { dismiss, go } from './nav.tsx'
import { reopenNewJob, stashNewJob } from './newjob.tsx'

/* ----- Add playbook ----- */
type Lint = { errs: string[]; pv: { pb: Playbook; tpl: Record<string, Tpl[]> } | null }
let setLint: ((l: Lint) => void) | null = null
let lintTimer: ReturnType<typeof setTimeout> | undefined
/** Add playbook's checks, or, for New job's steps, the ones their messages need too */
let check: (o: unknown) => string[] = checkPb
const checkSteps = (o: unknown) => (o && typeof o === 'object' && !Array.isArray(o) ? stepProblems(o as PbFile) : checkPb(o))

function lintOf(text: string): Lint {
  let o: unknown, errs: string[] = []
  try { o = JSON.parse(text) } catch (e) { errs = ['Not valid JSON yet: ' + (e as Error).message] }
  if (o !== undefined) errs = check(o)
  return { errs, pv: errs.length ? null : toInternal(o as PbFile, 'preview') }
}
/** check the JSON in the box now: show its errors or its preview, and return the errors */
export function pbLintNow(): string[] {
  clearTimeout(lintTimer)
  const t = document.getElementById('pbjson') as HTMLTextAreaElement | null
  if (!t) return []
  const l = lintOf(t.value)
  if (l.errs.length) t.setAttribute('aria-invalid', 'true'); else t.removeAttribute('aria-invalid')
  const f = setLint
  if (f) flushSync(() => f(l))
  return l.errs
}
export function setScope(ws: unknown) {
  const r = document.querySelector<HTMLInputElement>(`#scrim input[name=scope][value=${ws ? 'ws' : 'core'}]`)
  if (r) r.checked = true
}
function pbTpl(v: 'blank' | 'copy') {
  const t = document.getElementById('pbjson') as HTMLTextAreaElement | null
  if (!t) return
  let o: PbFile
  if (v === 'copy') {
    const k = (document.getElementById('pbcopy') as HTMLSelectElement).value
    o = pbToFile(k); delete o.key; o.name = PB[k].n + ' (copy)'; setScope(o.workspace)
  } else { o = blankFile(); setScope(true) }
  t.value = JSON.stringify(o, null, 2); pbLintNow(); t.focus(); t.setSelectionRange(0, 0); t.scrollTop = 0
}
function loadPbFile(inp: HTMLInputElement) {
  const f = inp.files && inp.files[0]
  if (!f) return
  const r = new FileReader()
  r.onload = () => {
    const t = document.getElementById('pbjson') as HTMLTextAreaElement | null
    if (!t) return
    t.value = String(r.result)
    const e = pbLintNow()
    try { setScope((JSON.parse(t.value) as PbFile).workspace) } catch { /* the errors under the box say why */ }
    toast(<>Loaded <b>{f.name}</b>{e.length ? ' · fix the errors shown' : ''}</>)
  }
  r.onerror = () => toast('Could not read that file.')
  r.readAsText(f)
  inp.value = ''
}

/** the steps of a New job form, as the box shows them: the form keeps their key and workspace */
function stepsFile(f: PbFile): PbFile {
  const o = { ...f }
  delete o.key; delete o.workspace
  return o
}

/** steps: New job's own steps, edited in place of a playbook added */
function PbAddBody({ w, steps: own }: { w: Pack; steps?: PbFile }) {
  const [text] = React.useState(() => JSON.stringify(own ? stepsFile(own) : blankFile(), null, 2))
  const [lint, set] = React.useState<Lint>(() => lintOf(text))
  React.useLayoutEffect(() => { setLint = set; return () => { if (setLint === set) setLint = null } }, [])
  const e = lint.errs, pv = lint.pv
  return <>
    {own ? null : <div className="row"><span className="lbl">Start from</span>
      <button type="button" className="btn sm" onClick={() => pbTpl('blank')}><Ic n="file" sm />Blank template</button>
      <span className="row" style={{ gap: 4 }}><select className="sel" id="pbcopy" aria-label="Playbook to copy">{Object.keys(PB).map((k) => {
        const ws = PB[k].ws
        return <option key={k} value={k}>{`${PB[k].n} · ${ws ? PACKS[ws].n : 'core'}`}</option>
      })}</select><button type="button" className="btn sm" onClick={() => pbTpl('copy')}><Ic n="copy" sm />Copy it</button></span>
      <button type="button" className="btn sm" onClick={() => document.getElementById('pbfile')?.click()}><Ic n="upload" sm />Load a file…</button>
      <input type="file" id="pbfile" accept=".json,application/json" hidden onChange={(ev) => loadPbFile(ev.currentTarget)} /></div>}
    <label className="field"><span>{own ? 'Steps JSON' : 'Playbook JSON'}</span><textarea className="ta code" name="json" id="pbjson" spellCheck={false} data-autofocus defaultValue={text}
      onChange={() => { clearTimeout(lintTimer); lintTimer = setTimeout(pbLintNow, 220) }} /></label>
    <ul className="errs" id="pberrs" hidden={!e.length}>{e.slice(0, 8).map((x, i) => <li key={i}>{x}</li>)}{e.length > 8 ? <li>…and {e.length - 8} more</li> : null}</ul>
    <div className="prev" id="pbprev" hidden={!pv}>{pv ? <>
      <div className="eyebrow">Preview · {pv.pb.n} · {plural(pv.pb.ph.length, 'phase')} · {plural(pv.pb.ph.reduce((a, p) => a + p.s.length, 0), 'step')}</div>
      <FlowMap p={pv.pb} T={pv.tpl} /></> : null}</div>
    <details className="why"><summary>File format</summary><p style={{ margin: '6px 0 0' }}>A JSON object: <span className="mono">name</span>, <span className="mono">description</span>, <span className="mono">phases</span>, and optionally <span className="mono">needs</span> (in plain words, the context its jobs need). Each phase: <span className="mono">code</span> (1–4 letters), <span className="mono">name</span>, <span className="mono">steps</span>. Each step: <span className="mono">id</span>, <span className="mono">title</span>, <span className="mono">who</span> (you or llm), <span className="mono">doneWhen</span>, and optionally <span className="mono">produces</span> (file names), <span className="mono">messages</span> (via chat, work or mail; to; text with {'{key}'}-style fields), <span className="mono">review</span>, <span className="mono">output</span>.</p></details>
    {own ? <p className="hint" style={{ margin: 0 }}>The steps go back to New job; Create job saves them.</p> : <>
      <div className="field"><span className="lbl">Available in</span><div className="pbc" role="radiogroup" aria-label="Available in">
        <label><input type="radio" name="scope" value="ws" defaultChecked /><b>{w.n} only</b><small>Uses {w.d}</small></label>
        <label><input type="radio" name="scope" value="core" /><b>Every workspace</b><small>A core playbook</small></label></div></div>
      <p className="hint" style={{ margin: 0 }}>Added playbooks stay in this browser. Download one to keep a copy or share it.</p></>}
  </>
}

/** fromNewJob: opened over New job, so it returns there with the new playbook picked; steps: New job's own
    steps, which go back to it as edited instead of being added */
export function pbAdd(fromNewJob?: boolean, steps?: PbFile) {
  S.pbRet = null
  if (fromNewJob) stashNewJob()
  check = steps ? checkSteps : checkPb
  modal({
    title: steps ? 'Edit steps' : 'Add playbook', cls: 'wide', form: 'pbadd',
    body: <PbAddBody w={W()} steps={steps} />,
    foot: <><CancelBtn /><button className="btn pri" type="submit">{steps ? <><Ic n="check" sm />Use these steps</> : <><Ic n="plus" sm />Add playbook</>}</button></>,
    onSubmit: (fd) => {
      const errs = pbLintNow()
      if (errs.length) { document.getElementById('pberrs')?.scrollIntoView({ block: 'nearest' }); document.getElementById('pbjson')?.focus(); return }
      const o = JSON.parse(String(fd.get('json'))) as PbFile & { key: string }
      if (steps) { S.pbRet = null; reopenNewJob({ steps: o }); return }
      o.format = FMT; o.workspace = fd.get('scope') === 'core' ? null : S.ws
      let key = slugify(o.key || o.name) || 'playbook'
      if (PB[key]) { let n = 2; while (PB[key + '-' + n]) n++; key = key + '-' + n }
      o.key = key
      addPb(o)
      if (LIVE.on) void api.putPlaybook(pbWs(key), key, PB[key], pbMsgs(key)).catch((e) => toast(`The backend did not keep it: ${(e as Error).message}`))
      const x = store.get<Record<string, PbFile>>('pbx', {}); x[key] = o; store.set('pbx', x)
      toast(<>Added playbook <b>{o.name}</b></>)
      if (S.pbRet === 'newjob') { S.pbRet = null; reopenNewJob({ pb: key }); return }
      closeModal()
      if (S.view === 'playbooks') commit(() => { S.pbv = key })
      else { S.pbv = key; go('playbooks') }
    },
  })
}

/* ----- Playbooks view actions ----- */
export function pbRemove(k: string) {
  const n = JOBS.filter((j) => j.pb === k).length
  if (n) { toast(`${n} job${n > 1 ? 's use' : ' uses'} this playbook, so it stays.`); return }
  const x = store.get<Record<string, PbFile>>('pbx', {}), o = x[k], p = PB[k], ws = pbWs(k), tp: Record<string, Tpl[]> = {}
  commit(() => {
    steps(k).forEach((s) => { if (TPL[s.id]) tp[s.id] = TPL[s.id]; delete TPL[s.id] })
    delete PB[k]; delete x[k]; store.set('pbx', x); S.pbv = null
  })
  if (LIVE.on) void api.putPlaybook(ws, k, null).catch((e) => toast(`The backend still has it: ${(e as Error).message}`))
  toast(<>Removed <b>{p.n}</b></>, 'Undo', () => commit(() => {
    PB[k] = p; Object.assign(TPL, tp)
    if (LIVE.on) void api.putPlaybook(ws, k, p, tp).catch(() => undefined)
    if (o) { const y = store.get<Record<string, PbFile>>('pbx', {}); y[k] = o; store.set('pbx', y) }
    S.pbv = k
  }))
}

/** who does a step: applies to open jobs at once and is remembered in this browser */
export function onPbStep(k: string, id: string, m: Mode) {
  const s = PB[k] && steps(k).find((x) => x.id === id)
  if (!s) return
  commit(() => {
    s.m = m
    const pm = store.get<Record<string, string>>('pbm', {}); pm[id] = m; store.set('pbm', pm)
    const x = store.get<Record<string, PbFile>>('pbx', {})
    if (x[k]) { x[k].phases.forEach((ph) => ph.steps.forEach((t) => { if (k + '/' + t.id === id) t.who = m })); store.set('pbx', x) }
  })
  toast(`${s.t}: ${MODES[m].l}`)
}

/* ----- saving a file: the page's downloads capability, a plain download elsewhere, or the clipboard ----- */
type Downloads = { save(o: { filename: string; data: string }): Promise<unknown> }
type ClaudeHost = { use?: (name: string) => Promise<unknown> }
let DL: Downloads | null = null
const host = () => (window as unknown as { claude?: ClaudeHost }).claude

export function initDownloads() {
  const c = host()
  if (typeof c?.use === 'function') c.use('downloads').then((d) => { DL = (d as Downloads | null) || null; repaint() }, () => {})
}
export const canSave = () => !!DL || !host()

export function showText(name: string, text: string, why: string) {
  if (!stashNewJob()) S.pbRet = null
  modal({
    title: name, cls: 'wide',
    body: <>
      <p className="why" style={{ margin: 0 }}>{why} Select the text and copy it.</p>
      <textarea className="ta code" id="jsonout" readOnly aria-label={name} defaultValue={text} />
    </>,
    foot: <button type="button" className="btn pri" onClick={dismiss}>Done</button>,
    onOpen: (el) => el.querySelector<HTMLTextAreaElement>('#jsonout')?.select(),
  })
}

export async function saveFile(name: string, text: string) {
  if (DL) {
    try { await DL.save({ filename: name, data: text }); toast(<>Saved <b>{name}</b></>) }
    catch (e) {
      const code = (e as { code?: string } | null)?.code
      if (code === 'declined') return
      if (code === 'rate_limited') { toast('A save prompt is already open. Try again in a moment.'); return }
      if (code === 'bad_request' || code === 'transform_error') { toast('Could not save that file.'); return }
      DL = null; repaint(); showText(name, text, 'Downloads are not available here.')
    }
    return
  }
  if (!host()) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    a.download = name
    document.body.append(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    toast(<>Downloaded <b>{name}</b></>)
    return
  }
  try { await navigator.clipboard.writeText(text); toast(<>Copied <b>{name}</b> to the clipboard</>) }
  catch { showText(name, text, 'Copy was blocked.') }
}
