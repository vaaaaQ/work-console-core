## For the person

The hosts, users, keys and roles are in ssh-mcp's own `config.toml`, never in the console. Write one profile per host
(`host`, `port`, `user`, a key path, `role`) with `approvalMode = "ask-destructive"`, and keep the file readable by
you only: ssh-mcp refuses a file others can change and prints the two `icacls` commands that fix it. Give its path
in the pack's `file` setting, or leave that empty for the default under `%APPDATA%`. A password or a key passphrase
goes in the environment: name it `${env:NAME}` and put `NAME=value` in `mcp.env` in the console's home.

Turning the pack on lets runs read. Tick a tool that changes things (`run-command`, `sftp-upload`, …) only when a
job needs it. A destructive or `sudo` command asks you first: a Confirm card on the step, and a push.

## For a run

- Start with `list-connections` to learn the profile names; every other tool takes one.
- Read with `read-command` (an allowlist of read-only commands, one line), `sftp-list` and `sftp-download`.
- Change things with `run-command` only when the step says so. A destructive command waits for the person's
  confirmation; if it is declined, say so in the draft and do not try another way round.
- Copy files with `sftp-upload` (content you give) rather than `echo > file`.
- A tool you were not given is refused and shows on the step; ask for it with `request_access` instead of retrying.
