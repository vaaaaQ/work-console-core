import { install } from './workspace.ts'
import acme from '../workspaces/acme/page.ts'

/* Tests that read demo data import this first: it installs the example workspace, as the page does at start. */
install([{ page: acme }])
export { acme }
