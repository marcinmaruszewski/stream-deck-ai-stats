(() => {
  const form = document.querySelector("#settings-form");
  const params = new URLSearchParams(location.search);
  const launch = Object.fromEntries(params.entries());
  const state = {
    socket: null,
    settings: {},
    port: launch.port,
    uiUUID: launch.pluginUUID,
    registerEvent: launch.registerEvent,
    action: launch.action,
  };
  const diagnostics = {
    operationalState: document.querySelector("#operational-state"),
    observationQuality: document.querySelector("#observation-quality"),
    resetAt: document.querySelector("#reset-at"),
    windowActivity: document.querySelector("#window-activity"),
    windowKeepingAction: document.querySelector("#window-keeping-action"),
    observationComparison: document.querySelector("#observation-comparison"),
    error: document.querySelector("#last-error"),
  };

  function send(event, payload = {}) {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ event, context: state.uiUUID, action: state.action, ...payload }));
    }
  }
  function sendGlobalSettings(event, payload = {}) {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ event, context: state.uiUUID, ...payload }));
    }
  }
  function sendRegistration() {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ event: state.registerEvent, uuid: state.uiUUID }));
    }
  }
  function readSettings() {
    const settings = Object.fromEntries(new FormData(form).entries());
    for (const control of form.elements) if (control.type === "checkbox" && control.name) settings[control.name] = control.checked;
    return settings;
  }
  function writeSettings(settings) {
    state.settings = settings || {};
    for (const control of form.elements) {
      if (!control.name || settings[control.name] === undefined) continue;
      if (control.type === "checkbox") control.checked = settings[control.name] === true;
      else control.value = settings[control.name];
    }
  }
  function showDiagnostics(payload = {}) {
    diagnostics.operationalState.textContent = payload.operationalState || "Waiting for a usage observation";
    diagnostics.observationQuality.textContent = payload.observationQuality || "Unknown";
    diagnostics.resetAt.textContent = payload.resetAt ? new Date(payload.resetAt).toLocaleString() : "Unavailable";
    diagnostics.windowActivity.textContent = humanize(payload.windowActivity || "unknown");
    diagnostics.windowKeepingAction.textContent = humanize(payload.windowKeepingAction || "not-enabled");
    diagnostics.observationComparison.textContent = humanize(payload.observationComparison || "unavailable");
    diagnostics.error.textContent = payload.error || "None";
  }
  function connect(connection = {}) {
    if (state.socket) return;
    Object.assign(state, connection);
    if (!state.port || !state.uiUUID || !state.registerEvent || !state.action) return;
    state.socket = new WebSocket(`ws://127.0.0.1:${state.port}`);
    state.socket.addEventListener("open", () => {
      sendRegistration();
      sendGlobalSettings("getGlobalSettings");
      send("sendToPlugin", { payload: { event: "requestDiagnostics" } });
    });
    state.socket.addEventListener("message", ({ data }) => {
      try {
        const message = JSON.parse(data);
        if (message.event === "didReceiveGlobalSettings") writeSettings(message.payload?.settings || {});
        if (message.event === "sendToPropertyInspector") showDiagnostics(message.payload);
      } catch { /* Ignore messages outside the inspector protocol. */ }
    });
  }
  globalThis.connectElgatoStreamDeckSocket = (port, uuid, event, info, actionInfo) => {
    try {
      const action = JSON.parse(actionInfo);
      connect({
        port,
        uiUUID: uuid,
        registerEvent: event,
        action: action.action,
      });
    } catch { /* Stream Deck may send malformed launch data while closing the Inspector. */ }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.settings = { ...state.settings, ...readSettings() };
    sendGlobalSettings("setGlobalSettings", { payload: state.settings });
  });
  document.querySelector("#refresh-diagnostics").addEventListener("click", () => send("sendToPlugin", { payload: { event: "requestDiagnostics" } }));
  document.querySelector("#request-codex-window-keeping").addEventListener("click", () => send("sendToPlugin", { payload: { event: "requestCodexWindowKeeping" } }));
  connect();

  function humanize(value) {
    return String(value).replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
})();
