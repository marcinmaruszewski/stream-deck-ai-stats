import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pluginDirectory = join(repositoryRoot, "com.marcinmaruszewski.ai-usage.sdPlugin");
export const distributionDirectory = join(repositoryRoot, "dist");

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const forbiddenPath = /(^|\/)(?:\.env(?:\..*)?|[^/]*(?:credential|secret|snapshot|cache)[^/]*|[^/]*\.log|[^/]*\.map)(?:\/|$)/i;
const textExtension = new Set(["", ".css", ".html", ".js", ".json", ".md", ".txt"]);
export const credentialValue = /(?:"(?:access_|refresh_)?token"\s*:\s*"[^"\s]+"|"api[_-]?key"\s*:\s*"[^"\s]+"|\bsk-[A-Za-z0-9_-]{12,}\b)/i;

export function manifestVersionFor(packageVersion) {
  if (!semver.test(packageVersion)) throw new Error(`package.json version must be SemVer, received ${packageVersion}`);
  const [core] = packageVersion.split(/[+-]/, 1);
  return `${core}.0`;
}

export function assertReleaseTag(tag, packageVersion) {
  const expected = `v${packageVersion}`;
  if (tag !== expected) throw new Error(`Release tag must be ${expected}, received ${tag}`);
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

export async function readReleaseMetadata(root = repositoryRoot) {
  const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "com.marcinmaruszewski.ai-usage.sdPlugin", "manifest.json"), "utf8"));
  return { packageMetadata, manifest };
}

export async function validatePluginContract(root = repositoryRoot) {
  const { packageMetadata, manifest } = await readReleaseMetadata(root);
  const expectedManifestVersion = manifestVersionFor(packageMetadata.version);
  if (manifest.Version !== expectedManifestVersion) {
    throw new Error(`manifest.json Version must be ${expectedManifestVersion} to match package.json ${packageMetadata.version}`);
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
  return { packageVersion: packageMetadata.version, manifestVersion: manifest.Version, entries };
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
