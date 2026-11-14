import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 256 * 1024;

let activeSnapshotRoot = null;

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
  const records = head ? parseNameStatus(gitBuffer(repoRoot, ["diff", "-z", "--name-status", "-M", "HEAD"])) : [];
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

function extractHeadArchive(repoRoot, dest) {
  return new Promise((resolve, reject) => {
    const archive = spawn("git", ["-C", repoRoot, "archive", "--format=tar", "HEAD"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const extract = spawn("tar", ["-x", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    let errorText = "";
    archive.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });
    extract.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });
    archive.stdout.pipe(extract.stdin);
    archive.on("error", reject);
    extract.on("error", reject);
    let archiveCode = null;
    let extractCode = null;
    const finish = () => {
      if (archiveCode == null || extractCode == null) {
        return;
      }
      if (archiveCode !== 0 || extractCode !== 0) {
        reject(new Error(errorText.trim() || "git archive failed"));
        return;
      }
      resolve();
    };
    archive.on("close", (code) => {
      archiveCode = code ?? 1;
      finish();
    });
    extract.on("close", (code) => {
      extractCode = code ?? 1;
      finish();
    });
  });
}

function streamGitChunks(repoRoot, args, contextDir, chunkBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoRoot, "-c", "core.quotePath=false", ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const files = [];
    let pending = [];
    let pendingBytes = 0;
    let index = 0;
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
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const room = Math.max(1, chunkBytes - pendingBytes);
        const slice = chunk.subarray(offset, Math.min(chunk.length, offset + room));
        pending.push(slice);
        pendingBytes += slice.length;
        offset += slice.length;
        if (pendingBytes >= chunkBytes) {
          flush();
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(errorText.trim() || `git ${args.join(" ")} failed`));
        return;
      }
      try {
        flush();
        resolve(files);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function isSnapshotPath(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    return false;
  }
  const relative = path.relative(os.tmpdir(), path.resolve(root));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(root).startsWith("cursor-review-");
}

export function cleanupSnapshotPath(root) {
  if (!isSnapshotPath(root)) {
    return;
  }
  fs.rmSync(root, { recursive: true, force: true });
  if (activeSnapshotRoot === root) {
    activeSnapshotRoot = null;
  }
}

export function trackSnapshot(root) {
  activeSnapshotRoot = root;
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
  const stop = (code) => {
    cleanupTrackedSnapshot();
    process.exit(code);
  };
  process.once("SIGTERM", () => stop(143));
  process.once("SIGINT", () => stop(130));
}

export async function createIsolatedReviewWorkspace(repoRoot, options = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-review-"));
  const tree = path.join(parent, "tree");
  const contextDir = path.join(parent, "context");
  fs.mkdirSync(tree, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  try {
    const head = hasHead(repoRoot);
    if (head) {
      await extractHeadArchive(repoRoot, tree);
    }
    if (options.syncWorkingTree || !head) {
      overlayWorkingTree(repoRoot, tree, {
        maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
        head
      });
    }
  } catch (error) {
    fs.rmSync(parent, { recursive: true, force: true });
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
  let chunks = [];
  if (head && target?.mode === "branch" && target.baseRef) {
    chunks = await streamGitChunks(repoRoot, ["diff", `${target.baseRef}...HEAD`], contextDir, chunkBytes);
  } else if (head) {
    chunks = await streamGitChunks(repoRoot, ["diff", "HEAD"], contextDir, chunkBytes);
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
