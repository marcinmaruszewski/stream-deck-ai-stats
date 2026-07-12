import { PluginCore } from "../core/plugin-core.js";
import { readFileSync } from "node:fs";
import { createProviderAdapter } from "../core/contracts.js";
import { createPlatformProcessTransport } from "../core/process-transport.js";
import { createClaudeUsageReader, createCodexUsageReader, UsageReaderError } from "../core/usage-readers.js";
import { createCodexWindowKeeper } from "../core/codex-window-keeper.js";
import { StreamDeckPlugin } from "./plugin.js";

/** Starts the Node 24 Stream Deck websocket boundary without exposing CLI work to the Property Inspector. */
export function startStreamDeckPlugin({ argv = process.argv.slice(2), WebSocketImpl = globalThis.WebSocket, platform = process.platform } = {}) {
  const launch = parseLaunchArguments(argv);
  if (!launch.port || !launch.pluginUUID || !launch.registerEvent) {
    throw new Error("Stream Deck launch arguments are incomplete");
  }
  if (typeof WebSocketImpl !== "function") throw new Error("Stream Deck requires a WebSocket implementation");

  let plugin;
  const core = new PluginCore({
    providers: [],
    ui: { publish: (state) => plugin.publish(state) },
  });
  const socket = new WebSocketImpl(`ws://127.0.0.1:${launch.port}`);
  plugin = new StreamDeckPlugin({
    core,
    send: (message) => socket.send(JSON.stringify(message)),
    configure: async (settings) => core.configure({ providers: await createConfiguredProviders(settings, { platform }), settings: coreSettings(settings) }),
    providerMarks: loadProviderMarks(),
  });

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ event: launch.registerEvent, uuid: launch.pluginUUID }));
    socket.send(JSON.stringify({ event: "getGlobalSettings", uuid: launch.pluginUUID }));
    core.start();
  });
  socket.addEventListener("message", (message) => {
    try {
      const event = JSON.parse(message.data);
      void plugin.handleEvent(event);
    } catch {
      // Stream Deck messages outside the plugin contract are ignored safely.
    }
  });
  return Object.freeze({ core, plugin, socket });
}

export async function createConfiguredProviders(settings = {}, { platform = process.platform } = {}) {
  try {
    const configurations = await resolveProviderTransportConfigurations(settings, { platform });
    const codexTransport = createPlatformProcessTransport({
      platform,
      ...configurations.codex,
      executableOverrides: compact({ codex: settings.codexExecutable }),
    });
    const claudeTransport = createPlatformProcessTransport({
      platform,
      ...configurations.claude,
      executableOverrides: compact({ claude: settings.claudeExecutable }),
    });
    const codexUsageReader = createCodexUsageReader({ transport: codexTransport });
    return [
      createProviderAdapter({
        id: "codex",
        transport: codexTransport,
        usageReader: codexUsageReader,
        windowKeeper: createCodexWindowKeeper({ transport: codexTransport, usageReader: codexUsageReader }),
      }),
      createProviderAdapter({
        id: "claude",
        transport: claudeTransport,
        usageReader: settings.claudeSnapshotPath
          ? createClaudeUsageReader({ transport: claudeTransport, snapshotPath: settings.claudeSnapshotPath })
          : unavailableUsageReader(),
      }),
    ];
  } catch {
    return [
      createProviderAdapter({ id: "codex", usageReader: unavailableUsageReader() }),
      createProviderAdapter({ id: "claude", usageReader: unavailableUsageReader() }),
    ];
  }
}

export async function resolveTransportConfiguration(settings = {}, { platform = process.platform, discoverWsl = discoverWslDistribution } = {}) {
  return resolveProviderTransportConfiguration(settings, { platform, executable: "codex", executableOverride: settings.codexExecutable, discoverWsl });
}

export async function resolveProviderTransportConfigurations(settings = {}, { platform = process.platform, discoverWsl = discoverWslDistribution } = {}) {
  const [codex, claude] = await Promise.all([
    resolveProviderTransportConfiguration(settings, { platform, executable: "codex", executableOverride: settings.codexExecutable, discoverWsl }),
    resolveProviderTransportConfiguration(settings, { platform, executable: "claude", executableOverride: settings.claudeExecutable, discoverWsl }),
  ]);
  return { codex, claude };
}

async function resolveProviderTransportConfiguration(settings, { platform, executable, executableOverride, discoverWsl }) {
  if (settings.transportMode === "wsl") return { mode: "wsl", wsl: { distribution: settings.wslDistribution } };
  if (settings.transportMode === "auto" && platform === "win32") {
    const distribution = await discoverWsl(settings, executable, executableOverride);
    if (distribution) return { mode: "wsl", wsl: { distribution } };
  }
  return { mode: "native" };
}

function coreSettings(settings) {
  return {
    ...settings,
    codex: {
      ...settings.codex,
      windowKeepingEnabled: settings.codexWindowKeepingEnabled === true,
      ...(typeof settings.codexWindowKeepingModel === "string" && settings.codexWindowKeepingModel.length > 0
        ? { windowKeepingModel: settings.codexWindowKeepingModel }
        : {}),
    },
    claude: { ...settings.claude },
  };
}

function unavailableUsageReader() {
  return Object.freeze({
    async read() {
      throw new UsageReaderError("configuration-required", "Provider configuration is incomplete");
    },
  });
}

function compact(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === "string" && value.length > 0));
}

async function discoverWslDistribution(settings, executable, executableOverride) {
  const nativeTransport = createPlatformProcessTransport({
    platform: "win32",
    executableOverrides: compact({ [executable]: executableOverride }),
  });
  try {
    const nativeProvider = await nativeTransport.execute({ executable, args: ["--version"], timeoutMs: 5_000 });
    if (nativeProvider.exitCode === 0) return null;
  } catch {
    // An unavailable native Codex CLI is the signal to inspect WSL next.
  }
  try {
    const distributions = await nativeTransport.execute({ executable: "wsl.exe", args: ["--list", "--quiet"], timeoutMs: 5_000 });
    if (distributions.exitCode !== 0) return null;
    return String(distributions.stdout).split(/\r?\n/).map((line) => line.replace(/\0/g, "").trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function loadProviderMarks() {
  return Object.freeze({
    codex: dataUri("../../assets/codex-tile.png"),
    claude: dataUri("../../assets/claude-tile.png"),
  });
}

function dataUri(path) {
  return `data:image/png;base64,${readFileSync(new URL(path, import.meta.url)).toString("base64")}`;
}

export function parseLaunchArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (typeof key === "string" && key.startsWith("-")) values[key.slice(1)] = value;
  }
  return Object.freeze({ port: values.port, pluginUUID: values.pluginUUID, registerEvent: values.registerEvent });
}
