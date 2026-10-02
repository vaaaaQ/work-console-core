import type { Pack, Ws } from '../model/types.ts'

/* ===== workspace packs: tools, vocabulary, review rule =====
   A pack maps a workplace's tools onto the core concepts. Each workspace brings its own under
   workspaces/<id>/; install() (src/workspace.ts) fills this map from the registered ones. */
export const PACKS: Record<Ws, Pack> = {}
/** the workspace the page opens in, and the one jobs from a removed workspace land in: the first registered */
export let DEFAULT_WS: Ws = ''
export function setDefaultWs(ws: Ws) { DEFAULT_WS = ws }
