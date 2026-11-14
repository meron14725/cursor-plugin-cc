import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createIsolatedReviewWorkspace } from "../plugins/cursor/scripts/lib/review-workspace.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("an isolated review workspace can be edited without changing the checkout", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");

  const isolated = createIsolatedReviewWorkspace(repo, { syncWorkingTree: true });
  try {
    assert.match(fs.readFileSync(path.join(isolated.path, "app.js"), "utf8"), /value = 2/);
    fs.writeFileSync(path.join(isolated.path, "app.js"), "export const value = 9;\n");
    assert.match(fs.readFileSync(path.join(repo, "app.js"), "utf8"), /value = 2/);
    assert.doesNotMatch(fs.readFileSync(path.join(repo, "app.js"), "utf8"), /value = 9/);
  } finally {
    isolated.cleanup();
  }

  assert.equal(fs.existsSync(isolated.path), false);
  const listed = run("git", ["worktree", "list", "--porcelain"], { cwd: repo });
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, /cursor-review-/);
});
