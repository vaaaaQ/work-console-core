import * as React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { store } from './lib/util.ts'
import { loadCustomPbs } from './model/playbookFile.ts'
import { JOBS, initFlow } from './model/world.ts'
import { applyStoredTheme, demoInfo, fromHash } from './actions/nav.tsx'
import { initDownloads } from './actions/playbooks.tsx'
import { toast } from './ui/toasts.tsx'
import { App } from './App.tsx'
import { boot, fromQuery } from './live/boot.ts'
import { PairScreen } from './views/Devices.tsx'

/* With a backend the page is live; without one (the artifact, vite dev) it is the demo. */
const root = createRoot(document.getElementById('root')!)
applyStoredTheme()
boot().then((mode) => {
  if (mode === 'unpaired') { root.render(<PairScreen />); return }
  if (mode === 'demo') { loadCustomPbs(); JOBS.forEach(initFlow) }
  fromHash()
  if (mode === 'live') fromQuery()
  root.render(<App />)
  initDownloads()
  if (mode === 'demo' && !store.get('seen2', false)) {
    store.set('seen2', true)
    setTimeout(() => toast('A clickable prototype on demo data. Nothing is sent anywhere.', 'What is real', demoInfo, 9000), 400)
  }
})
