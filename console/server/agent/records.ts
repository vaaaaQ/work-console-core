import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentRec } from '../../src/model/agent.ts'
import type { Store } from '../store/port.ts'

/* One workspace's agent conversations: in its store when the store keeps them, else in a JSON file of their own. */

export interface AgentRecords { all(): Promise<AgentRec[]>; put(a: AgentRec): Promise<void> }

export function agentRecords(store: Store, file: string): AgentRecords {
  if (store.agents && store.putAgent) return { all: () => store.agents!(), put: (a) => store.putAgent!(a) }
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = chain.then(f); chain = p.catch(() => undefined); return p }
  const read = (): AgentRec[] => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as AgentRec[] : [])
  return {
    all: () => serial(async () => read()),
    put: (a) => serial(async () => {
      const xs = read(), i = xs.findIndex((x) => x.id === a.id)
      if (i >= 0) xs[i] = structuredClone(a); else xs.push(structuredClone(a))
      mkdirSync(dirname(file), { recursive: true })
      await writeFile(file + '.tmp', JSON.stringify(xs))
      await rename(file + '.tmp', file)
    }),
  }
}
