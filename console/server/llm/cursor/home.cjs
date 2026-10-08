'use strict'
// Preloaded into the Cursor agent CLI: its home folder is the session's own, so the user's own config and MCP servers stay out.
const os = require('node:os')
const home = process.env.WC_CURSOR_HOME
if (home) os.homedir = () => home
