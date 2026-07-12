import test from "node:test";
import assert from "node:assert/strict";

import { createProcessTransport, createProviderAdapter, PluginCore, providerCapabilities } from "../src/core/index.js";
import { createPlatformProcessTransport, ProcessTimeoutError } from "../src/core/index.js";
import { EventEmitter } from "node:events";

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

test("recovers replaced provider transports before applying new Property Inspector configuration", async () => {
  const lifecycle = [];
  const core = new PluginCore({
    providers: [{
      id: "codex",
      usageReader: { read: async () => [] },
      recover: async () => lifecycle.push("recover-old"),
    }],
    now: () => NOW,
  });

  await core.configure({
    providers: [{ id: "codex", usageReader: { read: async () => { lifecycle.push("read-new"); return []; } } }],
    settings: { codex: {} },
  });

  assert.deepEqual(lifecycle, ["recover-old", "read-new"]);
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

test("refreshes usage after a validated window-keeping turn", async () => {
  let reads = 0;
  const core = new PluginCore({
    providers: [{
      id: "codex",
      usageReader: { read: async () => { reads += 1; return [observation({ usageProgress: reads / 10 })]; } },
      windowKeeper: {
        getActivityVerdict: async () => "inactive",
        keepWindow: async () => ({ completed: true }),
      },
    }],
    now: () => NOW,
    settings: { codex: { windowKeepingEnabled: true } },
  });

  await core.runCycle();

  assert.equal(reads, 2);
  assert.equal(core.stateFor("codex").windows[0].usageProgress, 0.2);
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

test("runs a native Windows CLI with an explicit executable and merged environment", async () => {
  const calls = [];
  const child = fakeChild();
  const transport = createPlatformProcessTransport({
    platform: "win32",
    executableOverrides: { codex: "C:\\Tools\\codex.exe" },
    inheritedEnv: { PATH: "base" },
    environment: { CODEX_HOME: "C:\\Users\\me\\.codex" },
    spawn: (...args) => { calls.push(args); return child; },
  });

  const result = transport.execute({ executable: "codex", args: ["app-server"], input: "request" });
  child.stdout.emit("data", "protocol output");
  child.stderr.emit("data", "diagnostic");
  child.emit("close", 0, null);

  assert.deepEqual(await result, { exitCode: 0, signal: null, stdout: "protocol output", stderr: "diagnostic" });
  assert.deepEqual(calls, [["C:\\Tools\\codex.exe", ["app-server"], {
    cwd: undefined,
    env: { PATH: "base", CODEX_HOME: "C:\\Users\\me\\.codex" },
    windowsHide: true,
    shell: false,
  }]]);
  assert.deepEqual(child.stdin.values, ["request"]);
});

test("bridges only the explicitly selected WSL distribution without a shell", async () => {
  const calls = [];
  const child = fakeChild();
  const transport = createPlatformProcessTransport({
    platform: "win32",
    mode: "wsl",
    executableOverrides: { wsl: "C:\\Windows\\System32\\wsl.exe" },
    inheritedEnv: { PATH: "host" },
    environment: { CODEX_HOME: "/mnt/c/Users/me/.codex" },
    wsl: { distribution: "Ubuntu-24.04", hostEnvironment: { WSLENV: "CODEX_HOME/u" } },
    spawn: (...args) => { calls.push(args); return child; },
  });

  const result = transport.execute({ executable: "codex", args: ["exec", "Reply with exactly OK."], cwd: "/home/me/plugin" });
  child.emit("close", 0, null);
  await result;

  assert.deepEqual(calls, [["C:\\Windows\\System32\\wsl.exe", [
    "--distribution", "Ubuntu-24.04", "--cd", "/home/me/plugin", "--env", "CODEX_HOME=/mnt/c/Users/me/.codex",
    "--exec", "codex", "exec", "Reply with exactly OK.",
  ], {
    cwd: undefined,
    env: { PATH: "host", WSLENV: "CODEX_HOME/u" },
    windowsHide: true,
    shell: false,
  }]]);
});

test("reads usage snapshots in the selected native or WSL environment", async () => {
  const native = createPlatformProcessTransport({
    platform: "win32",
    readFile: async (path, encoding) => {
      assert.equal(path, "C:\\Users\\me\\claude-usage.json");
      assert.equal(encoding, "utf8");
      return "native snapshot";
    },
  });
  assert.equal(await native.readFile("C:\\Users\\me\\claude-usage.json"), "native snapshot");

  const calls = [];
  const child = fakeChild();
  const wsl = createPlatformProcessTransport({
    platform: "win32",
    mode: "wsl",
    wsl: { distribution: "Ubuntu-24.04" },
    spawn: (...args) => { calls.push(args); return child; },
  });
  const snapshot = wsl.readFile("/home/me/.claude/usage.json");
  child.stdout.emit("data", "wsl snapshot");
  child.emit("close", 0, null);

  assert.equal(await snapshot, "wsl snapshot");
  assert.deepEqual(calls[0].slice(0, 2), ["wsl.exe", [
    "--distribution", "Ubuntu-24.04", "--exec", "cat", "/home/me/.claude/usage.json",
  ]]);
});

test("uses the native macOS CLI and rejects cancelled or timed out commands", async () => {
  const children = [];
  const transport = createPlatformProcessTransport({
    platform: "darwin",
    defaultTimeoutMs: 5,
    spawn: (...args) => {
      const child = fakeChild();
      children.push({ child, args });
      return child;
    },
  });
  const controller = new AbortController();
  const cancelled = transport.execute({ executable: "codex", signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(children[0].args[0], "codex");
  assert.deepEqual(children[0].args[1], []);
  assert.equal(children[0].args[2].env.PATH, process.env.PATH);
  assert.equal(children[0].args[2].windowsHide, false);
  assert.equal(children[0].args[2].shell, false);
  assert.equal(children[0].child.killCalls, 1);

  const timedOut = transport.execute({ executable: "codex" });
  await assert.rejects(timedOut, ProcessTimeoutError);
  assert.equal(children[1].child.killCalls, 1);
});

test("recovers by terminating outstanding child processes", async () => {
  const child = fakeChild();
  const transport = createPlatformProcessTransport({ platform: "darwin", spawn: () => child });
  const pending = transport.execute({ executable: "codex" });
  const recovery = transport.recover();
  child.emit("close", null, "SIGTERM");
  await recovery;
  assert.equal(child.killCalls, 1);
  await pending;
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { values: [], end(value) { this.values.push(value); } };
  child.exitCode = null;
  child.killed = false;
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; child.killed = true; return true; };
  return child;
}
