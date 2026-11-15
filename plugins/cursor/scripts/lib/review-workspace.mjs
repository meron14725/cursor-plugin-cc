import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "./state.mjs";

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 256 * 1024;

let activeSnapshotRoot = null;
let activeSnapshotTmp = null;
let reviewJob = null;
let agentPid = null;
const childPids = new Set();

function gitBuffer(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, "-c", "core.quotePath=false", ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString().trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function splitNull(buffer) {
  if (!buffer || buffer.length === 0) {
    return [];
  }
  const parts = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      if (index > start) {
        parts.push(buffer.subarray(start, index).toString("utf8"));
      }
      start = index + 1;
    }
  }
  if (start < buffer.length) {
    parts.push(buffer.subarray(start).toString("utf8"));
  }
  return parts;
}

function hasHead(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
  return result.status === 0;
}

function safeRelative(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    return null;
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    return null;
  }
  if (normalized === ".git" || normalized.startsWith(`.git${path.sep}`)) {
    return null;
  }
  return normalized;
}

function parseNameStatus(buffer) {
  const parts = splitNull(buffer);
  const records = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index];
    if (/^[RC]\d*$/.test(status)) {
      records.push({ status, from: parts[index + 1], path: parts[index + 2] });
      index += 3;
      continue;
    }
    records.push({ status, path: parts[index + 1] });
    index += 2;
  }
  return records.filter((record) => record.path);
}

function destinationPath(destRoot, relativePath) {
  const safe = safeRelative(relativePath);
  if (!safe) {
    throw new Error(`Refusing to snapshot unsafe path "${relativePath}".`);
  }
  const target = path.resolve(destRoot, safe);
  const root = path.resolve(destRoot);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to snapshot path outside the review tree "${relativePath}".`);
  }
  return { safe, target };
}

function removeExisting(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  fs.unlinkSync(target);
}

function ensureRealParents(destRoot, relativePath) {
  const parts = relativePath.split(path.sep);
  let current = path.resolve(destRoot);
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = null;
    }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      fs.unlinkSync(current);
      stat = null;
    }
    if (!stat) {
      fs.mkdirSync(current);
    }
  }
}

function placeFromWorktree(repoRoot, destRoot, relativePath, maxFileBytes) {
  const { safe, target } = destinationPath(destRoot, relativePath);
  const source = path.join(repoRoot, safe);
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch {
    ensureRealParents(destRoot, safe);
    removeExisting(target);
    return;
  }
  ensureRealParents(destRoot, safe);
  removeExisting(target);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), target);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target);
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  if (stat.size > maxFileBytes) {
    fs.writeFileSync(target, `cursor-review skipped ${safe} (${stat.size} bytes)\n`);
    return;
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const input = fs.openSync(source, flags);
  try {
    const data = fs.readFileSync(input);
    const output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, stat.mode & 0o777);
    try {
      fs.writeFileSync(output, data);
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(input);
  }
}

function overlayWorkingTree(repoRoot, destRoot, { maxFileBytes, head }) {
  const records = head
    ? parseNameStatus(gitBuffer(repoRoot, ["diff", "-z", "--name-status", "-M", "--no-ext-diff", "HEAD"]))
    : [];
  const untracked = splitNull(gitBuffer(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const removals = new Set();
  const writes = new Set();

  for (const record of records) {
    if (record.status === "D") {
      removals.add(record.path);
      continue;
    }
    if (record.from) {
      removals.add(record.from);
    }
    writes.add(record.path);
  }
  for (const relativePath of untracked) {
    writes.add(relativePath);
  }

  for (const relativePath of removals) {
    if (writes.has(relativePath)) {
      continue;
    }
    const located = destinationPath(destRoot, relativePath);
    removeExisting(located.target);
  }
  for (const relativePath of writes) {
    placeFromWorktree(repoRoot, destRoot, relativePath, maxFileBytes);
  }
}

export function registerChild(pid) {
  if (Number.isInteger(pid) && pid > 0) {
    childPids.add(pid);
  }
}

export function unregisterChild(pid) {
  childPids.delete(pid);
}

export function registerAgent(pid) {
  agentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function unregisterAgent(pid) {
  if (agentPid === pid) {
    agentPid = null;
  }
}

export function registerReviewJob(job) {
  if (job?.workspaceRoot && job?.jobId) {
    reviewJob = { workspaceRoot: job.workspaceRoot, jobId: job.jobId };
  }
}

export function clearReviewJob() {
  reviewJob = null;
}

function signalRecorded(signal) {
  const pids = [...childPids];
  if (agentPid) {
    pids.push(agentPid);
  }
  for (const pid of pids) {
    try {
      process.kill(-pid, signal);
    } catch {
      // The pid may not be a process-group leader.
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}

function markReviewCancelled() {
  if (!reviewJob) {
    return;
  }
  const completedAt = new Date().toISOString();
  const patch = {
    id: reviewJob.jobId,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    agentPid: null,
    completedAt,
    errorMessage: "Cancelled by signal."
  };
  try {
    const jobFile = resolveJobFile(reviewJob.workspaceRoot, reviewJob.jobId);
    const existing = fs.existsSync(jobFile) ? readJobFile(jobFile) : {};
    writeJobFile(reviewJob.workspaceRoot, reviewJob.jobId, {
      ...existing,
      ...patch,
      cancelledAt: completedAt
    });
    upsertJob(reviewJob.workspaceRoot, patch);
  } catch {
    // The process is exiting; keep the signal path best-effort.
  }
}

function runGit(args, { indexFile = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", ...args], {
      env: {
        ...process.env,
        ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    registerChild(child.pid);
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });
    const finish = (error) => {
      unregisterChild(child.pid);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    child.on("error", finish);
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(errorText.trim() || `git ${args.join(" ")} failed`));
        return;
      }
      finish();
    });
  });
}

function copyRegularFile(source, target, stat) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const input = fs.openSync(source, flags);
  try {
    const data = fs.readFileSync(input);
    const output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, stat.mode & 0o777 || 0o644);
    try {
      fs.writeFileSync(output, data);
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(input);
  }
}

function copyTree(source, dest, maxFileBytes, label) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue;
    }
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    const nextLabel = `${label}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
      continue;
    }
    if (entry.isDirectory()) {
      copyTree(from, to, maxFileBytes, nextLabel);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = fs.lstatSync(from);
    if (stat.size > maxFileBytes) {
      fs.writeFileSync(to, `cursor-review skipped ${nextLabel} (${stat.size} bytes)\n`);
      continue;
    }
    copyRegularFile(from, to, stat);
  }
}

function listGitlinks(repoRoot) {
  const entries = splitNull(gitBuffer(repoRoot, ["ls-tree", "-r", "-z", "HEAD"]));
  const links = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const mode = entry.slice(0, tab).split(" ")[0];
    if (mode === "160000") {
      links.push(entry.slice(tab + 1));
    }
  }
  return links;
}

function populateSubmodules(repoRoot, destRoot, maxFileBytes) {
  for (const relativePath of listGitlinks(repoRoot)) {
    const source = path.join(repoRoot, relativePath);
    let stat = null;
    try {
      stat = fs.lstatSync(source);
    } catch {
      stat = null;
    }
    const populated = stat && stat.isDirectory() && !stat.isSymbolicLink()
      && fs.readdirSync(source).some((name) => name !== ".git");
    if (!populated) {
      throw new Error(
        `Submodule ${relativePath} is not checked out. Populate it before reviewing so the snapshot can include its files.`
      );
    }
    const { target } = destinationPath(destRoot, relativePath);
    removeExisting(target);
    copyTree(source, target, maxFileBytes, relativePath);
  }
}

function walkSnapshot(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      visit(full, "symlink");
      continue;
    }
    if (entry.isDirectory()) {
      walkSnapshot(full, visit);
      continue;
    }
    if (entry.isFile()) {
      visit(full, "file");
    }
  }
}

function linkPointsOutside(root, linkPath) {
  const raw = fs.readlinkSync(linkPath);
  const resolved = path.resolve(path.dirname(linkPath), raw);
  const rootResolved = path.resolve(root);
  return resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`);
}

function replaceWithMarker(target, text) {
  fs.unlinkSync(target);
  fs.writeFileSync(target, text);
}

function sanitizeSnapshot(destRoot, maxFileBytes) {
  const replacements = [];
  walkSnapshot(destRoot, (full, kind) => {
    const relativePath = path.relative(destRoot, full);
    if (kind === "symlink" && linkPointsOutside(destRoot, full)) {
      replacements.push({
        full,
        text: `cursor-review replaced symlink ${relativePath} because it points outside the snapshot\n`
      });
      return;
    }
    if (kind === "file") {
      const stat = fs.lstatSync(full);
      if (stat.size > maxFileBytes) {
        replacements.push({
          full,
          text: `cursor-review skipped ${relativePath} (${stat.size} bytes)\n`
        });
      }
    }
  });
  for (const replacement of replacements) {
    replaceWithMarker(replacement.full, replacement.text);
  }
}

async function extractHeadTree(repoRoot, dest, indexFile) {
  await runGit(["-C", repoRoot, "read-tree", "HEAD"], { indexFile });
  await runGit(["-C", repoRoot, "checkout-index", "--all", `--prefix=${dest}${path.sep}`], { indexFile });
}

function streamGitChunks(repoRoot, args, contextDir, chunkBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-C", repoRoot, "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", ...args],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    registerChild(child.pid);
    const files = [];
    let pending = [];
    let pendingBytes = 0;
    let index = 0;
    let buffered = Buffer.alloc(0);
    const flush = () => {
      if (pendingBytes === 0) {
        return;
      }
      index += 1;
      const filePath = path.join(contextDir, `diff-${String(index).padStart(4, "0")}.txt`);
      fs.writeFileSync(filePath, Buffer.concat(pending));
      files.push(filePath);
      pending = [];
      pendingBytes = 0;
    };
    const pushLine = (line) => {
      if (pendingBytes > 0 && pendingBytes + line.length > chunkBytes) {
        flush();
      }
      pending.push(line);
      pendingBytes += line.length;
      if (pendingBytes >= chunkBytes) {
        flush();
      }
    };
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      let start = 0;
      for (let offset = 0; offset < buffered.length; offset += 1) {
        if (buffered[offset] === 0x0a) {
          pushLine(buffered.subarray(start, offset + 1));
          start = offset + 1;
        }
      }
      buffered = Buffer.from(buffered.subarray(start));
    });
    const finish = (error) => {
      unregisterChild(child.pid);
      if (error) {
        reject(error);
        return;
      }
      resolve(files);
    };
    child.on("error", finish);
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(errorText.trim() || `git ${args.join(" ")} failed`));
        return;
      }
      try {
        if (buffered.length > 0) {
          pushLine(buffered);
          buffered = Buffer.alloc(0);
        }
        flush();
        finish();
      } catch (error) {
        finish(error);
      }
    });
  });
}

export function isSnapshotPath(root, tmpRoot = os.tmpdir()) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    return false;
  }
  const resolved = path.resolve(root);
  if (!path.basename(resolved).startsWith("cursor-review-")) {
    return false;
  }
  const candidates = [...new Set([tmpRoot, os.tmpdir()].filter((value) => typeof value === "string" && value))];
  return candidates.some((tmp) => {
    const relative = path.relative(path.resolve(tmp), resolved);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

export function cleanupSnapshotPath(root, tmpRoot = activeSnapshotTmp || os.tmpdir()) {
  if (!isSnapshotPath(root, tmpRoot)) {
    return false;
  }
  fs.rmSync(root, { recursive: true, force: true });
  if (activeSnapshotRoot === root) {
    activeSnapshotRoot = null;
    activeSnapshotTmp = null;
  }
  return true;
}

export function trackSnapshot(root, tmpRoot = os.tmpdir()) {
  activeSnapshotRoot = root;
  activeSnapshotTmp = tmpRoot;
}

export function untrackSnapshot(root) {
  if (activeSnapshotRoot === root) {
    activeSnapshotRoot = null;
  }
}

export function cleanupTrackedSnapshot() {
  cleanupSnapshotPath(activeSnapshotRoot);
}

export function installSnapshotSignalHandlers() {
  let stopping = false;
  const stop = (code) => {
    if (stopping) {
      return;
    }
    stopping = true;
    signalRecorded("SIGTERM");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    signalRecorded("SIGKILL");
    cleanupTrackedSnapshot();
    markReviewCancelled();
    process.exit(code);
  };
  process.once("SIGTERM", () => stop(143));
  process.once("SIGINT", () => stop(130));
}

export async function createIsolatedReviewWorkspace(repoRoot, options = {}) {
  const tmpRoot = os.tmpdir();
  const parent = fs.mkdtempSync(path.join(tmpRoot, "cursor-review-"));
  trackSnapshot(parent, tmpRoot);
  const tree = path.join(parent, "tree");
  const contextDir = path.join(parent, "context");
  const indexFile = path.join(parent, "index");
  fs.mkdirSync(tree, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  try {
    const head = hasHead(repoRoot);
    if (head) {
      await extractHeadTree(repoRoot, tree, indexFile);
      populateSubmodules(repoRoot, tree, maxFileBytes);
    }
    if (options.syncWorkingTree || !head) {
      overlayWorkingTree(repoRoot, tree, {
        maxFileBytes,
        head
      });
    }
    sanitizeSnapshot(tree, maxFileBytes);
  } catch (error) {
    cleanupSnapshotPath(parent, tmpRoot);
    throw error;
  }

  let cleaned = false;
  return {
    path: tree,
    contextDir,
    root: parent,
    cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      cleanupSnapshotPath(parent);
    }
  };
}

export async function writeReviewContextFiles(repoRoot, target, contextDir, options = {}) {
  fs.mkdirSync(contextDir, { recursive: true });
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const head = hasHead(repoRoot);
  const diffFlags = ["diff", "--binary", "--no-ext-diff", "--submodule=diff"];
  let chunks = [];
  if (head && target?.mode === "branch" && target.baseRef) {
    chunks = await streamGitChunks(repoRoot, [...diffFlags, `${target.baseRef}...HEAD`], contextDir, chunkBytes);
  } else if (head) {
    chunks = await streamGitChunks(repoRoot, [...diffFlags, "HEAD"], contextDir, chunkBytes);
  }
  const untracked = splitNull(gitBuffer(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const lines = [
    "# Plugin-generated review context",
    "",
    "These files were generated by the Cursor review plugin. They are not part of the change.",
    "Do not report them as findings.",
    "Do not run shell, git, or any command.",
    ""
  ];
  if (chunks.length === 0) {
    lines.push("No tracked diff was produced.");
  } else {
    lines.push("Diff chunks:");
    for (const filePath of chunks) {
      lines.push(`- ${filePath}`);
    }
  }
  if (untracked.length > 0) {
    lines.push("", "Untracked files are present in the review tree:", ...untracked.map((file) => `- ${file}`));
  }
  const indexPath = path.join(contextDir, "index.md");
  fs.writeFileSync(indexPath, `${lines.join("\n")}\n`);
  return { indexPath, chunks: [indexPath, ...chunks] };
}
