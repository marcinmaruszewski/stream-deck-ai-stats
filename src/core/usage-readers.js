import { readFile as readSnapshot } from "node:fs/promises";

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

      const result = await execute("codex", ["app-server"], transport, "Codex", appServerRequest(clientInfo));
      const response = appServerResponse(result.stdout);
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
export function createClaudeUsageReader({ transport, snapshotPath, readFile = readSnapshot } = {}) {
  assertTransport(transport);
  if (typeof snapshotPath !== "string" || snapshotPath.length === 0) {
    throw new Error("Claude UsageReader requires a snapshot path");
  }
  if (typeof readFile !== "function") throw new Error("Claude UsageReader requires a snapshot reader");

  return Object.freeze({
    async read() {
      const authentication = await execute("claude", ["auth", "status"], transport, "Claude");
      const authStatus = parseObject(authentication.stdout, "Claude authentication status");
      if (authStatus.loggedIn !== true) {
        throw new UsageReaderError("authentication-required", "Claude authentication is required");
      }

      let rawSnapshot;
      try {
        rawSnapshot = await readFile(snapshotPath, "utf8");
      } catch {
        throw new UsageReaderError("snapshot-unavailable", "Claude usage snapshot is unavailable");
      }
      const snapshot = parseObject(rawSnapshot, "Claude usage snapshot");
      requireSupportedVersion(snapshot.claude_code_version, CLAUDE_MINIMUM_VERSION, "Claude Code");
      const observedAt = dateOrError(snapshot.captured_at, "Claude usage snapshot");

      return [
        claudeObservation("short-term", snapshot.five_hour, observedAt),
        claudeObservation("long-term", snapshot.seven_day, observedAt),
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
  } catch {
    throw new UsageReaderError("command-unavailable", `${provider} CLI is unavailable`);
  }
  if (result?.exitCode === 0) return result;
  if (authenticationSignal(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`)) {
    throw new UsageReaderError("authentication-required", `${provider} authentication is required`);
  }
  throw new UsageReaderError("command-failed", `${provider} usage command failed`);
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

function claudeObservation(windowKind, window, observedAt) {
  if (window === null || window === undefined) return null;
  if (!isObject(window)) throw new UsageReaderError("malformed-data", "Claude usage window was malformed");
  return providerObservation({
    provider: "claude",
    windowKind,
    usageProgress: percentage(window.used_percentage),
    resetAt: unixTimestamp(window.resets_at),
    observedAt,
    durationMs: null,
  });
}

function providerObservation({ provider, windowKind, usageProgress, resetAt, observedAt, durationMs }) {
  return { provider, windowKind, usageProgress, resetAt, observedAt, durationMs, provenance: "provider-reported" };
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
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1_000) : null;
}

function minutes(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 60_000 : null;
}

function percentage(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round((value / 100) * 1_000_000) / 1_000_000
    : null;
}

function authenticationSignal(value) {
  return /\b(auth(?:entication)?|log[ -]?in|sign[ -]?in|unauthori[sz]ed|forbidden)\b/i.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
