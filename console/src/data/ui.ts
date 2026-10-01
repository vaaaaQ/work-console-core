import type { MailCat, NodeState } from '../model/types.ts'

/** LLM reply drafts for the demo mail */
export const MDR: Record<string, string> = {
  m1: 'hi,\nthanks, I am on SUP-77 today and will update the ticket with what I find.',
  m2: 'hi Priya,\nsure, you will have the Q3 usage export by Friday, in the same format as last time.',
  m3: 'hi,\na quick follow-up: can ACME-530 go into tomorrow’s staging window?',
  m4: 'hi,\nthanks, noted.',
}
export const MCAT: [MailCat, string, string][] = [
  ['reply', 'To reply', 'mail'], ['wait', 'Waiting for an answer', 'hourglass'], ['fyi', 'FYI', 'inbox'], ['auto', 'Automatic', 'bot']]
/** the Jobs filter bar */
export const GROUPS: [string, string][] = [
  ['all', 'All'], ['needs', 'Needs you'], ['waiting', 'Waiting on others'], ['progress', 'In progress'],
  ['drafts', 'Drafts'], ['recurring', 'Recurring'], ['closed', 'Closed']]
/** glyph on a flow node; the current step shows who does it instead */
export const G: Partial<Record<NodeState, string>> = { done: 'check', wait: 'hourglass', bad: 'alert', tpl: 'message', skip: 'skip' }
