import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROMPT = "Reply with exactly OK. Do not use tools.";

/**
 * Performs the explicitly enabled Codex interaction used to start an inactive
 * short-term usage window. The usage reader remains the authoritative source
 * for its activity verdict and for the post-turn observation.
 */
export function createCodexWindowKeeper({
  transport,
  usageReader,
  createWorkDirectory = () => mkdtemp(join(tmpdir(), "stream-deck-ai-stats-")),
  removeWorkDirectory = (path) => rm(path, { recursive: true, force: true }),
} = {}) {
  if (typeof transport?.execute !== "function") throw new Error("Codex WindowKeeper requires a ProcessTransport");
  if (typeof usageReader?.read !== "function") throw new Error("Codex WindowKeeper requires a UsageReader");
  if (typeof createWorkDirectory !== "function" || typeof removeWorkDirectory !== "function") {
    throw new Error("Codex WindowKeeper requires temporary-directory lifecycle functions");
  }

  return Object.freeze({
    async getActivityVerdict() {
      const observations = await usageReader.read();
      if (!Array.isArray(observations)) throw new Error("Codex UsageReader must return an observation list");
      const shortTerm = observations.find((observation) => observation?.windowKind === "short-term");
      if (!shortTerm) return "inactive";
      return shortTerm.resetAt instanceof Date ? "active" : "unknown";
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
            ...(model ? ["--model", model] : []),
            PROMPT,
          ],
          cwd,
        });
        return { completed: completedTurn(result) };
      } finally {
        await removeWorkDirectory(cwd);
      }
    },
  });
}

function completedTurn(result) {
  if (result?.exitCode !== 0) return false;
  const events = String(result.stdout ?? "").split(/\r?\n/).filter(Boolean);
  let completed = false;
  for (const event of events) {
    let message;
    try {
      message = JSON.parse(event);
    } catch {
      return false;
    }
    if (message?.type === "turn.failed" || message?.type === "error") return false;
    if (message?.type === "turn.completed") completed = true;
  }
  return completed;
}
