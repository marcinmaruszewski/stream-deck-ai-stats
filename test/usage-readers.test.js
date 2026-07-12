import test from "node:test";
import assert from "node:assert/strict";

import {
  UsageReaderError,
  PluginCore,
  createClaudeUsageReader,
  createCodexUsageReader,
} from "../src/core/index.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");

test("reads Codex primary and secondary rate limits through the app-server protocol", async () => {
  const calls = [];
  const reader = createCodexUsageReader({
    transport: successTransport(calls, [
      { exitCode: 0, stdout: "codex-cli 0.144.1\n", stderr: "" },
      { exitCode: 0, stdout: `${JSON.stringify({ id: 1, result: { rateLimitsByLimitId: { codex: codexLimits() } } })}\n`, stderr: "" },
    ]),
    now: () => NOW,
  });

  assert.deepEqual(await reader.read(), [
    observation("codex", "short-term", 0.25, "2026-07-14T09:46:40.000Z", 300 * 60_000),
    observation("codex", "long-term", 0.42, "2026-07-20T09:46:40.000Z", 10_080 * 60_000),
  ]);
  assert.deepEqual(calls[0], { executable: "codex", args: ["--version"] });
  assert.equal(calls[1].executable, "codex");
  assert.deepEqual(calls[1].args, ["app-server"]);
  assert.match(calls[1].input, /"method":"initialize"/);
  assert.match(calls[1].input, /"method":"account\/rateLimits\/read","id":1/);
});

test("falls back to Codex rateLimits and retains incomplete provider data", async () => {
  const reader = createCodexUsageReader({
    transport: successTransport([], [
      { exitCode: 0, stdout: "0.144.1", stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ id: 1, result: { rateLimits: { primary: { usedPercent: 25 } } } }), stderr: "" },
    ]),
    now: () => NOW,
  });

  assert.deepEqual(await reader.read(), [observation("codex", "short-term", 0.25, null, null)]);
});

test("stops Codex app-server as soon as the rate-limit response arrives", async () => {
  let aborted = false;
  const reader = createCodexUsageReader({
    transport: {
      execute(command) {
        if (command.args[0] === "--version") return Promise.resolve({ exitCode: 0, stdout: "0.144.1", stderr: "" });
        return new Promise((resolve, reject) => {
          command.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Process execution was cancelled", "AbortError"));
          }, { once: true });
          command.onStdout(Buffer.from(`${JSON.stringify({ id: 1, result: { rateLimits: codexLimits() } })}\n`));
        });
      },
    },
    now: () => NOW,
  });

  const observations = await reader.read();

  assert.equal(aborted, true);
  assert.equal(observations.length, 2);
});

test("classifies unsupported, unauthenticated, and malformed Codex responses without exposing output", async () => {
  const unsupported = createCodexUsageReader({
    transport: successTransport([], [{ exitCode: 0, stdout: "codex-cli 0.143.9", stderr: "" }]),
  });
  await assert.rejects(unsupported.read(), errorWithCode("unsupported-version"));

  const unauthenticated = createCodexUsageReader({
    transport: successTransport([], [
      { exitCode: 0, stdout: "0.144.1", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "secret token: please log in" },
    ]),
  });
  await assert.rejects(unauthenticated.read(), errorWithCode("authentication-required", "secret token"));

  const malformed = createCodexUsageReader({
    transport: successTransport([], [
      { exitCode: 0, stdout: "0.144.1", stderr: "" },
      { exitCode: 0, stdout: "not-json", stderr: "" },
    ]),
  });
  await assert.rejects(malformed.read(), errorWithCode("malformed-data"));
});

test("reads and normalizes a Claude status-line snapshot after authentication preflight", async () => {
  const calls = [];
  const reader = createClaudeUsageReader({
    snapshotPath: "/private/claude-usage.json",
    transport: successTransport(calls, [{ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" }], async (path) => {
      assert.equal(path, "/private/claude-usage.json");
      return JSON.stringify({
        captured_at: "2026-07-13T11:57:00.000Z",
        version: "2.1.207",
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1_784_000_000 },
          seven_day: { used_percentage: 41.2, resets_at: 1_784_500_000 },
        },
      });
    }),
  });

  assert.deepEqual(await reader.read(), [
    observation("claude", "short-term", 0.235, "2026-07-14T03:33:20.000Z", null, new Date("2026-07-13T11:57:00.000Z")),
    observation("claude", "long-term", 0.412, "2026-07-19T22:26:40.000Z", null, new Date("2026-07-13T11:57:00.000Z")),
  ]);
  assert.deepEqual(calls, [{ executable: "claude", args: ["auth", "status"] }]);
});

test("rejects Claude authentication, unsupported snapshots, and malformed snapshots without leaking data", async () => {
  const unauthenticated = createClaudeUsageReader({
    transport: successTransport([], [{ exitCode: 0, stdout: JSON.stringify({ loggedIn: false, email: "private@example.com" }), stderr: "" }], async () => "{}"),
    snapshotPath: "/snapshot",
  });
  await assert.rejects(unauthenticated.read(), errorWithCode("authentication-required", "private@example.com"));

  const unsupported = createClaudeUsageReader({
    transport: successTransport([], [{ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" }], async () => JSON.stringify({ captured_at: NOW.toISOString(), claude_code_version: "2.1.79" })),
    snapshotPath: "/snapshot",
  });
  await assert.rejects(unsupported.read(), errorWithCode("unsupported-version"));

  const malformed = createClaudeUsageReader({
    transport: successTransport([], [{ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" }], async () => "contains a private token"),
    snapshotPath: "/snapshot",
  });
  await assert.rejects(malformed.read(), errorWithCode("malformed-data", "private token"));

  const apiKey = createClaudeUsageReader({
    transport: successTransport([], [{ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "apiKey" }), stderr: "" }], async () => "{}"),
    snapshotPath: "/snapshot",
  });
  await assert.rejects(apiKey.read(), errorWithCode("authentication-required"));

  const cloudProvider = createClaudeUsageReader({
    transport: successTransport([], [{ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }), stderr: "" }], async () => "{}"),
    snapshotPath: "/snapshot",
  });
  await assert.rejects(cloudProvider.read(), errorWithCode("authentication-required"));
});

test("preserves an aged Claude snapshot so the core exposes stale usage instead of inventing a reset", async () => {
  const reader = createClaudeUsageReader({
    transport: successTransport([], [{ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" }], async () => JSON.stringify({
      captured_at: "2026-07-13T11:40:00.000Z",
      claude_code_version: "2.1.207",
      five_hour: { used_percentage: 23.5, resets_at: 1_783_900_000 },
    })),
    snapshotPath: "/snapshot",
  });
  const core = new PluginCore({
    providers: [{ id: "claude", usageReader: reader }],
    now: () => NOW,
    freshnessMs: 15 * 60_000,
  });

  await core.refreshProvider("claude");

  assert.equal(core.stateFor("claude").windows[0].quality, "stale");
  assert.equal(core.stateFor("claude").windows[0].forecast.paceStatus, "unknown");
});

test("marks a Claude window awaiting a fresh observation after its reported reset", async () => {
  const reader = createClaudeUsageReader({
    transport: successTransport([], [{ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" }], async () => JSON.stringify({
      captured_at: "2026-07-13T11:59:00.000Z",
      claude_code_version: "2.1.207",
      five_hour: { used_percentage: 23.5, resets_at: 1_783_900_000 },
    })),
    snapshotPath: "/snapshot",
    now: () => NOW,
  });
  const core = new PluginCore({ providers: [{ id: "claude", usageReader: reader }], now: () => NOW });

  await core.refreshProvider("claude");

  assert.equal(core.stateFor("claude").windows[0].awaitingFreshObservation, true);
  assert.equal(core.stateFor("claude").windows[0].quality, "stale");
});

test("rejects invalid non-null provider usage values instead of treating them as missing", async () => {
  const codex = createCodexUsageReader({
    transport: successTransport([], [
      { exitCode: 0, stdout: "0.144.1", stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ id: 1, result: { rateLimits: { primary: { usedPercent: 101 } } } }), stderr: "" },
    ]),
  });
  await assert.rejects(codex.read(), errorWithCode("malformed-data"));
});

test("surfaces safe usage-reader failure codes through plugin state", async () => {
  const core = new PluginCore({
    providers: [{
      id: "codex",
      usageReader: { read: async () => { throw new UsageReaderError("authentication-required", "private provider output"); } },
    }],
  });

  await core.refreshProvider("codex");

  assert.equal(core.stateFor("codex").errorCode, "authentication-required");
  assert.equal(core.stateFor("codex").error, "Provider authentication is required");
});

function codexLimits() {
  return {
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_784_022_400 },
    secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_784_540_800 },
  };
}

function observation(provider, windowKind, usageProgress, resetAt, durationMs, observedAt = NOW) {
  return {
    provider,
    windowKind,
    usageProgress,
    resetAt: resetAt ? new Date(resetAt) : null,
    observedAt,
    durationMs,
    provenance: "provider-reported",
  };
}

function successTransport(calls, responses, readFile) {
  return {
    execute: async (command) => {
      calls.push(command);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected command");
      return response;
    },
    ...(readFile ? { readFile } : {}),
  };
}

function errorWithCode(code, excludedText = "") {
  return (error) => {
    assert.ok(error instanceof UsageReaderError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, new RegExp(excludedText || "(?!x)x"));
    return true;
  };
}
