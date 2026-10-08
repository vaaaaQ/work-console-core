# CLAUDE.md

Guidance for an agent working in this repo.

## Rules that do not bend

- **An LLM drafts; a person sends.** No LLM run and no Claude Code session ever posts, mails, votes,
  comments or changes state in a tool. Runs get read tools only (`server/llm/sdk.ts` `ALLOW`/`DENY`; Cursor's through `server/llm/cursor/policy.ts`).
  Acts go through `/api/act`, and only from the page after a person confirms.
- **The core names no workplace.** Code under `console/` and `schemas/` must not mention a real
  company, product, person or host. A workplace lives in its workspace, `console/workspaces/<id>/`
  (pack, playbooks, board rule, demo data), and in a bridge pack under `packs/<name>/`. The demo
  workspaces are the fictional Acme and Beta, and example hosts end in `.example`.
- **A repo that vendors the core never edits core files.** Its `core.lock.json` lists them, and
  `console/server/core-lock.test.ts` fails on an edit, a stray file or a missing lock. Change the core, then run
  `sync-core.mjs`. A consumer adds only `workspaces/<id>/`, its two registries and `tools/`.
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
node console/scripts/sync-core.mjs --to <consumer console dir> [--ref <rev>] [--force]   # vendor this core into another repo
```

## Where things are

- Concepts are `SrcKey` in `console/src/model/types.ts`: work, review, chat, mail, cal, ci,
  tickets, docs and time, plus board.
- The console's only external boundary is the gateway protocol: [docs/gateway-protocol.md](docs/gateway-protocol.md).
  `console/server/bridge/fake.ts` implements it in memory and is the executable reference.
- A pack's call envelope, error codes and tests are covered in [docs/pack-authoring.md](docs/pack-authoring.md).
- A workspace is two files, `console/workspaces/<id>/page.ts` (the page half) and `server.ts` (the backend
  half), listed in `workspaces/page.ts` and `workspaces/server.ts`. The seam is `console/src/workspace.ts`
  and `console/server/workspace.ts`; the contract is in [docs/architecture.md](docs/architecture.md#workspaces).
- Home time zone: `console/src/lib/zone.ts`. It uses the runtime zone unless `WORK_CONSOLE_TZ` is
  set. A pack's `tz` is the team's second clock.
- A test's folder in the OS temp dir comes from `tempDir()` of `console/server/testdirs.ts`: it goes when the
  test file's process exits, and one that will not go fails that file.

## Adding a workspace

A workspace is files under `console/workspaces/` only; nothing in `console/src/` or `console/server/` changes.

1. Copy `console/workspaces/beta/`, the smallest example, to `console/workspaces/<id>/`. In `page.ts` set
   the `id` and the `Pack` (tool names per concept, vote words, project list, key placeholder), the
   `board` rule, the `playbooks` (ids unique across workspaces) and the `demo` data.
2. In `server.ts` set a unique `jobPrefix`. Add `defaults`, `source`, `store`, `llm` or `plugins` only
   where the default does not fit. Page-only code, such as act handlers and dialogs, goes in an optional
   `ui.tsx` that only `workspaces/page.ts` imports.
3. List it in `workspaces/page.ts` and `workspaces/server.ts`; the first listed is the default.
4. Put its keys under `workspaces.<id>` in the console's `config.json`, such as `gatewayUrl`.
5. Copy `packs/example/` to `packs/<name>/`. Add one reader per concept, each with contract tests
   against `schemas/`.
6. Build the gateway and the carrier if they do not exist yet ([docs/roadmap.md](docs/roadmap.md)).
7. Run `npm test` and `npm run typecheck`.
