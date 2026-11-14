---
description: Check whether the local Cursor CLI is installed and logged in
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup $ARGUMENTS
```

Present the command output to the user.

If `cursor-agent` is missing, keep the install guidance exactly as printed. The supported install is:

```bash
curl https://cursor.com/install -fsS | bash
```

Then ensure `~/.local/bin` is on `PATH` (`cursor-agent` and `agent` are the same binary).

If `cursor-agent` is installed but not logged in, keep the guidance to run `cursor-agent login`. For a non-interactive machine, set `CURSOR_API_KEY` in the environment. Never put an API key on the command line or in the chat.
