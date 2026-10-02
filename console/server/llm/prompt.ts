import { contextSection } from '../../src/model/context.ts'
import type { Resolved } from '../../src/model/context.ts'
import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'

/* What a session is told: the job's frame and its context, read at the run's start; more it reads itself through the bridge. */

export function buildPrompt(x: T.Ctx, j: Job, step: string, q: string, ctx: Resolved[] = []): string {
  const s = T.stepOf(x, j, step), pb = x.PB[j.pb]
  const outs = T.steps(x, j.pb).filter((t) => j.flow[t.id]?.out).map((t) => `### ${t.t}\n${j.flow[t.id].out}`)
  const jr = j.jr.slice(-20).map((e) => `- ${e.ts} ${e.a}: ${e.o} → ${e.c} Next: ${e.n}`)
  return [
    `You are working one step of a job in the user's Work Console.`,
    ``,
    `Job ${j.id}: ${j.t}`,
    `Key: ${j.key} · playbook: ${pb?.n ?? j.pb} · project: ${j.prj}`,
    `Step: ${s?.t ?? step}`,
    `Exit criterion: ${s?.x ?? '-'}`,
    s?.a?.length ? `Expected artifacts: ${s.a.join(', ')}` : '',
    ``,
    `Instruction: ${q}`,
    ``,
    contextSection(ctx),
    outs.length ? `## Earlier outputs\n${outs.join('\n\n')}\n` : '',
    jr.length ? `## Journal (latest last)\n${jr.join('\n')}\n` : '',
    `## How to work`,
    `- The context above was read when this run started. Read anything more yourself with the bridge tools (bridge_snapshot, bridge_get).`,
    `- You never send anything to a source (no chat posts, mails, votes, comments or state changes): the user sends after review.`,
    `- Write progress with the run tool journal(observed, changed, next) at meaningful points.`,
    `- Save files the step expects with add_artifact(name, content).`,
    `- Finish by calling submit_draft(text) exactly once with the draft for the user to review. Without it the run counts as failed.`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n')
}

export const RESUME_PROMPT = 'The Work Console resumed this run. Continue the same step from where you stopped; finish with submit_draft(text).'
