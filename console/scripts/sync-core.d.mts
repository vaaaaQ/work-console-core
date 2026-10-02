/** the consumer's own files, which a sync never writes or deletes */
export const OWN: (p: string) => boolean
/** build output and the lock itself, which the lock never lists */
export const IGNORED: (p: string) => boolean
export interface CoreLock { core: string; files: Record<string, string> }
/** sha256 of the bytes with every CRLF turned into LF */
export function hash(buf: Uint8Array): string
/** the core's console/ at rev, paths relative to console/ and without OWN paths */
export function readCore(coreRoot: string, rev: string): { sha: string; files: Map<string, Buffer> }
/** the paths a sync would refuse to overwrite; empty without a lock */
export function conflicts(to: string, lock: CoreLock | null, files: Map<string, Uint8Array>): string[]
export function sync(o: { core: string; to: string; rev?: string; force?: boolean; log?: (line: string) => void }): { sha: string; written: string[]; deleted: string[] }
