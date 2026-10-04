import { acme } from '../src/testkit.ts'
import { CORE_PB, CORE_TPL } from '../src/data/playbooks.ts'
import * as T from '../src/model/transitions.ts'
import type { Job } from '../src/model/types.ts'
import acmeServer from '../workspaces/acme/server.ts'
import type { PromptImage } from './llm/context.ts'
import type { RunTools, Sdk, SdkEvent } from './llm/sdk.ts'
import type { Seed } from './store/file.ts'
import { fakeSeed } from './workspace.ts'

/* Demo-shaped state for tests and the smoke run; never loaded by main.ts. Importing it installs the example workspace.
   These read Acme alone, so they stay put when a test installs more workspaces. */

export { acme, acmeServer }
export const demoCtx = (): T.Ctx => ({ PB: { ...CORE_PB, ...acme.playbooks }, TPL: { ...CORE_TPL, ...acme.templates } })
export function demoSeed(): Seed {
  const x = demoCtx()
  const jobs = structuredClone(acme.demo.jobs).map((s) => { const j = s as Job; T.seedFlow(x, j, acme.demo.ovr?.[j.id], acme.demo.jr?.[j.id]); return j })
  return { jobs, playbooks: structuredClone(x.PB) }
}
/** what a fake gateway starts with to serve Acme's demo */
export const demoFake = () => fakeSeed(acmeServer)

/** one scripted LLM session: it runs until the test pushes its events and ends it */
export class FakeSession {
  prompt: string; images?: PromptImage[]; resume?: string; cwd?: string; tools: RunTools; abort: AbortController
  private q: (SdkEvent | null)[] = []; private wake: (() => void) | null = null
  constructor(o: { prompt: string; images?: PromptImage[]; resume?: string; cwd?: string; tools: RunTools; abort: AbortController }) {
    this.prompt = o.prompt; this.images = o.images; this.resume = o.resume; this.cwd = o.cwd; this.tools = o.tools; this.abort = o.abort
  }
  push(e: SdkEvent | null) { this.q.push(e); this.wake?.() }
  end(ok = true, error?: string) { this.push({ k: 'result', ok, error }); this.push(null) }
  async *events(): AsyncIterable<SdkEvent> {
    for (;;) {
      if (this.abort.signal.aborted) throw new Error('aborted')
      if (!this.q.length) await new Promise<void>((r) => { this.wake = r; this.abort.signal.addEventListener('abort', () => r(), { once: true }) })
      if (this.abort.signal.aborted) throw new Error('aborted')
      const e = this.q.shift()
      if (e === null) return
      if (e) yield e
    }
  }
}
/** an SDK whose every start() is a FakeSession, appended to sessions */
export function fakeSdk(sessions: FakeSession[] = []): { sdk: Sdk; sessions: FakeSession[] } {
  return { sdk: { start: (o) => { const s = new FakeSession(o); sessions.push(s); return s.events() } }, sessions }
}
