import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function gitLines(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function safeRelative(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    return null;
  }
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || normalized === ".git" || normalized.startsWith(`.git${path.sep}`)) {
    return null;
  }
  return normalized;
}

function syncWorkingTree(repoRoot, dest) {
  const changed = new Set([
    ...gitLines(repoRoot, ["diff", "--name-only"]),
    ...gitLines(repoRoot, ["diff", "--cached", "--name-only"]),
    ...gitLines(repoRoot, ["ls-files", "--others", "--exclude-standard"])
  ]);
  const deleted = new Set([
    ...gitLines(repoRoot, ["diff", "--name-only", "--diff-filter=D"]),
    ...gitLines(repoRoot, ["diff", "--cached", "--name-only", "--diff-filter=D"])
  ]);

  for (const relativePath of deleted) {
    const safe = safeRelative(relativePath);
    if (!safe) {
      continue;
    }
    fs.rmSync(path.join(dest, safe), { force: true, recursive: true });
  }

  for (const relativePath of changed) {
    if (deleted.has(relativePath)) {
      continue;
    }
    const safe = safeRelative(relativePath);
    if (!safe) {
      continue;
    }
    const source = path.join(repoRoot, safe);
    let stat;
    try {
      stat = fs.lstatSync(source);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }
    const target = path.join(dest, safe);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

export function createIsolatedReviewWorkspace(repoRoot, options = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-review-"));
  const dest = path.join(parent, "repo");
  const added = spawnSync("git", ["-C", repoRoot, "worktree", "add", "--detach", "--quiet", dest, "HEAD"], {
    encoding: "utf8"
  });
  if (added.status !== 0) {
    fs.rmSync(parent, { recursive: true, force: true });
    const detail = (added.stderr || added.stdout || "git worktree add failed").trim();
    throw new Error(`Could not create an isolated review workspace: ${detail}`);
  }
  if (options.syncWorkingTree) {
    syncWorkingTree(repoRoot, dest);
  }

  let cleaned = false;
  return {
    path: dest,
    cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", dest], { encoding: "utf8" });
      fs.rmSync(parent, { recursive: true, force: true });
    }
  };
}
