import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { assertRequiredInstallerEntries, assertSafeEntryPaths, credentialValue, isTextEntry } from "./release-contract.mjs";

const installer = process.argv[2];
if (!installer) throw new Error("Usage: node scripts/verify-installer.mjs path/to/plugin.streamDeckPlugin");
const installerPath = resolve(installer);
const entries = execFileSync("unzip", ["-Z1", installerPath], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);

assertRequiredInstallerEntries(entries);
assertSafeEntryPaths(entries);
for (const entry of entries.filter(isTextEntry)) {
  const content = execFileSync("unzip", ["-p", installerPath, entry], { encoding: "buffer" });
  if (credentialValue.test(content.toString("utf8"))) {
    throw new Error(`Installer contains credential-like data in ${entry}`);
  }
}

await readFile(installerPath);
console.log(`Verified ${basename(installerPath)}: ${entries.length} files, bundled backend present, no credential snapshots.`);
