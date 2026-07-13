import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const sourceDirectories = ["src/core", "src/stream-deck"];

for (const directory of sourceDirectories) {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".js"))
    .sort();

  for (const file of files) {
    execFileSync(process.execPath, ["--check", join(directory, file)], { stdio: "inherit" });
  }
}
