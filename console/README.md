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
