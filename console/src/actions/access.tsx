import * as React from 'react'
import * as api from '../live/api.ts'
import type { AccessRequest } from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { commit } from '../store.ts'
import { CancelBtn } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { VoiceField } from '../ui/VoiceField.tsx'

/* The answer to a run's access request: Accept commits what it adds to grants.json and restarts the console,
   Reject needs a reason, which goes into the journal of each job that asked. */

const errText = (e: unknown) => String((e as Error)?.message || e)
const keep = (ws: string, r: { requests: AccessRequest[] }) => commit(() => { const l = LIVE.ws[ws]; if (l) l.requests = r.requests })

export async function requestAccept(ws: string, id: string) {
  try {
    const r = await api.decideRequest(ws, id, true)
    keep(ws, r)
    toast(r.restart ? 'Granted; the console restarts with it' : 'The grants already hold it; the steps were told')
  } catch (e) { toast(`Not granted: ${errText(e)}`) }
}

export function requestReject(ws: string, id: string) {
  modal({
    title: 'Reject the access request', form: 'reject-access',
    body: <>
      <label className="field"><span>Why?</span><VoiceField name="why" target="llm" rows={3} autoFocus placeholder="Why not, or how the step should do without it" /></label>
      <p className="why" style={{ margin: 0 }}>The reason goes into the journal of each job that asked.</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="x" sm />Reject</button></>,
    onSubmit: (fd) => {
      const why = String(fd.get('why') || '').trim()
      if (!why) { toast('Say why: the step hears the reason'); return }
      closeModal()
      void api.decideRequest(ws, id, false, why).then((r) => { keep(ws, r); toast('Rejected; the steps hear why') }, (e) => toast(`Not rejected: ${errText(e)}`))
    },
  })
}
