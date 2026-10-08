import * as React from 'react'
import { PACKS } from '../data/packs.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { showAgent } from '../live/boot.ts'
import type { UpdateKind } from '../model/update.ts'
import { S } from '../model/world.ts'
import { commit } from '../store.ts'
import { go, setWs } from '../actions/nav.tsx'
import { CancelBtn } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'

/* A core update that failed: what failed and its output, then Reintegrate (a workspace agent fixes it on the update's
   branch), Apply (run the update again) or Give up (drop it and stay on the core the console runs). */

const sha7 = (s: string) => s.slice(0, 7)
const errText = (e: unknown) => String((e as Error)?.message || e)
const nameOf = (ws: string) => PACKS[ws]?.n || ws
/** the workspace on screen when it is managed, else the first managed one */
const fixer = () => (LIVE.ws[S.ws]?.managed ? S.ws : Object.keys(LIVE.ws).find((w) => LIVE.ws[w].managed) ?? null)

function reintegrate(ws: string) {
  const u = LIVE.update!
  modal({
    title: `Reintegrate · ${nameOf(ws)}`, form: 'update-reintegrate',
    body: <p className="why" style={{ margin: 0 }}>A new conversation with {nameOf(ws)}'s agent gets what failed at {u.step} and the core's changes. It fixes the workspace on {u.branch}, then applies the update or gives it up. A grants change waiting in Approvals still waits.</p>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="wrench" sm />Reintegrate</button></>,
    onSubmit: () => {
      closeModal()
      void api.agentReintegrate(ws).then((a) => { showAgent(ws, a); if (S.ws !== ws) setWs(ws); go('agent') }, (e) => toast(errText(e)))
    },
  })
}

function run(kind: UpdateKind) {
  const u = LIVE.update!
  const send = () => void api.updateRun(kind).then((v) => commit(() => { LIVE.update = v }), (e) => toast(errText(e)))
  if (kind === 'apply') { send(); return }
  modal({
    title: `Give up core ${sha7(u.core)}`, form: 'update-give-up',
    body: <p className="why" style={{ margin: 0 }}>The update's branch {u.branch} and its worktree are dropped, with any fix committed there. The console stays on core {sha7(u.from)}.</p>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="x" sm />Give up</button></>,
    onSubmit: () => { closeModal(); send() },
  })
}

export function UpdateBanner() {
  const u = LIVE.update
  if (!LIVE.on || !u) return null
  const ws = fixer(), answering = Object.values(LIVE.ws).some((l) => l.agent?.status === 'running')
  const out = u.last ? u.last.output : u.output
  const what = u.last && u.last.kind === 'apply' && u.last.code !== 0 ? `failed again at ${u.step}` : `failed at ${u.step}`
  return (
    <div className="banner upd" role="status">
      <Ic n="warn" sm />
      <span className="upd-t">The update to core {sha7(u.core)} {what}; the console runs core {sha7(u.from)}.</span>
      {u.running
        ? <span className="row"><span className="spin" />{u.running === 'apply' ? 'Updating' : 'Giving up'}{answering ? ', once the agent ends its turn' : ''}…</span>
        : <span className="row">
          {u.reintegrable && ws ? <button className="btn sm pri" disabled={LIVE.ws[ws].agent?.status === 'running'} title={`A conversation with ${nameOf(ws)}'s agent fixes it`} onClick={() => reintegrate(ws)}><Ic n="wrench" sm />Reintegrate</button> : null}
          <button className="btn sm" onClick={() => run('apply')}><Ic n="retry" sm />Apply</button>
          <button className="btn sm ghost" onClick={() => run('give-up')}><Ic n="x" sm />Give up…</button>
        </span>}
      {out ? <details><summary>Output</summary><pre className="mono">{out}</pre></details> : null}
    </div>
  )
}
