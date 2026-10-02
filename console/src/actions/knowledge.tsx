import * as React from 'react'
import * as api from '../live/api.ts'
import type { Note, Proposal } from '../live/api.ts'
import { L, loadKnowledge } from '../live/boot.ts'
import { S } from '../model/world.ts'
import { commit } from '../store.ts'
import { Ic } from '../ui/Icon.tsx'
import { CancelBtn } from '../ui/bits.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { saveThenClose } from '../lib/util.ts'

/* Knowledge lives in B on the workplace; the page only asks the backend and reloads what changed. */

const why = (e: unknown, conflict: string) => (e instanceof api.ApiError && e.code === 'conflict' ? conflict : (e as Error).message || String(e))
const tagsOf = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean)

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
    body: <label className="field"><span>Text</span><textarea className="ta" name="t" rows={14} data-autofocus defaultValue={p.text} /></label>,
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
      <label className="field"><span>Text, markdown</span><textarea className="ta" name="text" rows={16} defaultValue={n?.text ?? ''} /></label>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="check" sm />Save</button></>,
    onSubmit: (fd) => {
      const title = String(fd.get('title') ?? '').trim()
      if (!title) return
      saveThenClose(() => api.saveNote(ws, n ? n.id : null, { title, tags: tagsOf(String(fd.get('tags') ?? '')), text: String(fd.get('text') ?? '') }, n?.v), closeModal).then(
        (s) => { toast(<>Saved <b>{s.title}</b></>); done?.(s); void loadKnowledge(ws) },
        (e) => toast(why(e, n ? 'The note changed elsewhere. Copy your text, open the note again and redo the edit.' : 'A note with this title exists. Pick another title.')))
    },
  })
}
