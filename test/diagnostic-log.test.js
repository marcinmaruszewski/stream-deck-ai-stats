import assert from "node:assert/strict";
import test from "node:test";

import { createDiagnosticLogger } from "../src/stream-deck/diagnostic-log.js";

test("writes a safe diagnostic entry without command output or credentials", async () => {
  const lines = [];
  const logger = createDiagnosticLogger({
    append: async (line) => lines.push(line),
    now: () => new Date("2026-07-13T22:30:00.000Z"),
  });

  await logger.record("provider-state", {
    provider: "codex",
    operationalState: "error",
    errorCode: "command-unavailable",
    transportMode: "wsl",
    hasWslDistribution: true,
    commandOutput: "do-not-log-this",
    accessToken: "do-not-log-this-either",
  });

  assert.deepEqual(JSON.parse(lines[0]), {
    at: "2026-07-13T22:30:00.000Z",
    event: "provider-state",
    provider: "codex",
    operationalState: "error",
    errorCode: "command-unavailable",
    transportMode: "wsl",
    hasWslDistribution: true,
  });
});

test("does not let an unavailable log file disrupt the plugin", async () => {
  const logger = createDiagnosticLogger({ append: async () => { throw new Error("log directory unavailable"); } });

  await assert.doesNotReject(logger.record("plugin-connected"));
});
