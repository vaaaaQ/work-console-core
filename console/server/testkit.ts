import { acme } from '../src/testkit.ts'
import { CORE_PB, CORE_TPL } from '../src/data/playbooks.ts'
import * as T from '../src/model/transitions.ts'
import type { Job } from '../src/model/types.ts'
import acmeServer from '../workspaces/acme/server.ts'
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
