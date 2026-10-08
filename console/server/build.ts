import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

const seen = new Map<string, { mtime: number; size: number; id: string }>()

/** the page build the server serves: a hash of dist/index.html, re-read only when the file changes; null without one */
export function buildId(file: string): string | null {
  let st
  try { st = statSync(file) } catch { seen.delete(file); return null }
  const was = seen.get(file)
  if (was && was.mtime === st.mtimeMs && was.size === st.size) return was.id
  try {
    const id = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
    seen.set(file, { mtime: st.mtimeMs, size: st.size, id })
    return id
  } catch { return null }
}
