import type { MailCat, NodeState } from '../model/types.ts'

/** LLM reply drafts for the demo mail, from the registered workspaces; install() fills it */
export const MDR: Record<string, string> = {}
export const MCAT: [MailCat, string, string][] = [
  ['reply', 'To reply', 'mail'], ['wait', 'Waiting for an answer', 'hourglass'], ['fyi', 'FYI', 'inbox'], ['auto', 'Automatic', 'bot']]
/** the Jobs filter bar */
export const GROUPS: [string, string][] = [
  ['all', 'All'], ['needs', 'Needs you'], ['waiting', 'Waiting on others'], ['progress', 'In progress'],
  ['drafts', 'Drafts'], ['recurring', 'Recurring'], ['closed', 'Closed']]
/** glyph on a flow node; the current step shows who does it instead */
export const G: Partial<Record<NodeState, string>> = { done: 'check', wait: 'hourglass', bad: 'alert', tpl: 'message', skip: 'skip' }
