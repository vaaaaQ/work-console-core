import { existsSync, renameSync, rmSync } from 'node:fs'

/* A console that changed its own code exits with RESTART_EXIT; the run script starts it again on that code alone.
   The page is built into a staging dir first and swapped in, so a failed build never touches the served one. */

export const RESTART_EXIT = 75

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

/** a rename that waits out a file the server or a scanner still holds open (Windows says EBUSY or EPERM) */
async function move(from: string, to: string) {
  for (let i = 0; ; i++) {
    try { return renameSync(from, to) } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 40 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw e
      await sleep(50)
    }
  }
}

/** stage becomes dist; the old build waits beside it until done() drops it or back() puts it back */
export async function swapDist(stage: string, dist: string): Promise<{ done(): void; back(): Promise<void> }> {
  const old = `${dist}.old`
  rmSync(old, { recursive: true, force: true })
  const had = existsSync(dist)
  if (had) await move(dist, old)
  try { await move(stage, dist) } catch (e) { if (had) await move(old, dist); throw e }
  return {
    done: () => rmSync(old, { recursive: true, force: true }),
    back: async () => { rmSync(dist, { recursive: true, force: true }); if (had) await move(old, dist) },
  }
}
