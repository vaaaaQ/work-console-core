import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import pkg from './package.json' with { type: 'json' }

// The artifact CSP admits scripts from cdnjs only, so the build loads React's
// UMD globals from there instead of inlining the library into the page.
const REACT = pkg.dependencies.react
const reactFromCdnjs = (): Plugin => ({
  name: 'react-from-cdnjs',
  apply: 'build',
  transformIndexHtml: () =>
    [`react/${REACT}/umd/react`, `react-dom/${REACT}/umd/react-dom`].map((p) => ({
      tag: 'script',
      attrs: { src: `https://cdnjs.cloudflare.com/ajax/libs/${p}.production.min.js` },
      injectTo: 'head' as const,
    })),
})

export default defineConfig({
  plugins: [react({ jsxRuntime: 'classic' }), reactFromCdnjs(), viteSingleFile()],
  build: {
    minify: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client'],
      output: {
        format: 'iife',
        globals: { react: 'React', 'react-dom': 'ReactDOM', 'react-dom/client': 'ReactDOM' },
      },
    },
  },
})
