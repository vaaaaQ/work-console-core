/** the consumer's own files, which a sync never writes or deletes */
export const OWN: (p: string) => boolean
/** build output and the lock itself, which the lock never lists */
export const IGNORED: (p: string) => boolean
export interface CoreLock { core: string; files: Record<string, string> }
/** sha256 of the bytes with every CRLF turned into LF */
export function hash(buf: Uint8Array): string
/** true when p is a plain relative path that stays under dest, an absolute resolved dir */
export function inside(dest: string, p: string): boolean
/** the core's console/ at rev, paths relative to console/ and without OWN paths */
export function readCore(coreRoot: string, rev: string): { sha: string; files: Map<string, Buffer> }
/** the paths a sync would refuse to overwrite; empty without a lock */
export function conflicts(to: string, lock: CoreLock | null, files: Map<string, Uint8Array>): string[]
/** removes dir and its parents up to, not including, stop while they are empty */
export function prune(dir: string, stop: string): void
export function sync(o: { core: string; to: string; rev?: string; force?: boolean; log?: (line: string) => void }): { sha: string; written: string[]; deleted: string[] }
/** true when schemas/ and packs/ are directories beside consoleDir: the core's own layout */
export function isCoreLayout(consoleDir: string): boolean
/** one sentence per way a console dir that vendors the core has drifted from core.lock.json; empty when clean */
export function drift(consoleDir: string): string[]
