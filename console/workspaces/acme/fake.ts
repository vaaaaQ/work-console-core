import type { FakeSeed } from '../../server/workspace.ts'
import { seedFromDemo } from '../../server/workspace.ts'
import { wallIso } from '../../src/lib/zone.ts'
import acme from './page.ts'

/* Acme's fake gateway: what its demo gives (chats, mail, calendar, board, timesheet), plus the work items,
   pull requests and builds that only the gateway knows. */
export function acmeFake(): FakeSeed {
  const base = seedFromDemo(acme), me = acme.me ?? 'You'
  return {
    threads: base.threads,
    concepts: {
      ...base.concepts,
      work: acme.demo.jobs.filter((j) => /^ACME-\d/.test(j.key)).map((j) => ({
        id: j.key, type: 'Story', title: j.t, state: 'In Progress', assignedTo: me, changedAt: wallIso('09:00'), link: `https://jira.example/browse/${j.key}`,
      })),
      review: Object.values(acme.demo.pri ?? {}).filter((p) => p.id.startsWith('#')).map((p) => ({
        id: p.id.slice(1), repo: 'acme/platform', title: p.br, author: me, myVote: 0, votes: [{ reviewer: 'Priya Shah', vote: 1 }], activeThreads: 1, createdAt: wallIso('09:12'), link: `https://github.example/acme/platform/pull/${p.id.slice(1)}`,
      })),
      ci: [{ id: 'main#1288', pipeline: 'main', status: 'completed', result: 'succeeded', branch: 'main', startedAt: wallIso('07:01'), finishedAt: wallIso('07:15'), link: 'https://jenkins.example/job/main/1288/' }],
    },
  }
}
