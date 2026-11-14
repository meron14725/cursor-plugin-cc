# Cursor plugin for Claude Code

Use Cursor CLI (`cursor-agent`) from inside Claude Code for a read-only code review or an adversarial review.

This repository is a modified fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) at commit `db52e28f4d9ded852ab3942cea316258ae4ef346` (Apache-2.0). The Codex app-server transport was replaced with `cursor-agent`. Rescue, transfer, the stop-review gate, and the GPT-5.4 prompting skill were removed. See `NOTICE` for the license statement.

## What you get

- `/cursor:review` for a read-only review of the working tree or a branch
- `/cursor:adversarial-review` for a steerable challenge review
- `/cursor:status`, `/cursor:result`, and `/cursor:cancel` to inspect and stop background runs
- `/cursor:setup` to check that Cursor CLI is installed and logged in

Reviews run in a temporary git worktree, not in your checkout. `cursor-agent` is started with `--mode ask` and `-p`. [Headless print mode can still edit files inside its workspace without `--force`](https://cursor.com/docs/cli/headless), and the docs do not say that ask mode disables that. The plugin treats write, shell, MCP, and task tool calls as a failed review and stops the process tree. The temporary worktree is removed afterward, so those writes are not applied to your checkout.

## Requirements

- **Cursor CLI installed and logged in.** The installer links both `cursor-agent` and `agent` to the same binary. This plugin calls `cursor-agent`.
- **Node.js 18.18 or later**
- **Git**, in the repository you want reviewed

Install Cursor CLI:

```bash
curl https://cursor.com/install -fsS | bash
```

Add `~/.local/bin` to your `PATH` if the installer did not already do that. Then log in:

```bash
cursor-agent login
cursor-agent status
```

For a machine without a browser, set `CURSOR_API_KEY` in the environment. Do not pass the key as a command-line flag. Check status with `cursor-agent status` (add `--format json` for a machine-readable result).

## Install

In Claude Code:

```text
/plugin marketplace add meron14725/cursor-plugin-cc
/plugin install cursor@cursor-plugin-cc
/reload-plugins
/cursor:setup
```

`/cursor:setup` reports whether `cursor-agent` is on `PATH` and whether `cursor-agent status` says you are logged in. It prints the install or login command when something is missing. It does not install the CLI for you.

## Usage

### `/cursor:review`

Read-only review of the current work. It does not take extra focus text.

```text
/cursor:review
/cursor:review --base main
/cursor:review --background
/cursor:review --model composer-2.5
```

Target selection:

- dirty working tree: review uncommitted changes, including untracked files
- clean tree: review the branch against the detected default branch
- `--base <ref>`: review the branch against that ref
- `--scope working-tree` or `--scope branch` to force a target
- `--scope staged` and `--scope unstaged` are rejected

`--wait` runs in the foreground. `--background` asks Claude Code to detach the run. Check `/cursor:status` and read `/cursor:result` when it finishes. `--resume <chat-id>` continues an existing Cursor chat.

When `--model` is omitted, the plugin does not pass `--model`, so Cursor CLI uses the account's selected model. Set `CURSOR_AGENT_MODEL` to change that default without hardcoding it into the plugin. List models with `cursor-agent --list-models` or `cursor-agent models`.

### `/cursor:adversarial-review`

Same target selection as `/cursor:review`, plus optional focus text. The prompt is the adversarial review in `plugins/cursor/prompts/adversarial-review.md`, and the answer is parsed against `plugins/cursor/schemas/review-output.schema.json`.

```text
/cursor:adversarial-review
/cursor:adversarial-review --base main challenge whether this was the right caching and retry design
/cursor:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/cursor:status`

Shows running and recent Cursor review jobs for this repository and Claude session.

```text
/cursor:status
/cursor:status review-abc123
```

### `/cursor:result`

Shows the stored review for a finished job, including the Cursor session id and a `cursor-agent --resume <chat-id>` command when the CLI returned one.

```text
/cursor:result
/cursor:result review-abc123
```

### `/cursor:cancel`

Stops an active background review by signaling the companion process and the `cursor-agent` child.

```text
/cursor:cancel
/cursor:cancel review-abc123
```

### `/cursor:setup`

```text
/cursor:setup
```

## How a review runs

1. The plugin selects the git target (working tree, branch, or `--base`).
2. It creates a temporary git worktree. A working-tree review copies the uncommitted files into that worktree. Your checkout is not the process workspace.
3. It writes the diff to `.cursor-review/context.md` in that worktree. The argv prompt stays small: for a large diff it tells the model to read that file and not to run git or shell.
4. It spawns `cursor-agent -p --output-format stream-json --mode ask --trust --workspace <temporary worktree>`.
5. `--model` is added only when you passed `--model` or set `CURSOR_AGENT_MODEL`.
6. Read and search tools are allowed. A write, shell, MCP, or task tool fails the review. The plugin stops the process tree with `SIGTERM` and follows with `SIGKILL` if it is still alive. Tool lines are written to the job log as they arrive. Use `/cursor:status <job-id>` to see them.
7. The temporary worktree is removed when the run ends.

`--trust` only skips Cursor's headless workspace-trust prompt. It is not permission to edit. Ask mode is requested because the docs describe it as read-only, but print mode is separately documented as able to edit the workspace without `--force`. The isolated worktree and the tool block are what keep the review off your checkout.

## Fork

Upstream: https://github.com/openai/codex-plugin-cc (`db52e28f4d9ded852ab3942cea316258ae4ef346`).

What changed:

- Codex app-server JSON-RPC, the broker, and the generated TypeScript client were removed.
- Reviews call `cursor-agent` instead.
- The plugin namespace is `cursor` (`/cursor:review`, `/cursor:adversarial-review`).
- Removed: `/codex:rescue`, `/codex:transfer`, the rescue subagent, Claude session transfer, the stop-review gate, and the `gpt-5-4-prompting` skill.
