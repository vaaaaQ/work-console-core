/* How the console reaches a tab: the Chromium DevTools protocol over the browser's debugging port.
   One short websocket per call, so nothing needs repair when a tab reloads or closes. */

export type TabInfo = { id: string; url: string }
export type CarrierKind = 'gone' | 'timeout' | 'script' | 'cdp'

/** sent false: it failed before the expression reached the tab, so nothing ran there */
export class CarrierError extends Error {
  kind: CarrierKind; sent: boolean
  constructor(kind: CarrierKind, message: string, sent = true) { super(message); this.kind = kind; this.sent = sent }
}

export interface TabCarrier {
  list(): Promise<TabInfo[]>
  open(url: string): Promise<TabInfo>
  evaluate(id: string, expression: string, timeoutMs: number): Promise<unknown>
  reload(id: string): Promise<void>
  activate(id: string): Promise<void>
}

type Session = { call(method: string, params: Record<string, unknown>, ms: number): Promise<Record<string, unknown>>; close(): void }

/** endpoint: http://127.0.0.1:<port>, or null while there is no browser */
export function cdpCarrier(endpoint: () => string | null, o: { controlMs?: number } = {}): TabCarrier {
  const controlMs = o.controlMs ?? 5000
  const base = () => {
    const e = endpoint()
    if (!e) throw new CarrierError('cdp', 'no browser', false)
    return e.replace(/\/+$/, '')
  }

  async function http(method: string, path: string, gone404 = false): Promise<string> {
    const at = base(), name = `${method} /${path.split('?')[0]}`
    let r: Response
    try { r = await fetch(`${at}/${path}`, { method, signal: AbortSignal.timeout(controlMs) }) }
    catch (e) {
      if ((e as Error)?.name === 'TimeoutError') throw new CarrierError('timeout', `${name} took over ${controlMs} ms`, false)
      throw new CarrierError('cdp', `${name}: ${(e as Error)?.message ?? e}`, false)
    }
    const text = await r.text()
    if (r.status === 404 && gone404) throw new CarrierError('gone', `${name}: no such tab`, false)
    if (!r.ok) throw new CarrierError('cdp', `${name}: ${r.status}`, false)
    return text
  }

  function connect(id: string): Promise<Session> {
    const url = `${base().replace(/^http/, 'ws')}/devtools/page/${encodeURIComponent(id)}`
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url), waiting = new Map<number, (m: Record<string, unknown> | null) => void>()
      let opened = false, next = 0
      const timer = setTimeout(() => { ws.close(); fail(new CarrierError('gone', `tab ${id}: no connection within ${controlMs} ms`, false)) }, controlMs)
      ws.addEventListener('open', () => {
        opened = true; clearTimeout(timer)
        ok({
          call: (method, params, ms) => new Promise((done, bad) => {
            const id = ++next, t = setTimeout(() => { waiting.delete(id); bad(new CarrierError('timeout', `${method} took over ${ms} ms`)) }, ms)
            waiting.set(id, (m) => {
              clearTimeout(t); waiting.delete(id)
              if (!m) return bad(new CarrierError('gone', `${method}: the tab closed the session`))
              const err = m.error as { message?: string } | undefined
              if (err) return bad(new CarrierError('cdp', `${method}: ${err.message ?? 'error'}`))
              done((m.result ?? {}) as Record<string, unknown>)
            })
            ws.send(JSON.stringify({ id, method, params }))
          }),
          close: () => ws.close(),
        })
      })
      ws.addEventListener('message', (ev) => {
        let m: Record<string, unknown>
        try { m = JSON.parse(String(ev.data)) } catch { return }
        waiting.get(m.id as number)?.(m)
      })
      // a refused handshake fires error without close
      const end = () => {
        if (!opened) { clearTimeout(timer); fail(new CarrierError('gone', `tab ${id}: no such tab`, false)) }
        for (const w of [...waiting.values()]) w(null)
      }
      ws.addEventListener('close', end)
      ws.addEventListener('error', end)
    })
  }

  return {
    async list() {
      const all = JSON.parse(await http('GET', 'json/list')) as { id: string; type: string; url?: string }[]
      return all.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url ?? '' }))
    },
    async open(url) {
      const t = JSON.parse(await http('PUT', `json/new?${encodeURIComponent(url)}`)) as { id: string; url?: string }
      return { id: t.id, url: t.url || url }
    },
    async evaluate(id, expression, timeoutMs) {
      const s = await connect(id)
      try {
        // Sleeping Tabs freezes fetch and timers in an idle tab, so every eval wakes it first
        try { await s.call('Page.setWebLifecycleState', { state: 'active' }, controlMs) }
        catch (e) { const c = e as CarrierError; throw new CarrierError(c.kind, c.message, false) }
        const r = await s.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
        const ex = r.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
        if (ex) throw new CarrierError('script', ex.exception?.description ?? ex.text ?? 'script error')
        return (r.result as { value?: unknown } | undefined)?.value
      } finally { s.close() }
    },
    async reload(id) {
      const s = await connect(id)
      try { await s.call('Page.reload', {}, controlMs) } finally { s.close() }
    },
    async activate(id) { await http('GET', `json/activate/${encodeURIComponent(id)}`, true) },
  }
}
