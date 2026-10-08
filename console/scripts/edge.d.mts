/** <home>/browser, the console's own Edge profile */
export function edgeProfile(home: string): string
/** true when /json/version answers on the endpoint */
export function probe(endpoint: string): Promise<boolean>
/** the debugging endpoint from the profile's DevToolsActivePort, else null */
export function profileEndpoint(dir: string): string | null
/** true when a process command line runs on exactly this profile dir */
export function holdsProfile(cmd: string, dir: string, win?: boolean): boolean
/** true while a browser holds the profile: Edge's lock file on Windows, its singleton link elsewhere */
export function profileHeld(dir: string): boolean
/** asks the browser to close itself, which writes the profile out; true once its port is gone and the profile let go */
export function closeEdge(endpoint: string, dir: string, ms: number): Promise<boolean>
/** ends every process on this profile dir: Edge restarts itself under a new pid, so the spawned one may be gone */
export function killProfile(dir: string): Promise<void>
/** closes the Edge on this profile through CDP, ending its processes when it does not close; false when none held it */
export function closeProfile(dir: string, ms?: number): Promise<boolean>
