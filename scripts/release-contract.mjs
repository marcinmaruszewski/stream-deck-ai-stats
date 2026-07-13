import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pluginDirectory = join(repositoryRoot, "com.marcinmaruszewski.ai-usage.sdPlugin");
export const distributionDirectory = join(repositoryRoot, "dist");

const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const forbiddenPath = /(^|\/)(?:\.env(?:\..*)?|[^/]*(?:credential|secret|snapshot|cache)[^/]*|[^/]*\.log|[^/]*\.map)(?:\/|$)/i;
const textExtension = new Set(["", ".css", ".html", ".js", ".json", ".md", ".txt"]);
export const credentialValue = /(?:"(?:access_|refresh_)?token"\s*:\s*"[^"\s]+"|"api[_-]?key"\s*:\s*"[^"\s]+"|\bsk-[A-Za-z0-9_-]{12,}\b)/i;
export const developmentPackageVersion = "0.0.0";
export const developmentManifestVersion = "0.0.0.0";

export function manifestVersionFor(version) {
  if (!releaseVersion.test(version)) throw new Error(`Release version must be X.Y.Z, received ${version}`);
  return `${version}.0`;
}

export function versionFromReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) throw new Error(`Release tag must be vX.Y.Z, received ${tag}`);
  const version = tag.slice(1);
  manifestVersionFor(version);
  return version;
}

export function ciArtifactVersion({ refType, refName, runNumber }) {
  if (refType === "tag") return versionFromReleaseTag(refName);
  if (!/^[1-9]\d*$/.test(String(runNumber))) throw new Error(`CI run number must be a positive integer, received ${runNumber}`);
  return `0.0.${runNumber}`;
}

export function assertSafeEntryPaths(entries) {
  const forbidden = entries.filter((entry) => forbiddenPath.test(entry.replaceAll("\\", "/")));
  if (forbidden.length > 0) throw new Error(`Installer contains forbidden files: ${forbidden.join(", ")}`);
}

export function assertRequiredInstallerEntries(entries) {
  const normalized = entries.map((entry) => entry.replaceAll("\\", "/"));
  for (const path of ["manifest.json", "bin/plugin.js", "ui/property-inspector.html"]) {
    if (!normalized.some((entry) => entry === path || entry.endsWith(`/${path}`))) {
      throw new Error(`Installer is missing required runtime asset: ${path}`);
    }
  }
}

export function isTextEntry(path) {
  return textExtension.has(extname(path).toLowerCase());
}

export async function readPluginManifest(root = repositoryRoot) {
  const manifest = JSON.parse(await readFile(join(root, "com.marcinmaruszewski.ai-usage.sdPlugin", "manifest.json"), "utf8"));
  return manifest;
}

export async function validatePluginContract(root = repositoryRoot) {
  const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (packageMetadata.version !== developmentPackageVersion) {
    throw new Error(`package.json version must remain the development placeholder ${developmentPackageVersion}`);
  }
  const manifest = await readPluginManifest(root);
  if (manifest.Version !== developmentManifestVersion) {
    throw new Error(`Source manifest.json Version must remain the development placeholder ${developmentManifestVersion}`);
  }

  const requiredPaths = ["manifest.json", "bin/plugin.js", "ui/property-inspector.html", "ui/property-inspector.js"];
  for (const path of requiredPaths) {
    try {
      await readFile(join(root, "com.marcinmaruszewski.ai-usage.sdPlugin", path));
    } catch {
      throw new Error(`Plugin bundle is missing ${path}; run npm run bundle first`);
    }
  }

  const entries = await listFiles(join(root, "com.marcinmaruszewski.ai-usage.sdPlugin"));
  assertSafeEntryPaths(entries);
  return { manifestVersion: manifest.Version, entries };
}

export async function listFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, base));
    else if (entry.isFile()) files.push(relative(base, path).replaceAll("\\", "/"));
  }
  return files;
}

export function renderAcceptanceReport({ version, generatedAt = new Date().toISOString().slice(0, 10) }) {
  return `# Windows/WSL private-release acceptance — v${version}\n\n` +
    `Status: **not verified**. This report is attached to the draft release and must be completed on Windows with WSL2 before publication.\n\n` +
    `Generated: ${generatedAt}\n\n` +
    `## Environment\n\n` +
    `- Stream Deck version:\n- Windows version:\n- WSL distribution and version:\n- Codex CLI version:\n- Claude Code version:\n\n` +
    `## Required evidence\n\n` +
    `- [ ] Installed exactly one \`.streamDeckPlugin\` installer.\n- [ ] Four usage tiles render and refresh.\n- [ ] Property Inspector discovers providers and saves only non-secret settings.\n- [ ] Stale and provider-error states are visible.\n- [ ] Wake/restart recovery works.\n- [ ] The explicit Codex window-keeping action reports its result.\n\n` +
    `## Publication decision\n\n` +
    `- [ ] Windows/WSL acceptance is complete; the draft release may be published.\n- macOS remains experimental: CI packaging is not a real-hardware runtime verification.\n`;
}
