import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HttpError } from '../events.ts'
import { GATEWAY_ACTIONS, actionPacks, actionsOf, grantedActs, resolveAct } from './actions.ts'
import { PACKS_DIR } from './packs.ts'
import type { PackManifest } from './packs.ts'

const act = (concept: string) => ({ tab: 't', concept })
const PACKS: Pick<PackManifest, 'name' | 'actions'>[] = [
  { name: 'm365-mail', actions: { 'mail.send': act('mail') } },
  { name: 'm365-teams', actions: { 'chat.post': act('chat') } },
  { name: 'azure-devops', actions: { 'work.setState': act('work'), 'work.comment': act('work'), 'review.vote': act('review'), 'review.comment': act('review') } },
  { name: 'reader' },
]
const chats = async () => [{ id: '19:abc', name: 'Team Dev' }]
const refused = (code: string) => (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === code

test('a hand-kept workspace may use every action its packs declare', () => {
  assert.deepEqual([...actionsOf(PACKS)].sort(), ['chat.post', 'mail.send', 'review.comment', 'review.vote', 'work.comment', 'work.setState'])
})

test('grants narrow the declared actions, and a grant no pack declares stays out', () => {
  assert.deepEqual([...actionsOf(PACKS, ['mail.send'])], ['mail.send'])
  assert.deepEqual([...actionsOf(PACKS, [])], [])
  assert.deepEqual([...actionsOf(PACKS, ['mail.send', 'time.fill'])], ['mail.send'])
  assert.deepEqual([...actionsOf([], ['mail.send'])], [])
})

test('each action names the packs that declare it', () => {
  const by = actionPacks([...PACKS, { name: 'other-mail', actions: { 'mail.send': act('mail') } }])
  assert.deepEqual(by.get('mail.send'), ['m365-mail', 'other-mail'])
  assert.deepEqual(by.get('review.vote'), ['azure-devops'])
  assert.equal(by.get('work.start'), undefined)
})

test('resolveAct refuses an action outside the allowed set and takes one inside it', async () => {
  const allowed = actionsOf(PACKS, ['mail.send'])
  await assert.rejects(resolveAct({ action: 'work.start', args: {} }, chats, allowed), refused('unknown_action'))
  await assert.rejects(resolveAct({ action: 'chat.post', args: { chatName: 'Team Dev', text: 't' } }, chats, allowed), refused('unknown_action'))
  assert.equal((await resolveAct({ action: 'mail.send', actionId: 'a1', args: { to: ['x@example.com'] } }, chats, allowed)).action, 'mail.send')
})

test('a gateway workspace keeps its eight actions', async () => {
  assert.equal(GATEWAY_ACTIONS.size, 8)
  for (const action of GATEWAY_ACTIONS) assert.equal((await resolveAct({ action, args: { chatName: 'Team Dev' } }, chats)).action, action)
  await assert.rejects(resolveAct({ action: 'rm -rf', args: {} }, chats), refused('unknown_action'))
})

test("a managed workspace may act only through the core packs its grants name, and only as granted", () => {
  const said: string[] = []
  const hosts = ['teams.microsoft.com', 'graph.microsoft.com', 'outlook.office.com', 'dev.azure.com']
  const config = { 'azure-devops': { org: 'acme', project: 'core' } }
  const g = (packs: string[], acts: string[], h = hosts) => [...grantedActs({ packs, hosts: h, acts, config }, PACKS_DIR, undefined, (m) => said.push(m))].sort()
  assert.deepEqual(g(['m365-teams', 'azure-devops'], ['chat.post', 'review.vote', 'mail.send']), ['chat.post', 'review.vote'])
  assert.deepEqual(g(['m365-teams'], []), [], 'nothing granted, nothing allowed')
  assert.deepEqual(g([], ['chat.post']), [], 'a granted act no pack declares is not allowed')
  assert.deepEqual(g(['no-such-pack', 'm365-mail'], ['mail.send']), ['mail.send'], 'a pack that does not load gives nothing')
  assert.deepEqual(g(['m365-teams'], ['chat.post'], ['graph.microsoft.com']), [], 'nor does one whose hosts are not granted')
  assert.equal(said.length, 2)
  assert.match(said[0], /no-such-pack/)
  assert.match(said[1], /m365-teams.*teams\.microsoft\.com is not granted/)
})
