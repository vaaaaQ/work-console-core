import * as React from 'react'
import type { Start } from '../model/types.ts'
import { CancelBtn } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { VoiceField } from '../ui/VoiceField.tsx'
import { doCmd } from './flow.tsx'

/* The answer to a proposal the agent made on a job: the backend applies its commands at once, or refuses with the reason. */

export async function ppAccept(id: string): Promise<void> {
  const r = await doCmd(id, { op: 'ppAccept' }, null)
  if (!r) return
  if (r.job.pp?.err) toast(`Not applied: ${r.job.pp.err}`)
  else toast('Applied', 'Undo', r.undo)
}

export function ppReject(id: string): void {
  modal({
    title: `Reject the proposal · ${id}`, form: 'reject-pp',
    body: <>
      <label className="field"><span>Why?</span><VoiceField name="why" target="llm" rows={3} autoFocus placeholder="What is wrong with it (optional)" /></label>
      <p className="why" style={{ margin: 0 }}>The agent hears the reason with your next message to it.</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="x" sm />Reject</button></>,
    onSubmit: (fd) => {
      const why = String(fd.get('why') || '').trim()
      closeModal()
      void doCmd(id, { op: 'ppReject', ...(why ? { why } : {}) }, 'Rejected')
    },
  })
}

/** how an llm step the proposal adds starts */
export async function ppEdit(id: string, i: number, start: Start): Promise<void> {
  await doCmd(id, { op: 'ppEdit', i, start }, null)
}
