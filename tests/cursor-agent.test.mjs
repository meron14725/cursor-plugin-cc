import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCursorAgentArgs,
  DEFAULT_MODEL,
  parseCursorAgentOutput,
  parseStructuredOutput,
  resolveReviewModel
} from "../plugins/cursor/scripts/lib/cursor.mjs";

test("review argv is print mode, ask mode, and never force or yolo", () => {
  const args = buildCursorAgentArgs({
    workspace: "/repo",
    model: "composer-2.5",
    prompt: "review this"
  });

  assert.equal(args.includes("-p") || args.includes("--print"), true);
  assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "ask"]);
  assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2), [
    "--output-format",
    "stream-json"
  ]);
  assert.deepEqual(args.slice(args.indexOf("--workspace"), args.indexOf("--workspace") + 2), ["--workspace", "/repo"]);
  assert.ok(args.includes("--trust"));
  assert.equal(args.at(-1), "review this");
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--yolo"), false);
  assert.equal(args.includes("--api-key"), false);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "composer-2.5"]);
});

test("model falls back to the account default instead of a hardcoded id", () => {
  assert.equal(DEFAULT_MODEL, null);
  assert.equal(resolveReviewModel(undefined, {}), null);
  assert.equal(resolveReviewModel("  gpt-5  ", { CURSOR_AGENT_MODEL: "composer-2.5" }), "gpt-5");
  assert.equal(resolveReviewModel(undefined, { CURSOR_AGENT_MODEL: " composer-2.5 " }), "composer-2.5");

  const args = buildCursorAgentArgs({ workspace: "/repo", model: null, prompt: "review" });
  assert.equal(args.includes("--model"), false);
  assert.equal(args.includes("--force"), false);
});

test("resume is passed by chat id and secrets are not argv", () => {
  const args = buildCursorAgentArgs({
    workspace: "/repo",
    model: null,
    resume: "chat-123",
    prompt: "continue"
  });

  assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "chat-123"]);
  assert.equal(args.includes("--api-key"), false);
});

test("parseCursorAgentOutput reads the json result and flags write tools", () => {
  const parsed = parseCursorAgentOutput(
    [
      JSON.stringify({ type: "system", subtype: "init", session_id: "chat-1", model: "Composer 2.5" }),
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        tool_call: { readToolCall: { args: { path: "README.md" } } }
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "{\"verdict\":\"approve\"}",
        session_id: "chat-1"
      })
    ].join("\n")
  );

  assert.equal(parsed.sessionId, "chat-1");
  assert.equal(parsed.model, "Composer 2.5");
  assert.equal(parsed.text, "{\"verdict\":\"approve\"}");
  assert.equal(parsed.wroteFiles, false);
  assert.deepEqual(parsed.progress, ["Reading README.md"]);

  const wrote = parseCursorAgentOutput(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { writeToolCall: { args: { path: "src/app.js" } } },
      session_id: "chat-2"
    })
  );
  assert.equal(wrote.wroteFiles, true);
});

test("shell, MCP, task, and completed write tool calls are blocked; reads are not", () => {
  const shell = parseCursorAgentOutput(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { shellToolCall: { args: { command: "git diff" } } }
    })
  );
  assert.equal(shell.blocked, true);
  assert.match(shell.blockedTool, /shell/i);

  const completedWrite = parseCursorAgentOutput(
    JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      tool_call: { writeToolCall: { args: { path: "src/app.js" }, result: { success: {} } } }
    })
  );
  assert.equal(completedWrite.blocked, true);

  const mcp = parseCursorAgentOutput(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { function: { name: "Task", arguments: "{}" } }
    })
  );
  assert.equal(mcp.blocked, true);

  const read = parseCursorAgentOutput(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { readToolCall: { args: { path: "README.md" } } }
    })
  );
  assert.equal(read.blocked, false);
  assert.deepEqual(read.progress, ["Reading README.md"]);
});

test("parseStructuredOutput accepts raw JSON and fenced JSON", () => {
  const raw = parseStructuredOutput('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}');
  assert.equal(raw.parsed.verdict, "approve");
  assert.equal(raw.parseError, null);

  const fenced = parseStructuredOutput('```json\n{"verdict":"needs-attention","summary":"x","findings":[],"next_steps":[]}\n```');
  assert.equal(fenced.parsed.verdict, "needs-attention");

  const missing = parseStructuredOutput("", { failureMessage: "model failed" });
  assert.equal(missing.parsed, null);
  assert.equal(missing.parseError, "model failed");

  const prose = parseStructuredOutput(
    'Note {not json}\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}'
  );
  assert.equal(prose.parsed.verdict, "approve");
  assert.equal(prose.parseError, null);
});
