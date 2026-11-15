# Changelog

## 1.0.0

- Fork of openai/codex-plugin-cc at db52e28f4d9ded852ab3942cea316258ae4ef346.
- Reviews run through `cursor-agent` in ask mode (`-p`, `--output-format stream-json`, `--mode ask`) instead of the Codex app server.
- Removed rescue, transfer, the stop-review gate, and the GPT-5.4 prompting skill.
