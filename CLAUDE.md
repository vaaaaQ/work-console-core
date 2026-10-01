# CLAUDE.md

Guidance for an agent working in this repo.

## Rules that do not bend

- **An LLM drafts; a person sends.** No LLM run and no Claude Code session ever posts, mails, votes,
  comments or changes state in a tool. Runs get read tools only (`server/llm/sdk.ts` `ALLOW`/`DENY`).
  Acts go through `/api/act`, and only from the page after a person confirms.
- **The core names no workplace.** Code under `console/` and `schemas/` must not mention a real
  company, product, person or host. A workplace lives in its pack: an entry in
  `console/src/data/packs.ts`, its playbooks, and a bridge pack under `packs/<name>/`. The demo
  workplace is the fictional Acme, and example hosts end in `.example`.
- **No cloud of ours.** Everything runs on the user's machine: the page, the backend, the gateway and
  the browser. Do not add a dependency on a hosted queue, vault or database.
- **Tokens never leave the tab.** A pack reads with the tab's own session and never returns a
  secret, not even inside an error message (`scrub`).

## Commands

```bash
cd console && npm test          # every unit; tests pin WORK_CONSOLE_TZ through test.env
cd console && npm run typecheck
cd console && npm run build && npm run smoke
node --test "packs/**/test/*.test.mjs"   # from the repo root
```

## Where things are

- Concepts are `SrcKey` in `console/src/model/types.ts`: work, review, chat, mail, cal, ci,
  tickets, docs and time, plus board.
- The console's only external boundary is the gateway protocol: [docs/gateway-protocol.md](docs/gateway-protocol.md).
  `console/server/bridge/fake.ts` implements it in memory and is the executable reference.
- A pack's call envelope, error codes and tests are covered in [docs/pack-authoring.md](docs/pack-authoring.md).
- Home time zone: `console/src/lib/zone.ts`. It uses the runtime zone unless `WORK_CONSOLE_TZ` is
  set. A pack's `tz` is the team's second clock.

## Adding a workplace

1. Add a `Pack` entry in `console/src/data/packs.ts` with tool names per concept, vote words, project
   list and key placeholder. Then set `DEFAULT_WS`.
2. Add playbooks in `console/src/data/playbooks.ts`, either as core steps or with `ws` set to the pack.
3. Copy `packs/example/` to `packs/<name>/`. Add one reader per concept, each with contract tests
   against `schemas/`.
4. Build the gateway and the carrier if they do not exist yet ([docs/roadmap.md](docs/roadmap.md)).
