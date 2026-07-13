import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROMPT = "Reply with exactly OK. Do not use tools.";
const DEFAULT_MODEL = "gpt-5.6-luna";

/**
 * Performs an explicitly user-triggered Codex interaction. Rate limits do not
 * report whether a usage window is active, so this action never infers one.
 */
export function createCodexWindowKeeper({
  transport,
  createWorkDirectory = () => mkdtemp(join(tmpdir(), "stream-deck-ai-stats-")),
  removeWorkDirectory = (path) => rm(path, { recursive: true, force: true }),
} = {}) {
  if (typeof transport?.execute !== "function") throw new Error("Codex WindowKeeper requires a ProcessTransport");
  if (typeof createWorkDirectory !== "function" || typeof removeWorkDirectory !== "function") {
    throw new Error("Codex WindowKeeper requires temporary-directory lifecycle functions");
  }

  return Object.freeze({
    async getActivityVerdict() {
      return "unknown";
    },

    async keepWindow({ model } = {}) {
      if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
        throw new Error("Codex window-keeping model must be a non-empty string");
      }
      const cwd = await createWorkDirectory();
      try {
        const result = await transport.execute({
          executable: "codex",
          args: [
            "exec", "--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
            "--model", model ?? DEFAULT_MODEL,
            PROMPT,
          ],
          cwd,
        });
        return turnResult(result);
      } finally {
        await removeWorkDirectory(cwd);
      }
    },
  });
}

function turnResult(result) {
  if (result?.exitCode !== 0) {
    return { completed: false, ...(hasUnavailableModelFailure(result.stdout, result.stderr) ? { errorCode: "model-unavailable" } : {}) };
  }
  const events = String(result.stdout ?? "").split(/\r?\n/).filter(Boolean);
  let completed = false;
  for (const event of events) {
    let message;
    try {
      message = JSON.parse(event);
    } catch {
      return { completed: false };
    }
    if (message?.type === "turn.failed" || message?.type === "error") {
      return { completed: false, ...(hasUnavailableModelFailure(message) ? { errorCode: "model-unavailable" } : {}) };
    }
    if (message?.type === "turn.completed") completed = true;
  }
  return { completed };
}

function hasUnavailableModelFailure(...values) {
  const details = values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
  return /\bmodel\b.{0,80}\b(?:not available|unavailable|unsupported|not found|unknown|invalid)\b|\b(?:not available|unavailable|unsupported|not found|unknown|invalid)\b.{0,80}\bmodel\b/i.test(details);
}
