import test from "node:test";
import assert from "node:assert/strict";

import {
  assertRequiredInstallerEntries,
  assertManifestCategoryIcon,
  assertSafeEntryPaths,
  ciArtifactVersion,
  credentialValue,
  developmentManifestVersion,
  developmentPackageVersion,
  manifestVersionFor,
  readPluginManifest,
  renderAcceptanceReport,
  versionFromReleaseTag,
} from "../scripts/release-contract.mjs";

test("derives installer versions from release tags rather than package metadata", () => {
  assert.equal(manifestVersionFor("1.2.3"), "1.2.3.0");
  assert.equal(versionFromReleaseTag("v1.2.3"), "1.2.3");
  assert.equal(ciArtifactVersion({ refType: "tag", refName: "v1.2.3", runNumber: "42" }), "1.2.3");
  assert.equal(ciArtifactVersion({ refType: "branch", refName: "master", runNumber: "42" }), "0.0.42");
  assert.throws(() => manifestVersionFor("1.2"), /X.Y.Z/);
  assert.throws(() => versionFromReleaseTag("v1.2.3-rc.1"), /X.Y.Z/);
  assert.equal(developmentPackageVersion, "0.0.0");
  assert.equal(developmentManifestVersion, "0.0.0.0");
});

test("accepts only an installer with its runtime assets and no secret-bearing paths", () => {
  const entries = [
    "com.marcinmaruszewski.ai-usage.sdPlugin/manifest.json",
    "com.marcinmaruszewski.ai-usage.sdPlugin/bin/plugin.js",
    "com.marcinmaruszewski.ai-usage.sdPlugin/ui/property-inspector.html",
  ];
  assert.doesNotThrow(() => assertRequiredInstallerEntries(entries));
  assert.doesNotThrow(() => assertSafeEntryPaths(entries));
  assert.throws(() => assertSafeEntryPaths([...entries, "com.marcinmaruszewski.ai-usage.sdPlugin/data/credentials.json"]), /forbidden/);
  assert.throws(() => assertRequiredInstallerEntries(["manifest.json"]), /missing required runtime asset/);
  assert.match('{"access_token":"example-value"}', credentialValue);
});

test("creates an explicitly unverified per-version Windows and WSL acceptance report", () => {
  const report = renderAcceptanceReport({ version: "1.2.3", generatedAt: "2026-07-13" });
  assert.match(report, /v1.2.3/);
  assert.match(report, /not verified/);
  assert.match(report, /macOS remains experimental/);
  assert.doesNotMatch(report, /credential/i);
});

test("declares a category icon when it declares a custom category", async () => {
  const manifest = await readPluginManifest();
  assert.ok(manifest.Category);
  assert.equal(manifest.CategoryIcon, "assets/category-icon");
  assert.doesNotThrow(() => assertManifestCategoryIcon(manifest, ["assets/category-icon.svg"]));
  assert.throws(() => assertManifestCategoryIcon({ Category: "AI Usage Stats" }, []), /omits CategoryIcon/);
  assert.throws(
    () => assertManifestCategoryIcon({ Category: "AI Usage Stats", CategoryIcon: "assets/category-icon" }, []),
    /category icon is missing/,
  );
});
