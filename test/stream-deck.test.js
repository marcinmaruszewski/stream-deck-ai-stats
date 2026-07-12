import test from "node:test";
import assert from "node:assert/strict";

import { StreamDeckPlugin } from "../src/stream-deck/plugin.js";
import { resolveProviderTransportConfigurations, resolveTransportConfiguration } from "../src/stream-deck/runtime.js";
import { actionBinding, renderUsageTile } from "../src/stream-deck/usage-tile.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");

test("renders the accepted usage-tile hierarchy with pace and stale badges", () => {
  const image = renderUsageTile({
    provider: "codex",
    windowKind: "short-term",
    now: NOW,
    window: {
      usageProgress: 0.62,
      resetAt: new Date("2026-07-13T15:00:00.000Z"),
      quality: "stale",
      forecast: { paceStatus: "likely-to-exhaust", paceDelta: -0.22 },
    },
  });

  assert.match(image, /Codex 5h/);
  assert.match(image, /62%/);
  assert.match(image, /#fb6b52/);
  assert.match(image, /Δ −22pp/);
  assert.match(image, /data is stale/);
});

test("routes a provider state only to its matching Stream Deck usage tile", async () => {
  const messages = [];
  const lifecycle = { onWillAppear: async () => {}, onSystemDidWakeUp: async () => {} };
  const plugin = new StreamDeckPlugin({ core: lifecycle, send: (message) => messages.push(message), now: () => NOW });

  await plugin.handleEvent({ event: "willAppear", context: "codex-five-hour", action: "com.marcinmaruszewski.ai-usage.codex.short-term" });
  await plugin.handleEvent({ event: "willAppear", context: "claude-five-hour", action: "com.marcinmaruszewski.ai-usage.claude.short-term" });
  messages.length = 0;
  plugin.publish({
    provider: "codex",
    operationalState: "normal",
    windows: [{ windowKind: "short-term", usageProgress: 0.1, resetAt: new Date("2026-07-13T16:00:00.000Z"), quality: "fresh", forecast: { paceStatus: "on-track", paceDelta: 0.1 } }],
  });

  assert.deepEqual(messages.map(({ event, context }) => ({ event, context })), [
    { event: "setImage", context: "codex-five-hour" },
  ]);
});

test("binds exactly the four declared provider and window action identifiers", () => {
  assert.deepEqual(actionBinding("com.marcinmaruszewski.ai-usage.claude.long-term"), { provider: "claude", windowKind: "long-term" });
  assert.equal(actionBinding("com.mmaruszewski.ai-usage.codex.short-term"), null);
});

test("forwards non-secret global Property Inspector settings to the backend configuration", async () => {
  const configurations = [];
  const lifecycle = { onWillAppear: async () => {}, onSystemDidWakeUp: async () => {} };
  const plugin = new StreamDeckPlugin({
    core: lifecycle,
    send: () => {},
    configure: async (settings) => configurations.push(settings),
  });

  await plugin.handleEvent({
    event: "didReceiveGlobalSettings",
    payload: { settings: { transportMode: "wsl", wslDistribution: "Ubuntu-24.04", codexExecutable: "codex" } },
  });

  assert.deepEqual(configurations, [{ transportMode: "wsl", wslDistribution: "Ubuntu-24.04", codexExecutable: "codex" }]);
});

test("automatically selects a discovered WSL distribution when native Codex is unavailable", async () => {
  const configuration = await resolveTransportConfiguration(
    { transportMode: "auto" },
    { platform: "win32", discoverWsl: async () => "Ubuntu-24.04" },
  );

  assert.deepEqual(configuration, { mode: "wsl", wsl: { distribution: "Ubuntu-24.04" } });
});

test("discovers the Codex and Claude environments independently", async () => {
  const configurations = await resolveProviderTransportConfigurations(
    { transportMode: "auto" },
    {
      platform: "win32",
      discoverWsl: async (_settings, executable) => executable === "claude" ? "Ubuntu-24.04" : null,
    },
  );

  assert.deepEqual(configurations, {
    codex: { mode: "native" },
    claude: { mode: "wsl", wsl: { distribution: "Ubuntu-24.04" } },
  });
});
