import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createIsolatedReviewWorkspace, writeReviewContextFiles } from "../plugins/cursor/scripts/lib/review-workspace.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function commitAll(cwd, message) {
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", message], { cwd });
}

test("an isolated snapshot is not a git checkout and edits stay inside it", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  commitAll(repo, "init");
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");

  const isolated = await createIsolatedReviewWorkspace(repo, { syncWorkingTree: true });
  try {
    assert.equal(fs.existsSync(path.join(isolated.path, ".git")), false);
    assert.match(fs.readFileSync(path.join(isolated.path, "app.js"), "utf8"), /value = 2/);
    fs.writeFileSync(path.join(isolated.path, "app.js"), "export const value = 9;\n");
    assert.match(fs.readFileSync(path.join(repo, "app.js"), "utf8"), /value = 2/);
  } finally {
    isolated.cleanup();
  }

  assert.equal(fs.existsSync(isolated.root), false);
  const listed = run("git", ["worktree", "list", "--porcelain"], { cwd: repo });
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, /cursor-review-/);
});

test("copying a dirty file over a committed symlink does not follow the link", async () => {
  const repo = makeTempDir();
  const outside = path.join(os.tmpdir(), `cursor-review-secret-${process.pid}-${Date.now()}`);
  fs.writeFileSync(outside, "SECRET");
  initGitRepo(repo);
  fs.symlinkSync(outside, path.join(repo, "app.js"));
  commitAll(repo, "link");
  fs.unlinkSync(path.join(repo, "app.js"));
  fs.writeFileSync(path.join(repo, "app.js"), "SAFE\n");

  const isolated = await createIsolatedReviewWorkspace(repo, { syncWorkingTree: true });
  try {
    assert.equal(fs.readFileSync(outside, "utf8"), "SECRET");
    const snapshotFile = path.join(isolated.path, "app.js");
    assert.equal(fs.lstatSync(snapshotFile).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(snapshotFile, "utf8"), "SAFE\n");
  } finally {
    isolated.cleanup();
    fs.rmSync(outside, { force: true });
  }
});

test("snapshot keeps a non-ascii path that quotePath would escape", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const name = "héllo world.js";
  fs.writeFileSync(path.join(repo, "keep.js"), "export const value = 1;\n");
  commitAll(repo, "init");
  fs.writeFileSync(path.join(repo, name), "export const value = 'quoted';\n");

  const isolated = await createIsolatedReviewWorkspace(repo, { syncWorkingTree: true });
  try {
    assert.equal(fs.readFileSync(path.join(isolated.path, name), "utf8"), "export const value = 'quoted';\n");
  } finally {
    isolated.cleanup();
  }
});

test("snapshot applies a staged rename and a directory replaced by a file", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "old.js"), "export const renamed = true;\n");
  fs.mkdirSync(path.join(repo, "dir"));
  fs.writeFileSync(path.join(repo, "dir", "a.js"), "export const nested = true;\n");
  commitAll(repo, "init");
  run("git", ["mv", "old.js", "new.js"], { cwd: repo });
  fs.rmSync(path.join(repo, "dir"), { recursive: true, force: true });
  fs.writeFileSync(path.join(repo, "dir"), "export const fileNow = true;\n");
  run("git", ["add", "-A"], { cwd: repo });

  const isolated = await createIsolatedReviewWorkspace(repo, { syncWorkingTree: true });
  try {
    assert.equal(fs.existsSync(path.join(isolated.path, "old.js")), false);
    assert.match(fs.readFileSync(path.join(isolated.path, "new.js"), "utf8"), /renamed = true/);
    assert.equal(fs.lstatSync(path.join(isolated.path, "dir")).isFile(), true);
    assert.match(fs.readFileSync(path.join(isolated.path, "dir"), "utf8"), /fileNow = true/);
  } finally {
    isolated.cleanup();
  }
});

test("a repository with no commits can be snapshotted from untracked files", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const fresh = true;\n");

  const isolated = await createIsolatedReviewWorkspace(repo, { syncWorkingTree: true });
  try {
    assert.equal(fs.existsSync(path.join(isolated.path, ".git")), false);
    assert.match(fs.readFileSync(path.join(isolated.path, "app.js"), "utf8"), /fresh = true/);
  } finally {
    isolated.cleanup();
  }
});

test("snapshot creation does not run a post-checkout hook", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  commitAll(repo, "init");
  const hook = path.join(repo, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\necho hooked >> \"$(dirname \"$0\")/../../hook-ran\"\n", { mode: 0o755 });

  const isolated = await createIsolatedReviewWorkspace(repo, { syncWorkingTree: true });
  isolated.cleanup();
  assert.equal(fs.existsSync(path.join(repo, "hook-ran")), false);
});

test("review context is chunked outside the tree and is not dropped", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  commitAll(repo, "init");
  fs.writeFileSync(path.join(repo, "app.js"), `export const value = "${"x".repeat(200)}";\n`);
  const contextDir = path.join(repo, "context-out");
  const written = await writeReviewContextFiles(repo, { mode: "working-tree" }, contextDir, { chunkBytes: 40 });
  const combined = written.chunks.map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
  assert.ok(written.chunks.length > 2);
  assert.match(combined, /xxxxxxxx/);
  assert.match(fs.readFileSync(written.indexPath, "utf8"), /Do not report them as findings/);
});

test("a dirty file over the byte cap is not copied into the snapshot", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  commitAll(repo, "init");
  fs.writeFileSync(path.join(repo, "app.js"), `${"y".repeat(80)}\n`);

  const isolated = await createIsolatedReviewWorkspace(repo, { syncWorkingTree: true, maxFileBytes: 16 });
  try {
    const body = fs.readFileSync(path.join(isolated.path, "app.js"), "utf8");
    assert.match(body, /cursor-review skipped/);
    assert.doesNotMatch(body, /yyyy/);
  } finally {
    isolated.cleanup();
  }
});
