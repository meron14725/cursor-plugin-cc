import { spawn } from "node:child_process";

import { registerAgent, unregisterAgent } from "./review-workspace.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";

export const CURSOR_AGENT_BIN = "cursor-agent";
export const CURSOR_AGENT_BIN_ENV = "CURSOR_AGENT_BIN";
export const MODEL_ENV = "CURSOR_AGENT_MODEL";

// Null means "do not pass --model". Cursor CLI then uses the model selected
// for the logged-in account. Model ids differ by plan, so a hardcoded id is
// not a safe default. Override per call with --model or CURSOR_AGENT_MODEL.
export const DEFAULT_MODEL = null;

const INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";

export function resolveCursorAgentBin(env = process.env) {
  const override = String(env?.[CURSOR_AGENT_BIN_ENV] ?? "").trim();
  return override || CURSOR_AGENT_BIN;
}

export function resolveReviewModel(explicit, env = process.env) {
  const fromFlag = explicit == null ? "" : String(explicit).trim();
  if (fromFlag) {
    return fromFlag;
  }
  const fromEnv = String(env?.[MODEL_ENV] ?? "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_MODEL;
}

export function buildCursorAgentArgs({ workspace, model = null, resume = null, prompt, mode = "ask" } = {}) {
  if (mode !== "ask") {
    throw new Error("Reviews must run in ask mode so cursor-agent cannot edit files.");
  }
  if (!workspace) {
    throw new Error("A workspace directory is required.");
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("Review prompt is empty.");
  }

  const args = ["-p", "--output-format", "stream-json", "--mode", "ask", "--trust", "--workspace", workspace];
  if (model) {
    args.push("--model", model);
  }
  if (resume) {
    args.push("--resume", String(resume));
  }
  args.push(prompt);
  return args;
}

const FORBIDDEN_TOOL = /write|edit|delete|replace|applypatch|shell|bash|terminal|mcp|task|exec|command/;
const READ_ONLY_TOOL = /^(read|grep|glob|rg|list|search|semsearch|semanticsearch|codebasesearch|ripgrep)/;

export function classifyToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== "object") {
    return { allowed: false, name: null };
  }
  const names = [];
  if (typeof toolCall.function?.name === "string" && toolCall.function.name.trim()) {
    names.push(toolCall.function.name.trim());
  }
  for (const key of Object.keys(toolCall)) {
    if (key !== "function") {
      names.push(key);
    }
  }
  if (names.length === 0) {
    return { allowed: false, name: null };
  }
  const name = names[0];
  const normalized = name.replace(/[^a-z]/gi, "").toLowerCase();
  if (FORBIDDEN_TOOL.test(normalized) || !READ_ONLY_TOOL.test(normalized)) {
    return { allowed: false, name };
  }
  return { allowed: true, name };
}

function toolLabel(toolCall) {
  const readPath = toolCall?.readToolCall?.args?.path;
  if (readPath) {
    return `Reading ${readPath}`;
  }
  const writePath = toolCall?.writeToolCall?.args?.path;
  if (writePath) {
    return `Attempted write: ${writePath}`;
  }
  const name = toolCall?.function?.name;
  if (name) {
    return `Running tool: ${name}`;
  }
  const key = toolCall && typeof toolCall === "object" ? Object.keys(toolCall)[0] : null;
  return key ? `Running tool: ${key}` : null;
}

export function parseCursorAgentOutput(stdout) {
  const events = [];
  const text = String(stdout ?? "");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON lines are ignored. Failure text belongs on stderr.
    }
  }

  let sessionId = null;
  let model = null;
  let resultText = "";
  let sawResult = false;
  let failed = false;
  const progress = [];
  let wroteFiles = false;
  let blocked = false;
  let blockedTool = null;

  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    if (typeof event.session_id === "string" && event.session_id) {
      sessionId = event.session_id;
    }
    if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
      model = event.model;
    }
    if (event.type === "tool_call") {
      const classification = classifyToolCall(event.tool_call);
      if (!classification.allowed) {
        blocked = true;
        blockedTool = blockedTool ?? classification.name;
        wroteFiles = true;
        if (event.subtype !== "completed") {
          progress.push(`Blocked tool: ${classification.name ?? "unknown"}`);
        }
      } else if (event.subtype !== "completed") {
        const label = toolLabel(event.tool_call);
        if (label) {
          progress.push(label);
        }
      }
    }
    if (event.type === "result" || (sawResult === false && typeof event.result === "string" && event.session_id)) {
      if (typeof event.result === "string") {
        resultText = event.result;
        sawResult = true;
      }
      if (event.is_error === true || (event.subtype && event.subtype !== "success")) {
        failed = true;
      }
    }
  }

  return {
    sessionId,
    model,
    text: resultText,
    wroteFiles,
    blocked,
    blockedTool,
    failed,
    progress
  };
}

function jsonObjectSlices(text) {
  const slices = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        slices.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return slices;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  const raw = String(rawOutput ?? "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Cursor did not return a final structured message.",
      rawOutput: raw,
      ...fallback
    };
  }

  const candidates = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }
  candidates.push(...jsonObjectSlices(trimmed));
  candidates.push(trimmed);

  let lastError = null;
  let lastObject = null;
  let lastReview = null;
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      lastObject = parsed;
      if (typeof parsed.verdict === "string" && parsed.verdict.trim()) {
        lastReview = parsed;
      }
    } catch (error) {
      lastError = error;
    }
  }

  const parsed = lastReview ?? lastObject;
  if (parsed) {
    return {
      parsed,
      parseError: null,
      rawOutput: raw,
      ...fallback
    };
  }

  return {
    parsed: null,
    parseError: lastError instanceof Error ? lastError.message : "Invalid JSON.",
    rawOutput: raw,
    ...fallback
  };
}

export function getCursorAgentAvailability(cwd, env = process.env) {
  return binaryAvailable(resolveCursorAgentBin(env), ["--version"], { cwd, env });
}

function parseStatusPayload(stdout) {
  const text = String(stdout ?? "").trim();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      const line = text.split(/\r?\n/).find((entry) => entry.trim().startsWith("{"));
      if (line) {
        try {
          payload = JSON.parse(line);
        } catch {
          payload = null;
        }
      }
    }
  }

  if (payload && typeof payload === "object") {
    const loggedIn = payload.isAuthenticated === true || payload.status === "authenticated";
    const email = typeof payload.userInfo?.email === "string" ? payload.userInfo.email : "";
    return {
      loggedIn,
      detail: loggedIn ? (email ? `Authenticated (${email}).` : "Authenticated.") : "Not logged in."
    };
  }

  if (/not logged in|not authenticated|logged out|unauthenticated/i.test(text)) {
    return { loggedIn: false, detail: "Not logged in." };
  }
  if (/\bauthenticated\b|\blogged in\b/i.test(text)) {
    return { loggedIn: true, detail: "Authenticated." };
  }
  return { loggedIn: false, detail: "Not logged in." };
}

export function getCursorAuthStatus(cwd, env = process.env) {
  const availability = getCursorAgentAvailability(cwd, env);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: "cursor-agent is not on PATH.",
      source: "availability"
    };
  }

  const result = runCommand(resolveCursorAgentBin(env), ["status", "--format", "json"], { cwd, env });
  const parsed = parseStatusPayload(result.stdout);
  return {
    available: true,
    loggedIn: parsed.loggedIn,
    detail: parsed.detail,
    source: "cursor-agent status"
  };
}

export function cursorAgentInstallGuidance() {
  return `Install Cursor CLI with \`${INSTALL_COMMAND}\`, then make sure \`~/.local/bin\` is on PATH.`;
}

export function runCursorAgent(cwd, options = {}) {
  const env = options.env ?? process.env;
  const model = Object.prototype.hasOwnProperty.call(options, "model") ? options.model : resolveReviewModel(null, env);
  const bin = resolveCursorAgentBin(env);
  const args = buildCursorAgentArgs({
    workspace: options.workspace ?? cwd,
    model,
    resume: options.resume ?? null,
    prompt: options.prompt,
    mode: "ask"
  });

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    registerAgent(child.pid);
    options.onProgress?.({
      message: "Cursor review running in ask mode.",
      phase: "reviewing",
      agentPid: Number.isInteger(child.pid) ? child.pid : null
    });

    let stdout = "";
    let stderr = "";
    let killedForWrite = false;
    let emittedProgress = 0;
    const abortAgent = () => {
      const signalGroup = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The process may already have exited, or it may not be a group leader.
        }
        try {
          process.kill(child.pid, signal);
        } catch {
          // Already exited.
        }
      };
      signalGroup("SIGTERM");
      const timer = setTimeout(() => signalGroup("SIGKILL"), 200);
      timer.unref?.();
      child.once("close", () => clearTimeout(timer));
    };
    const consumeStdout = () => {
      const parsed = parseCursorAgentOutput(stdout);
      const fresh = parsed.progress.slice(emittedProgress);
      emittedProgress = parsed.progress.length;
      for (const line of fresh) {
        options.onProgress?.({
          message: line,
          phase: "reviewing",
          threadId: parsed.sessionId
        });
      }
      if (parsed.blocked && !killedForWrite) {
        killedForWrite = true;
        abortAgent();
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      consumeStdout();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (error?.code === "ENOENT") {
        reject(new Error(`cursor-agent is not on PATH. ${cursorAgentInstallGuidance()}`));
        return;
      }
      if (error?.code === "E2BIG") {
        reject(new Error("The review prompt is too large to pass to cursor-agent. Narrow the diff with --base or review a smaller change."));
        return;
      }
      reject(error);
    });
    child.on("close", (code, signal) => {
      unregisterAgent(child.pid);
      const parsed = parseCursorAgentOutput(stdout);
      const fresh = parsed.progress.slice(emittedProgress);
      for (const line of fresh) {
        options.onProgress?.({
          message: line,
          phase: "reviewing",
          threadId: parsed.sessionId
        });
      }
      if (parsed.sessionId) {
        options.onProgress?.({
          message: `Cursor session ${parsed.sessionId}.`,
          phase: "finalizing",
          threadId: parsed.sessionId
        });
      }

      let status = code ?? (signal ? 1 : 0);
      let errorMessage = "";
      if (parsed.blocked || parsed.wroteFiles) {
        status = 1;
        const tool = parsed.blockedTool ? ` (${parsed.blockedTool})` : "";
        errorMessage = `Review aborted because cursor-agent attempted a tool that can change the workspace${tool}. Reviews must not edit files or run shell, MCP, or task tools.`;
      } else if (parsed.failed && status === 0) {
        status = 1;
        errorMessage = stderr.trim() || "cursor-agent reported an error.";
      } else if (status !== 0) {
        errorMessage = stderr.trim() || (signal ? `signal ${signal}` : `cursor-agent exited ${status}`);
      }

      resolve({
        status,
        text: parsed.text,
        stderr,
        sessionId: parsed.sessionId,
        model: parsed.model,
        wroteFiles: parsed.wroteFiles,
        errorMessage
      });
    });
  });
}
