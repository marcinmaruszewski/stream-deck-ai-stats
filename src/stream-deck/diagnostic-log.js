import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const diagnosticLog = new URL("../../logs/ai-usage-diagnostics.log", import.meta.url);
const safeFields = new Set([
  "provider",
  "operationalState",
  "errorCode",
  "transportMode",
  "hasWslDistribution",
  "hasCodexExecutable",
  "hasClaudeExecutable",
  "hasClaudeSnapshotPath",
  "windowCount",
]);

/** Writes only classified diagnostics, never provider output, paths, settings values, or credentials. */
export function createDiagnosticLogger({ append = appendDiagnosticLine, now = () => new Date() } = {}) {
  return Object.freeze({
    async record(event, fields = {}) {
      const entry = { at: now().toISOString(), event };
      for (const [name, value] of Object.entries(fields)) {
        if (safeFields.has(name) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
          entry[name] = value;
        }
      }
      try {
        await append(`${JSON.stringify(entry)}\n`);
      } catch {
        // Diagnostics must never interrupt usage monitoring.
      }
    },
  });
}

async function appendDiagnosticLine(line) {
  const path = fileURLToPath(diagnosticLog);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, "utf8");
}
