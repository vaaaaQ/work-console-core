import '../src/testkit.ts'
import { JOBS0, JR, OVR, TPL0 } from '../src/data/demo.ts'
import { PB0 } from '../src/data/playbooks.ts'
import * as T from '../src/model/transitions.ts'
import type { Job } from '../src/model/types.ts'
import type { Seed } from './store/file.ts'

/* Demo-shaped state for tests and the smoke run; never loaded by main.ts. Importing it installs the example workspace. */

export const demoCtx = (): T.Ctx => ({ PB: PB0, TPL: TPL0 })
export function demoSeed(): Seed {
  const x = demoCtx()
  const jobs = structuredClone(JOBS0).map((s) => { const j = s as Job; T.seedFlow(x, j, OVR[j.id], JR[j.id]); return j })
  return { jobs, playbooks: structuredClone(PB0) }
}
