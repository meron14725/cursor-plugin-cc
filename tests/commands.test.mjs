import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "cursor");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Cursor's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cursor-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Cursor review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
  assert.match(source, /--mode ask/);
  assert.match(source, /Do not add `--force`/);
  assert.doesNotMatch(source, /codex-companion/);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Cursor's output verbatim to the user/i);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\].*\[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /description:\s*"Cursor adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/cursor:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
  assert.match(source, /--mode ask/);
});

test("kept commands are setup, review, adversarial-review, status, result, and cancel", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "agents")), false);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "skills", "gpt-5-4-prompting")), false);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs")), false);
});

test("result and cancel are deterministic entrypoints and reviews are not auto-fixed", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/cursor-result-handling/SKILL.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /cursor-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(result, /cursor-agent --resume <chat-id>/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /cursor-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not generate a substitute review/i);
  assert.match(resultHandling, /if Cursor was never successfully invoked, do not generate a substitute answer at all/i);
  assert.match(resultHandling, /Auto-applying fixes from a review is strictly forbidden/i);
  assert.match(resultHandling, /\/cursor:setup/);
});

test("hooks keep session cleanup and do not install a stop-review gate", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
  assert.doesNotMatch(source, /stop-review-gate-hook/);
  assert.doesNotMatch(source, /Stop/);
});

test("setup command points users at cursor-agent install and login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /cursor-companion\.mjs" setup/);
  assert.match(setup, /curl https:\/\/cursor\.com\/install -fsS \| bash/);
  assert.match(setup, /cursor-agent login/);
  assert.match(setup, /CURSOR_API_KEY/);
  assert.doesNotMatch(setup, /@openai\/codex/);
  assert.match(readme, /cursor-agent login/);
  assert.match(readme, /\/plugin marketplace add meron14725\/cursor-plugin-cc/);
  assert.match(readme, /\/cursor:setup/);
  assert.match(readme, /\/cursor:review/);
  assert.match(readme, /\/cursor:adversarial-review/);
  assert.match(readme, /\/cursor:status/);
  assert.match(readme, /\/cursor:result/);
  assert.match(readme, /\/cursor:cancel/);
  assert.match(readme, /--mode ask/);
  assert.match(readme, /openai\/codex-plugin-cc/);
});
