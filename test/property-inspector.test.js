import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const inspectorUrl = new URL("../com.marcinmaruszewski.ai-usage.sdPlugin/ui/property-inspector.js", import.meta.url);

test("Property Inspector sends an explicitly scoped Codex request and renders its separate diagnostics", async () => {
  const elements = new Map();
  for (const selector of [
    "#settings-form", "#operational-state", "#observation-quality", "#reset-at",
    "#window-activity", "#window-keeping-action", "#observation-comparison",
    "#last-error", "#refresh-diagnostics", "#request-codex-window-keeping",
  ]) elements.set(selector, new FakeElement());
  elements.get("#settings-form").elements = [];

  const document = { querySelector: (selector) => elements.get(selector) };
  const context = vm.createContext({
    document,
    FormData: class { entries() { return []; } },
    URLSearchParams,
    location: {
      search: "?port=28123&pluginUUID=plugin-id&registerEvent=registerPropertyInspector&context=codex-key&action=com.marcinmaruszewski.ai-usage.codex.short-term",
    },
    WebSocket: FakeWebSocket,
  });

  vm.runInContext(await readFile(inspectorUrl, "utf8"), context, { filename: inspectorUrl.pathname });
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("open");

  assert.deepEqual(socket.messages.slice(0, 3), [
    { event: "registerPropertyInspector", uuid: "plugin-id" },
    { event: "getGlobalSettings", context: "plugin-id" },
    {
      event: "sendToPlugin",
      context: "codex-key",
      action: "com.marcinmaruszewski.ai-usage.codex.short-term",
      payload: { event: "requestDiagnostics" },
    },
  ]);

  elements.get("#settings-form").emit("submit");
  assert.deepEqual(socket.messages.at(-1), {
    event: "setGlobalSettings",
    context: "plugin-id",
    payload: {},
  });

  elements.get("#request-codex-window-keeping").emit("click");

  assert.deepEqual(socket.messages.at(-1), {
    event: "sendToPlugin",
    context: "codex-key",
    action: "com.marcinmaruszewski.ai-usage.codex.short-term",
    payload: { event: "requestCodexWindowKeeping" },
  });

  socket.emit("message", { data: JSON.stringify({
    event: "sendToPropertyInspector",
    payload: {
      windowActivity: "unknown",
      windowKeepingAction: "completed",
      observationComparison: "changed",
      error: null,
    },
  }) });

  assert.equal(elements.get("#window-activity").textContent, "Unknown");
  assert.equal(elements.get("#window-keeping-action").textContent, "Completed");
  assert.equal(elements.get("#observation-comparison").textContent, "Changed");
  assert.equal(elements.get("#last-error").textContent, "None");
});

class FakeElement {
  #listeners = new Map();

  constructor() {
    this.textContent = "";
  }

  addEventListener(event, listener) {
    this.#listeners.set(event, listener);
  }

  emit(event, payload = {}) {
    this.#listeners.get(event)?.({ preventDefault() {}, ...payload });
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  #listeners = new Map();

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.messages = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event, listener) {
    this.#listeners.set(event, listener);
  }

  send(message) {
    this.messages.push(JSON.parse(message));
  }

  emit(event, payload = {}) {
    this.#listeners.get(event)?.(payload);
  }
}
