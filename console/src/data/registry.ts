import type { Ws } from '../model/types.ts'
import type { Board, Registered, WorkspacePage } from '../workspace.ts'

/* The registered workspaces; install() (src/workspace.ts) fills the list. A leaf with no runtime imports, so the
   model (context.ts) reads a workspace's board rule without importing install, which imports the world. */
export const REG: Registered[] = []

/** a registered workspace's page half, or undefined */
export const pageOf = (id: Ws): WorkspacePage | undefined => REG.find((r) => r.page.id === id)?.page
export const wsPage = (id: Ws): WorkspacePage => {
  const p = pageOf(id)
  if (!p) throw new Error(`no workspace ${id}`)
  return p
}
/** a key, or a bare item id the board's key round-trips */
export const itemOf = (b: Board, s: string): string | null => b.itemId(s) ?? (b.itemId(b.key(s)) === s ? s : null)
