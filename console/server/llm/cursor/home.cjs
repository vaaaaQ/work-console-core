'use strict'
// Preloaded into the Cursor agent CLI: its home folder is the session's own, so the user's own config and MCP servers stay out.
const os = require('node:os')
const cp = require('node:child_process')
const home = process.env.WC_CURSOR_HOME
if (home) {
  os.homedir = () => home
  // the CLI starts itself again for its worker server, without its own preload: that one gets it too
  const self = (file, args) => file === process.execPath && Array.isArray(args) && args.includes(process.argv[1])
  for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const orig = cp[fn]
    cp[fn] = function (file, args, ...rest) { return orig.call(this, file, self(file, args) ? ['-r', __filename, ...args] : args, ...rest) }
  }
  require('node:module').syncBuiltinESMExports()
}
