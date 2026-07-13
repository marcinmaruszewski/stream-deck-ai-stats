import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { distributionDirectory, pluginDirectory, readReleaseMetadata, renderAcceptanceReport } from "./release-contract.mjs";

const run = promisify(execFile);
await rm(distributionDirectory, { recursive: true, force: true });
await mkdir(distributionDirectory, { recursive: true });
await run("streamdeck", ["pack", pluginDirectory, "--output", distributionDirectory, "--force", "--no-update-check"], { stdio: "inherit" });

const installers = (await readdir(distributionDirectory)).filter((name) => name.endsWith(".streamDeckPlugin"));
if (installers.length !== 1) throw new Error(`Expected exactly one installer, found ${installers.length}`);

const { packageMetadata } = await readReleaseMetadata();
const reportPath = `${distributionDirectory}/windows-wsl-acceptance-v${packageMetadata.version}.md`;
await writeFile(reportPath, renderAcceptanceReport({ version: packageMetadata.version }));
await run(process.execPath, ["scripts/verify-installer.mjs", `${distributionDirectory}/${installers[0]}`], { stdio: "inherit" });
console.log(`Created ${installers[0]} and a draft Windows/WSL acceptance report.`);
