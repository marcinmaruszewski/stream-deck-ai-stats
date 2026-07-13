import test from "node:test";
import assert from "node:assert/strict";

import {
  assertReleaseTag,
  assertRequiredInstallerEntries,
  assertSafeEntryPaths,
  credentialValue,
  manifestVersionFor,
  renderAcceptanceReport,
} from "../scripts/release-contract.mjs";

test("maps the single SemVer source to the Stream Deck manifest version", () => {
  assert.equal(manifestVersionFor("1.2.3"), "1.2.3.0");
  assert.equal(manifestVersionFor("1.2.3-rc.1"), "1.2.3.0");
  assert.throws(() => manifestVersionFor("1.2"), /SemVer/);
  assert.doesNotThrow(() => assertReleaseTag("v1.2.3", "1.2.3"));
  assert.throws(() => assertReleaseTag("v1.2.4", "1.2.3"), /must be v1.2.3/);
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
