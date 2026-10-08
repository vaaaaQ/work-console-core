# console

The Work Console: the page (`src/`) and its backend (`server/`). Design: [docs/architecture.md](../docs/architecture.md).

```bash
npm ci
npm test              # model + every server unit, fake gateway and fake SDK
npm run typecheck
npm run build         # typecheck, dist/index.html for the backend, dist/artifact.html (the demo)
npm run smoke         # after build: a whole backend end to end on free ports
npm run dev           # vite, the page alone in demo mode
WORK_CONSOLE_FAKE_GATEWAY=1 npm start   # backend on http://127.0.0.1:7410 against the demo-seeded fake gateway
```

## Install, run, update

Your own console is a folder of its own, a git repo that vendors this core:

```bash
node <core>/console/scripts/install.mjs --to <dir> [--provider claude|cursor]   # once; again repairs
node <dir>/scripts/run.mjs [--detach | --stop | --restart]                     # keeps the server running
node <dir>/scripts/update.mjs [--give-up]                                      # pull the core, check, move on
```

- Install checks Node 22.6+, git, npm and Docker, writes the folder with a `home` workspace (the one workspace
  template, managed with empty grants, so its agent opens with the interview), starts its
  Postgres (`postgres/compose.yaml`, port 55432 or the next free one), reports whether the provider is signed
  in (it never signs in), asks for an optional OpenAI key for voice, builds, and starts the console.
- A port is the console's own only when its container `work-console-postgres` publishes it (`docker ps`);
  one any other container or process holds is skipped. With Docker down, home gets no database address
  and says "Postgres not running — start Docker and run install again".
- `WORK_CONSOLE_PG_CONTAINER` and `WORK_CONSOLE_PG_VOLUME`, set together, give a test install its own
  container and volume beside the real ones.
- `--provider` writes `<home>/providers.json`; without it, install keeps the choice already there.
- `<home>` is `WORK_CONSOLE_HOME` or `~/.work-console`: `config.json`, `install.json`, `providers.json`,
  `postgres.password`, `openai.key`, `run.json`, `logs/console.log` and `browser/`, the console's own Edge profile.
- `run.mjs` restarts the server at once on exit code 75 and after a backoff on any other exit; a restart keeps
  the console's Edge for the next server, and `--stop` or Ctrl+C closes it. `--restart` asks the server, which
  waits until no agent turn runs. After a restart into a new build the page says "Updated — press Ctrl+F5".
- `update.mjs` syncs and checks a new core in a worktree `<home>-updates/<sha7>` on `update/<sha7>`. A failure
  leaves the folder as it was, exits 3 and writes `<home>/update-failed.json`, which the console shows in a
  banner: **Reintegrate** opens a conversation with a managed workspace's agent, given the failing output and
  the core's diff, which fixes the workspace on that branch and applies or gives up; **Apply** runs the update
  again; **Give up** drops it. By hand: commit a fix on that branch and run the update again, or run `--give-up`.
  `--no-restart` leaves the restart to the console that runs it. `npm ci` runs only when the npm lock changed:
  under `run.mjs` the update asks the console to restart, which waits for the agents' turns, and `run.mjs` runs
  `npm ci` and the build (`update.mjs --finish`) before it starts the server again, so nothing rewrites
  `node_modules` under a running server. A finish that fails puts the folder back and writes
  `update-failed.json` at step `finish`: the banner shows its output and `logs/console.log`, **Apply** tries
  the update again and **Dismiss** drops the record.
- What to change where, and what never to touch, is in [EXTENDING.md](EXTENDING.md).
- Starting at logon is up to you: install prints the command and changes nothing on your system.

The `.ps1` scripts are the older setup and still work: `scripts/install.ps1` once, `scripts/update.ps1`
after pulling, `scripts/pair.ps1` to pair a phone.

## Adding a workspace

A workspace is two files under `workspaces/<id>/`, listed in `workspaces/page.ts` and `workspaces/server.ts`.
Copy `workspaces/beta/`, the smallest example, and follow [the steps in CLAUDE.md](../CLAUDE.md#adding-a-workspace).
The contract is in [docs/architecture.md](../docs/architecture.md#workspaces).

| File | Holds |
|---|---|
| `workspaces/<id>/page.ts` | id, pack, playbooks, board rule, demo data; Node must be able to load it |
| `workspaces/<id>/server.ts` | job prefix, config defaults, source, store, LLM tools, plugins |
| `workspaces/<id>/ui.tsx` | optional: act handlers and dialogs, imported only by `workspaces/page.ts` |

A workspace's own commands run as `node --experimental-strip-types workspaces/<id>/...`. `package.json`
is core-owned, so there is no npm script for them.

## Using the core from another repo

Order: the consumer's registries first, then the sync.

1. In the consumer's console dir write `workspaces/page.ts` and `workspaces/server.ts`. Copy the core's as
   a start and list only the consumer's workspaces.
2. From a core checkout, with the core change committed:

```bash
node <core>/console/scripts/sync-core.mjs --to <consumer console dir> [--ref <rev>] [--force]
```

| Whose | What |
|---|---|
| Core-owned, synced | everything under `console/` except the two rows below: `src/`, `server/`, `scripts/`, `package.json`, `package-lock.json`, and the example workspaces `acme` and `beta`; and the core's `packs/` and `schemas/`, into the consumer's own `packs/` and `schemas/` |
| The consumer's own | `workspaces/page.ts`, `workspaces/server.ts`, its `workspaces/<id>/` and `tools/` |
| Written by sync | `core.lock.json`: the core commit and a sha256 per synced file |

- Sync refuses a `--to` that lacks either registry, whether or not there is a lock, and writes nothing.
- Sync reads the core commit (`HEAD`, or `--ref`), never the working tree, and deletes the files the
  previous lock listed that the commit dropped. It never writes or deletes the consumer's own files, and
  it refuses a path that would leave the console dir, whether it comes from the core tree or the lock.
- It refuses when a core file was edited in the consumer, or when an unlisted consumer file would be
  overwritten, and it lists them. A CRLF-only difference is not an edit. `--force` overrides.
- The first sync has no lock and checks no edits; the log says how many existing files differ from the
  core and are replaced.
- `npm test` in the consumer runs `server/core-lock.test.ts`: it fails on an edited or missing core
  file, on a stray file outside `workspaces/` and `tools/`, and on a missing `core.lock.json` (run the
  sync). It skips only in the core itself, which has `schemas/` and `packs/` beside `console/`.
- Rule: a generic change is a core commit, then a consumer commit that only syncs. A workspace change
  touches only `workspaces/<id>/`.

## Known issues

- A page command that races a runner write to the same job can fail with 409 `conflict`, even without
  `expectV`: the write is compare-and-set, and only the runner's and the console's own writes try again
  (`server/jobs/jobs.ts:77`). This is the behaviour so far, not a regression.
- `server/store/file.test.ts` once failed as a whole file, with no output, inside an agent's apply when
  `check` still ran the whole suite. Its cause is not found.
