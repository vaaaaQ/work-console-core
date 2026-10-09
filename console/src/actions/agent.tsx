import * as React from 'react'
import * as api from '../live/api.ts'
import type { Where } from '../live/api.ts'
import { L, showAgent } from '../live/boot.ts'
import { store } from '../lib/util.ts'
import type { AgentCommit } from '../model/agent.ts'
import type { Job } from '../model/types.ts'
import { S } from '../model/world.ts'
import { commit } from '../store.ts'
import { CancelBtn } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { VoiceField } from '../ui/VoiceField.tsx'

/* The workspace agent's buttons: the panel, a message, Stop, Retry, a new conversation, Undo of a commit, and the answer
   to a grants change. */

const short = (sha: string) => sha.slice(0, 8)
const errText = (e: unknown) => String((e as Error)?.message || e)
const put = showAgent

/** the panel open on a conversation; none named = the one the page leads to (a job page's own, else the newest general) */
export function openAgent(w: { conv?: string } = {}) {
  commit(() => { S.agentOpen = true; if (w.conv) S.agentConv = w.conv })
  store.set('agentOpen', true)
}
export function closeAgent() {
  commit(() => { S.agentOpen = false })
  store.set('agentOpen', false)
}
/** a proposal talked over in the conversation that made it */
export function discuss(j: Job) {
  const by = j.pp?.by
  openAgent(by && L(j.ws).convs.some((c) => c.id === by) ? { conv: by } : {})
}

/** true when the message was taken */
export async function agentSend(ws: string, text: string, w: Where): Promise<boolean> {
  try { put(ws, await api.agentSay(ws, text, w)); return true } catch (e) { toast(errText(e)); return false }
}

export async function agentStop(ws: string, conv: string) {
  try { await api.agentStop(ws, conv) } catch (e) { toast(errText(e)) }
}

export async function agentRetry(ws: string, conv: string) {
  try { put(ws, await api.agentRetry(ws, conv)) } catch (e) { toast(errText(e)) }
}

/** a new general conversation, shown in the panel; the others stay in its list */
export async function agentFresh(ws: string) {
  try { const a = await api.agentNew(ws); put(ws, a); commit(() => { S.agentConv = a.id }) } catch (e) { toast(errText(e)) }
}

export function agentUndo(ws: string, c: AgentCommit) {
  modal({
    title: `Undo · ${c.summary}`, form: 'agent-undo',
    body: <p className="why" style={{ margin: 0 }}>The console reverts {short(c.sha)} ({c.files.length} file{c.files.length === 1 ? '' : 's'}), checks and builds the result, commits the revert and restarts. The agent hears of it with your next message.</p>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="retry" sm />Undo</button></>,
    onSubmit: () => {
      closeModal()
      toast(`Undoing ${short(c.sha)}…`)
      void api.agentUndo(ws, c.sha).then((a) => { put(ws, a); toast(`Undone · ${c.summary}`) }, (e) => toast(`Not undone: ${errText(e)}`))
    },
  })
}

export async function grantsAccept(ws: string) {
  try {
    const a = await api.agentGrants(ws, true)
    put(ws, a)
    toast(`Grants accepted (${short(a.commits.at(-1)?.sha ?? '')}); the console restarts with them`)
  } catch (e) { toast(`Not accepted: ${errText(e)}`) }
}

export function grantsReject(ws: string) {
  modal({
    title: 'Reject the grants change', form: 'reject-grants',
    body: <>
      <label className="field"><span>Why?</span><VoiceField name="why" target="llm" rows={3} autoFocus placeholder="What is wrong with it, or what the agent should do instead" /></label>
      <p className="why" style={{ margin: 0 }}>The reason goes back to the agent, which answers in its conversation.</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="x" sm />Reject</button></>,
    onSubmit: (fd) => {
      const why = String(fd.get('why') || '').trim()
      if (!why) { toast('Say why: the agent hears the reason'); return }
      closeModal()
      void api.agentGrants(ws, false, why).then((a) => { put(ws, a); toast('Rejected; the agent hears why') }, (e) => toast(`Not rejected: ${errText(e)}`))
    },
  })
}
