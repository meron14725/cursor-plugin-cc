import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCursorAgent, readFakeState } from "./fake-cursor-agent-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/cursor/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "cursor");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "cursor-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

function prepareRepo(mutate) {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  if (mutate) {
    mutate(repo);
  } else {
    fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  }
  return repo;
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function assertAskMode(args) {
  assert.equal(args.includes("-p") || args.includes("--print"), true);
  assert.equal(args[args.indexOf("--mode") + 1], "ask");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args.includes("--trust"), true);
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--yolo"), false);
  assert.equal(args.includes("--api-key"), false);
}

test("setup reports ready when fake cursor-agent is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.cursorAgent.available, true);
  assert.match(payload.cursorAgent.detail, /2026\.11\.13-test/);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.source, "cursor-agent status");
  assert.match(payload.auth.detail, /test@example\.com/);
  assert.match(payload.nextSteps.join("\n"), /\/cursor:review/);
});

test("setup explains how to install cursor-agent when it is missing", () => {
  const binDir = makeTempDir();
  const missing = path.join(binDir, "missing-cursor-agent");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir, { CURSOR_AGENT_BIN: missing })
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.cursorAgent.available, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.match(payload.nextSteps.join("\n"), /curl https:\/\/cursor\.com\/install -fsS \| bash/);
  assert.doesNotMatch(result.stdout, /CURSOR_API_KEY=/);
});

test("setup tells the user to log in when cursor-agent is logged out", () => {
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "logged-out");

  const result = run("node", [SCRIPT, "setup"], {
    cwd: ROOT,
    env: buildEnv(binDir, { CURSOR_API_KEY: "super-secret-key" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /needs attention/);
  assert.match(result.stdout, /Not logged in/);
  assert.match(result.stdout, /cursor-agent login/);
  assert.match(result.stdout, /CURSOR_API_KEY/);
  assert.doesNotMatch(result.stdout, /super-secret-key/);
  assert.doesNotMatch(result.stderr, /super-secret-key/);
});

test("review renders a no-findings result and stays in ask mode", () => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir, { CURSOR_API_KEY: "super-secret-key" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Cursor Review/);
  assert.match(result.stdout, /working tree diff/);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material issues found/);
  assert.match(result.stdout, /No material findings/);
  assert.doesNotMatch(result.stdout, /super-secret-key/);

  const state = readFakeState(binDir);
  assertAskMode(state.lastArgs);
  assert.equal(state.lastArgs.includes("--model"), false);
  assert.equal(state.lastArgs.includes("super-secret-key"), false);
  assert.match(state.lastPrompt, /Do not edit files/);
  assert.match(state.lastPrompt, /"verdict"/);
  assert.doesNotMatch(state.lastPrompt, /You are Codex/);
});

test("review passes --model and CURSOR_AGENT_MODEL without putting secrets in argv", () => {
  const repo = prepareRepo();
  const flagged = makeTempDir();
  installFakeCursorAgent(flagged);
  const flaggedRun = run("node", [SCRIPT, "review", "--model", "gpt-5"], {
    cwd: repo,
    env: buildEnv(flagged, { CURSOR_AGENT_MODEL: "composer-2.5" })
  });
  assert.equal(flaggedRun.status, 0, flaggedRun.stderr);
  assert.equal(readFakeState(flagged).lastArgs[readFakeState(flagged).lastArgs.indexOf("--model") + 1], "gpt-5");

  const fromEnv = makeTempDir();
  installFakeCursorAgent(fromEnv);
  const envRun = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(fromEnv, { CURSOR_AGENT_MODEL: "composer-2.5" })
  });
  assert.equal(envRun.status, 0, envRun.stderr);
  const args = readFakeState(fromEnv).lastArgs;
  assert.equal(args[args.indexOf("--model") + 1], "composer-2.5");
});

test("review accepts the quoted raw argument style for base-branch review", () => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /branch diff against main/);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("review resumes a cursor chat by id", () => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "review", "--resume", "chat-existing"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const args = readFakeState(binDir).lastArgs;
  assert.equal(args[args.indexOf("--resume") + 1], "chat-existing");
  assertAskMode(args);
});

test("review rejects focus text and staged scope", () => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);
  const env = buildEnv(binDir);

  const focus = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env
  });
  assert.equal(focus.status > 0, true);
  assert.match(focus.stderr, /does not support custom focus text/i);
  assert.match(focus.stderr, /\/cursor:adversarial-review focus on auth/);

  const staged = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env
  });
  assert.equal(staged.status > 0, true);
  assert.match(staged.stderr, /Unsupported review scope "staged"/);
});

test("adversarial review renders structured findings and rejects staged scope", () => {
  const repo = prepareRepo((dir) => {
    fs.writeFileSync(path.join(dir, "src", "app.js"), "export const value = items[0].id;\n");
  });
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "findings");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Cursor Adversarial Review/);
  assert.match(result.stdout, /branch diff against main/);
  assert.match(result.stdout, /Missing empty-state guard/);
  assert.match(result.stdout, /src\/app\.js:1/);
  const prompt = readFakeState(binDir).lastPrompt;
  assert.match(prompt, /You are Cursor performing an adversarial software review/);
  assert.doesNotMatch(prompt, /You are Codex/);
  assertAskMode(readFakeState(binDir).lastArgs);

  const staged = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(staged.status > 0, true);
  assert.match(staged.stderr, /Unsupported review scope "staged"/);
});

test("adversarial review asks Cursor to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "findings");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.match(state.lastPrompt, /lightweight summary/i);
  assert.match(state.lastPrompt, /plugin-generated/i);
  assert.match(state.lastPrompt, /Do not run shell, git/i);
  assert.doesNotMatch(state.lastPrompt, /git commands/i);
  assert.doesNotMatch(state.lastPrompt, /PROMPT_SELF_COLLECT_[ABC]/);
  assert.match(state.contextFile, /PROMPT_SELF_COLLECT_A/);
  assert.match(state.contextFile, /PROMPT_SELF_COLLECT_B/);
  assert.match(state.contextFile, /PROMPT_SELF_COLLECT_C/);
  assert.notEqual(path.resolve(state.workspace), path.resolve(repo));
});

test("review fails when cursor-agent tries to write a file", () => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "write-attempt");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /must not edit files/);
  assert.match(result.stdout, /writeToolCall/);
  assert.equal(fs.readFileSync(path.join(repo, "src", "app.js"), "utf8").includes("hacked"), false);
  const workspace = readFakeState(binDir).workspace;
  assert.notEqual(path.resolve(workspace), path.resolve(repo));
  assert.match(workspace, /cursor-review-/);
  const worktrees = run("git", ["worktree", "list"], { cwd: repo });
  assert.doesNotMatch(worktrees.stdout, /cursor-review-/);
});

test("review fails when cursor-agent runs a shell or a completed write", () => {
  const repo = prepareRepo();
  const shellBin = makeTempDir();
  installFakeCursorAgent(shellBin, "shell-attempt");
  const shell = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(shellBin) });
  assert.notEqual(shell.status, 0);
  assert.match(shell.stdout, /shellToolCall/);
  assert.match(shell.stdout, /must not edit files/);
  assert.equal(fs.existsSync(path.join(repo, "hacked.txt")), false);

  const writeBin = makeTempDir();
  installFakeCursorAgent(writeBin, "write-completed");
  const completed = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(writeBin) });
  assert.notEqual(completed.status, 0);
  assert.match(completed.stdout, /writeToolCall/);
});

test("review surfaces cursor-agent failures", () => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "fail");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /authentication expired; run cursor-agent login/);
});

test("review --background still records a finished tracked job", () => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const payload = JSON.parse(launched.stdout);
  assert.equal(payload.review, "Review");
  assert.match(payload.cursor.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Cursor Status/);
  assert.match(status.stdout, /Cursor Review/);
  assert.match(status.stdout, /completed/);

  const stored = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(stored.stdout, /# Cursor Review/);
  assert.match(stored.stdout, /Cursor session ID: chat-/);
  assert.match(stored.stdout, /Resume in Cursor: cursor-agent --resume chat-/);
});

test("status shows the running job, progress, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Cursor Review.",
      "[2026-03-18T15:30:01.000Z] Cursor review running in ask mode.",
      "[2026-03-18T15:30:02.000Z] Reading README.md"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {},
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Cursor Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "chat-live",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Cursor Review",
            jobClass: "review",
            kindLabel: "review",
            threadId: "chat-done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], { cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Cursor Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \|/);
  assert.match(result.stdout, /`\/cursor:status review-live`/);
  assert.match(result.stdout, /`\/cursor:cancel review-live`/);
  assert.match(result.stdout, /Cursor session ID: chat-live/);
  assert.match(result.stdout, /Resume in Cursor: cursor-agent --resume chat-live/);
  assert.match(result.stdout, /Reading README.md/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /chat-done/);
});

test("status and result without a job id stay inside the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: {},
      jobs: [
        {
          id: "review-current",
          status: "completed",
          title: "Cursor Review",
          jobClass: "review",
          kindLabel: "review",
          sessionId: "sess-current",
          summary: "current session",
          updatedAt: "2026-03-18T15:20:00.000Z"
        },
        {
          id: "review-other",
          status: "completed",
          title: "Cursor Review",
          jobClass: "review",
          kindLabel: "review",
          sessionId: "sess-other",
          summary: "other session",
          updatedAt: "2026-03-18T15:30:00.000Z"
        }
      ]
    })}\n`,
    "utf8"
  );

  const env = { ...process.env, CURSOR_COMPANION_SESSION_ID: "sess-current" };
  const status = run("node", [SCRIPT, "status"], { cwd: workspace, env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /review-current/);
  assert.doesNotMatch(status.stdout, /review-other/);

  const result = run("node", [SCRIPT, "result"], { cwd: workspace, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /current session/);
  assert.doesNotMatch(result.stdout, /other session/);
});

test("status shows a tool line while the review is still running", { timeout: 15000 }, async (t) => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "progress-then-sleep");
  const child = spawn(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir),
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // The process already exited.
      }
    }
  });

  const running = await waitFor(() => {
    const status = run("node", [SCRIPT, "status", "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (status.status !== 0) {
      return null;
    }
    const payload = JSON.parse(status.stdout);
    const job = payload.running?.[0];
    if (!job) {
      return null;
    }
    return job.progressPreview?.some((line) => line.includes("Reading README.md")) ? job : null;
  });

  assert.equal(running.status, "running");
  assert.match(running.progressPreview.join("\n"), /Reading README.md/);

  const single = run("node", [SCRIPT, "status", running.id], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(single.status, 0, single.stderr);
  assert.match(single.stdout, /Reading README.md/);

  const cancel = run("node", [SCRIPT, "cancel", running.id], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(cancel.status, 0, cancel.stderr);
});

test("cancel removes the review snapshot", { timeout: 15000 }, async (t) => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "sleep");
  const child = spawn(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir),
    detached: false,
    stdio: "ignore"
  });
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // Cancel already stopped it.
    }
  });

  const running = await waitFor(() => {
    const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env: buildEnv(binDir) });
    if (status.status !== 0) {
      return null;
    }
    const job = JSON.parse(status.stdout).running?.find((entry) => entry.snapshotPath);
    return job ?? null;
  });
  assert.equal(fs.existsSync(running.snapshotPath), true);

  const cancel = run("node", [SCRIPT, "cancel", running.id], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(fs.existsSync(running.snapshotPath), false);
});

test("SIGTERM removes the review snapshot", { timeout: 15000 }, async (t) => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "sleep");
  const child = spawn(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir),
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  const running = await waitFor(() => {
    const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env: buildEnv(binDir) });
    if (status.status !== 0) {
      return null;
    }
    const job = JSON.parse(status.stdout).running?.find((entry) => entry.snapshotPath && entry.agentPid);
    return job ?? null;
  });
  assert.equal(fs.existsSync(running.snapshotPath), true);
  process.kill(child.pid, "SIGTERM");
  await waitFor(() => fs.existsSync(running.snapshotPath) === false);
  try {
    process.kill(running.agentPid, "SIGKILL");
  } catch {
    // The agent exited with the review.
  }
});

test("cancel stops a review whose companion is not a process-group leader", { timeout: 15000 }, async (t) => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "sleep");
  const child = spawn(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir),
    detached: false,
    stdio: "ignore"
  });
  t.after(() => {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // The cancel command already stopped it.
    }
  });

  const running = await waitFor(() => {
    const status = run("node", [SCRIPT, "status", "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (status.status !== 0) {
      return null;
    }
    const payload = JSON.parse(status.stdout);
    const job = payload.running?.find((entry) => Number.isInteger(entry.agentPid) && entry.agentPid > 0);
    return job ? { job } : null;
  });

  const cancel = run("node", [SCRIPT, "cancel", running.job.id, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(child.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  const stored = state.jobs.find((job) => job.id === running.job.id);
  assert.equal(stored.status, "cancelled");
  assert.notEqual(stored.phase, "failed");
});

test("cancel stops a running cursor-agent review", { timeout: 15000 }, async (t) => {
  const repo = prepareRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "sleep");
  const child = spawn(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir),
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // The cancel command already stopped it.
      }
    }
  });

  const running = await waitFor(() => {
    const status = run("node", [SCRIPT, "status", "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (status.status !== 0) {
      return null;
    }
    const payload = JSON.parse(status.stdout);
    const job = payload.running?.find((entry) => Number.isInteger(entry.agentPid) && entry.agentPid > 0);
    return job ? { payload, job } : null;
  });

  const cancel = run("node", [SCRIPT, "cancel", running.job.id, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(running.job.agentPid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs.find((job) => job.id === running.job.id).status, "cancelled");
});

test("cancel without a job id ignores other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: {},
      jobs: [
        {
          id: "review-other",
          status: "running",
          title: "Cursor Review",
          sessionId: "sess-other",
          summary: "other",
          updatedAt: "2026-03-18T15:30:00.000Z"
        }
      ]
    })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "cancel"], {
    cwd: workspace,
    env: { ...process.env, CURSOR_COMPANION_SESSION_ID: "sess-current" }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No active Cursor jobs to cancel for this session/);

  const targeted = run("node", [SCRIPT, "cancel", "review-other"], {
    cwd: workspace,
    env: { ...process.env, CURSOR_COMPANION_SESSION_ID: "sess-current" }
  });
  assert.equal(targeted.status, 0, targeted.stderr);
  assert.match(targeted.stdout, /Cancelled review-other/);
});

test("session start exports the Claude session id and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CURSOR_COMPANION_SESSION_ID='sess-current'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("session end cleans up jobs for the ending session", async (t) => {
  const repo = prepareRepo();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const keptLog = path.join(jobsDir, "review-other.log");
  const keptJob = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(keptLog, "other\n", "utf8");
  fs.writeFileSync(keptJob, JSON.stringify({ id: "review-other" }), "utf8");
  fs.writeFileSync(path.join(jobsDir, "review-current.log"), "current\n", "utf8");
  fs.writeFileSync(path.join(jobsDir, "review-current.json"), JSON.stringify({ id: "review-current" }), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Already stopped.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: {},
      jobs: [
        {
          id: "review-current",
          status: "running",
          sessionId: "sess-current",
          pid: sleeper.pid,
          logFile: path.join(jobsDir, "review-current.log"),
          updatedAt: "2026-03-18T15:30:00.000Z"
        },
        {
          id: "review-other",
          status: "completed",
          sessionId: "sess-other",
          logFile: keptLog,
          updatedAt: "2026-03-18T15:31:00.000Z"
        }
      ]
    })}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: { ...process.env, CURSOR_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(keptLog), true);
  assert.equal(fs.existsSync(keptJob), true);
  assert.equal(fs.existsSync(path.join(jobsDir, "review-current.json")), false);
  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
});
