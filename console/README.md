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

On your PC: `scripts/install.ps1` once, `scripts/update.ps1` after pulling, `scripts/pair.ps1`
to pair a phone.

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

```bash
# from a core checkout, with the core change committed
node <core>/console/scripts/sync-core.mjs --to <consumer console dir> [--ref <rev>] [--force]
```

| Whose | What |
|---|---|
| Core-owned, synced | everything under `console/` except the two rows below: `src/`, `server/`, `scripts/`, `package.json`, `package-lock.json`, and the example workspaces `acme` and `beta` |
| The consumer's own | `workspaces/page.ts`, `workspaces/server.ts`, its `workspaces/<id>/` and `tools/` |
| Written by sync | `core.lock.json`: the core commit and a sha256 per synced file |

- The consumer writes its two registries first. Copy the core's as a start and list only its workspaces.
- Sync reads the core commit (`HEAD`, or `--ref`), never the working tree, and deletes the files the
  previous lock listed that the commit dropped.
- It refuses when a core file was edited in the consumer, or when an unlisted consumer file would be
  overwritten, and it lists them. A CRLF-only difference is not an edit. `--force` overrides.
- The first sync has no lock and checks nothing; the log says how many existing files it replaced.
- `npm test` in the consumer runs `server/core-lock.test.ts`: it fails on an edited core file or on a
  stray file outside `workspaces/` and `tools/`. In the core it skips, since there is no lock.
- Rule: a generic change is a core commit, then a consumer commit that only syncs. A workspace change
  touches only `workspaces/<id>/`.
