# AGENTS.md

This folder is a Work Console. Before changing anything here, read [EXTENDING.md](EXTENDING.md): where
each change goes, what is never touched, the ctx API and the patterns with their tests.

- In a console that vendors the core (it has `core.lock.json`), change only `workspaces/<id>/` and
  `tools/`; core files, the lock, `grants.json` and the two registries are not yours.
- In the core repo itself, the repo root's `CLAUDE.md` governs.
- Check with `npm run typecheck` and `npm test` from this folder.
