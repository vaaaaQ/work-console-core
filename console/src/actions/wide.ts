import { S } from '../model/world.ts'
import { commit } from '../store.ts'

/* The step inspector opens at a third of the window; widened, it covers the page right of the nav rail.
   Only for the step it was widened on: another step, or closing it, starts at a third again. */

export const isWide = () => S.sel !== null && S.wide === S.sel
export function toggleWide() { commit(() => { S.wide = isWide() ? null : S.sel }) }
/** Esc narrows a widened inspector before it closes it; true when it narrowed */
export function escNarrow() { if (!isWide()) return false; toggleWide(); return true }
