export interface NewWorkspace { id: string; prefix: string; title: string }
/** the workspace a new console starts with */
export const HOME: NewWorkspace
/** the id as a camel-case identifier: my-crm → myCrm; a reserved word gets a ws prefix */
export function varName(id: string): string
export function render(text: string, o: NewWorkspace): string
/** grants.json of a workspace granted nothing yet, byte for byte as the console writes it */
export const EMPTY_GRANTS_JSON: string
/** the registry with the workspace's import after the last import and its entry last in the array */
export function addRegistry(text: string, kind: 'page' | 'server', id: string): string
