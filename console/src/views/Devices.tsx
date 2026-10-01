import * as React from 'react'
import { tfmt } from '../lib/util.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import type { Device } from '../live/api.ts'
import { Ic } from '../ui/Icon.tsx'
import { toast } from '../ui/toasts.tsx'

/* Phones reach the console over the home LAN only once paired: the PC shows a one-time code as a QR,
   the phone opens it and keeps a device cookie. Pairing and revoking happen on the PC only. */

const box = (t: React.ReactNode) => <div className="pb"><p className="why" style={{ margin: 0 }}>{t}</p></div>

export function Devices() {
  const [list, setList] = React.useState<Device[] | null>(null)
  const [code, setCode] = React.useState<{ url: string; qr: string; expires: string } | null>(null)
  const load = React.useCallback(() => { api.devices().then((r) => setList(r.devices), (e) => toast((e as Error).message)) }, [])
  React.useEffect(() => { if (LIVE.on && LIVE.pc) load() }, [load])
  if (!LIVE.on || !LIVE.pc) return <>
    <div className="vh"><div><div className="eyebrow">Setup</div><h1>Devices</h1></div></div>
    {box(LIVE.on ? 'Devices are paired and revoked on the PC, at http://127.0.0.1.' : 'Phones pair with the console backend on your PC. This demo has no backend.')}
  </>
  const pair = () => api.pairNew().then(setCode, (e) => toast((e as Error).message))
  const revoke = (d: Device) => api.revoke(d.id).then(() => { toast(<>Revoked <b>{d.name}</b></>); load() }, (e) => toast((e as Error).message))
  return <>
    <div className="vh"><div><div className="eyebrow">Setup</div><h1>Devices</h1>
      <p>Phones that can open the console on the home network. A new phone scans a one-time code; revoking one signs it out at once.</p></div></div>
    <div className="cols">
      <section className="panel"><header><Ic n="plus" /><h3>Pair a phone</h3></header>
        <div className="pb" style={{ display: 'grid', gap: 12 }}>
          {code ? <>
            <img className="qr" alt="Pairing code" src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(code.qr)} />
            <p className="why" style={{ margin: 0 }}>Scan it with the phone's camera, or open <span className="mono">{code.url}</span>. It works once, until {tfmt(code.expires)}.</p>
          </> : <p className="why" style={{ margin: 0 }}>The phone must trust the console's certificate first; scripts/install.ps1 prints how.</p>}
          <div className="row"><button className="btn pri" onClick={() => void pair()}><Ic n="plus" sm />{code ? 'New code' : 'Show a pairing code'}</button></div>
        </div></section>
      <section className="panel"><header><Ic n="user" /><h3>Paired</h3><span className="src">{list?.length ?? '…'}</span></header>
        {list == null ? box('Loading…') : list.length ? <ul className="al">{list.map((d) => (
          <li key={d.id}><Ic n="user" sm /><span>{d.name}</span><span className="why">paired {tfmt(d.at)}{d.lastSeen ? ` · seen ${tfmt(d.lastSeen)}` : ''}</span>
            <button className="btn sm ghost" onClick={() => void revoke(d)}><Ic n="x" sm />Revoke</button></li>))}</ul>
          : box('No phone is paired yet.')}</section>
    </div>
  </>
}

/** what an unpaired phone sees instead of the console */
export function PairScreen() {
  return (
    <div className="pairs"><div className="panel"><header><Ic n="user" /><h3>This phone is not paired</h3></header>
      <div className="pb" style={{ display: 'grid', gap: 10 }}>
        <p style={{ margin: 0 }}>On your PC, open the console at http://127.0.0.1, go to <b>Devices</b> and choose <b>Show a pairing code</b>. Scan it with this phone.</p>
        <p className="why" style={{ margin: 0 }}>A revoked phone lands here too; pair it again the same way.</p>
        <div className="row"><button className="btn" onClick={() => location.reload()}><Ic n="refresh" sm />Try again</button></div>
      </div></div></div>
  )
}
