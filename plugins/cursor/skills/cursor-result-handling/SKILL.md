---
name: cursor-result-handling
description: Internal guidance for presenting Cursor review output back to the user
user-invocable: false
---

# Cursor Result Handling

When the helper returns a Cursor review:
- Preserve the helper's verdict, summary, findings, and next steps.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- If there are no findings, say that explicitly.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports a failed or incomplete Cursor run, include the actionable error text and stop. Do not generate a substitute review.
- If Cursor was never successfully invoked, do not generate a substitute answer at all.
- If the helper reports that setup or authentication is required, direct the user to `/cursor:setup` and do not improvise alternate auth flows.
- Reviews run `cursor-agent` in ask mode. Do not rerun them with `--force` or without `--mode ask`.
