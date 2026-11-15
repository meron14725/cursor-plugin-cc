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

test("checkout keeps export-ignore files and does not expand export-subst", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "secret.txt"), "KEEP-SECRET\n");
  fs.writeFileSync(path.join(repo, "version.txt"), "literal $Format:%H$\n");
  fs.writeFileSync(path.join(repo, ".gitattributes"), "secret.txt export-ignore\nversion.txt export-subst\n");
  commitAll(repo, "attrs");

  const isolated = await createIsolatedReviewWorkspace(repo);
  try {
    assert.equal(fs.readFileSync(path.join(isolated.path, "secret.txt"), "utf8"), "KEEP-SECRET\n");
    assert.match(fs.readFileSync(path.join(isolated.path, "version.txt"), "utf8"), /\$Format:%H\$/);
  } finally {
    isolated.cleanup();
  }
});

test("a populated submodule is copied and an empty submodule fails the snapshot", async () => {
  const sub = makeTempDir();
  initGitRepo(sub);
  fs.writeFileSync(path.join(sub, "inside.js"), "export const inside = true;\n");
  commitAll(sub, "sub");
  const subSha = run("git", ["rev-parse", "HEAD"], { cwd: sub }).stdout.trim();

  const populated = makeTempDir();
  initGitRepo(populated);
  fs.writeFileSync(path.join(populated, "README.md"), "parent\n");
  commitAll(populated, "init");
  run("git", ["clone", sub, path.join(populated, "vendor", "lib")], { cwd: populated });
  run("git", ["update-index", "--add", "--cacheinfo", `160000,${subSha},vendor/lib`], { cwd: populated });
  run("git", ["commit", "-m", "link"], { cwd: populated });

  const isolated = await createIsolatedReviewWorkspace(populated);
  try {
    assert.match(fs.readFileSync(path.join(isolated.path, "vendor", "lib", "inside.js"), "utf8"), /inside = true/);
  } finally {
    isolated.cleanup();
  }

  const empty = makeTempDir();
  initGitRepo(empty);
  fs.writeFileSync(path.join(empty, "README.md"), "parent\n");
  commitAll(empty, "init");
  run("git", ["update-index", "--add", "--cacheinfo", `160000,${subSha},vendor/lib`], { cwd: empty });
  run("git", ["commit", "-m", "link"], { cwd: empty });
  await assert.rejects(() => createIsolatedReviewWorkspace(empty), /Submodule vendor\/lib is not checked out/);
});

test("an external diff driver does not replace the review diff", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  commitAll(repo, "init");
  const marker = path.join(repo, "ext-ran");
  const script = path.join(repo, "ext.sh");
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\necho FAKE-EXTERNAL-DIFF\n`, { mode: 0o755 });
  run("git", ["config", "diff.external", script], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = REAL-DIFF-BODY;\n");

  const contextDir = path.join(repo, "context-out");
  const written = await writeReviewContextFiles(repo, { mode: "working-tree" }, contextDir);
  const body = written.chunks.map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
  assert.equal(fs.existsSync(marker), false);
  assert.doesNotMatch(body, /FAKE-EXTERNAL-DIFF/);
  assert.match(body, /REAL-DIFF-BODY/);
});

test("a committed symlink to an outside file becomes a marker and its target is not read", async () => {
  const outside = path.join(os.tmpdir(), `cursor-review-target-${process.pid}-${Date.now()}`);
  fs.writeFileSync(outside, "SECRET-LINK-TARGET");
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.symlinkSync(outside, path.join(repo, "linked.js"));
  commitAll(repo, "link");

  const isolated = await createIsolatedReviewWorkspace(repo);
  try {
    const snapshotFile = path.join(isolated.path, "linked.js");
    assert.equal(fs.lstatSync(snapshotFile).isSymbolicLink(), false);
    assert.match(fs.readFileSync(snapshotFile, "utf8"), /points outside the snapshot/);
    assert.equal(fs.readFileSync(outside, "utf8"), "SECRET-LINK-TARGET");
  } finally {
    isolated.cleanup();
    fs.rmSync(outside, { force: true });
  }
});

test("committed files over the byte cap are replaced with a marker", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "big.js"), `${"y".repeat(80)}\n`);
  commitAll(repo, "big");

  const isolated = await createIsolatedReviewWorkspace(repo, { maxFileBytes: 16 });
  try {
    const body = fs.readFileSync(path.join(isolated.path, "big.js"), "utf8");
    assert.match(body, /cursor-review skipped/);
    assert.doesNotMatch(body, /yyyy/);
  } finally {
    isolated.cleanup();
  }
});

test("diff chunks break on newlines", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  commitAll(repo, "init");
  fs.writeFileSync(path.join(repo, "app.js"), `export const value = "${"x".repeat(200)}";\n`);
  const written = await writeReviewContextFiles(repo, { mode: "working-tree" }, path.join(repo, "chunks"), {
    chunkBytes: 40
  });
  const diffFiles = written.chunks.filter((filePath) => path.basename(filePath).startsWith("diff-"));
  assert.ok(diffFiles.length > 1);
  for (const filePath of diffFiles) {
    assert.equal(fs.readFileSync(filePath).at(-1), 0x0a);
  }
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
