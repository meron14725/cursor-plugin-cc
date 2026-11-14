import fs from "node:fs";
import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

export function installFakeCursorAgent(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-cursor-agent-state.json");
  const scriptPath = path.join(binDir, "cursor-agent");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { nextSession: 1, invocations: [], lastArgs: null, lastPrompt: null };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function record(kind) {
  const state = loadState();
  const args = process.argv.slice(2);
  state.invocations.push({ kind, args });
  if (kind === "prompt") {
    state.lastArgs = args;
    state.lastPrompt = args[args.length - 1] ?? "";
    const workspaceIndex = args.indexOf("--workspace");
    const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : process.cwd();
    state.workspace = workspace;
    const contextDir = path.join(path.dirname(workspace), "context");
    if (fs.existsSync(contextDir)) {
      state.contextFile = fs
        .readdirSync(contextDir)
        .sort()
        .map((name) => fs.readFileSync(path.join(contextDir, name), "utf8"))
        .join("\\n");
    }
  }
  saveState(state);
  return state;
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function reviewBody() {
  if (BEHAVIOR === "findings") {
    return JSON.stringify({
      verdict: "needs-attention",
      summary: "Empty-state access can throw.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "items[0] is used without a length check.",
          file: "src/app.js",
          line_start: 1,
          line_end: 1,
          confidence: 0.8,
          recommendation: "Guard the empty array."
        }
      ],
      next_steps: ["Add a guard."]
    });
  }

  const prompt = String(process.argv[process.argv.length - 1] ?? "");
  const summary = prompt.includes("against main")
    ? "Reviewed changes against main. No material issues found."
    : "Reviewed uncommitted changes. No material issues found.";
  return JSON.stringify({
    verdict: "approve",
    summary,
    findings: [],
    next_steps: []
  });
}

const args = process.argv.slice(2);
if (args[0] === "--version" || (args.includes("--version") && !args.includes("-p") && !args.includes("--print"))) {
  record("version");
  process.stdout.write("cursor-agent 2026.11.13-test\\n");
  process.exit(0);
}

if (args[0] === "status" || args[0] === "whoami") {
  record("status");
  if (BEHAVIOR === "logged-out") {
    process.stdout.write(JSON.stringify({ status: "unauthenticated", isAuthenticated: false }) + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    status: "authenticated",
    isAuthenticated: true,
    hasAccessToken: true,
    userInfo: { email: "test@example.com" }
  }) + "\\n");
  process.exit(0);
}

const state = record("prompt");
const sessionId = "chat-" + state.nextSession++;
saveState(state);

if (BEHAVIOR === "fail") {
  process.stderr.write("authentication expired; run cursor-agent login\\n");
  process.exit(1);
}

emit({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model: "Composer 2.5",
  cwd: process.cwd()
});

if (BEHAVIOR === "write-attempt") {
  emit({
    type: "tool_call",
    subtype: "started",
    session_id: sessionId,
    tool_call: { writeToolCall: { args: { path: "src/app.js", fileText: "hacked" } } }
  });
}

if (BEHAVIOR === "write-completed") {
  emit({
    type: "tool_call",
    subtype: "completed",
    session_id: sessionId,
    tool_call: { writeToolCall: { args: { path: "src/app.js", fileText: "hacked" }, result: { success: {} } } }
  });
}

if (BEHAVIOR === "shell-attempt") {
  emit({
    type: "tool_call",
    subtype: "started",
    session_id: sessionId,
    tool_call: { shellToolCall: { args: { command: "touch hacked.txt" } } }
  });
}

if (BEHAVIOR === "progress-then-sleep") {
  emit({
    type: "tool_call",
    subtype: "started",
    session_id: sessionId,
    tool_call: { readToolCall: { args: { path: "README.md" } } }
  });
  setInterval(() => {}, 1000);
} else if (BEHAVIOR === "sleep") {
  setInterval(() => {}, 1000);
} else {
  emit({
    type: "tool_call",
    subtype: "started",
    session_id: sessionId,
    tool_call: { readToolCall: { args: { path: "README.md" } } }
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: reviewBody(),
    session_id: sessionId
  });
}
`;
  writeExecutable(scriptPath, source);
  return statePath;
}

export function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-cursor-agent-state.json"), "utf8"));
}

export function buildEnv(binDir, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
  };
  delete env.CURSOR_AGENT_MODEL;
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_AGENT_BIN;
  delete env.CURSOR_COMPANION_SESSION_ID;
  delete env.CLAUDE_PLUGIN_DATA;
  return { ...env, ...extra };
}
