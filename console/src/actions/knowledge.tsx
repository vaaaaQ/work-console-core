import * as React from 'react'
import * as api from '../live/api.ts'
import type { Note, Proposal } from '../live/api.ts'
import { L, loadKnowledge } from '../live/boot.ts'
import { pbs, S } from '../model/world.ts'
import { commit } from '../store.ts'
import { Ic } from '../ui/Icon.tsx'
import { CancelBtn } from '../ui/bits.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { VoiceField } from '../ui/VoiceField.tsx'
import { saveThenClose } from '../lib/util.ts'

/* Knowledge is the workspace's folder of Markdown notes on the PC; the page only asks the backend and
   reloads what changed. */

const why = (e: unknown, conflict: string) => (e instanceof api.ApiError && e.code === 'conflict' ? conflict : (e as Error).message || String(e))
const listOf = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean)

/** close runs only once the decision went through, so an edited text survives a failure */
export async function decide(p: Proposal, accept: boolean, text?: string, close: () => void = () => undefined) {
  // the proposal is the workspace's on screen; the answer lands there even after a switch
  const ws = S.ws
  try {
    const n = await saveThenClose(() => api.decide(ws, p.id, accept, text), close)
    commit(() => { const l = L(ws); l.proposals = l.proposals.filter((x) => x.id !== p.id) })
    toast(accept ? <>Saved note <b>{n?.title ?? p.title}</b></> : <>Rejected <b>{p.title}</b></>)
  } catch (e) {
    toast(why(e, 'The note changed since this proposal. Reject it, or edit the note by hand.'))
  }
  void loadKnowledge(ws)
}

export function editProposal(p: Proposal) {
  modal({
    title: `Edit before accepting · ${p.title}`, form: 'kn-accept',
    body: <label className="field"><span>Text</span><VoiceField name="t" target="llm" rows={14} autoFocus defaultValue={p.text} ctx={p.reason || p.title} /></label>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="check" sm />Accept edited</button></>,
    onSubmit: (fd) => void decide(p, true, String(fd.get('t') ?? ''), closeModal),
  })
}

/** n = null: a new note; done gets the saved note */
export function editNote(n: Note | null, done?: (n: Note) => void) {
  const ws = S.ws
  modal({
    title: n ? `Edit note · ${n.title}` : 'New note', form: 'kn-note',
    body: <>
      <label className="field"><span>Title</span><input className="inp" name="title" required data-autofocus defaultValue={n?.title ?? ''} /></label>
      <label className="field"><span>Tags, comma separated</span><input className="inp" name="tags" defaultValue={n?.tags.join(', ') ?? ''} /></label>
      <label className="field"><span>Playbooks, comma separated: every run of their jobs reads the note</span>
        <input className="inp" name="playbooks" defaultValue={n?.playbooks.join(', ') ?? ''} placeholder={pbs(ws).join(', ')} /></label>
      <label className="field"><span>Text, markdown</span><textarea className="ta" name="text" rows={16} defaultValue={n?.text ?? ''} /></label>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="check" sm />Save</button></>,
    onSubmit: (fd) => {
      const title = String(fd.get('title') ?? '').trim()
      if (!title) return
      const note = { title, tags: listOf(String(fd.get('tags') ?? '')), playbooks: listOf(String(fd.get('playbooks') ?? '')), text: String(fd.get('text') ?? '') }
      saveThenClose(() => api.saveNote(ws, n ? n.id : null, note, n?.v), closeModal).then(
        (s) => { toast(<>Saved <b>{s.title}</b></>); done?.(s); void loadKnowledge(ws) },
        (e) => toast(why(e, n ? 'The note changed elsewhere. Copy your text, open the note again and redo the edit.' : 'A note with this title exists. Pick another title.')))
    },
  })
}

/** done runs once the note is gone */
export function deleteNote(n: Note, done?: () => void) {
  const ws = S.ws
  modal({
    title: `Delete note · ${n.title}`, form: 'kn-del',
    body: <p className="why" style={{ margin: 0 }}>The file <span className="mono">{n.id}.md</span> leaves the knowledge folder, and runs stop reading it. There is no undo.</p>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="x" sm />Delete</button></>,
    onSubmit: () => {
      saveThenClose(() => api.deleteNote(ws, n.id, n.v), closeModal).then(
        () => { toast(<>Deleted <b>{n.title}</b></>); done?.(); void loadKnowledge(ws) },
        (e) => toast(why(e, 'The note changed since you opened it. Open it again, then delete.')))
    },
  })
}
