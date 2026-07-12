const CODEX_MINIMUM_VERSION = [0, 144, 1];
const CLAUDE_MINIMUM_VERSION = [2, 1, 80];

/** A safe, machine-readable failure returned by a provider UsageReader. */
export class UsageReaderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UsageReaderError";
    this.code = code;
  }
}

/**
 * Reads the two Codex plan usage windows through a short-lived app-server.
 * The caller supplies the selected native or WSL ProcessTransport, which keeps
 * the CLI's existing authentication in its own environment.
 */
export function createCodexUsageReader({ transport, now = () => new Date(), clientInfo = defaultClientInfo() } = {}) {
  assertTransport(transport);

  return Object.freeze({
    async read() {
      const version = await execute("codex", ["--version"], transport, "Codex");
      requireSupportedVersion(version.stdout, CODEX_MINIMUM_VERSION, "Codex");

      const response = await readCodexRateLimits(transport, clientInfo);
      const snapshot = rateLimitSnapshot(response);
      return codexObservations(snapshot, now());
    },
  });
}

/**
 * Reads a sanitized snapshot written by the user's Claude Code status-line
 * collector. The snapshot remains a cache: its captured_at timestamp is kept
 * intact so PluginCore can mark aged data stale rather than inventing usage.
 */
export function createClaudeUsageReader({ transport, snapshotPath, now = () => new Date() } = {}) {
  assertTransport(transport);
  if (typeof snapshotPath !== "string" || snapshotPath.length === 0) {
    throw new Error("Claude UsageReader requires a snapshot path");
  }
  if (typeof transport.readFile !== "function") throw new Error("Claude UsageReader requires a snapshot-capable ProcessTransport");

  return Object.freeze({
    async read() {
      const authentication = await execute("claude", ["auth", "status"], transport, "Claude");
      const authStatus = parseObject(authentication.stdout, "Claude authentication status");
      if (authStatus.loggedIn !== true || authStatus.authMethod !== "claude.ai" || authStatus.apiProvider === "cloud" || authStatus.apiProvider === "apiKey") {
        throw new UsageReaderError("authentication-required", "Claude authentication is required");
      }

      let rawSnapshot;
      try {
        rawSnapshot = await transport.readFile(snapshotPath);
      } catch {
        throw new UsageReaderError("snapshot-unavailable", "Claude usage snapshot is unavailable");
      }
      const snapshot = parseObject(rawSnapshot, "Claude usage snapshot");
      requireSupportedVersion(snapshot.claude_code_version, CLAUDE_MINIMUM_VERSION, "Claude Code");
      const observedAt = dateOrError(snapshot.captured_at, "Claude usage snapshot");

      return [
        claudeObservation("short-term", snapshot.five_hour, observedAt, now()),
        claudeObservation("long-term", snapshot.seven_day, observedAt, now()),
      ].filter(Boolean);
    },
  });
}

function defaultClientInfo() {
  return { name: "stream_deck_ai_stats", title: "Stream Deck AI Stats", version: "0.1.0" };
}

function assertTransport(transport) {
  if (typeof transport?.execute !== "function") throw new Error("UsageReader requires a ProcessTransport");
}

async function execute(executable, args, transport, provider, input) {
  let result;
  try {
    result = await transport.execute({ executable, args, ...(input === undefined ? {} : { input }) });
  } catch (error) {
    const code = error?.name === "ProcessTimeoutError" ? "command-failed" : "command-unavailable";
    throw new UsageReaderError(code, code === "command-failed" ? `${provider} usage command timed out` : `${provider} CLI is unavailable`);
  }
  return successfulResult(result, provider);
}

function successfulResult(result, provider) {
  if (result?.exitCode === 0) return result;
  if (authenticationSignal(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`)) {
    throw new UsageReaderError("authentication-required", `${provider} authentication is required`);
  }
  throw new UsageReaderError("command-failed", `${provider} usage command failed`);
}

async function readCodexRateLimits(transport, clientInfo) {
  const controller = new AbortController();
  let response;
  let resolveResponse;
  const receivedResponse = new Promise((resolve) => { resolveResponse = resolve; });
  let pendingLines = "";
  const onStdout = (chunk) => {
    pendingLines += Buffer.from(chunk).toString("utf8");
    const lines = pendingLines.split(/\r?\n/);
    pendingLines = lines.pop();
    for (const line of lines) {
      const message = parseObject(line, "Codex app-server response");
      if (message.id === 1) {
        response = message;
        resolveResponse();
      }
    }
  };
  const process = transport.execute({
    executable: "codex",
    args: ["app-server"],
    input: appServerRequest(clientInfo),
    signal: controller.signal,
    onStdout,
  });
  const completion = process.then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  const first = await Promise.race([
    receivedResponse.then(() => ({ response })),
    completion,
  ]);
  if (first.response) {
    controller.abort();
    await process.catch(() => undefined);
    return validatedAppServerResponse(first.response);
  }
  if (first.error) {
    const code = first.error?.name === "ProcessTimeoutError" ? "command-failed" : "command-unavailable";
    throw new UsageReaderError(code, code === "command-failed" ? "Codex usage command timed out" : "Codex CLI is unavailable");
  }
  return appServerResponse(successfulResult(first.result, "Codex").stdout);
}

function appServerRequest(clientInfo) {
  return [
    JSON.stringify({ method: "initialize", id: 0, params: { clientInfo } }),
    JSON.stringify({ method: "initialized", params: {} }),
    JSON.stringify({ method: "account/rateLimits/read", id: 1 }),
    "",
  ].join("\n");
}

function appServerResponse(stdout) {
  const lines = String(stdout).split(/\r?\n/).filter(Boolean);
  let response;
  for (const line of lines) {
    const message = parseObject(line, "Codex app-server response");
    if (message.id === 1) response = message;
  }
  if (!response) throw new UsageReaderError("malformed-data", "Codex app-server did not return rate limits");
  return validatedAppServerResponse(response);
}

function validatedAppServerResponse(response) {
  if (response.error) {
    if (authenticationSignal(JSON.stringify(response.error))) {
      throw new UsageReaderError("authentication-required", "Codex authentication is required");
    }
    throw new UsageReaderError("command-failed", "Codex rejected the usage read");
  }
  return response;
}

function rateLimitSnapshot(response) {
  const result = response.result;
  if (!isObject(result)) throw new UsageReaderError("malformed-data", "Codex rate limits were malformed");
  const buckets = result.rateLimitsByLimitId;
  if (isObject(buckets)) {
    const codex = Object.entries(buckets).find(([key, value]) => key === "codex" || value?.limitId === "codex")?.[1];
    if (isObject(codex)) return codex;
  }
  if (isObject(result.rateLimits)) return result.rateLimits;
  throw new UsageReaderError("malformed-data", "Codex rate limits were unavailable");
}

function codexObservations(snapshot, observedAt) {
  return [
    codexObservation("short-term", snapshot.primary, observedAt),
    codexObservation("long-term", snapshot.secondary, observedAt),
  ].filter(Boolean);
}

function codexObservation(windowKind, window, observedAt) {
  if (window === null || window === undefined) return null;
  if (!isObject(window)) throw new UsageReaderError("malformed-data", "Codex usage window was malformed");
  return providerObservation({
    provider: "codex",
    windowKind,
    usageProgress: percentage(window.usedPercent),
    resetAt: unixTimestamp(window.resetsAt),
    observedAt,
    durationMs: minutes(window.windowDurationMins),
  });
}

function claudeObservation(windowKind, window, observedAt, now) {
  if (window === null || window === undefined) return null;
  if (!isObject(window)) throw new UsageReaderError("malformed-data", "Claude usage window was malformed");
  const resetAt = unixTimestamp(window.resets_at);
  return providerObservation({
    provider: "claude",
    windowKind,
    usageProgress: percentage(window.used_percentage),
    resetAt,
    observedAt,
    durationMs: null,
    awaitingFreshObservation: resetAt !== null && now.getTime() >= resetAt.getTime(),
  });
}

function providerObservation({ provider, windowKind, usageProgress, resetAt, observedAt, durationMs, awaitingFreshObservation = false }) {
  return {
    provider,
    windowKind,
    usageProgress,
    resetAt,
    observedAt,
    durationMs,
    ...(awaitingFreshObservation ? { awaitingFreshObservation: true } : {}),
    provenance: "provider-reported",
  };
}

function parseObject(text, source) {
  try {
    const parsed = JSON.parse(text);
    if (isObject(parsed)) return parsed;
  } catch {
    // The caller only receives a safe classification, never raw provider output.
  }
  throw new UsageReaderError("malformed-data", `${source} was malformed`);
}

function requireSupportedVersion(value, minimum, provider) {
  const version = parseVersion(value);
  if (!version || compareVersions(version, minimum) < 0) {
    throw new UsageReaderError("unsupported-version", `${provider} version is unsupported`);
  }
}

function parseVersion(value) {
  const match = String(value ?? "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] - minimum[index];
  }
  return 0;
}

function dateOrError(value, source) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new UsageReaderError("malformed-data", `${source} was malformed`);
  }
  return parsed;
}

function unixTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new UsageReaderError("malformed-data", "Provider usage data was malformed");
  return new Date(value * 1_000);
}

function minutes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new UsageReaderError("malformed-data", "Provider usage data was malformed");
  return value * 60_000;
}

function percentage(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new UsageReaderError("malformed-data", "Provider usage data was malformed");
  }
  return Math.round((value / 100) * 1_000_000) / 1_000_000;
}

function authenticationSignal(value) {
  return /\b(auth(?:entication)?|log[ -]?in|sign[ -]?in|unauthori[sz]ed|forbidden)\b/i.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
