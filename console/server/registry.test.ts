import { test } from 'node:test'
import { SERVERS } from '../workspaces/server.ts'
import { checkWorkspaces } from './workspace.ts'

/* The registered workspaces pass the checks the server makes at start; the agent's check runs this in a consumer. */

test('the registered workspaces pass the start checks', () => {
  checkWorkspaces(SERVERS)
})
