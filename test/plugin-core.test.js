import test from "node:test";
import assert from "node:assert/strict";

import { createProcessTransport, createProviderAdapter, PluginCore, providerCapabilities } from "../src/core/index.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function observation(overrides = {}) {
  return {
    provider: "codex",
    windowKind: "short-term",
    usageProgress: 0.25,
    resetAt: new Date(NOW.getTime() + 4 * HOUR),
    observedAt: NOW,
    durationMs: 5 * HOUR,
    provenance: "provider-reported",
    ...overrides,
  };
}

test("publishes fresh provider observations with a pace forecast", async () => {
  const states = [];
  const core = new PluginCore({
    providers: [{ id: "codex", usageReader: { read: async () => [observation()] } }],
    now: () => NOW,
    ui: { publish: (state) => states.push(state) },
  });

  await core.refreshProvider("codex");

  assert.deepEqual(states.at(-1), {
    provider: "codex",
    operationalState: "normal",
    windows: [{
      provider: "codex",
      windowKind: "short-term",
      usageProgress: 0.25,
      resetAt: new Date("2026-07-13T16:00:00.000Z"),
      observedAt: NOW,
      durationMs: 5 * HOUR,
      provenance: "provider-reported",
      quality: "fresh",
      forecast: {
        paceStatus: "likely-to-exhaust",
        paceDelta: -0.05,
        projectedUsageProgress: 1.25,
      },
    }],
  });
});

test("marks incomplete or stale observations unknown instead of inventing current pace", async () => {
  const states = [];
  const core = new PluginCore({
    providers: [{ id: "claude", usageReader: { read: async () => [observation({ provider: "claude", usageProgress: null, observedAt: new Date(NOW.getTime() - 16 * 60 * 1000) })] } }],
    now: () => NOW,
    freshnessMs: 15 * 60 * 1000,
    ui: { publish: (state) => states.push(state) },
  });

  await core.refreshProvider("claude");

  assert.equal(states.at(-1).windows[0].quality, "incomplete");
  assert.deepEqual(states.at(-1).windows[0].forecast, {
    paceStatus: "unknown",
    paceDelta: null,
    projectedUsageProgress: null,
  });
});

test("marks a provider-reported reset discontinuity as a new forecast basis", async () => {
  const observations = [
    observation({ usageProgress: 0.7 }),
    observation({ usageProgress: 0.8, resetAt: new Date(NOW.getTime() + 5 * HOUR) }),
  ];
  const core = new PluginCore({
    providers: [{ id: "codex", usageReader: { read: async () => [observations.shift()] } }],
    now: () => NOW,
  });

  await core.refreshProvider("codex");
  await core.refreshProvider("codex");

  assert.equal(core.stateFor("codex").windows[0].resetDiscontinuity, true);
});

test("marks a decreasing provider progress as a reset discontinuity even without a new reset time", async () => {
  const observations = [observation({ usageProgress: 0.7 }), observation({ usageProgress: 0.1 })];
  const core = new PluginCore({
    providers: [{ id: "codex", usageReader: { read: async () => [observations.shift()] } }],
    now: () => NOW,
  });

  await core.refreshProvider("codex");
  await core.refreshProvider("codex");

  assert.equal(core.stateFor("codex").windows[0].resetDiscontinuity, true);
});

test("makes provider capabilities explicit while leaving process execution outside the core", () => {
  const transport = createProcessTransport({ execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
  const adapter = createProviderAdapter({
    id: "codex",
    usageReader: { read: async () => [] },
    transport,
  });

  assert.deepEqual(providerCapabilities(adapter), { usageReading: true, windowKeeping: false });
  assert.equal(typeof adapter.transport.execute, "function");
  assert.throws(() => createProviderAdapter({ id: "missing-reader" }), /UsageReader/);
});

test("keeps a window only when explicitly enabled and provider-confirmed inactive", async () => {
  let interactions = 0;
  const core = new PluginCore({
    providers: [{
      id: "codex",
      usageReader: { read: async () => [observation()] },
      windowKeeper: {
        getActivityVerdict: async () => "inactive",
        keepWindow: async () => { interactions += 1; return { completed: true }; },
      },
    }],
    now: () => NOW,
    settings: { codex: { windowKeepingEnabled: true } },
  });

  await core.runCycle();

  assert.equal(interactions, 1);
  assert.equal(core.stateFor("codex").operationalState, "window-keeping");
});

test("retries a failed window-keeping interaction using the configured backoff", async () => {
  let attempts = 0;
  const waits = [];
  const core = new PluginCore({
    providers: [{
      id: "codex",
      usageReader: { read: async () => [observation()] },
      windowKeeper: {
        getActivityVerdict: async () => "inactive",
        keepWindow: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary provider outage");
          return { completed: true };
        },
      },
    }],
    now: () => NOW,
    settings: { codex: { windowKeepingEnabled: true } },
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  await core.runCycle();

  assert.equal(attempts, 2);
  assert.deepEqual(waits, [30 * 1000]);
  assert.equal(core.stateFor("codex").operationalState, "window-keeping");
});

test("prevents concurrent checks from starting duplicate window-keeping interactions", async () => {
  let interactions = 0;
  const core = new PluginCore({
    providers: [{
      id: "codex",
      usageReader: { read: async () => [observation()] },
      windowKeeper: {
        getActivityVerdict: async () => "inactive",
        keepWindow: async () => { interactions += 1; return { completed: true }; },
      },
    }],
    now: () => NOW,
    settings: { codex: { windowKeepingEnabled: true } },
  });

  await Promise.all([core.runCycle(), core.runCycle()]);

  assert.equal(interactions, 1);
});

test("recovers transport-backed providers once before an appearance refresh", async () => {
  let recoveries = 0;
  const core = new PluginCore({
    providers: [{
      id: "codex",
      usageReader: { read: async () => [observation()] },
      recover: async () => { recoveries += 1; },
    }],
    now: () => NOW,
  });

  await Promise.all([core.onWillAppear(), core.onWillAppear()]);

  assert.equal(recoveries, 1);
  assert.equal(core.stateFor("codex").operationalState, "normal");
  core.stop();
});

test("keeps cached observations stale and visible when lifecycle recovery fails", async () => {
  const core = new PluginCore({
    providers: [{
      id: "codex",
      usageReader: { read: async () => [observation()] },
      recover: async () => { throw new Error("transport unavailable"); },
    }],
    now: () => NOW,
  });

  await core.refreshProvider("codex");
  try {
    await core.onSystemDidWakeUp();
    assert.equal(core.stateFor("codex").operationalState, "error");
    assert.equal(core.stateFor("codex").windows[0].quality, "stale");
  } finally {
    core.stop();
  }
});

test("reports unsupported window keeping without treating usage monitoring as an error", async () => {
  const core = new PluginCore({
    providers: [{ id: "claude", usageReader: { read: async () => [observation({ provider: "claude" })] } }],
    now: () => NOW,
    settings: { claude: { windowKeepingEnabled: true } },
  });

  await core.runCycle();

  assert.equal(core.stateFor("claude").operationalState, "unsupported");
  assert.equal(core.stateFor("claude").windows[0].quality, "fresh");
});
