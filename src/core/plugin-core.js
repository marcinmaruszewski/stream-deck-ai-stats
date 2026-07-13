import { normalizeObservation, staleObservation } from "./usage-model.js";
import { createProviderAdapter, providerCapabilities } from "./contracts.js";

const FOUR_MINUTES = 4 * 60 * 1000;

export class PluginCore {
  #providers;
  #states = new Map();
  #inFlight = new Map();
  #manualWindowActions = new Map();
  #recoveries = new Map();
  #timer;

  constructor({ providers, now = () => new Date(), freshnessMs = 15 * 60 * 1000, settings = {}, ui = {} }) {
    this.#providers = providerMap(providers);
    this.now = now;
    this.freshnessMs = freshnessMs;
    this.settings = settings;
    this.ui = ui;
  }

  async configure({ providers, settings = {} } = {}) {
    await Promise.allSettled([...this.#providers.values()].map((provider) => provider.recover?.()));
    await Promise.allSettled([...this.#inFlight.values(), ...this.#manualWindowActions.values()]);
    this.#providers = providerMap(providers);
    this.settings = settings;
    for (const providerId of this.#states.keys()) {
      if (!this.#providers.has(providerId)) this.#states.delete(providerId);
    }
    await this.runCycle();
  }

  stateFor(providerId) {
    return this.#states.get(providerId) ?? {
      provider: providerId,
      operationalState: "normal",
      windowActivity: "unknown",
      windowKeepingAction: { status: "not-enabled", observationComparison: "unavailable" },
      windows: [],
    };
  }

  async refreshProvider(providerId) {
    if (this.#inFlight.has(providerId)) return this.#inFlight.get(providerId);
    const work = this.#refreshProvider(providerId).finally(() => this.#inFlight.delete(providerId));
    this.#inFlight.set(providerId, work);
    return work;
  }

  async runCycle() {
    await Promise.all([...this.#providers.keys()].map((id) => this.refreshProvider(id)));
  }

  async requestWindowKeeping(providerId) {
    if (this.#manualWindowActions.has(providerId)) return this.#manualWindowActions.get(providerId);
    const work = this.#runManualWindowKeeping(providerId).finally(() => this.#manualWindowActions.delete(providerId));
    this.#manualWindowActions.set(providerId, work);
    return work;
  }

  start() {
    if (this.#timer) return;
    void this.runCycle();
    this.#recreateSchedule();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  onWillAppear() {
    this.#recreateSchedule();
    return this.#recoverAndRun();
  }

  onSystemDidWakeUp() {
    this.#recreateSchedule();
    return this.#recoverAndRun();
  }

  async #refreshProvider(providerId) {
    const provider = this.#provider(providerId);
    try {
      const observations = await provider.usageReader.read();
      if (!Array.isArray(observations)) throw new Error("UsageReader must return an observation list");
      const previousState = this.stateFor(providerId);
      const previousWindows = previousState.windows;
      const windows = observations.map((observation) => {
        const normalized = normalizeObservation(
          { ...observation, provider: providerId },
          { now: this.now(), freshnessMs: this.freshnessMs },
        );
        const previous = previousWindows.find((window) => window.windowKind === normalized.windowKind);
        return resetDiscontinuity(previous, normalized)
          ? { ...normalized, resetDiscontinuity: true }
          : normalized;
      });
      this.#publish({ ...previousState, provider: providerId, operationalState: "normal", windows });
      return true;
    } catch (error) {
      this.#publishFailure(providerId, usageReadFailure(error));
      return false;
    }
  }

  async #recoverAndRun() {
    const availableProviders = (await Promise.all([...this.#providers.keys()].map(async (id) => {
      try {
        await this.#recoverProvider(id);
        return id;
      } catch {
        this.#publishFailure(id, "Transport recovery failed");
        return null;
      }
    }))).filter(Boolean);
    await Promise.all(availableProviders.map((id) => this.refreshProvider(id)));
    return undefined;
  }

  #recreateSchedule() {
    clearInterval(this.#timer);
    this.#timer = setInterval(() => void this.runCycle(), FOUR_MINUTES);
  }

  async #recoverProvider(providerId) {
    if (this.#recoveries.has(providerId)) return this.#recoveries.get(providerId);
    const provider = this.#provider(providerId);
    const recovery = Promise.resolve(provider.recover?.()).finally(() => this.#recoveries.delete(providerId));
    this.#recoveries.set(providerId, recovery);
    return recovery;
  }

  async #runManualWindowKeeping(providerId) {
    const provider = this.#provider(providerId);
    if (!providerCapabilities(provider).windowKeeping) {
      this.#publish({
        ...this.stateFor(providerId),
        operationalState: "unsupported",
        windowKeepingAction: { status: "not-enabled", observationComparison: "unavailable" },
      });
      return { completed: false };
    }

    const before = shortTermWindow(this.stateFor(providerId).windows);
    this.#publish({
      ...this.stateFor(providerId),
      operationalState: "window-keeping",
      windowActivity: "unknown",
      windowKeepingAction: { status: "requested", observationComparison: "unavailable" },
    });
    try {
      const result = await provider.windowKeeper.keepWindow({
        provider: providerId,
        model: this.settings[providerId]?.windowKeepingModel,
      });
      if (result?.errorCode === "model-unavailable") {
        throw Object.assign(new Error("Configured window-keeping model is unavailable"), { code: "model-unavailable" });
      }
      if (result?.completed !== true) throw new Error("Window keeping did not produce a validated completion");

      const refreshed = await this.refreshProvider(providerId);
      const state = this.stateFor(providerId);
      this.#publish({
        ...state,
        operationalState: refreshed ? "normal" : state.operationalState,
        windowActivity: "unknown",
        windowKeepingAction: {
          status: "completed",
          observationComparison: refreshed ? compareWindows(before, shortTermWindow(state.windows)) : "unavailable",
        },
      });
      return { completed: true };
    } catch (error) {
      const state = this.stateFor(providerId);
      const failure = windowKeepingFailure(error);
      this.#publish({
        ...state,
        operationalState: "error",
        windows: state.windows.map(staleObservation),
        error: failure.message,
        ...(failure.code ? { errorCode: failure.code } : {}),
        windowActivity: "unknown",
        windowKeepingAction: { status: "failed", observationComparison: "unavailable" },
      });
      return { completed: false };
    }
  }

  #provider(providerId) {
    const provider = this.#providers.get(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    return provider;
  }

  #publish(state) {
    this.#states.set(state.provider, state);
    this.ui.publish?.(state);
  }

  #publishFailure(providerId, error) {
    const { error: previousError, errorCode: previousErrorCode, ...state } = this.stateFor(providerId);
    const failure = typeof error === "string" ? { message: error } : error;
    this.#publish({
      ...state,
      operationalState: "error",
      windows: state.windows.map(staleObservation),
      error: failure.message,
      ...(failure.code ? { errorCode: failure.code } : {}),
    });
  }
}

function usageReadFailure(error) {
  const messages = {
    "authentication-required": "Provider authentication is required",
    "unsupported-version": "Provider version is unsupported",
    "snapshot-unavailable": "Provider usage snapshot is unavailable",
    "malformed-data": "Provider usage data was malformed",
    "command-unavailable": "Provider CLI is unavailable",
    "command-failed": "Provider usage command failed",
    "configuration-required": "Provider configuration is incomplete",
  };
  const code = error?.code;
  return code && messages[code]
    ? { code, message: messages[code] }
    : { message: "Usage observation unavailable" };
}

function windowKeepingFailure(error) {
  if (error?.code === "model-unavailable") {
    return { code: error.code, message: "Configured window-keeping model is unavailable" };
  }
  return { message: "Window keeping failed" };
}

function shortTermWindow(windows) {
  return windows.find((window) => window.windowKind === "short-term") ?? null;
}

function compareWindows(before, after) {
  if (!before || !after) return "unavailable";
  return before.usageProgress === after.usageProgress
    && before.resetAt?.getTime() === after.resetAt?.getTime()
    ? "unchanged"
    : "changed";
}

function providerMap(providers) {
  if (!Array.isArray(providers)) throw new Error("PluginCore requires a provider list");
  const adapters = new Map(providers.map((provider) => {
    const adapter = createProviderAdapter(provider);
    return [adapter.id, adapter];
  }));
  if (adapters.size !== providers.length) throw new Error("Provider identifiers must be unique");
  return adapters;
}

function resetDiscontinuity(previous, current) {
  return previous?.resetAt instanceof Date
    && current.resetAt instanceof Date
    && previous.usageProgress !== null
    && current.usageProgress !== null
    && (previous.resetAt.getTime() !== current.resetAt.getTime()
      || current.usageProgress < previous.usageProgress);
}
