import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* Test folders in the OS temp dir: tempDir makes wc-<what>-XXXXXX, and each goes when the process that made it exits,
   after its tests' own hooks closed what held them. One that will not go fails the test file. */

const made = new Set<string>()

/** rm -rf that waits out a folder Windows still holds for a moment after its process or handle closed: ~2 s at most.
    rmSync's own maxRetries skip access denied, which is how a held folder often fails */
export function removeDir(dir: string) {
  for (let i = 1; ; i++) {
    try { rmSync(dir, { recursive: true, force: true }); break } catch (e) {
      if (i === 10) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * i)
    }
  }
  made.delete(dir)
}

export function tempDir(what: string): string {
  const d = mkdtempSync(join(tmpdir(), `wc-${what}-`))
  made.add(d)
  return d
}

process.once('exit', () => {
  const left: string[] = []
  for (const d of [...made]) try { removeDir(d) } catch (e) { left.push(`${d}: ${(e as Error).message}`) }
  if (left.length) { console.error(`test folders left behind:\n${left.join('\n')}`); process.exitCode = 1 }
})
