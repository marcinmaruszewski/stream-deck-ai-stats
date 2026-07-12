export function createProviderAdapter({ id, usageReader, windowKeeper, transport, recover } = {}) {
  if (typeof id !== "string" || id.length === 0) throw new Error("Provider adapter requires an identifier");
  if (typeof usageReader?.read !== "function") throw new Error("Provider adapter requires a UsageReader");
  if (windowKeeper && (typeof windowKeeper.getActivityVerdict !== "function" || typeof windowKeeper.keepWindow !== "function")) {
    throw new Error("WindowKeeper must report activity and keep a window");
  }
  if (transport && typeof transport.execute !== "function") throw new Error("ProcessTransport must execute commands");
  const recovery = recover ?? transport?.recover;
  if (recovery && typeof recovery !== "function") throw new Error("Provider recovery must be a function");

  return Object.freeze({ id, usageReader, windowKeeper, transport, recover: recovery });
}

export function createProcessTransport({ execute, recover } = {}) {
  if (typeof execute !== "function") throw new Error("ProcessTransport requires an execute function");
  if (recover && typeof recover !== "function") throw new Error("ProcessTransport recovery must be a function");
  return Object.freeze({ execute, recover });
}

export function providerCapabilities(adapter) {
  return Object.freeze({
    usageReading: typeof adapter?.usageReader?.read === "function",
    windowKeeping: typeof adapter?.windowKeeper?.getActivityVerdict === "function"
      && typeof adapter.windowKeeper.keepWindow === "function",
  });
}
