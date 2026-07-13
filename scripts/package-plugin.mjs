import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { distributionDirectory, manifestVersionFor, pluginDirectory, renderAcceptanceReport } from "./release-contract.mjs";

const run = promisify(execFile);
const version = process.argv[2];
if (!version) throw new Error("Usage: node scripts/package-plugin.mjs X.Y.Z");
const manifestVersion = manifestVersionFor(version);
await rm(distributionDirectory, { recursive: true, force: true });
await mkdir(distributionDirectory, { recursive: true });
const stagingRoot = await mkdtemp(join(tmpdir(), "stream-deck-ai-stats-"));
const stagingPlugin = join(stagingRoot, basename(pluginDirectory));

try {
  await cp(pluginDirectory, stagingPlugin, { recursive: true });
  await run("streamdeck", ["pack", stagingPlugin, "--output", distributionDirectory, "--version", manifestVersion, "--force", "--no-update-check"], { stdio: "inherit" });

  const installers = (await readdir(distributionDirectory)).filter((name) => name.endsWith(".streamDeckPlugin"));
  if (installers.length !== 1) throw new Error(`Expected exactly one installer, found ${installers.length}`);

  const reportPath = `${distributionDirectory}/windows-wsl-acceptance-v${version}.md`;
  await writeFile(reportPath, renderAcceptanceReport({ version }));
  await run(process.execPath, ["scripts/verify-installer.mjs", `${distributionDirectory}/${installers[0]}`], { stdio: "inherit" });
  console.log(`Created ${installers[0]} for v${version} and a draft Windows/WSL acceptance report.`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
